export interface SessionStartedMessage {
  type: 'session.started';
  sessionId: string;
  modelId: string;
}

export interface SessionStoppedMessage {
  type: 'session.stopped';
  sessionId: string;
}

export interface SessionErrorMessage {
  type: 'session.error';
  sessionId?: string;
  message: string;
  recoverable: boolean;
}

export interface SessionStatusEvent {
  type: 'session.status';
  sessionId: string;
  message: string;
}

export interface FinalCaptionEvent {
  type: 'caption.final';
  sessionId: string;
  segmentId: string;
  parentSegmentId: string;
  audioStartUs: number;
  audioEndUs: number;
  text: string;
  processingMs: number;
}

export interface CaptionPreviewPart {
  segmentId: string;
  text: string;
  audioStartUs: number;
  audioEndUs: number;
  stable: boolean;
}

export interface CaptionPreviewEvent {
  type: 'caption.preview';
  sessionId: string;
  parentSegmentId: string;
  parts: CaptionPreviewPart[];
  processingMs: number;
}

export type SessionEvent =
  | SessionStartedMessage
  | SessionStoppedMessage
  | SessionErrorMessage
  | SessionStatusEvent;

export type InferenceEvent =
  | SessionEvent
  | CaptionPreviewEvent
  | FinalCaptionEvent;

export interface RawAsrCaptionEvent {
  type: 'asr.caption';
  kind: 'preview' | 'final';
  sessionId: string;
  segmentId: string;
  audioStartUs: number;
  audioEndUs: number;
  text: string;
  processingMs: number;
}

export type AsrWorkerEvent =
  | SessionEvent
  | RawAsrCaptionEvent
  | { type: 'worker.ready' }
  | { type: 'worker.error'; error: string };

export type CaptionWorkerRequest =
  | { type: 'caption.raw'; event: RawAsrCaptionEvent }
  | { type: 'caption.flush' };

export type CaptionWorkerEvent =
  | InferenceEvent
  | { type: 'caption.ready' }
  | { type: 'caption.drained' }
  | { type: 'caption.error'; error: string };

export interface VideoState {
  hasVideo: boolean;
  currentTime: number;
}

export interface PanelContext {
  tabId: number;
  video: VideoState;
}

export interface SessionRuntimeState {
  running: boolean;
  sourceTabId: number;
  startedAtEpochMs: number;
}

export type ExtensionRequest =
  | { type: 'panel.get-context'; sourceTabId?: number }
  | {
      type: 'panel.start';
      sourceTabId: number;
    }
  | { type: 'panel.stop' }
  | { type: 'panel.get-runtime-state' }
  | { type: 'panel.get-video-state'; tabId: number }
  | { type: 'panel.jump-to-time'; tabId: number; seconds: number };

export type OffscreenRequest =
  | {
      type: 'capture.start';
      streamId: string;
    }
  | { type: 'capture.stop' }
  | { type: 'capture.seek' };

export interface BackgroundRequestMessage {
  target: 'background';
  request: ExtensionRequest;
}

export interface OffscreenRequestMessage {
  target: 'offscreen';
  request: OffscreenRequest;
}

export interface OffscreenEventMessage {
  target: 'background';
  type: 'inference.event';
  event: InferenceEvent;
}

export interface PanelEventMessage {
  target: 'panel';
  type: 'inference.event';
  event: InferenceEvent;
}

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

