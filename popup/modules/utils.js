import { ASR_SAMPLE_RATE } from './config.js';

export function formatTime(seconds) {
  const sec = Math.max(0, Number(seconds || 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function cleanTranscript(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^\)]*\)/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function likelyDuplicateText(text, lastAcceptedNorm, minTextLength = 2) {
  const current = normalizeText(text);
  if (!current || current.length < minTextLength) return true;
  if (!lastAcceptedNorm) return false;
  if (current === lastAcceptedNorm) return true;
  return current.length >= 5
    && lastAcceptedNorm.length >= 5
    && (current.endsWith(lastAcceptedNorm) || lastAcceptedNorm.endsWith(current));
}

export function estimateVideoSec(audioSec, offsetSec) {
  return Math.max(0, Number(audioSec || 0) + Number(offsetSec || 0));
}

export function reanchorOffset(videoCurrentSec, capturedAudioSec) {
  return Number(videoCurrentSec || 0) - Number(capturedAudioSec || 0);
}

export function nextOffset(offsetSec, audioCapturedSec, videoCurrentSec, paused) {
  const predicted = estimateVideoSec(audioCapturedSec, offsetSec);
  const drift = Number(videoCurrentSec || 0) - predicted;

  if (paused || Math.abs(drift) > 1.25) {
    return {
      offsetSec: reanchorOffset(videoCurrentSec, audioCapturedSec),
      drift,
      hardReset: true
    };
  }

  return {
    offsetSec: offsetSec + drift * 0.22,
    drift,
    hardReset: false
  };
}

export function mergeChunksToAudio(chunks) {
  const totalLength = chunks.reduce((sum, item) => sum + item.data.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const item of chunks) {
    merged.set(item.data, offset);
    offset += item.data.length;
  }
  return merged;
}

export function downsampleTo16k(input, inputRate) {
  if (!(input instanceof Float32Array) || input.length === 0) {
    return new Float32Array(0);
  }

  if (inputRate === ASR_SAMPLE_RATE) {
    return input;
  }

  const ratio = inputRate / ASR_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  let outputOffset = 0;
  let inputOffset = 0;

  while (outputOffset < outputLength) {
    const nextInputOffset = Math.round((outputOffset + 1) * ratio);
    let sum = 0;
    let count = 0;

    for (let i = inputOffset; i < nextInputOffset && i < input.length; i += 1) {
      sum += input[i];
      count += 1;
    }

    output[outputOffset] = count > 0 ? sum / count : 0;
    outputOffset += 1;
    inputOffset = nextInputOffset;
  }

  return output;
}

export function getMonoChannel(inputBuffer) {
  const channels = inputBuffer.numberOfChannels;
  const length = inputBuffer.length;

  if (channels <= 1) {
    return new Float32Array(inputBuffer.getChannelData(0));
  }

  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = inputBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i] / channels;
    }
  }
  return mono;
}

export function calcRms(data) {
  if (!(data instanceof Float32Array) || data.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / data.length);
}
