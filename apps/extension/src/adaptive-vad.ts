const HISTORY_LIMIT = 160;
const WARMUP_SAMPLES = 32;
const DEFAULT_POSITIVE_THRESHOLD = 0.5;
const DEFAULT_NEGATIVE_THRESHOLD = 0.35;

export interface VadDecision {
  positive: boolean;
  negative: boolean;
  positiveThreshold: number;
  negativeThreshold: number;
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * ratio))
  );
  return sorted[index] ?? 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export class AdaptiveVadGate {
  private history: number[] = [];

  reset(): void {
    this.history = [];
  }

  update(probability: number, isSpeaking: boolean): VadDecision {
    if (!isSpeaking) {
      this.history.push(probability);
      if (this.history.length > HISTORY_LIMIT) {
        this.history.shift();
      }
    }

    let positiveThreshold = DEFAULT_POSITIVE_THRESHOLD;
    let negativeThreshold = DEFAULT_NEGATIVE_THRESHOLD;
    if (this.history.length >= WARMUP_SAMPLES) {
      const noiseFloor = percentile(this.history, 0.2);
      const signalPeak = percentile(this.history, 0.9);
      const dynamicRange = Math.max(0.05, signalPeak - noiseFloor);
      positiveThreshold = clamp(
        noiseFloor + Math.max(0.22, dynamicRange * 0.55),
        0.3,
        0.85
      );
      negativeThreshold = clamp(
        noiseFloor + dynamicRange * 0.25,
        0.12,
        positiveThreshold - 0.08
      );
    }

    return {
      positive: probability >= positiveThreshold,
      negative: probability <= negativeThreshold,
      positiveThreshold,
      negativeThreshold
    };
  }
}
