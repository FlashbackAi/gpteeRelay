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
} from './types';

const PORT = parseInt(process.env.PORT || '8080', 10);

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
  peers.forEach((peer) => {
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

  // Sort providers by load (least loaded first) for load balancing
  providerList.sort((a, b) => {
    const loadA = calculateLoad(peers.get(a.peerId)?.metrics);
    const loadB = calculateLoad(peers.get(b.peerId)?.metrics);
    return loadA - loadB;
  });

  // Send updated list to all connected peers (everyone is a user)
  // Filter out each peer's own ID from their provider list
  peers.forEach((peer) => {
    const filteredProviders = providerList.filter(p => p.peerId !== peer.peerId);
    send(peer.socket, {
      type: 'provider_list',
      id: uuidv4(),
      from: 'relay',
      timestamp: Date.now(),
      providers: filteredProviders,
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
      const user = peers.get(stream.to);
      if (user) send(user.socket, { ...stream, from: senderPeerId });
      break;
    }

    // Forward done signal: provider → user
    case 'inference_done': {
      const done = msg as InferenceDoneMessage;
      if (!done.to) return;
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

    default:
      console.warn(`[relay] Unhandled message type: ${msg.type}`);
  }
}

// ── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });

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

  socket.on('message', (data: Buffer) => {
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

      if (msg.type !== 'register') {
        console.warn(`[relay] Expected register, got ${msg.type}`);
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
      console.log(`[relay] Disconnected: ${registeredId} (${peer?.role}) - Code: ${code}, Reason: ${reason.toString()}`);
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

wss.on('listening', () => {
  console.log(`✅  GPTee Relay Server running on ws://0.0.0.0:${PORT}`);
  console.log(`    Peers connected: ${peers.size}`);
});

// ── Health check every 30s ────────────────────────────────────────────────────
setInterval(() => {
  const providersCount = [...peers.values()].filter((p) => p.deviceInfo.acceptingJobs).length;
  const consumersCount = [...peers.values()].filter((p) => !p.deviceInfo.acceptingJobs).length;
  console.log(`[relay] 💓 peers=${peers.size} providers=${providersCount} consumers=${consumersCount}`);
}, 30_000);