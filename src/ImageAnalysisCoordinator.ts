import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  WorkerRegisterMessage,
  WorkerDeregisterMessage,
  WorkerHeartbeatMessage,
  WorkerStatusMessage,
  TaskAcceptMessage,
  TaskRejectMessage,
  TaskResultMessage,
  TaskErrorMessage,
  WorkerPauseMessage,
  WorkerResumeMessage,
  TaskAssignMessage,
  ThermalStatus,
  GPTeeMessage,
} from './types';
import { getDynamoDBService } from './services/DynamoDBService';
import { getRedisService } from './services/RedisService';

// ── Worker Registry ───────────────────────────────────────────────────────────

export interface Worker {
  workerId: string;
  socket: WebSocket;
  deviceName: string;
  deviceModel: string;
  platform: 'android' | 'ios';
  osVersion: string;
  chipVendor: string;

  // Health metrics
  thermalStatus: ThermalStatus;
  batteryLevel: number;
  networkType: string;
  networkQuality: string;

  // Capabilities
  modelsLoaded: {
    face_detection: boolean;
    object_detection?: boolean;
  };
  hardwareAcceleration: string[];
  maxConcurrentTasks: number;
  maxImageResolution: number;

  // Performance metrics
  activeTasks: number;
  tasksCompleted: number;
  tasksFailed: number;
  avgProcessingTimeMs: number;
  uptimeMs: number;

  // Availability
  availableForWork: boolean;
  lastHeartbeat: number;
  connectedAt: number;
}

// ── Task Management ───────────────────────────────────────────────────────────

export interface Task {
  taskId: string;
  imageId: string;
  imageName: string;
  imageUrl: string;
  analysisType: string;
  priority: 'low' | 'normal' | 'high';
  timeout: number;

  // Assignment info
  workerId?: string;
  status: 'pending' | 'assigned' | 'processing' | 'completed' | 'failed' | 'timeout';
  assignedAt?: number;
  startedAt?: number;
  completedAt?: number;

  // Retry logic
  retryCount: number;
  maxRetries: number;

  // Results
  detectionsFound?: number;
  processingTimeMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

// ── Image Analysis Coordinator ────────────────────────────────────────────────

export class ImageAnalysisCoordinator {
  // Local worker connections (WebSocket refs - each instance manages its own connected workers)
  private workers: Map<string, Worker> = new Map();

  // Services
  private dynamoDBService = getDynamoDBService();
  private redis = getRedisService();

  // Local task tracking (for this instance only)
  private activeTasks: Map<string, Task> = new Map();
  private taskTimeouts: Map<string, NodeJS.Timeout> = new Map();

  // Periodic task assignment
  private taskAssignmentInterval?: NodeJS.Timeout;
  private heartbeatCheckInterval?: NodeJS.Timeout;

  private readonly HEARTBEAT_TIMEOUT_MS = 90_000; // 90 seconds
  private readonly HEARTBEAT_CHECK_INTERVAL_MS = 30_000; // 30 seconds
  private readonly TASK_ASSIGNMENT_INTERVAL_MS = 5_000; // Check for tasks every 5 seconds
  private readonly DEFAULT_TASK_TIMEOUT_MS = 30_000; // 30 seconds
  private readonly MAX_RETRIES = 3;

  constructor() {
    console.log('[ImageCoordinator] Initializing Image Analysis Coordinator');
    this.startHeartbeatMonitoring();
    // Don't call async loadPendingTasksFromDB() in constructor - call it from initialize()
  }

  /**
   * Initialize the coordinator (call this after construction)
   * This is async and should be awaited
   */
  async initialize(): Promise<void> {
    console.log('[ImageCoordinator] Starting coordinator initialization...');

    // Start periodic task assignment (distributed-safe)
    this.startPeriodicTaskAssignment();

    // Do an immediate assignment check
    await this.assignPendingTasks();

    console.log('[ImageCoordinator] ✅ Coordinator initialized successfully');
  }

  /**
   * Start periodic task assignment loop
   * Checks DynamoDB for pending tasks and tries to assign them
   */
  private startPeriodicTaskAssignment(): void {
    console.log(`[ImageCoordinator] Starting periodic task assignment (every ${this.TASK_ASSIGNMENT_INTERVAL_MS}ms)`);

    this.taskAssignmentInterval = setInterval(async () => {
      try {
        await this.assignPendingTasks();
      } catch (error: any) {
        console.error('[ImageCoordinator] Error in periodic task assignment:', error.message);
      }
    }, this.TASK_ASSIGNMENT_INTERVAL_MS);
  }

  /**
   * Stop all background processes
   */
  shutdown(): void {
    console.log('[ImageCoordinator] Shutting down...');
    if (this.taskAssignmentInterval) {
      clearInterval(this.taskAssignmentInterval);
    }
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
    }
  }

  /**
   * Assign pending tasks to available workers (distributed-safe)
   * Uses Redis atomic locks to prevent duplicate assignments across instances
   */
  private async assignPendingTasks(): Promise<void> {
    try {
      // Check if we have any available workers on THIS instance
      const availableWorkers = Array.from(this.workers.values()).filter(w => {
        return (
          w.availableForWork &&
          w.activeTasks < w.maxConcurrentTasks &&
          w.modelsLoaded.face_detection === true
        );
      });

      if (availableWorkers.length === 0) {
        // No workers available on this instance, skip
        return;
      }

      // Query DynamoDB for pending tasks (limit to avoid overload)
      const pendingTasks = await this.dynamoDBService.getPendingTasks(20);

      if (pendingTasks.length === 0) {
        return;
      }

      console.log(`[ImageCoordinator] 🔄 Found ${pendingTasks.length} pending tasks, ${availableWorkers.length} available workers`);

      let assignedCount = 0;

      // Try to assign tasks
      for (const dbTask of pendingTasks) {
        // Check if already active on THIS instance
        if (this.activeTasks.has(dbTask.image_id)) {
          continue;
        }

        // Get best available worker
        const worker = this.selectBestWorker(availableWorkers);
        if (!worker) {
          console.log('[ImageCoordinator] No more available workers, stopping assignment');
          break;
        }

        // Try to claim this task atomically (distributed lock)
        const claimed = await this.redis.claimTaskForAssignment(dbTask.image_id, worker.workerId);

        if (!claimed) {
          console.log(`[ImageCoordinator] ⏭️ Task ${dbTask.image_id} already claimed by another instance, skipping`);
          continue;
        }

        // Successfully claimed! Now assign to worker
        try {
          // Generate presigned URL for the image
          const s3Service = require('./services/S3Service').getS3Service();
          const imageUrl = await s3Service.generatePresignedUrl(dbTask.s3Key, 3600);

          // Create task object
          const task: Task = {
            taskId: dbTask.image_id,
            imageId: dbTask.image_id,
            imageName: dbTask.imageName,
            imageUrl: imageUrl,
            analysisType: 'face_detection',
            priority: dbTask.priority || 'normal',
            timeout: this.DEFAULT_TASK_TIMEOUT_MS,
            status: 'pending',
            retryCount: dbTask.attemptCount || 0,
            maxRetries: this.MAX_RETRIES,
          };

          await this.assignTaskToWorker(task, worker);
          assignedCount++;

          // Remove worker from available list temporarily
          const workerIndex = availableWorkers.indexOf(worker);
          if (workerIndex > -1 && worker.activeTasks >= worker.maxConcurrentTasks) {
            availableWorkers.splice(workerIndex, 1);
          }
        } catch (error: any) {
          console.error(`[ImageCoordinator] Failed to assign task ${dbTask.image_id}:`, error.message);
          // Release the lock if assignment failed
          await this.redis.releaseTaskAssignment(dbTask.image_id);
        }
      }

      if (assignedCount > 0) {
        console.log(`[ImageCoordinator] ✅ Assigned ${assignedCount} tasks to workers`);
      }
    } catch (error: any) {
      console.error('[ImageCoordinator] ❌ Error in assignPendingTasks:', error.message);
    }
  }

  /**
   * Select the best worker for a task based on scoring algorithm
   */
  private selectBestWorker(availableWorkers: Worker[]): Worker | null {
    if (availableWorkers.length === 0) return null;

    // Score each worker
    const scoredWorkers = availableWorkers.map(worker => ({
      worker,
      score: this.calculateWorkerScore(worker),
    }));

    // Sort by score (highest first)
    scoredWorkers.sort((a, b) => b.score - a.score);

    return scoredWorkers[0].worker;
  }

  /**
   * Calculate worker score for task assignment
   * Higher score = better candidate
   */
  private calculateWorkerScore(worker: Worker): number {
    let score = 100;

    // Hardware acceleration bonus
    if (worker.hardwareAcceleration.includes('gpu')) score += 30;
    if (worker.hardwareAcceleration.includes('npu')) score += 25;

    // Platform preference (iOS generally faster for ML)
    if (worker.platform === 'ios') score += 10;

    // Thermal status penalty
    if (worker.thermalStatus === 'severe' || worker.thermalStatus === 'critical') {
      score -= 50;
    } else if (worker.thermalStatus === 'moderate') {
      score -= 20;
    }

    // Battery level consideration
    if (worker.batteryLevel < 20) score -= 30;
    else if (worker.batteryLevel < 50) score -= 10;

    // Network quality
    if (worker.networkQuality === 'poor') score -= 20;

    // Workload penalty
    const workloadRatio = worker.activeTasks / worker.maxConcurrentTasks;
    score -= workloadRatio * 20;

    // Performance history bonus
    if (worker.avgProcessingTimeMs > 0 && worker.avgProcessingTimeMs < 5000) {
      score += 15; // Fast worker
    }

    return score;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Worker Management
  // ═══════════════════════════════════════════════════════════════════════════

  async registerWorker(socket: WebSocket, msg: WorkerRegisterMessage): Promise<void> {
    const { workerId, workerInfo } = msg;

    console.log(`[ImageCoordinator] 📝 Worker registered: ${workerId} (${workerInfo.deviceName})`);

    const worker: Worker = {
      workerId,
      socket,
      deviceName: workerInfo.deviceName,
      deviceModel: workerInfo.deviceModel,
      platform: workerInfo.platform,
      osVersion: workerInfo.osVersion,
      chipVendor: workerInfo.chipVendor,
      thermalStatus: workerInfo.thermalStatus,
      batteryLevel: workerInfo.batteryLevel,
      networkType: workerInfo.networkType,
      networkQuality: 'good', // Default
      modelsLoaded: workerInfo.modelsLoaded,
      hardwareAcceleration: workerInfo.hardwareAcceleration,
      maxConcurrentTasks: workerInfo.maxConcurrentTasks,
      maxImageResolution: workerInfo.maxImageResolution,
      activeTasks: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      avgProcessingTimeMs: 0,
      uptimeMs: 0,
      availableForWork: true,
      lastHeartbeat: Date.now(),
      connectedAt: Date.now(),
    };

    // Store locally (for WebSocket reference)
    this.workers.set(workerId, worker);

    // Register in Redis (for global visibility across instances)
    await this.redis.registerWorker({
      workerId: worker.workerId,
      deviceName: worker.deviceName,
      deviceModel: worker.deviceModel,
      platform: worker.platform,
      instanceId: this.redis.getInstanceId(),
      connectedAt: worker.connectedAt,
      lastHeartbeat: worker.lastHeartbeat,
      availableForWork: worker.availableForWork,
      activeTasks: worker.activeTasks,
      maxConcurrentTasks: worker.maxConcurrentTasks,
    });

    // Try to assign pending tasks immediately
    await this.assignPendingTasks();
  }

  async deregisterWorker(workerId: string): Promise<void> {
    console.log(`[ImageCoordinator] 📤 Worker deregistered: ${workerId}`);

    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Handle active tasks on this worker
    for (const [taskId, task] of this.activeTasks) {
      if (task.workerId === workerId) {
        console.log(`[ImageCoordinator] ♻️ Releasing task ${taskId} (worker offline)`);

        // Release Redis lock and update DynamoDB status back to pending
        await this.redis.releaseTaskAssignment(taskId);
        await this.dynamoDBService.updateTaskStatus(task.imageId, 'pending', {
          attemptCount: task.retryCount + 1
        });

        this.activeTasks.delete(taskId);
        this.clearTaskTimeout(taskId);
      }
    }

    // Remove from local workers
    this.workers.delete(workerId);

    // Remove from Redis (global registry)
    await this.redis.deregisterWorker(workerId);

    console.log(`[ImageCoordinator] ✅ Worker ${workerId} fully deregistered from instance and Redis`);
  }

  async updateWorkerHeartbeat(msg: WorkerHeartbeatMessage): Promise<void> {
    const worker = this.workers.get(msg.from);
    if (!worker) return;

    worker.lastHeartbeat = Date.now();
    worker.thermalStatus = msg.thermalStatus;
    worker.batteryLevel = msg.batteryLevel;
    worker.activeTasks = msg.activeTasks;

    // Sync to Redis (for global visibility and cross-instance monitoring)
    await this.redis.updateWorkerHeartbeat(msg.from, msg.activeTasks);
  }

  updateWorkerStatus(msg: WorkerStatusMessage): void {
    const worker = this.workers.get(msg.from);
    if (!worker) return;

    worker.thermalStatus = msg.thermalStatus;
    worker.batteryLevel = msg.batteryLevel;
    worker.networkType = msg.networkType;
    worker.networkQuality = msg.networkQuality;
    worker.activeTasks = msg.activeTasks;
    worker.tasksCompleted = msg.tasksCompleted;
    worker.tasksFailed = msg.tasksFailed;
    worker.avgProcessingTimeMs = msg.avgProcessingTimeMs;
    worker.uptimeMs = msg.uptimeMs;
    worker.availableForWork = msg.availableForWork;
    worker.lastHeartbeat = Date.now();
  }

  pauseWorker(msg: WorkerPauseMessage): void {
    const worker = this.workers.get(msg.from);
    if (!worker) return;

    console.log(`[ImageCoordinator] ⏸️ Worker paused: ${msg.from} (reason: ${msg.reason})`);
    worker.availableForWork = false;
  }

  resumeWorker(msg: WorkerResumeMessage): void {
    const worker = this.workers.get(msg.from);
    if (!worker) return;

    console.log(`[ImageCoordinator] ▶️ Worker resumed: ${msg.from}`);
    worker.availableForWork = true;

    // Try to assign pending tasks
    this.assignPendingTasks();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Task Management
  // ═══════════════════════════════════════════════════════════════════════════

  private async assignTaskToWorker(task: Task, worker: Worker): Promise<void> {
    console.log(`[ImageCoordinator] ➡️ Assigning task ${task.taskId} to worker ${worker.workerId}`);

    task.status = 'assigned';
    task.workerId = worker.workerId;
    task.assignedAt = Date.now();

    worker.activeTasks++;
    this.activeTasks.set(task.taskId, task);

    // Send task to worker
    const assignMessage: TaskAssignMessage = {
      type: 'task_assign',
      id: uuidv4(),
      from: 'coordinator',
      to: worker.workerId,
      timestamp: Date.now(),
      taskId: task.taskId,
      imageId: task.imageId,
      imageName: task.imageName,
      imageUrl: task.imageUrl,
      analysisType: task.analysisType as any,
      priority: task.priority,
      timeout: task.timeout,
    };

    this.send(worker.socket, assignMessage);

    // Set timeout
    const timeout = setTimeout(() => {
      this.handleTaskTimeout(task.taskId);
    }, task.timeout);

    this.taskTimeouts.set(task.taskId, timeout);
  }

  handleTaskAccept(msg: TaskAcceptMessage): void {
    const task = this.activeTasks.get(msg.taskId);
    if (!task) return;

    console.log(`[ImageCoordinator] ✅ Task accepted: ${msg.taskId} by ${msg.from}`);
    task.status = 'processing';
    task.startedAt = Date.now();
  }

  async handleTaskReject(msg: TaskRejectMessage): Promise<void> {
    const task = this.activeTasks.get(msg.taskId);
    if (!task) return;

    console.log(`[ImageCoordinator] ❌ Task rejected: ${msg.taskId} (reason: ${msg.reason})`);

    const worker = this.workers.get(msg.from);
    if (worker) worker.activeTasks--;

    this.activeTasks.delete(msg.taskId);
    this.clearTaskTimeout(msg.taskId);

    // Release Redis lock
    await this.redis.releaseTaskAssignment(msg.taskId);

    // Increment retry count
    task.retryCount++;

    if (task.retryCount < task.maxRetries) {
      // Update DynamoDB status back to pending for retry
      await this.dynamoDBService.updateTaskStatus(task.imageId, 'pending', {
        attemptCount: task.retryCount
      });
      console.log(`[ImageCoordinator] ♻️ Task ${msg.taskId} marked pending for retry (attempt ${task.retryCount}/${task.maxRetries})`);
    } else {
      console.log(`[ImageCoordinator] ⛔ Task failed after ${task.retryCount} retries: ${msg.taskId}`);
      await this.dynamoDBService.updateTaskStatus(task.imageId, 'failed', {
        attemptCount: task.retryCount
      });
    }
  }
  async handleTaskResult(msg: TaskResultMessage): Promise<void> {
    const task = this.activeTasks.get(msg.taskId);
    if (!task) return;

    console.log(`[ImageCoordinator] ✨ Task completed: ${msg.taskId} (${msg.detectionsFound} detections)`);

    const worker = this.workers.get(msg.from || task.workerId!);
    let workerDisplayName = 'Unknown Worker';
    if (worker) {
      worker.activeTasks--;
      worker.tasksCompleted++;
      workerDisplayName = worker.deviceName;

      // Update average processing time
      if (worker.avgProcessingTimeMs === 0) {
        worker.avgProcessingTimeMs = msg.processingTimeMs;
      } else {
        worker.avgProcessingTimeMs = (worker.avgProcessingTimeMs + msg.processingTimeMs) / 2;
      }
    }

    task.status = 'completed';
    task.completedAt = Date.now();
    task.detectionsFound = msg.detectionsFound;
    task.processingTimeMs = msg.processingTimeMs;

    this.activeTasks.delete(msg.taskId);
    this.clearTaskTimeout(msg.taskId);

    // Store results in DynamoDB
    try {
      await this.dynamoDBService.storeTaskResult({
        taskId: msg.taskId,
        imageId: task.imageId,
        imageName: task.imageName,
        analysisType: task.analysisType,
        status: 'completed',
        detections: (msg.detections || []).map(d => ({
        detectionsFound: msg.detectionsFound,
          detectionId: d.detectionId,
          bbox: [d.bbox.x, d.bbox.y, d.bbox.width, d.bbox.height],
          confidence: d.confidence,
          attributes: d.attributes,
        })),
        workerId: msg.from || task.workerId || 'unknown',
        workerDisplayName,
        processingTimeMs: msg.processingTimeMs,
        thermalStatus: msg.thermalStatus || 'unknown',
      });
      console.log(`[ImageCoordinator] 💾 Stored results in DynamoDB for task ${msg.taskId}`);
    } catch (error: any) {
      console.error(`[ImageCoordinator] ❌ Failed to store results in DynamoDB:`, error.message);
    }
  }

  async handleTaskError(msg: TaskErrorMessage): Promise<void> {
    const task = this.activeTasks.get(msg.taskId);
    if (!task) return;

    console.log(`[ImageCoordinator] ⚠️ Task error: ${msg.taskId} - ${msg.errorCode}: ${msg.errorMessage}`);

    const worker = this.workers.get(msg.from);
    let workerDisplayName = "Unknown Worker";
    if (worker) {
      worker.activeTasks--;
      worker.tasksFailed++;
      workerDisplayName = worker.deviceName;
    }

    this.activeTasks.delete(msg.taskId);
    this.clearTaskTimeout(msg.taskId);

    // Release Redis lock
    await this.redis.releaseTaskAssignment(msg.taskId);

    // Retry if retryable
    if (msg.retryable && task.retryCount < task.maxRetries) {
      console.log(`[ImageCoordinator] ♻️ Retrying task ${msg.taskId} (attempt ${task.retryCount + 1}/${task.maxRetries})`);
      task.retryCount++;

      // Update DynamoDB status back to pending for retry with exponential backoff
      await this.dynamoDBService.updateTaskStatus(task.imageId, 'pending', {
        attemptCount: task.retryCount
      });

      console.log(`[ImageCoordinator] Task ${msg.taskId} will be picked up in next assignment cycle`);
    } else {
      console.log(`[ImageCoordinator] ⛔ Task failed permanently: ${msg.taskId}`);
      task.status = "failed";
      task.errorCode = msg.errorCode;
      task.errorMessage = msg.errorMessage;

      // Store failed result in DynamoDB
      try {
        await this.dynamoDBService.storeTaskResult({
          taskId: msg.taskId,
          imageId: task.imageId,
          imageName: task.imageName,
          analysisType: task.analysisType,
          status: "failed",
          workerId: msg.from,
          workerDisplayName,
          processingTimeMs: 0,
          thermalStatus: "unknown",
          errorMessage: msg.errorMessage,
          errorCode: msg.errorCode,
        });
        console.log(`[ImageCoordinator] 💾 Stored failed result in DynamoDB for task ${msg.taskId}`);
      } catch (error: any) {
        console.error(`[ImageCoordinator] ❌ Failed to store error result in DynamoDB:`, error.message);
      }
    }
  }
  private async handleTaskTimeout(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId);
    if (!task || task.status === 'completed') return;

    console.log(`[ImageCoordinator] ⏰ Task timeout: ${taskId}`);

    const worker = this.workers.get(task.workerId!);
    if (worker) worker.activeTasks--;

    this.activeTasks.delete(taskId);

    // Release Redis lock
    await this.redis.releaseTaskAssignment(taskId);

    // Retry
    if (task.retryCount < task.maxRetries) {
      task.retryCount++;
      console.log(`[ImageCoordinator] ♻️ Task ${taskId} timed out, marking pending for retry (attempt ${task.retryCount}/${task.maxRetries})`);

      // Update DynamoDB status back to pending for retry
      await this.dynamoDBService.updateTaskStatus(task.imageId, 'pending', {
        attemptCount: task.retryCount
      });
    } else {
      console.log(`[ImageCoordinator] ⛔ Task ${taskId} failed permanently after timeout (exceeded ${task.maxRetries} retries)`);

      // Mark as failed in DynamoDB
      await this.dynamoDBService.updateTaskStatus(task.imageId, 'failed', {
        attemptCount: task.retryCount
      });
    }
  }

  private clearTaskTimeout(taskId: string): void {
    const timeout = this.taskTimeouts.get(taskId);
    if (timeout) {
      clearTimeout(timeout);
      this.taskTimeouts.delete(taskId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Health Monitoring
  // ═══════════════════════════════════════════════════════════════════════════

  private startHeartbeatMonitoring(): void {
    this.heartbeatCheckInterval = setInterval(() => {
      this.checkWorkerHeartbeats();
    }, this.HEARTBEAT_CHECK_INTERVAL_MS);
  }

  private checkWorkerHeartbeats(): void {
    const now = Date.now();

    for (const [workerId, worker] of this.workers) {
      const timeSinceLastHeartbeat = now - worker.lastHeartbeat;

      if (timeSinceLastHeartbeat > this.HEARTBEAT_TIMEOUT_MS) {
        console.log(`[ImageCoordinator] 💔 Worker timeout: ${workerId} (${timeSinceLastHeartbeat}ms since last heartbeat)`);
        this.deregisterWorker(workerId);
      }
    }
  }

  stopHeartbeatMonitoring(): void {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  private send(socket: WebSocket, msg: GPTeeMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stats & Monitoring
  // ═══════════════════════════════════════════════════════════════════════════

  getStats() {
    return {
      workers: {
        total: this.workers.size,
        available: Array.from(this.workers.values()).filter(w => w.availableForWork).length,
        active: Array.from(this.workers.values()).filter(w => w.activeTasks > 0).length,
      },
      tasks: {
        active: this.activeTasks.size,
      },
    };
  }
}
