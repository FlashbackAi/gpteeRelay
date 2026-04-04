/**
 * Redis Service
 *
 * Shared state management across multiple instances:
 * - Provider registry (for P2P discovery)
 * - Worker registry (for image analysis tasks)
 * - Active task tracking (for deduplication)
 */

import Redis from 'ioredis';
import logger from '../utils/logger';
import { ProviderInfo } from '../types';

export interface WorkerInfo {
  workerId: string;
  deviceName: string;
  deviceModel: string;
  platform: 'android' | 'ios';
  instanceId: string; // Which ECS instance the worker is connected to
  connectedAt: number;
  lastHeartbeat: number;
  availableForWork: boolean;
  activeTasks: number;
  maxConcurrentTasks: number;
}

class RedisService {
  private client: Redis;
  private pubClient: Redis;
  private subClient: Redis;
  private instanceId: string;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    // Main client for commands
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    // Separate clients for pub/sub (Redis requirement)
    this.pubClient = new Redis(redisUrl);
    this.subClient = new Redis(redisUrl);

    // Unique instance identifier (ECS task ID or random)
    this.instanceId = process.env.ECS_TASK_ID || `instance-${Date.now()}`;

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.client.on('connect', () => {
      logger.info('[Redis] Connected successfully');
    });

    this.client.on('error', (err) => {
      logger.error(`[Redis] Connection error: ${err.message}`);
    });

    this.client.on('ready', () => {
      logger.info('[Redis] Client ready');
    });
  }

  /**
   * Get instance ID for this ECS task
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  // ── Provider Registry ─────────────────────────────────────────────────────

  /**
   * Register a provider (for P2P inference)
   * Stored with TTL - auto-expires if not refreshed
   */
  async registerProvider(provider: ProviderInfo & { instanceId: string }): Promise<void> {
    const key = `provider:${provider.peerId}`;
    await this.client.hset(key, {
      peerId: provider.peerId,
      modelName: provider.modelName,
      platform: provider.platform,
      displayName: provider.displayName,
      instanceId: provider.instanceId,
      registeredAt: Date.now(),
    });

    // Auto-expire after 2 minutes (refreshed by heartbeat)
    await this.client.expire(key, 120);

    // Add to providers set
    await this.client.sadd('providers:active', provider.peerId);

    logger.info(`[Redis] Registered provider: ${provider.peerId} on instance ${provider.instanceId}`);
  }

  /**
   * Deregister a provider
   */
  async deregisterProvider(peerId: string): Promise<void> {
    await this.client.del(`provider:${peerId}`);
    await this.client.srem('providers:active', peerId);
    logger.info(`[Redis] Deregistered provider: ${peerId}`);
  }

  /**
   * Get all active providers (across all instances)
   */
  async getAllProviders(): Promise<ProviderInfo[]> {
    const providerIds = await this.client.smembers('providers:active');
    const providers: ProviderInfo[] = [];

    for (const peerId of providerIds) {
      const data = await this.client.hgetall(`provider:${peerId}`);

      // Skip if expired or missing
      if (!data.peerId) {
        await this.client.srem('providers:active', peerId);
        continue;
      }

      providers.push({
        peerId: data.peerId,
        modelName: data.modelName,
        platform: data.platform,
        displayName: data.displayName,
      });
    }

    return providers;
  }

  /**
   * Refresh provider heartbeat (extends TTL)
   */
  async refreshProviderHeartbeat(peerId: string): Promise<void> {
    const exists = await this.client.exists(`provider:${peerId}`);
    if (exists) {
      await this.client.expire(`provider:${peerId}`, 120);
    }
  }

  // ── Worker Registry ───────────────────────────────────────────────────────

  /**
   * Register a worker (for image analysis)
   */
  async registerWorker(worker: WorkerInfo): Promise<void> {
    const key = `worker:${worker.workerId}`;
    await this.client.hset(key, {
      workerId: worker.workerId,
      deviceName: worker.deviceName,
      deviceModel: worker.deviceModel,
      platform: worker.platform,
      instanceId: worker.instanceId,
      connectedAt: worker.connectedAt,
      lastHeartbeat: worker.lastHeartbeat,
      availableForWork: worker.availableForWork ? '1' : '0',
      activeTasks: worker.activeTasks,
      maxConcurrentTasks: worker.maxConcurrentTasks,
    });

    // Auto-expire after 2 minutes
    await this.client.expire(key, 120);

    // Add to active workers set
    await this.client.sadd('workers:active', worker.workerId);

    logger.info(`[Redis] Registered worker: ${worker.workerId} on instance ${worker.instanceId}`);
  }

  /**
   * Deregister a worker
   */
  async deregisterWorker(workerId: string): Promise<void> {
    await this.client.del(`worker:${workerId}`);
    await this.client.srem('workers:active', workerId);
    logger.info(`[Redis] Deregistered worker: ${workerId}`);
  }

  /**
   * Get all active workers (across all instances)
   */
  async getAllWorkers(): Promise<WorkerInfo[]> {
    const workerIds = await this.client.smembers('workers:active');
    const workers: WorkerInfo[] = [];

    for (const workerId of workerIds) {
      const data = await this.client.hgetall(`worker:${workerId}`);

      if (!data.workerId) {
        await this.client.srem('workers:active', workerId);
        continue;
      }

      workers.push({
        workerId: data.workerId,
        deviceName: data.deviceName,
        deviceModel: data.deviceModel,
        platform: data.platform as 'android' | 'ios',
        instanceId: data.instanceId,
        connectedAt: parseInt(data.connectedAt),
        lastHeartbeat: parseInt(data.lastHeartbeat),
        availableForWork: data.availableForWork === '1',
        activeTasks: parseInt(data.activeTasks),
        maxConcurrentTasks: parseInt(data.maxConcurrentTasks),
      });
    }

    return workers;
  }

  /**
   * Update worker heartbeat
   */
  async updateWorkerHeartbeat(workerId: string, activeTasks: number): Promise<void> {
    const key = `worker:${workerId}`;
    const exists = await this.client.exists(key);

    if (exists) {
      await this.client.hset(key, {
        lastHeartbeat: Date.now(),
        activeTasks,
      });
      await this.client.expire(key, 120);
    }
  }

  // ── Task Assignment (Distributed Lock) ───────────────────────────────────

  /**
   * Try to claim a task for assignment (atomic operation)
   * Returns true if this instance successfully claimed the task
   */
  async claimTaskForAssignment(taskId: string, workerId: string): Promise<boolean> {
    const key = `task:assigned:${taskId}`;

    // Use SET NX (set if not exists) with expiration
    // Returns 'OK' if set, null if already exists
    const result = await this.client.set(key, workerId, 'EX', 300, 'NX');

    if (result === 'OK') {
      logger.info(`[Redis] Claimed task ${taskId} for worker ${workerId}`);
      return true;
    }

    logger.debug(`[Redis] Task ${taskId} already claimed`);
    return false;
  }

  /**
   * Release task assignment (when task completes or fails)
   */
  async releaseTaskAssignment(taskId: string): Promise<void> {
    await this.client.del(`task:assigned:${taskId}`);
  }

  /**
   * Check if task is already assigned
   */
  async isTaskAssigned(taskId: string): Promise<boolean> {
    return await this.client.exists(`task:assigned:${taskId}`) === 1;
  }

  // ── Pub/Sub for Cross-Instance Events ────────────────────────────────────

  /**
   * Publish provider list update event
   */
  async publishProviderListUpdate(): Promise<void> {
    await this.pubClient.publish('events:provider-list-updated', Date.now().toString());
  }

  /**
   * Subscribe to provider list updates
   */
  async subscribeToProviderListUpdates(callback: () => void): Promise<void> {
    await this.subClient.subscribe('events:provider-list-updated');

    this.subClient.on('message', (channel, message) => {
      if (channel === 'events:provider-list-updated') {
        logger.debug('[Redis] Provider list updated event received');
        callback();
      }
    });
  }

  /**
   * Publish worker list update event
   */
  async publishWorkerListUpdate(): Promise<void> {
    await this.pubClient.publish('events:worker-list-updated', Date.now().toString());
  }

  /**
   * Subscribe to worker list updates
   */
  async subscribeToWorkerListUpdates(callback: () => void): Promise<void> {
    await this.subClient.subscribe('events:worker-list-updated');

    this.subClient.on('message', (channel, message) => {
      if (channel === 'events:worker-list-updated') {
        logger.debug('[Redis] Worker list updated event received');
        callback();
      }
    });
  }

  // ── WebRTC Signaling (Cross-Instance) ────────────────────────────────────────

  /**
   * Publish WebRTC signaling message for cross-instance routing
   */
  async publishWebRTCSignaling(message: any): Promise<void> {
    await this.pubClient.publish('webrtc:signaling', JSON.stringify(message));
    logger.debug(`[Redis] Published WebRTC signaling: ${message.type} from ${message.from} to ${message.to}`);
  }

  /**
   * Subscribe to WebRTC signaling messages
   */
  async subscribeToWebRTCSignaling(callback: (message: any) => void): Promise<void> {
    await this.subClient.subscribe('webrtc:signaling');

    this.subClient.on('message', (channel, rawMessage) => {
      if (channel === 'webrtc:signaling') {
        try {
          const message = JSON.parse(rawMessage);
          logger.debug(`[Redis] Received WebRTC signaling: ${message.type} from ${message.from} to ${message.to}`);
          callback(message);
        } catch (e) {
          logger.error('[Redis] Failed to parse WebRTC signaling message:', e);
        }
      }
    });
  }

  // ── Health & Cleanup ──────────────────────────────────────────────────────

  /**
   * Cleanup stale entries (expired workers/providers)
   */
  async cleanupStaleEntries(): Promise<void> {
    const now = Date.now();
    const STALE_THRESHOLD = 120_000; // 2 minutes

    // Cleanup providers
    const providerIds = await this.client.smembers('providers:active');
    for (const peerId of providerIds) {
      const exists = await this.client.exists(`provider:${peerId}`);
      if (!exists) {
        await this.client.srem('providers:active', peerId);
      }
    }

    // Cleanup workers
    const workerIds = await this.client.smembers('workers:active');
    for (const workerId of workerIds) {
      const exists = await this.client.exists(`worker:${workerId}`);
      if (!exists) {
        await this.client.srem('workers:active', workerId);
      }
    }

    logger.debug('[Redis] Cleanup completed');
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch (err) {
      logger.error(`[Redis] Health check failed: ${err}`);
      return false;
    }
  }

  /**
   * Close all connections
   */
  async disconnect(): Promise<void> {
    await this.client.quit();
    await this.pubClient.quit();
    await this.subClient.quit();
    logger.info('[Redis] Disconnected');
  }
}

// Singleton instance
let redisServiceInstance: RedisService | null = null;

export function getRedisService(): RedisService {
  if (!redisServiceInstance) {
    redisServiceInstance = new RedisService();
  }
  return redisServiceInstance;
}

export default RedisService;
