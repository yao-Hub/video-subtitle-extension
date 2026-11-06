export interface CaptionTimeRange {
  type: 'caption.partial' | 'caption.final';
  videoStartMs: number;
  videoEndMs: number;
}

export function shouldRecognizeAtTime(
  videoTimeMs: number,
  captions: CaptionTimeRange[]
): boolean {
  return !captions.some((caption) => (
    caption.type === 'caption.final'
    && videoTimeMs >= caption.videoStartMs
    && videoTimeMs < caption.videoEndMs
  ));
}

export function getNextRecognitionBoundary(
  videoTimeMs: number,
  captions: CaptionTimeRange[]
): number | null {
  let boundary = Number.POSITIVE_INFINITY;
  for (const caption of captions) {
    if (caption.type !== 'caption.final') {
      continue;
    }
    if (
      videoTimeMs >= caption.videoStartMs
      && videoTimeMs < caption.videoEndMs
    ) {
      boundary = Math.min(boundary, caption.videoEndMs);
    } else if (videoTimeMs < caption.videoStartMs) {
      boundary = Math.min(boundary, caption.videoStartMs);
    }
  }
  return Number.isFinite(boundary) ? boundary : null;
}
