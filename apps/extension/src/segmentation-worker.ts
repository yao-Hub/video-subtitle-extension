import type {
  CaptionPreviewEvent,
  FinalCaptionEvent,
  PunctuatedCaptionEvent,
  SegmentationWorkerEvent,
  SegmentationWorkerRequest
} from '../../../packages/protocol/src/index';
import { splitChineseCaption } from './sentence-segmenter';

function postEvent(event: SegmentationWorkerEvent): void {
  self.postMessage(event);
}

function createPreview(event: PunctuatedCaptionEvent): CaptionPreviewEvent {
  const parts = splitChineseCaption(
    event.text,
    event.audioStartUs,
    event.audioEndUs
  );
  return {
    type: 'caption.preview',
    recognitionEpoch: event.recognitionEpoch,
    sessionId: event.sessionId,
    parentSegmentId: event.segmentId,
    parts: parts.map((part, index) => ({
      segmentId: `${event.segmentId}_p${index + 1}`,
      text: part.text,
      audioStartUs: part.audioStartUs,
      audioEndUs: part.audioEndUs
    })),
    processingMs: event.processingMs
  };
}

function createFinals(event: PunctuatedCaptionEvent): FinalCaptionEvent[] {
  return splitChineseCaption(
    event.text,
    event.audioStartUs,
    event.audioEndUs
  ).map((part, index) => ({
    type: 'caption.final',
    recognitionEpoch: event.recognitionEpoch,
    sessionId: event.sessionId,
    segmentId: `${event.segmentId}_c${index + 1}`,
    parentSegmentId: event.segmentId,
    audioStartUs: part.audioStartUs,
    audioEndUs: part.audioEndUs,
    text: part.text,
    processingMs: event.processingMs
  }));
}

postEvent({ type: 'segmentation.ready' });
self.onmessage = (event: MessageEvent<SegmentationWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'segmentation.flush') {
      postEvent({ type: 'segmentation.drained' });
      return;
    }
    if (request.event.kind === 'preview') {
      postEvent(createPreview(request.event));
      return;
    }
    for (const finalEvent of createFinals(request.event)) {
      postEvent(finalEvent);
    }
  } catch (error) {
    postEvent({
      type: 'segmentation.error',
      error: error instanceof Error ? error.message : '字幕分句失败'
    });
  }
};
