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
  deliverySequence?: number;
  recognitionEpoch: number;
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
}

export interface CaptionPreviewEvent {
  type: 'caption.preview';
  deliverySequence?: number;
  recognitionEpoch: number;
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
  | FinalCaptionEvent
  | RecognitionEpochEvent;

export interface RawAsrCaptionEvent {
  type: 'asr.caption';
  kind: 'preview' | 'final';
  recognitionEpoch: number;
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

export interface PunctuatedCaptionEvent {
  kind: 'preview' | 'final';
  recognitionEpoch: number;
  sessionId: string;
  segmentId: string;
  audioStartUs: number;
  audioEndUs: number;
  text: string;
  processingMs: number;
}

export type PunctuationWorkerRequest =
  | { type: 'punctuation.raw'; event: RawAsrCaptionEvent }
  | { type: 'punctuation.flush' };

export type PunctuationWorkerEvent =
  | { type: 'punctuation.ready' }
  | {
      type: 'punctuation.result';
      event: PunctuatedCaptionEvent;
    }
  | { type: 'punctuation.drained' }
  | { type: 'punctuation.error'; error: string };

export type SegmentationWorkerRequest =
  | {
      type: 'segmentation.punctuated';
      event: PunctuatedCaptionEvent;
    }
  | { type: 'segmentation.flush' };

export type SegmentationWorkerEvent =
  | { type: 'segmentation.ready' }
  | CaptionPreviewEvent
  | FinalCaptionEvent
  | { type: 'segmentation.drained' }
  | { type: 'segmentation.error'; error: string };

export type VadWorkerRequest =
  | { type: 'vad.start'; sessionId: string }
  | { type: 'audio.frame'; samples: ArrayBuffer }
  | { type: 'vad.seek' }
  | { type: 'vad.stop' };

export type VadWorkerEvent =
  | { type: 'vad.ready' }
  | { type: 'vad.speech-start'; sessionId: string; startUs: number }
  | {
      type: 'vad.speech-frame';
      sessionId: string;
      samples: ArrayBuffer;
      startUs: number;
      endUs: number;
    }
  | { type: 'vad.speech-end'; sessionId: string; endUs: number }
  | { type: 'vad.stopped'; sessionId: string }
  | { type: 'vad.error'; error: string };

export interface VideoState {
  hasVideo: boolean;
  videoId: string;
  sequence: number;
  currentTime: number;
  paused: boolean;
  playbackRate: number;
}

export interface RecognitionEpochEvent {
  type: 'recognition.epoch';
  sessionId: string;
  epoch: number;
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
  | {
      type: 'panel.jump-to-time';
      tabId: number;
      seconds: number;
    }
  | { type: 'panel.pause-recognition' }
  | { type: 'panel.resume-recognition' }
  | {
      type: 'panel.schedule-video-boundary';
      tabId: number;
      videoId: string;
      boundaryVideoTimeMs: number | null;
    };

export type OffscreenRequest =
  | {
      type: 'capture.start';
      streamId: string;
    }
  | { type: 'capture.stop' }
  | { type: 'capture.pause' }
  | { type: 'capture.resume' }
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

export interface PageVideoStateMessage {
  target: 'background';
  type: 'page.video-state';
  state: VideoState;
}

export interface PanelVideoStateMessage {
  target: 'panel';
  type: 'video.state';
  tabId: number;
  state: VideoState;
}

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

