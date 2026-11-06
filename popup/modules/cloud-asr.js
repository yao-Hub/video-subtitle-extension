const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'whisper-1';
const DEFAULT_TIMEOUT_MS = 45000;

function normalizeText(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function clampSample(value) {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

function pcmToWavBlob(float32Pcm, sampleRate = 16000) {
  const pcmLength = float32Pcm.length;
  const wavBuffer = new ArrayBuffer(44 + pcmLength * 2);
  const view = new DataView(wavBuffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcmLength * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, pcmLength * 2, true);

  let offset = 44;
  for (let i = 0; i < pcmLength; i += 1) {
    const sample = clampSample(float32Pcm[i]);
    view.setInt16(offset, Math.round(sample * 32767), true);
    offset += 2;
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

function parseWindow(payload, fallbackStart, fallbackEnd) {
  const defaultStart = Number(fallbackStart || 0);
  const defaultEnd = Number(fallbackEnd || defaultStart);

  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  if (!segments.length) {
    return {
      startSec: defaultStart,
      endSec: defaultEnd
    };
  }

  const first = segments[0] || {};
  const last = segments[segments.length - 1] || {};
  const startSec = Number.isFinite(Number(first.start)) ? Number(first.start) : defaultStart;
  const endSec = Number.isFinite(Number(last.end)) ? Number(last.end) : defaultEnd;

  return {
    startSec: startSec < 0 ? defaultStart : startSec,
    endSec: endSec >= startSec ? endSec : defaultEnd
  };
}

export class CloudAsrClient {
  constructor() {
    this.queue = Promise.resolve();
  }

  clearQueue() {
    this.queue = Promise.resolve();
  }

  enabled(settings) {
    if (!settings) return false;
    if (!settings.apiKey) return false;
    if (!settings.apiBase) return false;
    return true;
  }

  async transcribe(task, settings) {
    if (!task || !(task.audio instanceof Float32Array) || task.audio.length === 0) {
      return { ok: false, error: 'invalid_audio', text: '' };
    }
    if (!this.enabled(settings)) {
      return { ok: false, error: 'cloud_disabled', text: '' };
    }

    const run = async () => {
      const apiBase = String(settings.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
      const endpoint = `${apiBase}/audio/transcriptions`;
      const model = String(settings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const language = String(settings.language || 'auto').trim() || 'auto';
      const timeoutMs = Number(settings.timeoutMs || DEFAULT_TIMEOUT_MS);

      const form = new FormData();
      form.append('file', pcmToWavBlob(task.audio), `chunk-${Date.now()}.wav`);
      // Force transcription behavior on OpenAI-compatible providers that support `task`.
      form.append('task', 'transcribe');
      form.append('model', model);
      form.append('temperature', '0');
      form.append('response_format', 'verbose_json');
      if (language !== 'auto') {
        form.append('language', language);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.apiKey}`
          },
          body: form,
          signal: controller.signal
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
        }

        const payload = await response.json();
        const text = normalizeText(payload?.text);
        if (!text) {
          throw new Error('empty_text');
        }

        const windowInfo = parseWindow(payload, task.windowStart, task.windowEnd);
        return {
          ok: true,
          text,
          startSec: windowInfo.startSec,
          endSec: windowInfo.endSec,
          payload
        };
      } finally {
        clearTimeout(timeout);
      }
    };

    this.queue = this.queue.then(run, run);

    try {
      return await this.queue;
    } catch (error) {
      return {
        ok: false,
        error: error?.message || 'cloud_transcribe_failed',
        text: ''
      };
    }
  }
}
