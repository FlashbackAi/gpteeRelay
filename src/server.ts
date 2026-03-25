import express from 'express';
import http from 'http';
import apiRouter from './api/routes';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  GPTeeMessage,
  RegisterMessage,
  InferenceRequestMessage,
  InferenceStreamMessage,
  InferenceDoneMessage,
  InferenceResponseMessage,
  ProviderInfo,
  ProviderStatusMessage,
  WebRTCOfferMessage,
  WebRTCAnswerMessage,
  WebRTCIceCandidateMessage,
  WorkerRegisterMessage,
  WorkerRegisteredMessage,
  WorkerDeregisterMessage,
  WorkerHeartbeatMessage,
  WorkerStatusMessage,
  TaskAcceptMessage,
  TaskRejectMessage,
  TaskResultMessage,
  TaskErrorMessage,
  WorkerPauseMessage,
  WorkerResumeMessage,
} from './types';
import { ImageAnalysisCoordinator } from './ImageAnalysisCoordinator';
import { getTaskCreatorService } from './services/TaskCreatorService';

const PORT = parseInt(process.env.PORT || '9293', 10);

// ── Image Analysis Coordinator ────────────────────────────────────────────────
const imageCoordinator = new ImageAnalysisCoordinator();

// ── Task Creator Service ──────────────────────────────────────────────────────
const taskCreatorService = getTaskCreatorService(imageCoordinator);

// ── Peer Registry ─────────────────────────────────────────────────────────────
interface ProviderMetrics {
  activeJobs: number;
  queueDepth: number;
  avgResponseTime: number; // ms
  tokensPerSec: number;
  lastUpdated: number;
}

interface Peer {
  peerId: string;
  role: 'user' | 'provider';
  socket: WebSocket;
  deviceInfo: RegisterMessage['deviceInfo'];
  connectedAt: number;
  metrics?: ProviderMetrics; // Only for providers (acceptingJobs=true)
}

const peers = new Map<string, Peer>();

// ── Request Context Tracking (for failover) ───────────────────────────────────
interface RequestContext {
  requestId: string;
  consumerId: string;
  providerId: string;
  prompt: string;
  conversationHistory: any[]; // ChatMessage[]
  startTime: number;
  tokensReceived: number;
  status: 'active' | 'completed' | 'failed';
  retryCount: number;
  lastHeartbeat: number;
}

const activeRequests = new Map<string, RequestContext>();

// Failover configuration
const FAILOVER_CONFIG = {
  MAX_RETRIES: 3,
  REQUEST_TIMEOUT_MS: 30_000, // 30 seconds
  CLEANUP_DELAY_MS: 5 * 60 * 1000, // 5 minutes
  HEALTH_CHECK_INTERVAL_MS: 10_000, // 10 seconds
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function send(socket: WebSocket, msg: GPTeeMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function calculateLoad(metrics?: ProviderMetrics): number {
  if (!metrics) return 0; // No metrics = lowest priority

  // Load score based on active jobs, queue depth, and response time
  // Lower score = better (less loaded)
  const jobWeight = metrics.activeJobs * 10;
  const queueWeight = metrics.queueDepth * 5;
  const responseWeight = metrics.avgResponseTime / 100; // normalize to ~10s range

  return jobWeight + queueWeight + responseWeight;
}

function broadcastProviderList() {
  const providerList: ProviderInfo[] = [];

  console.log(`[relay] 📋 Building provider list from ${peers.size} peers:`);
  peers.forEach((peer) => {
    console.log(`[relay]   - ${peer.peerId.substring(0, 8)}: ${peer.deviceInfo.displayName} (accepting: ${peer.deviceInfo.acceptingJobs})`);

    // A peer is an available provider if they are accepting jobs
    if (peer.deviceInfo.acceptingJobs) {
      providerList.push({
        peerId: peer.peerId,
        modelName: peer.deviceInfo.modelName ?? 'unknown',
        platform: peer.deviceInfo.platform,
        displayName: peer.deviceInfo.displayName,
      });
    }
  });

  console.log(`[relay] 📤 Broadcasting ${providerList.length} providers to ${peers.size} peers`);
  providerList.forEach((p, i) => {
    console.log(`[relay]   ${i + 1}. ${p.displayName} (${p.peerId.substring(0, 8)}...)`);
  });

  // Sort providers by load (least loaded first) for load balancing
  providerList.sort((a, b) => {
    const loadA = calculateLoad(peers.get(a.peerId)?.metrics);
    const loadB = calculateLoad(peers.get(b.peerId)?.metrics);
    return loadA - loadB;
  });

  // Send updated list to all connected peers
  // Include all providers (including the peer itself if they're a provider)
  peers.forEach((peer) => {
    send(peer.socket, {
      type: 'provider_list',
      id: uuidv4(),
      from: 'relay',
      timestamp: Date.now(),
      providers: providerList,
    });
  });
}

function getProviders(): ProviderInfo[] {
  const list: ProviderInfo[] = [];
  peers.forEach((peer) => {
    // A peer is an available provider if they are accepting jobs
    if (peer.deviceInfo.acceptingJobs) {
      list.push({
        peerId: peer.peerId,
        modelName: peer.deviceInfo.modelName ?? 'unknown',
        platform: peer.deviceInfo.platform,
        displayName: peer.deviceInfo.displayName,
      });
    }
  });

  // Sort providers by load (least loaded first) for load balancing
  list.sort((a, b) => {
    const loadA = calculateLoad(peers.get(a.peerId)?.metrics);
    const loadB = calculateLoad(peers.get(b.peerId)?.metrics);
    return loadA - loadB;
  });

  return list;
}

function sendErrorToConsumer(consumerId: string, requestId: string, errorCode: string, errorMessage: string) {
  const consumer = peers.get(consumerId);
  if (consumer) {
    send(consumer.socket, {
      type: 'inference_error',
      id: uuidv4(),
      from: 'relay',
      timestamp: Date.now(),
      requestId,
      code: errorCode,
      message: errorMessage,
    });
  }
}

function handleProviderFailure(failedProviderId: string) {
  // Find all requests assigned to this provider
  const failedRequests = Array.from(activeRequests.values())
    .filter(ctx => ctx.providerId === failedProviderId && ctx.status === 'active');

  if (failedRequests.length === 0) return;

  console.log(`[relay] 🔄 Provider ${failedProviderId} failed with ${failedRequests.length} active requests`);

  // For each failed request, attempt reassignment
  for (const context of failedRequests) {
    // Skip if already retried too many times
    if (context.retryCount >= FAILOVER_CONFIG.MAX_RETRIES) {
      console.log(`[relay] ❌ Request ${context.requestId} exceeded retry limit`);
      sendErrorToConsumer(context.consumerId, context.requestId, 'MAX_RETRIES_EXCEEDED', 'All providers failed. Maximum retry limit reached.');
      activeRequests.delete(context.requestId);
      continue;
    }

    // Find next best provider (excluding failed one)
    const availableProviders = getProviders().filter(p => p.peerId !== failedProviderId);

    if (availableProviders.length === 0) {
      console.log(`[relay] ❌ No backup providers for request ${context.requestId}`);
      sendErrorToConsumer(context.consumerId, context.requestId, 'NO_PROVIDERS_AVAILABLE', 'No alternative providers available.');
      activeRequests.delete(context.requestId);
      continue;
    }

    const newProvider = availableProviders[0]; // Least loaded
    context.providerId = newProvider.peerId;
    context.retryCount++;
    context.startTime = Date.now();
    context.lastHeartbeat = Date.now();

    console.log(`[relay] ♻️  Reassigning ${context.requestId} to ${newProvider.peerId} (attempt ${context.retryCount})`);

    // Notify consumer about failover
    const consumer = peers.get(context.consumerId);
    if (consumer) {
      send(consumer.socket, {
        type: 'provider_failover',
        id: uuidv4(),
        from: 'relay',
        timestamp: Date.now(),
        requestId: context.requestId,
        newProviderId: newProvider.peerId,
        newProviderName: newProvider.displayName || 'Unknown',
        tokensReceived: context.tokensReceived,
      });
    }

    // Send request to new provider with conversation context
    const newProviderPeer = peers.get(newProvider.peerId);
    if (newProviderPeer) {
      send(newProviderPeer.socket, {
        type: 'inference_request',
        id: uuidv4(),
        from: context.consumerId,
        to: newProvider.peerId,
        timestamp: Date.now(),
        requestId: context.requestId,
        prompt: context.prompt,
        conversationHistory: context.conversationHistory,
        isFailoverRequest: true,
        previousTokens: context.tokensReceived,
      });
    }
  }
}

// ── Message Router ────────────────────────────────────────────────────────────
function routeMessage(senderPeerId: string, raw: string) {
  let msg: GPTeeMessage;
  try {
    msg = JSON.parse(raw) as GPTeeMessage;
  } catch {
    console.error(`[relay] Invalid JSON from ${senderPeerId}`);
    return;
  }

  console.log(`[relay] ${msg.type} from ${senderPeerId} → ${msg.to ?? 'relay'}`);

  switch (msg.type) {
    case 'register': {
      // Handle re-registration (update existing peer info)
      const reg = msg as RegisterMessage;
      const peer = peers.get(senderPeerId);
      if (peer) {
        peer.role = reg.role;
        peer.deviceInfo = reg.deviceInfo;
        console.log(`[relay] 🔄 Updated registration: ${senderPeerId} (acceptingJobs: ${reg.deviceInfo.acceptingJobs}) - ${reg.deviceInfo.displayName || 'No displayName'}`);

        // Broadcast updated provider list
        broadcastProviderList();
      }
      break;
    }

    case 'provider_status': {
      // Update provider metrics for load balancing
      const status = msg as ProviderStatusMessage;
      const peer = peers.get(senderPeerId);
      if (peer && peer.deviceInfo.acceptingJobs) {
        peer.metrics = {
          ...status.metrics,
          lastUpdated: Date.now(),
        };
        console.log(`[relay] 📊 Updated metrics for ${senderPeerId}: activeJobs=${status.metrics.activeJobs}, queueDepth=${status.metrics.queueDepth}`);

        // Broadcast updated provider list (sorted by new metrics)
        broadcastProviderList();
      }
      break;
    }

    case 'ping': {
      const sender = peers.get(senderPeerId);
      if (sender) {
        send(sender.socket, {
          type: 'pong',
          id: uuidv4(),
          from: 'relay',
          timestamp: Date.now(),
        });
      }
      break;
    }

    // Forward inference_request: user → provider
    case 'inference_request': {
      const req = msg as InferenceRequestMessage;
      const provider = peers.get(req.to);
      if (!provider) {
        const sender = peers.get(senderPeerId);
        if (sender) {
          send(sender.socket, {
            type: 'error',
            id: uuidv4(),
            from: 'relay',
            timestamp: Date.now(),
            code: 'PROVIDER_NOT_FOUND',
            message: `Provider ${req.to} is not connected`,
          });
        }
        return;
      }

      // Track this request for failover (only if not already tracked)
      if (!activeRequests.has(req.requestId)) {
        activeRequests.set(req.requestId, {
          requestId: req.requestId,
          consumerId: senderPeerId,
          providerId: req.to,
          prompt: req.prompt,
          conversationHistory: req.conversationHistory || [],
          startTime: Date.now(),
          tokensReceived: req.previousTokens || 0,
          status: 'active',
          retryCount: req.isFailoverRequest ? 1 : 0,
          lastHeartbeat: Date.now(),
        });
        console.log(`[relay] 📝 Tracking request ${req.requestId}: ${senderPeerId} → ${req.to}`);
      }

      // Forward with original sender id
      send(provider.socket, { ...req, from: senderPeerId });
      break;
    }

    // Forward inference_response: provider → user
    case 'inference_response': {
      const res = msg as InferenceResponseMessage;
      if (!res.to) return;
      const user = peers.get(res.to);
      if (user) send(user.socket, { ...res, from: senderPeerId });
      break;
    }

    // Forward stream token: provider → user
    case 'inference_stream': {
      const stream = msg as InferenceStreamMessage;
      if (!stream.to) return;

      // Update heartbeat on each stream token
      const context = activeRequests.get(stream.requestId);
      if (context) {
        context.tokensReceived++;
        context.lastHeartbeat = Date.now();
      }

      const user = peers.get(stream.to);
      if (user) send(user.socket, { ...stream, from: senderPeerId });
      break;
    }

    // Forward done signal: provider → user
    case 'inference_done': {
      const done = msg as InferenceDoneMessage;
      if (!done.to) return;

      // Mark completed when done
      const context = activeRequests.get(done.requestId);
      if (context) {
        context.status = 'completed';
        // Clean up after 5 minutes (for debugging/logging)
        setTimeout(() => {
          activeRequests.delete(done.requestId);
          console.log(`[relay] 🧹 Cleaned up completed request ${done.requestId}`);
        }, FAILOVER_CONFIG.CLEANUP_DELAY_MS);
      }

      const user = peers.get(done.to);
      if (user) send(user.socket, { ...done, from: senderPeerId });
      break;
    }

    // Forward WebRTC signaling messages: peer → peer
    case 'webrtc_offer': {
      const offer = msg as WebRTCOfferMessage;
      if (!offer.to) return;
      const target = peers.get(offer.to);
      if (target) {
        send(target.socket, { ...offer, from: senderPeerId });
        console.log(`[relay] WebRTC offer forwarded: ${senderPeerId} → ${offer.to}`);
      } else {
        console.warn(`[relay] WebRTC offer target not found: ${offer.to}`);
      }
      break;
    }

    case 'webrtc_answer': {
      const answer = msg as WebRTCAnswerMessage;
      if (!answer.to) return;
      const target = peers.get(answer.to);
      if (target) {
        send(target.socket, { ...answer, from: senderPeerId });
        console.log(`[relay] WebRTC answer forwarded: ${senderPeerId} → ${answer.to}`);
      } else {
        console.warn(`[relay] WebRTC answer target not found: ${answer.to}`);
      }
      break;
    }

    case 'webrtc_ice_candidate': {
      const candidate = msg as WebRTCIceCandidateMessage;
      if (!candidate.to) return;
      const target = peers.get(candidate.to);
      if (target) {
        send(target.socket, { ...candidate, from: senderPeerId });
        console.log(`[relay] WebRTC ICE candidate forwarded: ${senderPeerId} → ${candidate.to}`);
      } else {
        console.warn(`[relay] WebRTC ICE candidate target not found: ${candidate.to}`);
      }
      break;
    }

    // ── Image Analysis Worker Protocol ────────────────────────────────────────
    case 'worker_register': {
      const reg = msg as WorkerRegisterMessage;
      const sender = peers.get(senderPeerId);
      if (sender) {
        imageCoordinator.registerWorker(sender.socket, reg);
      }
      break;
    }

    case 'worker_deregister': {
      const dereg = msg as WorkerDeregisterMessage;
      imageCoordinator.deregisterWorker(dereg.workerId);
      break;
    }

    case 'worker_heartbeat': {
      const heartbeat = msg as WorkerHeartbeatMessage;
      imageCoordinator.updateWorkerHeartbeat(heartbeat);
      break;
    }

    case 'worker_status': {
      const status = msg as WorkerStatusMessage;
      imageCoordinator.updateWorkerStatus(status);
      break;
    }

    case 'task_accept': {
      const accept = msg as TaskAcceptMessage;
      imageCoordinator.handleTaskAccept(accept);
      break;
    }

    case 'task_reject': {
      const reject = msg as TaskRejectMessage;
      imageCoordinator.handleTaskReject(reject);
      break;
    }

    case 'task_result': {
      const result = msg as TaskResultMessage;
      imageCoordinator.handleTaskResult(result);
      break;
    }

    case 'task_error': {
      const error = msg as TaskErrorMessage;
      imageCoordinator.handleTaskError(error);
      break;
    }

    case 'worker_pause': {
      const pause = msg as WorkerPauseMessage;
      imageCoordinator.pauseWorker(pause);
      break;
    }

    case 'worker_resume': {
      const resume = msg as WorkerResumeMessage;
      imageCoordinator.resumeWorker(resume);
      break;
    }

    default:
      console.warn(`[relay] Unhandled message type: ${msg.type}`);
  }
}

// ── HTTP & WebSocket Server ───────────────────────────────────────────────────
const app = express();
app.use(express.json());

// API Routes
app.use('/api', apiRouter);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (socket: WebSocket) => {
  // Assign a temporary peer id — replaced when peer registers
  const tempId = `temp_${uuidv4()}`;
  let registeredId: string | null = null;

  console.log(`[relay] New connection (temp: ${tempId})`);

  // First message must be a register
  const registrationTimeout = setTimeout(() => {
    if (!registeredId) {
      console.log(`[relay] ${tempId} did not register in time — closing`);
      socket.close();
    }
  }, 10_000);

  socket.on('message', async (data: Buffer) => {
    const raw = data.toString();

    // Handle registration separately (before peer is in registry)
    if (!registeredId) {
      let msg: GPTeeMessage;
      try {
        msg = JSON.parse(raw) as GPTeeMessage;
      } catch (err) {
        console.error(`[relay] ❌ Failed to parse JSON:`, err);
        return;
      }

      if (msg.type !== 'register' && msg.type !== 'worker_register') {
        console.warn(`[relay] Expected register or worker_register, got ${msg.type}`);
        return;
      }

      // Handle both peer registration and worker registration
      if (msg.type === 'worker_register') {
        const workerReg = msg as WorkerRegisterMessage;
        registeredId = workerReg.workerId || uuidv4();

        // Register worker in image analysis coordinator
        await imageCoordinator.registerWorker(socket, workerReg);

        console.log(`[relay] ✅ Worker registered: ${registeredId} (${workerReg.workerInfo.deviceName})`);

        // Send acknowledgment
        const ackMsg: WorkerRegisteredMessage = {
          type: 'worker_registered',
          id: uuidv4(),
          from: 'relay',
          timestamp: Date.now(),
          workerId: registeredId,
        };
        send(socket, ackMsg);

        return;
      }

      const reg = msg as RegisterMessage;
      registeredId = reg.from || uuidv4();
      clearTimeout(registrationTimeout);

      peers.set(registeredId, {
        peerId: registeredId,
        role: reg.role,
        socket,
        deviceInfo: reg.deviceInfo,
        connectedAt: Date.now(),
      });

      console.log(`[relay] ✅ Registered: ${registeredId} as ${reg.role} (${reg.deviceInfo.platform}) - ${reg.deviceInfo.displayName || 'No displayName'}`);

      // Ack registration
      send(socket, {
        type: 'provider_list',
        id: uuidv4(),
        from: 'relay',
        timestamp: Date.now(),
        providers: getProviders(),
      });

      // Always broadcast when a peer registers (provider list may have changed)
      broadcastProviderList();

      return;
    }

    routeMessage(registeredId, raw);
  });

  socket.on('close', (code, reason) => {
    if (registeredId) {
      const peer = peers.get(registeredId);
      console.log(`[relay] ❌ Disconnected: ${registeredId} (${peer?.role}) - Code: ${code}, Reason: ${reason.toString()}`);

      // Check if this was a provider with active requests
      if (peer?.deviceInfo.acceptingJobs) {
        handleProviderFailure(registeredId);
      }

      peers.delete(registeredId);
      // Always broadcast when a peer disconnects (provider list may have changed)
      broadcastProviderList();
    } else {
      console.log(`[relay] Disconnected before registration - Code: ${code}`);
    }
  });

  socket.on('error', (err) => {
    console.error(`[relay] Socket error (${registeredId ?? tempId}):`, err.message);
  });
});

server.listen(PORT, async () => {
  console.log(`✅  GPTee Relay Server running on http/ws://0.0.0.0:${PORT}`);
  console.log(`    Peers connected: ${peers.size}`);

  // Start automatic task creation from S3
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AUTOMATIC TASK CREATION ENABLED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  The coordinator will automatically:');
  console.log('  • Scan S3 bucket for images every 10 minutes');
  console.log('  • Create tasks for unprocessed images');
  console.log('  • Distribute tasks to available workers');
  console.log('  • Track results in DynamoDB');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  await taskCreatorService.start();
});

// ── Health check every 30s ────────────────────────────────────────────────────
setInterval(() => {
  const providersCount = [...peers.values()].filter((p) => p.deviceInfo.acceptingJobs).length;
  const consumersCount = [...peers.values()].filter((p) => !p.deviceInfo.acceptingJobs).length;
  console.log(`[relay] 💓 peers=${peers.size} providers=${providersCount} consumers=${consumersCount} activeRequests=${activeRequests.size}`);
}, 30_000);

// ── Zombie Detection & Timeout Monitoring ─────────────────────────────────────
setInterval(() => {
  const now = Date.now();

  for (const [requestId, context] of activeRequests.entries()) {
    if (context.status !== 'active') continue;

    const timeSinceHeartbeat = now - context.lastHeartbeat;

    // If no activity for timeout period, assume provider is stuck
    if (timeSinceHeartbeat > FAILOVER_CONFIG.REQUEST_TIMEOUT_MS) {
      console.log(`[relay] ⏰ Request ${requestId} timed out (${timeSinceHeartbeat}ms since last token)`);
      console.log(`[relay] 🔄 Provider ${context.providerId} appears hung, reassigning request`);

      // Treat as provider failure and reassign
      const provider = peers.get(context.providerId);
      if (provider) {
        // Only handle this specific request's failover
        const failedRequests = [context];

        // Same failover logic but for single request
        if (context.retryCount >= FAILOVER_CONFIG.MAX_RETRIES) {
          console.log(`[relay] ❌ Request ${context.requestId} exceeded retry limit`);
          sendErrorToConsumer(context.consumerId, context.requestId, 'MAX_RETRIES_EXCEEDED', 'Request timed out after maximum retries.');
          activeRequests.delete(context.requestId);
          continue;
        }

        const availableProviders = getProviders().filter(p => p.peerId !== context.providerId);

        if (availableProviders.length === 0) {
          console.log(`[relay] ❌ No backup providers for timed out request ${context.requestId}`);
          sendErrorToConsumer(context.consumerId, context.requestId, 'NO_PROVIDERS_AVAILABLE', 'Request timed out and no alternative providers available.');
          activeRequests.delete(context.requestId);
          continue;
        }

        const newProvider = availableProviders[0];
        context.providerId = newProvider.peerId;
        context.retryCount++;
        context.startTime = Date.now();
        context.lastHeartbeat = Date.now();

        console.log(`[relay] ♻️  Reassigning timed out ${context.requestId} to ${newProvider.peerId} (attempt ${context.retryCount})`);

        // Notify consumer about failover
        const consumer = peers.get(context.consumerId);
        if (consumer) {
          send(consumer.socket, {
            type: 'provider_failover',
            id: uuidv4(),
            from: 'relay',
            timestamp: Date.now(),
            requestId: context.requestId,
            newProviderId: newProvider.peerId,
            newProviderName: newProvider.displayName || 'Unknown',
            tokensReceived: context.tokensReceived,
          });
        }

        // Send request to new provider
        const newProviderPeer = peers.get(newProvider.peerId);
        if (newProviderPeer) {
          send(newProviderPeer.socket, {
            type: 'inference_request',
            id: uuidv4(),
            from: context.consumerId,
            to: newProvider.peerId,
            timestamp: Date.now(),
            requestId: context.requestId,
            prompt: context.prompt,
            conversationHistory: context.conversationHistory,
            isFailoverRequest: true,
            previousTokens: context.tokensReceived,
          });
        }
      }
    }
  }
}, FAILOVER_CONFIG.HEALTH_CHECK_INTERVAL_MS);