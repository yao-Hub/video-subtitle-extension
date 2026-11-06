export const ASR_SAMPLE_RATE = 16000;
export const MIN_SPEECH_RMS = 0.007;
export const MIN_TEXT_LENGTH = 2;
export const MAX_SUBTITLE_ITEMS = 180;
export const INTERIM_ITEM_ID = '__interim__';

export const MODEL_CANDIDATES = [
  { name: 'tiny', label: 'tiny（速度优先）', file: 'wasm/ggml-tiny.bin' },
  { name: 'base', label: 'base（准确优先）', file: 'wasm/ggml-base.bin' }
];

export const MODE_CONFIG = {
  live: {
    key: 'live',
    label: '实时（低延迟）',
    preRollSec: 0.22,
    recentBufferSec: 1.8,
    silenceHoldSec: 0.25,
    minSegmentSec: 0.7,
    maxSegmentSec: 2.6,
    minVoicedRatio: 0.13,
    interimWindowSec: 1.9,
    interimStepSec: 0.75,
    interimMinVoicedRatio: 0.18,
    workletBlockSize: 1024,
    fallbackBlockSize: 2048,
    timelineSyncMs: 550
  },
  accurate: {
    key: 'accurate',
    label: '准确（高延迟）',
    preRollSec: 0.55,
    recentBufferSec: 3.0,
    silenceHoldSec: 0.95,
    minSegmentSec: 2.0,
    maxSegmentSec: 11.0,
    minVoicedRatio: 0.06,
    interimWindowSec: 0,
    interimStepSec: 0,
    interimMinVoicedRatio: 0,
    workletBlockSize: 2048,
    fallbackBlockSize: 4096,
    timelineSyncMs: 800
  }
};

export const DEFAULT_MODE = 'live';
export const DEFAULT_MODEL = 'tiny';

export function resolveModeConfig(mode) {
  return MODE_CONFIG[mode] || MODE_CONFIG[DEFAULT_MODE];
}
