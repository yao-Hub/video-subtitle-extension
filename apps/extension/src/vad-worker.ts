import type {
  VadWorkerEvent,
  VadWorkerRequest
} from '../../../packages/protocol/src/index';
import { AdaptiveVadGate } from './adaptive-vad';

interface OrtTensor {
  readonly data: Float32Array | BigInt64Array;
  dispose?: () => void;
}

interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

interface OrtRuntime {
  env: {
    logLevel: string;
    wasm: {
      numThreads: number;
      proxy: boolean;
      simd: boolean;
      wasmPaths: string;
    };
  };
  InferenceSession: {
    create(
      model: ArrayBuffer,
      options: { executionProviders: string[] }
    ): Promise<OrtSession>;
  };
  Tensor: new (
    type: 'float32',
    data: Float32Array,
    dims: number[]
  ) => OrtTensor;
}

interface VadTensorConstructor {
  new (
    type: 'int64',
    data: BigInt64Array,
    dims: number[]
  ): OrtTensor;
}

interface BufferedBlock {
  samples: Float32Array;
  startUs: number;
  endUs: number;
}

declare function importScripts(...urls: string[]): void;
declare const ort: OrtRuntime & { Tensor: VadTensorConstructor };

const SAMPLE_RATE = 16_000;
const VAD_WINDOW_SAMPLES = 512;
const VAD_CONTEXT_SAMPLES = 64;
const VAD_BLOCK_US = 32_000;
const VAD_START_BLOCKS = 2;
const PRE_ROLL_US = 300_000;
const SILENCE_END_US = 650_000;
const MAX_SEGMENT_US = 12_000_000;
const ortRuntimeBase = new URL(
  'runtime/onnxruntime-web/',
  self.location.href
).href;
const modelRuntimeBase = new URL('runtime/vad/', self.location.href).href;

let sessionId = '';
let session: OrtSession | null = null;
let state: OrtTensor | null = null;
let sampleRate: OrtTensor | null = null;
let context = new Float32Array(VAD_CONTEXT_SAMPLES);
let inputBuffer = new Float32Array(0);
let samplesProcessed = 0;
let isSpeaking = false;
let activeStartUs = 0;
let lastVoiceUs = 0;
let silenceUs = 0;
let speechBlockStreak = 0;
const recentBlocks: BufferedBlock[] = [];
const adaptiveGate = new AdaptiveVadGate();
let requestQueue = Promise.resolve();

function postEvent(event: VadWorkerEvent): void {
  self.postMessage(event);
}

function resetModelState(): void {
  context = new Float32Array(VAD_CONTEXT_SAMPLES);
  state?.dispose?.();
  state = null;
  if (session) {
    state = new ort.Tensor(
      'float32',
      new Float32Array(2 * 1 * 128),
      [2, 1, 128]
    );
  }
}

function resetStreamState(): void {
  inputBuffer = new Float32Array(0);
  recentBlocks.length = 0;
  isSpeaking = false;
  activeStartUs = 0;
  lastVoiceUs = 0;
  silenceUs = 0;
  speechBlockStreak = 0;
  adaptiveGate.reset();
  resetModelState();
}

async function loadModel(): Promise<void> {
  importScripts(new URL('ort.wasm.min.js', ortRuntimeBase).toString());
  ort.env.logLevel = 'error';
  ort.env.wasm.wasmPaths = ortRuntimeBase;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.simd = true;

  const response = await fetch(
    new URL('silero_vad_v5.onnx', modelRuntimeBase)
  );
  if (!response.ok) {
    throw new Error('人声检测模型加载失败');
  }
  session = await ort.InferenceSession.create(
    await response.arrayBuffer(),
    { executionProviders: ['wasm'] }
  );
  sampleRate = new ort.Tensor(
    'int64',
    BigInt64Array.from([BigInt(SAMPLE_RATE)]),
    [1]
  );
  resetModelState();
  postEvent({ type: 'vad.ready' });
}

async function detectSpeech(samples: Float32Array): Promise<number> {
  if (!session || !state || !sampleRate) {
    throw new Error('人声检测模型尚未就绪');
  }
  const inputWithContext = new Float32Array(
    VAD_CONTEXT_SAMPLES + VAD_WINDOW_SAMPLES
  );
  inputWithContext.set(context, 0);
  inputWithContext.set(samples, VAD_CONTEXT_SAMPLES);
  context = samples.slice(-VAD_CONTEXT_SAMPLES);

  const previousState = state;
  const output = await session.run({
    input: new ort.Tensor('float32', inputWithContext, [
      1,
      inputWithContext.length
    ]),
    state: previousState,
    sr: sampleRate
  });
  const nextState = output.stateN;
  const probability = output.output?.data[0];
  if (!nextState || typeof probability !== 'number') {
    throw new Error('人声检测模型返回无效结果');
  }
  state = nextState;
  previousState.dispose?.();
  return probability;
}

function emitSpeechFrame(block: BufferedBlock): void {
  const samples = block.samples.slice();
  postEvent({
    type: 'vad.speech-frame',
    sessionId,
    samples: samples.buffer,
    startUs: block.startUs,
    endUs: block.endUs
  });
}

function endSpeech(): void {
  postEvent({
    type: 'vad.speech-end',
    sessionId,
    endUs: lastVoiceUs
  });
  while (
    recentBlocks.length
    && (recentBlocks[0]?.endUs ?? Number.POSITIVE_INFINITY) <= lastVoiceUs
  ) {
    recentBlocks.shift();
  }
  isSpeaking = false;
  resetActiveSpeechState();
}

function resetActiveSpeechState(): void {
  activeStartUs = 0;
  lastVoiceUs = 0;
  silenceUs = 0;
  speechBlockStreak = 0;
}

async function processBlock(samples: Float32Array): Promise<void> {
  const startUs = Math.round(samplesProcessed * 1_000_000 / SAMPLE_RATE);
  samplesProcessed += samples.length;
  const endUs = startUs + VAD_BLOCK_US;
  const probability = await detectSpeech(samples);
  const decision = adaptiveGate.update(probability, isSpeaking);
  const block: BufferedBlock = { samples, startUs, endUs };

  recentBlocks.push(block);
  while (
    recentBlocks.length > 1
    && endUs - (recentBlocks[0]?.startUs ?? endUs) > PRE_ROLL_US
  ) {
    recentBlocks.shift();
  }

  if (!isSpeaking) {
    speechBlockStreak = decision.positive ? speechBlockStreak + 1 : 0;
    if (speechBlockStreak < VAD_START_BLOCKS) {
      return;
    }
    isSpeaking = true;
    activeStartUs = recentBlocks[0]!.startUs;
    lastVoiceUs = endUs;
    postEvent({
      type: 'vad.speech-start',
      sessionId,
      startUs: activeStartUs
    });
    for (const recentBlock of recentBlocks) {
      emitSpeechFrame(recentBlock);
    }
    return;
  }

  emitSpeechFrame(block);
  if (decision.positive) {
    lastVoiceUs = endUs;
    silenceUs = 0;
  } else if (decision.negative) {
    silenceUs += VAD_BLOCK_US;
  }

  if (
    silenceUs >= SILENCE_END_US
    || endUs - activeStartUs >= MAX_SEGMENT_US
  ) {
    endSpeech();
  }
}

async function pushAudioFrame(
  request: Extract<VadWorkerRequest, { type: 'audio.frame' }>
): Promise<void> {
  if (!sessionId || !session || !request.samples.byteLength) {
    return;
  }
  const pcm = new Int16Array(request.samples);
  const samples = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    samples[index] = (pcm[index] ?? 0) / 32768;
  }

  const merged = new Float32Array(inputBuffer.length + samples.length);
  merged.set(inputBuffer);
  merged.set(samples, inputBuffer.length);
  inputBuffer = merged;

  while (inputBuffer.length >= VAD_WINDOW_SAMPLES) {
    const block = inputBuffer.slice(0, VAD_WINDOW_SAMPLES);
    inputBuffer = inputBuffer.slice(VAD_WINDOW_SAMPLES);
    await processBlock(block);
  }
}

async function handleRequest(request: VadWorkerRequest): Promise<void> {
  if (request.type === 'vad.start') {
    sessionId = request.sessionId;
    samplesProcessed = 0;
    resetStreamState();
    return;
  }

  if (request.type === 'audio.frame') {
    await pushAudioFrame(request);
    return;
  }

  if (request.type === 'vad.seek') {
    resetStreamState();
    return;
  }

  if (isSpeaking && inputBuffer.length) {
    const startUs = Math.round(
      samplesProcessed * 1_000_000 / SAMPLE_RATE
    );
    emitSpeechFrame({
      samples: inputBuffer,
      startUs,
      endUs: startUs + VAD_BLOCK_US
    });
    inputBuffer = new Float32Array(0);
  }
  if (isSpeaking) {
    endSpeech();
  }
  postEvent({ type: 'vad.stopped', sessionId });
  sessionId = '';
}

void loadModel().catch((error) => {
  postEvent({
    type: 'vad.error',
    error: error instanceof Error ? error.message : '人声检测模型加载失败'
  });
});

self.onmessage = (event: MessageEvent<VadWorkerRequest>) => {
  requestQueue = requestQueue
    .then(() => handleRequest(event.data))
    .catch((error) => {
      postEvent({
        type: 'vad.error',
        error: error instanceof Error ? error.message : '人声检测失败'
      });
    });
};
