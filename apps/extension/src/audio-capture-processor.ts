declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void;

const TARGET_SAMPLE_RATE = 16_000;
const TARGET_FRAME_SAMPLES = 320;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly sourceStep = sampleRate / TARGET_SAMPLE_RATE;
  private readonly pcm = new Int16Array(TARGET_FRAME_SAMPLES);
  private pcmOffset = 0;
  private sourceOffset = 0;
  private nextSampleOffset = this.sourceStep;
  private sampleSum = 0;
  private sampleCount = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const firstChannel = input?.[0];
    if (!input?.length || !firstChannel?.length) {
      return true;
    }

    for (let frame = 0; frame < firstChannel.length; frame += 1) {
      let mixed = 0;
      for (const channel of input) {
        mixed += channel[frame] || 0;
      }
      mixed /= input.length;

      this.sampleSum += mixed;
      this.sampleCount += 1;
      this.sourceOffset += 1;

      while (this.sourceOffset >= this.nextSampleOffset) {
        const downsampled = this.sampleSum / Math.max(1, this.sampleCount);
        const clamped = Math.max(-1, Math.min(1, downsampled));
        this.pcm[this.pcmOffset] = clamped < 0
          ? Math.round(clamped * 32768)
          : Math.round(clamped * 32767);
        this.pcmOffset += 1;
        this.sampleSum = 0;
        this.sampleCount = 0;
        this.nextSampleOffset += this.sourceStep;

        if (this.pcmOffset === TARGET_FRAME_SAMPLES) {
          const output = this.pcm.slice();
          this.port.postMessage(output.buffer, [output.buffer]);
          this.pcmOffset = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);

