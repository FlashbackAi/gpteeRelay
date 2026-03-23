export type PeerRole = 'user' | 'provider';

export type MessageType =
  | 'register'        // peer announces itself + role
  | 'provider_list'   // relay sends list of available providers
  | 'provider_status' // provider sends metrics update to relay
  | 'inference_request'  // user → relay → provider
  | 'inference_response' // provider → relay → user
  | 'inference_stream'   // provider → relay → user (streaming token)
  | 'inference_done'     // provider signals stream complete
  | 'error'
  | 'ping'
  | 'pong'
  | 'provider_failover'  // relay → user (provider switched)
  | 'inference_error'    // relay → user (inference failed)
  | 'webrtc_offer'       // WebRTC signaling: offer
  | 'webrtc_answer'      // WebRTC signaling: answer
  | 'webrtc_ice_candidate' // WebRTC signaling: ICE candidate
  // Image Analysis Worker Protocol
  | 'worker_register'           // Worker announces capabilities
  | 'worker_registered'         // Coordinator → Worker: registration confirmed
  | 'worker_deregister'         // Worker going offline
  | 'worker_status'             // Periodic health metrics
  | 'worker_heartbeat'          // Lightweight keepalive (every 30s)
  | 'task_assign'               // Coordinator → Worker: analyze this image
  | 'task_accept'               // Worker → Coordinator: task accepted
  | 'task_reject'               // Worker → Coordinator: cannot accept
  | 'task_result'               // Worker → Coordinator: analysis complete
  | 'task_error'                // Worker → Coordinator: task failed
  | 'worker_pause'              // Worker → Coordinator: pausing work
  | 'worker_resume'             // Worker → Coordinator: resuming work
  | 'coordinator_pause_worker'  // Coordinator → Worker: please pause
  | 'coordinator_resume_worker';// Coordinator → Worker: resume work

export interface BaseMessage {
  type: MessageType;
  id: string;          // uuid for this message
  from: string;        // sender peer id
  to?: string;         // target peer id (optional for broadcasts)
  timestamp: number;
}

export interface RegisterMessage extends BaseMessage {
  type: 'register';
  role: PeerRole;
  deviceInfo: {
    platform: string;  // 'android' | 'ios' | 'web'
    modelLoaded: boolean;
    modelName?: string;
    acceptingJobs?: boolean; // Whether this peer is accepting inference requests from others
    displayName?: string;     // User-friendly device name
  };
}

export interface ProviderListMessage extends BaseMessage {
  type: 'provider_list';
  providers: ProviderInfo[];
}

export interface ProviderInfo {
  peerId: string;
  modelName: string;
  platform: string;
  displayName?: string; // User-friendly device name
}

export interface ProviderStatusMessage extends BaseMessage {
  type: 'provider_status';
  metrics: {
    activeJobs: number;
    queueDepth: number;
    avgResponseTime: number; // ms
    tokensPerSec: number;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
  tokensGenerated?: number;
  durationMs?: number;
  fulfilledBy?: string;
}

export interface InferenceRequestMessage extends BaseMessage {
  type: 'inference_request';
  to: string;          // provider peer id
  requestId: string;   // used to match response
  prompt: string;
  conversationHistory?: ChatMessage[]; // Full chat context for failover
  isFailoverRequest?: boolean; // Mark as failover request
  previousTokens?: number; // Tokens already generated (for failover)
  params?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  };
}

export interface InferenceResponseMessage extends BaseMessage {
  type: 'inference_response';
  to: string;
  requestId: string;
  response: string;
  tokensGenerated: number;
  durationMs: number;
}

export interface InferenceStreamMessage extends BaseMessage {
  type: 'inference_stream';
  to: string;
  requestId: string;
  token: string;
}

export interface InferenceDoneMessage extends BaseMessage {
  type: 'inference_done';
  to: string;
  requestId: string;
  tokensGenerated: number;
  durationMs: number;
}

export interface ErrorMessage extends BaseMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PingMessage extends BaseMessage {
  type: 'ping';
}

export interface PongMessage extends BaseMessage {
  type: 'pong';
}

export interface WebRTCOfferMessage extends BaseMessage {
  type: 'webrtc_offer';
  to: string;
  sdp: string;
  encryptionKeyOffer: string; // Base64 encoded encryption key
}

export interface WebRTCAnswerMessage extends BaseMessage {
  type: 'webrtc_answer';
  to: string;
  sdp: string;
  encryptionKeyAnswer: string; // Echo back for confirmation
}

export interface WebRTCIceCandidateMessage extends BaseMessage {
  type: 'webrtc_ice_candidate';
  to: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export interface ProviderFailoverMessage extends BaseMessage {
  type: 'provider_failover';
  requestId: string;
  newProviderId: string;
  newProviderName: string;
  tokensReceived: number;
}

export interface InferenceErrorMessage extends BaseMessage {
  type: 'inference_error';
  requestId: string;
  code: string;
  message: string;
}

// ── Image Analysis Worker Protocol ───────────────────────────────────────────

export type ThermalStatus = 'nominal' | 'light' | 'moderate' | 'severe' | 'critical';

export interface WorkerRegisterMessage extends BaseMessage {
  type: 'worker_register';
  workerId: string;
  workerInfo: {
    deviceName: string;
    deviceModel: string;
    platform: 'android' | 'ios';
    osVersion: string;
    chipVendor: 'qualcomm' | 'mediatek' | 'samsung' | 'apple';
    thermalStatus: ThermalStatus;
    batteryLevel: number;
    networkType: 'wifi' | 'cellular';
    modelsLoaded: {
      face_detection: boolean;
      object_detection?: boolean;
    };
    hardwareAcceleration: Array<'qnn' | 'nnapi' | 'coreml' | 'cpu'>;
    maxConcurrentTasks: number;
    maxImageResolution: number;
  };
}

export interface WorkerRegisteredMessage extends BaseMessage {
  type: 'worker_registered';
  workerId: string;
}

export interface WorkerDeregisterMessage extends BaseMessage {
  type: 'worker_deregister';
  workerId: string;
}

export interface WorkerHeartbeatMessage extends BaseMessage {
  type: 'worker_heartbeat';
  workerId: string;
  thermalStatus: ThermalStatus;
  batteryLevel: number;
  activeTasks: number;
}

export interface TaskAssignMessage extends BaseMessage {
  type: 'task_assign';
  to: string;
  taskId: string;
  imageId: string;
  imageName: string;
  imageUrl: string;
  analysisType: 'face_detection' | 'object_detection' | 'classification';
  priority: 'low' | 'normal' | 'high';
  timeout: number;
  modelHints?: {
    preferredDetector?: string;
    minConfidence?: number;
    maxDetections?: number;
  };
}

export interface TaskAcceptMessage extends BaseMessage {
  type: 'task_accept';
  taskId: string;
  workerId: string;
  estimatedCompletionMs: number;
}

export interface TaskRejectMessage extends BaseMessage {
  type: 'task_reject';
  taskId: string;
  workerId: string;
  reason: 'overloaded' | 'low_battery' | 'thermal_warning' | 'model_not_loaded' | 'network_poor';
  retryAfterMs?: number;
}

export interface TaskResultMessage extends BaseMessage {
  type: 'task_result';
  taskId: string;
  imageId: string;
  imageName: string;
  analysisType: string;
  detectionsFound: number;
  detections: Array<{
    detectionId: string;
    bbox: { x: number; y: number; width: number; height: number };
    confidence: number;
    attributes: Record<string, any>;
  }>;
  processingTimeMs: number;
  thermalStatus: ThermalStatus;
  hardwareAccelerator: string;
  modelVersions: Record<string, string>;
  imageQuality?: {
    resolution: { width: number; height: number };
    blurScore?: number;
    brightness?: number;
  };
}

export interface TaskErrorMessage extends BaseMessage {
  type: 'task_error';
  taskId: string;
  workerId: string;
  errorCode: 'MODEL_ERROR' | 'DOWNLOAD_FAILED' | 'OUT_OF_MEMORY' | 'TIMEOUT' | 'INVALID_IMAGE';
  errorMessage: string;
  retryable: boolean;
}

export interface WorkerStatusMessage extends BaseMessage {
  type: 'worker_status';
  workerId: string;
  thermalStatus: ThermalStatus;
  batteryLevel: number;
  cpuUsagePercent: number;
  memoryUsageMb: number;
  networkType: 'wifi' | 'cellular' | 'ethernet';
  networkQuality: 'excellent' | 'good' | 'fair' | 'poor';
  activeTasks: number;
  tasksCompleted: number;
  tasksFailed: number;
  avgProcessingTimeMs: number;
  uptimeMs: number;
  availableForWork: boolean;
  maxConcurrentTasks: number;
}

export interface WorkerPauseMessage extends BaseMessage {
  type: 'worker_pause';
  workerId: string;
  reason: 'thermal' | 'battery' | 'manual';
}

export interface WorkerResumeMessage extends BaseMessage {
  type: 'worker_resume';
  workerId: string;
}

export interface CoordinatorPauseWorkerMessage extends BaseMessage {
  type: 'coordinator_pause_worker';
  to: string;
  reason: string;
}

export interface CoordinatorResumeWorkerMessage extends BaseMessage {
  type: 'coordinator_resume_worker';
  to: string;
}

export type GPTeeMessage =
  | RegisterMessage
  | ProviderListMessage
  | ProviderStatusMessage
  | InferenceRequestMessage
  | InferenceResponseMessage
  | InferenceStreamMessage
  | InferenceDoneMessage
  | ErrorMessage
  | PingMessage
  | PongMessage
  | ProviderFailoverMessage
  | InferenceErrorMessage
  | WebRTCOfferMessage
  | WebRTCAnswerMessage
  | WebRTCIceCandidateMessage
  // Image Analysis Worker Messages
  | WorkerRegisterMessage
  | WorkerRegisteredMessage
  | WorkerDeregisterMessage
  | WorkerHeartbeatMessage
  | TaskAssignMessage
  | TaskAcceptMessage
  | TaskRejectMessage
  | TaskResultMessage
  | TaskErrorMessage
  | WorkerStatusMessage
  | WorkerPauseMessage
  | WorkerResumeMessage
  | CoordinatorPauseWorkerMessage
  | CoordinatorResumeWorkerMessage;