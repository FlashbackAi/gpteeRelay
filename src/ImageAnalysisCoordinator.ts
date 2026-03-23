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
  private workers: Map<string, Worker> = new Map();
  private dynamoDBService = getDynamoDBService();
  private taskQueue: Task[] = [];
  private activeTasks: Map<string, Task> = new Map();
  private taskTimeouts: Map<string, NodeJS.Timeout> = new Map();

  private heartbeatCheckInterval?: NodeJS.Timeout;

  private readonly HEARTBEAT_TIMEOUT_MS = 90_000; // 90 seconds
  private readonly HEARTBEAT_CHECK_INTERVAL_MS = 30_000; // 30 seconds
  private readonly DEFAULT_TASK_TIMEOUT_MS = 30_000; // 30 seconds
  private readonly MAX_RETRIES = 3;

  constructor() {
    console.log('[ImageCoordinator] Initializing Image Analysis Coordinator');
    this.startHeartbeatMonitoring();
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

    this.workers.set(workerId, worker);

    // Try to assign pending tasks
    await this.assignPendingTasks();
  }

  async deregisterWorker(workerId: string): Promise<void> {
    console.log(`[ImageCoordinator] 📤 Worker deregistered: ${workerId}`);

    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Reassign active tasks
    for (const [taskId, task] of this.activeTasks) {
      if (task.workerId === workerId) {
        console.log(`[ImageCoordinator] ♻️ Reassigning task ${taskId} (worker offline)`);
        task.status = 'pending';
        task.workerId = undefined;
        task.retryCount++;
        this.taskQueue.push(task);
        this.activeTasks.delete(taskId);
      }
    }

    this.workers.delete(workerId);

    // Try to assign reassigned tasks
    await this.assignPendingTasks();
  }

  updateWorkerHeartbeat(msg: WorkerHeartbeatMessage): void {
    const worker = this.workers.get(msg.from);
    if (!worker) return;

    worker.lastHeartbeat = Date.now();
    worker.thermalStatus = msg.thermalStatus;
    worker.batteryLevel = msg.batteryLevel;
    worker.activeTasks = msg.activeTasks;
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

  async submitTask(
    imageId: string,
    imageUrl: string,
    analysisType: string,
    priority: 'low' | 'normal' | 'high' = 'normal'
  ): Promise<string> {
    const taskId = uuidv4();

    const task: Task = {
      taskId,
      imageId,
      imageName: imageUrl.split('/').pop() || 'unknown',
      imageUrl,
      analysisType,
      priority,
      timeout: this.DEFAULT_TASK_TIMEOUT_MS,
      status: 'pending',
      retryCount: 0,
      maxRetries: this.MAX_RETRIES,
    };

    console.log(`[ImageCoordinator] 📥 Task submitted: ${taskId} (${analysisType})`);

    this.taskQueue.push(task);
    this.sortTaskQueue(); // Sort by priority

    // Try immediate assignment
    await this.assignPendingTasks();

    return taskId;
  }

  private sortTaskQueue(): void {
    const priorityOrder = { high: 3, normal: 2, low: 1 };
    this.taskQueue.sort((a, b) => {
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  private async assignPendingTasks(): Promise<void> {
    if (this.taskQueue.length === 0) return;

    console.log(`[ImageCoordinator] 🔄 Attempting to assign ${this.taskQueue.length} pending tasks`);

    const tasksToAssign = [...this.taskQueue];
    this.taskQueue = [];

    for (const task of tasksToAssign) {
      const worker = this.selectBestWorker(task);

      if (!worker) {
        console.log(`[ImageCoordinator] ⏳ No available worker for task ${task.taskId}, re-queuing`);
        this.taskQueue.push(task);
        continue;
      }

      await this.assignTaskToWorker(task, worker);
    }
  }

  private selectBestWorker(task: Task): Worker | null {
    const availableWorkers = Array.from(this.workers.values()).filter(w => {
      return (
        w.availableForWork &&
        w.activeTasks < w.maxConcurrentTasks &&
        w.modelsLoaded[task.analysisType as keyof typeof w.modelsLoaded] === true
      );
    });

    if (availableWorkers.length === 0) return null;

    // Score each worker
    const scoredWorkers = availableWorkers.map(worker => ({
      worker,
      score: this.calculateWorkerScore(worker),
    }));

    // Sort by score (higher is better)
    scoredWorkers.sort((a, b) => b.score - a.score);

    return scoredWorkers[0].worker;
  }

  private calculateWorkerScore(worker: Worker): number {
    let score = 100;

    // Thermal penalty
    const thermalPenalty = {
      nominal: 0,
      light: -5,
      moderate: -20,
      severe: -50,
      critical: -100,
    };
    score += thermalPenalty[worker.thermalStatus];

    // Battery penalty
    if (worker.batteryLevel < 20) score -= 30;
    else if (worker.batteryLevel < 50) score -= 10;

    // Workload penalty
    const workloadRatio = worker.activeTasks / worker.maxConcurrentTasks;
    score -= workloadRatio * 20;

    // Performance bonus (faster workers get higher score)
    if (worker.avgProcessingTimeMs > 0) {
      const performanceBonus = Math.max(0, (5000 - worker.avgProcessingTimeMs) / 100);
      score += performanceBonus;
    }

    // Hardware acceleration bonus
    if (worker.hardwareAcceleration.includes('qnn')) score += 10;
    else if (worker.hardwareAcceleration.includes('nnapi')) score += 5;

    // Network quality bonus
    const networkBonus = {
      excellent: 10,
      good: 5,
      fair: -5,
      poor: -20,
    };
    score += networkBonus[worker.networkQuality as keyof typeof networkBonus] || 0;

    return score;
  }

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

  handleTaskReject(msg: TaskRejectMessage): void {
    const task = this.activeTasks.get(msg.taskId);
    if (!task) return;

    console.log(`[ImageCoordinator] ❌ Task rejected: ${msg.taskId} (reason: ${msg.reason})`);

    const worker = this.workers.get(msg.from);
    if (worker) worker.activeTasks--;

    this.activeTasks.delete(msg.taskId);
    this.clearTaskTimeout(msg.taskId);

    // Re-queue for retry
    task.status = 'pending';
    task.workerId = undefined;
    task.retryCount++;

    if (task.retryCount < task.maxRetries) {
      this.taskQueue.push(task);
      this.assignPendingTasks();
    } else {
      console.log(`[ImageCoordinator] ⛔ Task failed after ${task.retryCount} retries: ${msg.taskId}`);
      task.status = 'failed';
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

    // Retry if retryable
    if (msg.retryable && task.retryCount < task.maxRetries) {
      console.log(`[ImageCoordinator] ♻️ Retrying task ${msg.taskId} (attempt ${task.retryCount + 1}/${task.maxRetries})`);
      task.status = "pending";
      task.workerId = undefined;
      task.retryCount++;
      this.taskQueue.push(task);

      // Exponential backoff
      const delayMs = Math.min(1000 * Math.pow(2, task.retryCount), 60000);
      setTimeout(() => this.assignPendingTasks(), delayMs);
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
  private handleTaskTimeout(taskId: string): void {

    const task = this.activeTasks.get(taskId);
    if (!task || task.status === 'completed') return;

    console.log(`[ImageCoordinator] ⏰ Task timeout: ${taskId}`);

    const worker = this.workers.get(task.workerId!);
    if (worker) worker.activeTasks--;

    this.activeTasks.delete(taskId);

    // Retry
    if (task.retryCount < task.maxRetries) {
      task.status = 'pending';
      task.workerId = undefined;
      task.retryCount++;
      this.taskQueue.push(task);
      this.assignPendingTasks();
    } else {
      task.status = 'timeout';
      task.errorMessage = `Task exceeded timeout (${task.timeout}ms)`;
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
        pending: this.taskQueue.length,
        active: this.activeTasks.size,
      },
    };
  }
}
