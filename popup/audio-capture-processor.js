class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const fromOptions = options?.processorOptions?.blockSize;
    this.blockSize = Number.isFinite(fromOptions) && fromOptions > 0 ? Math.floor(fromOptions) : 2048;
    this.buffer = new Float32Array(this.blockSize);
    this.offset = 0;
  }

  pushSample(sample) {
    this.buffer[this.offset] = sample;
    this.offset += 1;

    if (this.offset >= this.blockSize) {
      const out = this.buffer;
      this.port.postMessage(out, [out.buffer]);
      this.buffer = new Float32Array(this.blockSize);
      this.offset = 0;
    }
  }

  process(inputs) {
    const input = inputs?.[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelCount = input.length;
    const frames = input[0]?.length || 0;

    for (let i = 0; i < frames; i += 1) {
      let sample = 0;
      for (let c = 0; c < channelCount; c += 1) {
        sample += input[c]?.[i] || 0;
      }
      sample /= channelCount;
      this.pushSample(sample);
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
