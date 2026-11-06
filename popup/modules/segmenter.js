import { MIN_SPEECH_RMS } from './config.js';
import { mergeChunksToAudio } from './utils.js';

export class Segmenter {
  constructor(resolveModeConfig) {
    this.resolveModeConfig = resolveModeConfig;
    this.recentChunks = [];
    this.recentDurationSec = 0;
    this.interimLastDispatchAudioSec = 0;
    this.segment = this.createEmptySegment();
  }

  createEmptySegment() {
    return {
      active: false,
      chunks: [],
      startAudioSec: 0,
      lastVoiceAudioSec: 0,
      lastChunkEndSec: 0
    };
  }

  reset() {
    this.recentChunks = [];
    this.recentDurationSec = 0;
    this.interimLastDispatchAudioSec = 0;
    this.segment = this.createEmptySegment();
  }

  pushChunk(chunk, modeKey, useInterim = true) {
    const mode = this.resolveModeConfig(modeKey);
    const tasks = [];

    this.pushRecentChunk(chunk, mode.recentBufferSec);

    if (chunk.rms >= MIN_SPEECH_RMS) {
      if (!this.segment.active) {
        this.createSegmentWithPreroll(chunk, mode.preRollSec);
      } else {
        this.segment.chunks.push(chunk);
        this.segment.lastVoiceAudioSec = chunk.endAudioSec;
        this.segment.lastChunkEndSec = chunk.endAudioSec;

        if (this.segmentDurationSec() >= mode.maxSegmentSec) {
          const task = this.flushSegment(mode, true);
          if (task) tasks.push(task);
        }
      }
    } else if (this.segment.active) {
      this.segment.chunks.push(chunk);
      this.segment.lastChunkEndSec = chunk.endAudioSec;
      const task = this.flushSegment(mode, false);
      if (task) tasks.push(task);
    }

    if (useInterim) {
      const interimTask = this.buildInterimTask(mode, chunk.endAudioSec);
      if (interimTask) tasks.push(interimTask);
    }

    return tasks;
  }

  flushFinal(modeKey, force = true) {
    const mode = this.resolveModeConfig(modeKey);
    return this.flushSegment(mode, force);
  }

  pushRecentChunk(chunk, maxDurationSec) {
    this.recentChunks.push(chunk);
    this.recentDurationSec += chunk.endAudioSec - chunk.startAudioSec;

    while (this.recentDurationSec > maxDurationSec && this.recentChunks.length > 1) {
      const removed = this.recentChunks.shift();
      this.recentDurationSec -= removed.endAudioSec - removed.startAudioSec;
    }
  }

  createSegmentWithPreroll(chunk, preRollSec) {
    const minKeepSec = Math.max(0, chunk.startAudioSec - preRollSec);
    const preroll = this.recentChunks.filter((it) => it.endAudioSec > minKeepSec);

    this.segment.active = true;
    this.segment.chunks = preroll.slice();

    if (!this.segment.chunks.includes(chunk)) {
      this.segment.chunks.push(chunk);
    }

    this.segment.startAudioSec = this.segment.chunks[0]?.startAudioSec || chunk.startAudioSec;
    this.segment.lastVoiceAudioSec = chunk.endAudioSec;
    this.segment.lastChunkEndSec = chunk.endAudioSec;
  }

  segmentDurationSec() {
    if (!this.segment.active || !this.segment.chunks.length) return 0;
    const first = this.segment.chunks[0];
    const last = this.segment.chunks[this.segment.chunks.length - 1];
    return Math.max(0, last.endAudioSec - first.startAudioSec);
  }

  flushSegment(mode, force) {
    if (!this.segment.active || !this.segment.chunks.length) {
      this.segment = this.createEmptySegment();
      return null;
    }

    const durationSec = this.segmentDurationSec();
    const silentTailSec = Math.max(0, this.segment.lastChunkEndSec - this.segment.lastVoiceAudioSec);

    if (!force) {
      if (durationSec < mode.minSegmentSec) return null;
      if (silentTailSec < mode.silenceHoldSec && durationSec < mode.maxSegmentSec) return null;
    }

    const totalSamples = this.segment.chunks.reduce((sum, item) => sum + item.data.length, 0);
    const voicedSamples = this.segment.chunks
      .filter((item) => item.rms >= MIN_SPEECH_RMS)
      .reduce((sum, item) => sum + item.data.length, 0);
    const voicedRatio = totalSamples > 0 ? voicedSamples / totalSamples : 0;

    let task = null;
    if (durationSec >= mode.minSegmentSec && voicedRatio >= mode.minVoicedRatio) {
      task = this.buildTask('final', this.segment.chunks);
    }

    this.segment = this.createEmptySegment();
    return task;
  }

  buildInterimTask(mode, currentAudioSec) {
    if (mode.interimWindowSec <= 0 || mode.interimStepSec <= 0 || mode.interimMinVoicedRatio <= 0) {
      return null;
    }
    if ((currentAudioSec - this.interimLastDispatchAudioSec) < mode.interimStepSec) {
      return null;
    }

    const minStartSec = Math.max(0, currentAudioSec - mode.interimWindowSec);
    const chunks = this.recentChunks.filter((it) => it.endAudioSec > minStartSec);
    if (!chunks.length) return null;

    const durationSec = Math.max(0, chunks[chunks.length - 1].endAudioSec - chunks[0].startAudioSec);
    if (durationSec < 0.75) return null;

    const totalSamples = chunks.reduce((sum, item) => sum + item.data.length, 0);
    const voicedSamples = chunks
      .filter((item) => item.rms >= MIN_SPEECH_RMS)
      .reduce((sum, item) => sum + item.data.length, 0);
    const voicedRatio = totalSamples > 0 ? voicedSamples / totalSamples : 0;
    if (voicedRatio < mode.interimMinVoicedRatio) return null;

    this.interimLastDispatchAudioSec = currentAudioSec;
    return this.buildTask('interim', chunks);
  }

  buildTask(taskKind, chunks) {
    if (!chunks.length) return null;
    return {
      taskKind,
      audio: mergeChunksToAudio(chunks),
      startAudioSec: chunks[0].startAudioSec,
      endAudioSec: chunks[chunks.length - 1].endAudioSec
    };
  }
}
