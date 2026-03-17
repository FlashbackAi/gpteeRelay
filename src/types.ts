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
  | 'webrtc_ice_candidate'; // WebRTC signaling: ICE candidate

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
  | WebRTCIceCandidateMessage;