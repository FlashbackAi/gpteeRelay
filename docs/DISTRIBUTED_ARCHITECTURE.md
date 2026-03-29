# Distributed Architecture Implementation Guide

This guide explains the changes needed to support multi-instance deployment with:
- **Global provider discovery** (P2P inference)
- **Global worker registry** (image analysis)
- **Event-driven task creation** (S3 → SQS)
- **Atomic task assignment** (no duplicates)

---

## Architecture Changes

### **Before (Single Instance)**

```
┌─────────────────────────────┐
│      Instance 1             │
│                             │
│  In-Memory State:           │
│  - peers Map                │
│  - workers Map              │
│  - taskQueue[]              │
│                             │
│  Polling:                   │
│  - S3 scan every 2 min      │
└─────────────────────────────┘
         ↓
    DynamoDB + S3
```

**Problems:**
- ❌ Users only see providers on same instance
- ❌ Workers only visible to same instance
- ❌ Multiple instances scan S3 (inefficient)

---

### **After (Multi-Instance with Redis + SQS)**

```
┌──────────────────────────────────────────────────────────────┐
│                    DISTRIBUTED SYSTEM                         │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  S3 Bucket (gptee-image-analysis)                            │
│      │                                                        │
│      │ (S3 Event Notification on ObjectCreated)              │
│      ↓                                                        │
│  SQS Standard Queue (gptee-image-tasks)                      │
│      │                                                        │
│      │ (Long-polling by all instances)                       │
│      ↓                                                        │
│  ┌─────────────────┐         ┌─────────────────┐            │
│  │   Instance 1    │         │   Instance 2    │            │
│  ├─────────────────┤         ├─────────────────┤            │
│  │ Local State:    │         │ Local State:    │            │
│  │ - WebSocket     │         │ - WebSocket     │            │
│  │   connections   │◄────────┤   connections   │            │
│  │   (peers Map)   │  Redis  │   (peers Map)   │            │
│  │                 │         │                 │            │
│  │ Shared State:   │         │ Shared State:   │            │
│  │ - Providers ────┼────┐    │ - Providers ────┼────┐       │
│  │ - Workers ──────┼────┤    │ - Workers ──────┼────┤       │
│  │ - Task claims ──┼────┤    │ - Task claims ──┼────┤       │
│  └─────────────────┘    │    └─────────────────┘    │       │
│                         ↓                            ↓       │
│                    ElastiCache Redis                         │
│                    ┌────────────────────┐                    │
│                    │ Hashes:            │                    │
│                    │ - provider:{id}    │                    │
│                    │ - worker:{id}      │                    │
│                    │                    │                    │
│                    │ Sets:              │                    │
│                    │ - providers:active │                    │
│                    │ - workers:active   │                    │
│                    │                    │                    │
│                    │ Locks:             │                    │
│                    │ - task:assigned:{id}│                   │
│                    │                    │                    │
│                    │ Pub/Sub:           │                    │
│                    │ - provider-list-   │                    │
│                    │   updated          │                    │
│                    │ - worker-list-     │                    │
│                    │   updated          │                    │
│                    └────────────────────┘                    │
│                             │                                │
│                    ┌────────┴────────┐                       │
│                    ↓                 ↓                        │
│               DynamoDB              S3                       │
│               (Persistence)      (Images)                    │
└──────────────────────────────────────────────────────────────┘
```

**Benefits:**
- ✅ All users see ALL providers (Redis-backed registry)
- ✅ All instances see ALL workers (Redis-backed registry)
- ✅ Event-driven task creation (SQS notifications)
- ✅ Atomic task assignment (Redis distributed locks)

---

## Code Changes Required

### **1. Update Environment Variables**

Add to your ECS task definition or `.env`:

```bash
# Redis (ElastiCache endpoint after creation)
REDIS_URL=redis://gptee-redis.abc123.ng.0001.use1.cache.amazonaws.com:6379

# SQS Queue URL (after creation)
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/144273780915/gptee-image-tasks

# Instance identification (auto-set by ECS)
ECS_TASK_ID=${ECS_TASK_ID}
```

---

### **2. Update server.ts - Provider Registry**

**File:** `src/server.ts`

**Change 1: Add Redis imports**
```typescript
import { getRedisService } from './services/RedisService';

const redis = getRedisService();
const instanceId = redis.getInstanceId();
```

**Change 2: Register providers in Redis (line ~273)**
```typescript
case 'register': {
  const reg = msg as RegisterMessage;
  const peer = peers.get(senderPeerId);

  if (peer) {
    peer.role = reg.role;
    peer.deviceInfo = reg.deviceInfo;

    // If provider, register in Redis for global discovery
    if (reg.deviceInfo.acceptingJobs) {
      await redis.registerProvider({
        peerId: senderPeerId,
        modelName: reg.deviceInfo.modelName ?? 'unknown',
        platform: reg.deviceInfo.platform,
        displayName: reg.deviceInfo.displayName,
        instanceId, // Which instance this provider is on
      });

      // Notify all instances
      await redis.publishProviderListUpdate();
    }

    logger.info(`[Relay] Updated registration: ${senderPeerId}`);
    broadcastProviderList();
  }
  break;
}
```

**Change 3: Update broadcastProviderList() (line ~105)**
```typescript
async function broadcastProviderList() {
  // Get ALL providers from Redis (across all instances)
  const allProviders = await redis.getAllProviders();

  logger.info(`[Relay] Broadcasting ${allProviders.length} providers (global)`);

  // Send to local peers only (sticky sessions)
  peers.forEach((peer) => {
    send(peer.socket, {
      type: 'provider_list',
      id: uuidv4(),
      from: 'relay',
      timestamp: Date.now(),
      providers: allProviders, // ← Global list!
    });
  });
}
```

**Change 4: Deregister on disconnect (line ~611)**
```typescript
socket.on('close', async (code, reason) => {
  if (registeredId) {
    const peer = peers.get(registeredId);

    // Remove from Redis if provider
    if (peer?.deviceInfo.acceptingJobs) {
      await redis.deregisterProvider(registeredId);
      await redis.publishProviderListUpdate();
    }

    peers.delete(registeredId);
    broadcastProviderList();
  }
});
```

**Change 5: Subscribe to Redis events (server startup)**
```typescript
server.listen(PORT, async () => {
  logger.info(`✅  GPTee Relay Server running on http/ws://0.0.0.0:${PORT}`);

  // Subscribe to provider list updates from other instances
  await redis.subscribeToProviderListUpdates(async () => {
    await broadcastProviderList(); // Re-broadcast when other instances update
  });

  // Start SQS-based task creation
  await startSQSTaskCreation();
});
```

---

### **3. Update ImageAnalysisCoordinator.ts - Worker Registry**

**File:** `src/ImageAnalysisCoordinator.ts`

**Change 1: Add Redis**
```typescript
import { getRedisService } from './services/RedisService';

export class ImageAnalysisCoordinator {
  private workers: Map<string, Worker> = new Map(); // Local connections
  private redis = getRedisService();
  // ... rest
```

**Change 2: Register workers in Redis (line ~450)**
```typescript
async registerWorker(socket: WebSocket, msg: WorkerRegisterMessage) {
  const workerId = msg.workerId || uuidv4();

  // Store local WebSocket connection
  const worker: Worker = {
    workerId,
    socket,
    deviceName: msg.workerInfo.deviceName,
    // ... other fields
  };

  this.workers.set(workerId, worker);

  // Register in Redis for global visibility
  await this.redis.registerWorker({
    workerId,
    deviceName: msg.workerInfo.deviceName,
    deviceModel: msg.workerInfo.deviceModel,
    platform: msg.workerInfo.platform,
    instanceId: this.redis.getInstanceId(),
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    availableForWork: true,
    activeTasks: 0,
    maxConcurrentTasks: msg.workerInfo.maxConcurrentTasks,
  });

  await this.redis.publishWorkerListUpdate();

  logger.info(`[Coordinator] Registered worker: ${workerId}`);
}
```

**Change 3: Update heartbeat in Redis**
```typescript
updateWorkerHeartbeat(msg: WorkerHeartbeatMessage) {
  const worker = this.workers.get(msg.workerId);
  if (worker) {
    worker.lastHeartbeat = Date.now();

    // Update Redis
    this.redis.updateWorkerHeartbeat(msg.workerId, worker.activeTasks);
  }
}
```

**Change 4: Deregister from Redis**
```typescript
async deregisterWorker(workerId: string) {
  this.workers.delete(workerId);
  await this.redis.deregisterWorker(workerId);
  await this.redis.publishWorkerListUpdate();
  logger.info(`[Coordinator] Deregistered worker: ${workerId}`);
}
```

**Change 5: Atomic task assignment**
```typescript
async assignTaskToWorker(task: Task) {
  // Get available workers from Redis (global view)
  const allWorkers = await this.redis.getAllWorkers();

  const availableWorkers = allWorkers.filter(w =>
    w.availableForWork &&
    w.activeTasks < w.maxConcurrentTasks
  );

  if (availableWorkers.length === 0) {
    logger.warn('[Coordinator] No available workers');
    return;
  }

  // Sort by load (least busy first)
  availableWorkers.sort((a, b) => a.activeTasks - b.activeTasks);

  for (const workerInfo of availableWorkers) {
    // Try to claim task atomically (distributed lock)
    const claimed = await this.redis.claimTaskForAssignment(task.taskId, workerInfo.workerId);

    if (claimed) {
      // Only assign if worker is connected to THIS instance
      const localWorker = this.workers.get(workerInfo.workerId);

      if (localWorker) {
        // Worker is on this instance - assign directly
        this.sendTaskToWorker(localWorker, task);
        logger.info(`[Coordinator] Assigned task ${task.taskId} to worker ${workerInfo.workerId}`);
        return;
      } else {
        // Worker is on different instance - release claim
        await this.redis.releaseTaskAssignment(task.taskId);
        continue;
      }
    }
  }

  logger.warn(`[Coordinator] Could not assign task ${task.taskId}`);
}
```

---

### **4. Replace S3 Polling with SQS**

**Create new file:** `src/services/SQSTaskCreator.ts`

```typescript
import { getSQSService, ImageUploadEvent } from './SQSService';
import { getDynamoDBService } from './DynamoDBService';
import { ImageAnalysisCoordinator } from '../ImageAnalysisCoordinator';
import logger from '../utils/logger';

export class SQSTaskCreator {
  private sqsService = getSQSService();
  private dynamoDBService = getDynamoDBService();
  private coordinator: ImageAnalysisCoordinator;

  constructor(coordinator: ImageAnalysisCoordinator) {
    this.coordinator = coordinator;
  }

  async start(): Promise<void> {
    if (!this.sqsService.isConfigured()) {
      logger.warn('[SQSTaskCreator] SQS not configured - using fallback S3 polling');
      return;
    }

    logger.info('[SQSTaskCreator] Starting SQS-based task creation');

    // Start polling SQS
    await this.sqsService.startPolling(async (event: ImageUploadEvent) => {
      await this.handleImageUpload(event);
    });
  }

  stop(): void {
    this.sqsService.stopPolling();
  }

  private async handleImageUpload(event: ImageUploadEvent): Promise<void> {
    try {
      const imageId = this.generateImageId(event.imageKey);

      // Try to create task in DynamoDB (atomic - prevents duplicates)
      const result = await this.dynamoDBService.createTask({
        imageId,
        imageName: event.imageKey.split('/').pop() || event.imageKey,
        s3Bucket: event.bucket,
        s3Key: event.imageKey,
        priority: 'normal',
      });

      if (result.created) {
        logger.info(`[SQSTaskCreator] Created task for image: ${event.imageKey}`);
        // Task will be picked up by coordinator
      } else {
        logger.debug(`[SQSTaskCreator] Task already exists: ${imageId}`);
      }
    } catch (err: any) {
      logger.error(`[SQSTaskCreator] Error handling image upload: ${err.message}`);
      throw err; // SQS will retry
    }
  }

  private generateImageId(s3Key: string): string {
    return s3Key.replace(/[^a-zA-Z0-9]/g, '_');
  }
}
```

**Update server.ts startup:**
```typescript
import { SQSTaskCreator } from './services/SQSTaskCreator';

server.listen(PORT, async () => {
  logger.info(`✅  GPTee Relay Server running`);

  // Start SQS-based task creation (replaces S3 polling)
  const sqsTaskCreator = new SQSTaskCreator(imageCoordinator);
  await sqsTaskCreator.start();
});
```

---

## AWS Infrastructure Setup

### **1. Create ElastiCache Redis Cluster**

```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id gptee-redis \
  --cache-node-type cache.t4g.small \
  --engine redis \
  --engine-version 7.0 \
  --num-cache-nodes 1 \
  --cache-subnet-group-name your-subnet-group \
  --security-group-ids sg-xxxxx \
  --region us-east-1
```

**Get endpoint:**
```bash
aws elasticache describe-cache-clusters \
  --cache-cluster-id gptee-redis \
  --show-cache-node-info \
  --query 'CacheClusters[0].CacheNodes[0].Endpoint.Address' \
  --output text
```

**Output:** `gptee-redis.abc123.ng.0001.use1.cache.amazonaws.com`

---

### **2. Create SQS Standard Queue**

**Note:** We use a standard queue (not FIFO) because S3 event notifications don't support FIFO queues. Duplicate prevention is handled by DynamoDB's atomic operations.

```bash
aws sqs create-queue \
  --queue-name gptee-image-tasks \
  --attributes '{
    "MessageRetentionPeriod": "86400",
    "VisibilityTimeout": "300"
  }' \
  --region us-east-1
```

**Get queue URL:**
```bash
aws sqs get-queue-url \
  --queue-name gptee-image-tasks \
  --query 'QueueUrl' \
  --output text
```

---

### **3. Configure S3 Event Notifications**

```bash
aws s3api put-bucket-notification-configuration \
  --bucket gptee-image-analysis \
  --notification-configuration '{
    "QueueConfigurations": [{
      "QueueArn": "arn:aws:sqs:us-east-1:144273780915:gptee-image-tasks",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [{
            "Name": "suffix",
            "Value": ".jpg"
          }, {
            "Name": "suffix",
            "Value": ".png"
          }]
        }
      }
    }]
  }'
```

**Allow S3 to publish to SQS:**
```bash
aws sqs set-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/144273780915/gptee-image-tasks \
  --attributes '{
    "Policy": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"s3.amazonaws.com\"},\"Action\":\"SQS:SendMessage\",\"Resource\":\"arn:aws:sqs:us-east-1:144273780915:gptee-image-tasks\",\"Condition\":{\"ArnLike\":{\"aws:SourceArn\":\"arn:aws:s3:::gptee-image-analysis\"}}}]}"
  }'
```

---

### **4. Update IAM Policy**

Add to `aws/iam-task-role-policy.json`:

```json
{
  "Sid": "RedisAccess",
  "Effect": "Allow",
  "Action": [
    "elasticache:DescribeCacheClusters"
  ],
  "Resource": "*"
},
{
  "Sid": "SQSAccess",
  "Effect": "Allow",
  "Action": [
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes"
  ],
  "Resource": "arn:aws:sqs:us-east-1:144273780915:gptee-image-tasks"
}
```

---

### **5. Update Security Groups**

**Allow ECS tasks to access Redis:**
```bash
aws ec2 authorize-security-group-ingress \
  --group-id sg-redis-xxxxx \
  --protocol tcp \
  --port 6379 \
  --source-group sg-ecs-tasks
```

---

## Testing

### **Test 1: Provider Discovery**

```bash
# Connect User1 to Instance 1
# Connect Provider1 to Instance 1
# Connect User2 to Instance 2
# Connect Provider2 to Instance 2

# User1 should see: [Provider1, Provider2] ✅
# User2 should see: [Provider1, Provider2] ✅
```

### **Test 2: Image Upload Event**

```bash
# Upload image to S3
aws s3 cp test.jpg s3://gptee-image-analysis/test.jpg

# Check SQS queue
aws sqs receive-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/144273780915/gptee-image-tasks

# Both instances should process (only one creates task due to DynamoDB atomic check)
```

### **Test 3: Task Assignment**

```bash
# 10 workers connected (5 on each instance)
# Upload 20 images
# Each worker should get ~2 tasks
# No duplicate assignments (Redis lock prevents)
```

---

## Rollback Plan

If issues occur, you can revert to S3 polling:

1. Set `SQS_QUEUE_URL=""` (disables SQS)
2. Fallback code will use old `TaskCreatorService`
3. Providers/workers still visible only per-instance (acceptable for rollback)

---

## Cost Summary

| Service | Configuration | Cost/Month |
|---------|--------------|------------|
| ECS Fargate | 2-6 tasks (0.5 vCPU, 1 GB) | $30-40 |
| ALB | Internet-facing | $16-25 |
| **ElastiCache Redis** | **cache.t4g.small** | **$23** |
| **SQS Standard** | **~1M requests** | **$2-5** |
| Route 53 | 1 hosted zone | $0.50 |
| CloudWatch Logs | 10 GB | $5 |
| **Total** | | **~$85-110** |

**Additional cost for distributed architecture: ~$25-30/month**

---

## Benefits

✅ **Global Provider Discovery** - Users see ALL providers
✅ **Global Worker Registry** - Tasks distributed across all workers
✅ **Event-Driven** - No S3 polling overhead
✅ **Atomic Operations** - No duplicate task assignments
✅ **Scalable** - Add instances without coordination
✅ **Production-Ready** - High availability, auto-healing

---

## Next Steps

1. Install dependencies: `npm install`
2. Create AWS resources (Redis, SQS)
3. Update environment variables
4. Deploy updated code
5. Test provider discovery
6. Test image upload events
7. Monitor Redis/SQS metrics
