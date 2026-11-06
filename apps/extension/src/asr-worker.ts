import type {
  AsrWorkerEvent,
  RawAsrCaptionEvent
} from '../../../packages/protocol/src/index';

// The ASR worker owns speech detection and raw recognition only.
// Punctuation and sentence splitting stay in caption-worker.

interface RecognizerResult {
  text?: string;
}

interface RecognizerStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
}

interface Recognizer {
  createStream(): RecognizerStream;
  isReady(stream: RecognizerStream): boolean;
  decode(stream: RecognizerStream): void;
  getResult(stream: RecognizerStream): RecognizerResult;
}

interface WorkerModule {
  locateFile?: (path: string) => string;
  setStatus?: (status: string) => void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  onRuntimeInitialized?: () => void;
}

interface OnlineRecognizerConfig {
  featConfig: {
    sampleRate: number;
    featureDim: number;
  };
  modelConfig: {
    transducer: {
      encoder: string;
      decoder: string;
      joiner: string;
    };
    tokens: string;
    numThreads: number;
    provider: string;
    debug: number;
    modelType: string;
    modelingUnit: string;
    bpeVocab: string;
  };
  decodingMethod: string;
  maxActivePaths: number;
  enableEndpoint: number;
  rule1MinTrailingSilence: number;
  rule2MinTrailingSilence: number;
  rule3MinUtteranceLength: number;
}

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

interface ActiveSegment {
  segmentId: string;
  stream: RecognizerStream;
  startedUs: number;
  lastVoiceUs: number;
  lastPartialAtUs: number;
  lastText: string;
}

type WorkerRequest =
  | {
      type: 'asr.start';
      sessionId: string;
    }
  | {
      type: 'audio.frame';
      samples: ArrayBuffer;
    }
  | { type: 'asr.stop' }
  | { type: 'asr.seek' };

declare function importScripts(...urls: string[]): void;
declare function createOnlineRecognizer(
  module: WorkerModule,
  config: OnlineRecognizerConfig
): Recognizer;
declare const ort: OrtRuntime & { Tensor: VadTensorConstructor };

const MODEL_ID = 'streaming-zipformer-bilingual-zh-en-2023-02-20';
const SAMPLE_RATE = 16_000;
const VAD_MODEL_ID = 'silero-vad-v5';
const VAD_WINDOW_SAMPLES = 512;
const VAD_CONTEXT_SAMPLES = 64;
const VAD_BLOCK_US = 32_000;
const VAD_POSITIVE_THRESHOLD = 0.5;
const VAD_NEGATIVE_THRESHOLD = 0.35;
const VAD_START_BLOCKS = 2;
const PRE_ROLL_US = 300_000;
const SILENCE_END_US = 650_000;
const MAX_SEGMENT_US = 12_000_000;
const PARTIAL_INTERVAL_US = 250_000;
const sherpaRuntimeBase = new URL('runtime/sherpa-onnx/', self.location.href).href;
const ortRuntimeBase = new URL('runtime/onnxruntime-web/', self.location.href).href;
const vadRuntimeBase = new URL('runtime/vad/', self.location.href).href;

let recognizer: Recognizer | null = null;
let vadSession: OrtSession | null = null;
let vadState: OrtTensor | null = null;
let vadSampleRate: OrtTensor | null = null;
let vadContext = new Float32Array(VAD_CONTEXT_SAMPLES);
let vadInputBuffer = new Float32Array(0);
let vadSamplesProcessed = 0;
let asrReady = false;
let vadReady = false;
let readyPosted = false;
let sessionId = '';
const recentBlocks: BufferedBlock[] = [];
let speechBlockStreak = 0;
let silenceUs = 0;
let segmentCounter = 0;
let activeSegment: ActiveSegment | null = null;
let requestQueue = Promise.resolve();

function postEvent(event: AsrWorkerEvent): void {
  self.postMessage(event);
}

function postStatus(message: string): void {
  if (!sessionId) {
    return;
  }
  postEvent({
    type: 'session.status',
    sessionId,
    message
  });
}

function postReadyIfAvailable(): void {
  if (!asrReady || !vadReady || readyPosted) {
    return;
  }
  readyPosted = true;
  postEvent({ type: 'worker.ready' });
  postStatus('本地人声检测与中文识别引擎已就绪');
}

function createRecognizer(): void {
  recognizer = createOnlineRecognizer(workerModule, {
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: 80
    },
    modelConfig: {
      transducer: {
        encoder: './encoder.onnx',
        decoder: './decoder.onnx',
        joiner: './joiner.onnx'
      },
      tokens: './tokens.txt',
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: '',
      modelingUnit: 'cjkchar',
      bpeVocab: ''
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: 0,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20
  });
  asrReady = true;
  postReadyIfAvailable();
}

const workerModule: WorkerModule = {
  locateFile: (fileName) => new URL(fileName, sherpaRuntimeBase).toString(),
  setStatus: (status) => {
    if (status && status !== 'Running...') {
      postStatus(status);
    }
  },
  print: () => undefined,
  printErr: (text) => {
    if (/error|failed|abort/i.test(text)) {
      console.error(text);
    }
  },
  onRuntimeInitialized: createRecognizer
};

(self as typeof self & { Module: WorkerModule }).Module = workerModule;

function resetVadStreamState(): void {
  vadContext = new Float32Array(VAD_CONTEXT_SAMPLES);
  vadState?.dispose?.();
  vadState = null;
  if (vadSession) {
    vadState = new ort.Tensor(
      'float32',
      new Float32Array(2 * 1 * 128),
      [2, 1, 128]
    );
  }
}

async function loadVadModel(): Promise<void> {
  importScripts(new URL('ort.wasm.min.js', ortRuntimeBase).toString());
  ort.env.logLevel = 'error';
  ort.env.wasm.wasmPaths = ortRuntimeBase;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.simd = true;

  const response = await fetch(
    new URL('silero_vad_v5.onnx', vadRuntimeBase)
  );
  if (!response.ok) {
    throw new Error('人声检测模型加载失败');
  }
  vadSession = await ort.InferenceSession.create(
    await response.arrayBuffer(),
    { executionProviders: ['wasm'] }
  );
  vadSampleRate = new ort.Tensor(
    'int64',
    BigInt64Array.from([BigInt(SAMPLE_RATE)]),
    [1]
  );
  resetVadStreamState();
  vadReady = true;
  postReadyIfAvailable();
}

try {
  importScripts(
    new URL('sherpa-onnx-asr.js', sherpaRuntimeBase).toString(),
    new URL('sherpa-onnx-wasm-main-asr.js', sherpaRuntimeBase).toString()
  );
  void loadVadModel().catch((error) => {
    postEvent({
      type: 'worker.error',
      error: error instanceof Error ? error.message : '人声检测模型加载失败'
    });
  });
} catch (error) {
  postEvent({
    type: 'worker.error',
    error: error instanceof Error ? error.message : '识别运行时加载失败'
  });
}

function decodeText(
  activeRecognizer: Recognizer,
  stream: RecognizerStream
): { text: string; processingMs: number } {
  const started = performance.now();
  while (activeRecognizer.isReady(stream)) {
    activeRecognizer.decode(stream);
  }
  const result = activeRecognizer.getResult(stream);
  return {
    text: String(result.text || '').trim(),
    processingMs: performance.now() - started
  };
}

function createRawCaption(
  segment: ActiveSegment,
  kind: 'preview' | 'final',
  endUs: number,
  result: { text: string; processingMs: number }
): RawAsrCaptionEvent {
  return {
    type: 'asr.caption',
    kind,
    sessionId,
    segmentId: segment.segmentId,
    audioStartUs: segment.startedUs,
    audioEndUs: Math.max(segment.startedUs, endUs),
    text: result.text,
    processingMs: result.processingMs
  };
}

function startSegment(activeRecognizer: Recognizer, endUs: number): void {
  segmentCounter += 1;
  const stream = activeRecognizer.createStream();
  for (const block of recentBlocks) {
    stream.acceptWaveform(SAMPLE_RATE, block.samples);
  }
  activeSegment = {
    segmentId: `seg_${segmentCounter.toString().padStart(8, '0')}`,
    stream,
    startedUs: recentBlocks[0]!.startUs,
    lastVoiceUs: endUs,
    lastPartialAtUs: endUs,
    lastText: ''
  };
  speechBlockStreak = 0;
  silenceUs = 0;
}

function finishSegment(
  activeRecognizer: Recognizer,
  segment: ActiveSegment,
  endUs: number
): void {
  const result = decodeText(activeRecognizer, segment.stream);
  if (result.text) {
    postEvent(createRawCaption(segment, 'final', endUs, result));
  }
  segment.stream.free();
  activeSegment = null;
  speechBlockStreak = 0;
  silenceUs = 0;
}

async function detectSpeech(block: Float32Array): Promise<number> {
  if (!vadSession || !vadState || !vadSampleRate) {
    throw new Error('人声检测模型尚未就绪');
  }
  const inputWithContext = new Float32Array(
    VAD_CONTEXT_SAMPLES + VAD_WINDOW_SAMPLES
  );
  inputWithContext.set(vadContext, 0);
  inputWithContext.set(block, VAD_CONTEXT_SAMPLES);
  vadContext = block.slice(-VAD_CONTEXT_SAMPLES);

  const previousState = vadState;
  const output = await vadSession.run({
    input: new ort.Tensor('float32', inputWithContext, [
      1,
      inputWithContext.length
    ]),
    state: previousState,
    sr: vadSampleRate
  });
  const nextState = output.stateN;
  const probability = output.output?.data[0];
  if (!nextState || typeof probability !== 'number') {
    throw new Error('人声检测模型返回无效结果');
  }
  vadState = nextState;
  previousState.dispose?.();
  return probability;
}

async function processAudioBlock(
  activeRecognizer: Recognizer,
  samples: Float32Array
): Promise<void> {
  const startUs = Math.round(
    vadSamplesProcessed * 1_000_000 / SAMPLE_RATE
  );
  vadSamplesProcessed += samples.length;
  const endUs = startUs + VAD_BLOCK_US;
  const speechProbability = await detectSpeech(samples);
  const isPositive = speechProbability >= VAD_POSITIVE_THRESHOLD;
  const isNegative = speechProbability <= VAD_NEGATIVE_THRESHOLD;
  const block: BufferedBlock = { samples, startUs, endUs };

  recentBlocks.push(block);
  while (
    recentBlocks.length > 1
    && endUs - (recentBlocks[0]?.startUs ?? endUs) > PRE_ROLL_US
  ) {
    recentBlocks.shift();
  }

  if (!activeSegment) {
    speechBlockStreak = isPositive ? speechBlockStreak + 1 : 0;
    if (speechBlockStreak >= VAD_START_BLOCKS) {
      startSegment(activeRecognizer, endUs);
    }
    return;
  }

  const segment = activeSegment;
  segment.stream.acceptWaveform(SAMPLE_RATE, samples);
  if (isPositive) {
    segment.lastVoiceUs = endUs;
    silenceUs = 0;
  } else if (isNegative) {
    silenceUs += VAD_BLOCK_US;
  }

  if (endUs - segment.lastPartialAtUs >= PARTIAL_INTERVAL_US) {
    segment.lastPartialAtUs = endUs;
    const result = decodeText(activeRecognizer, segment.stream);
    if (result.text && result.text !== segment.lastText) {
      segment.lastText = result.text;
      postEvent(createRawCaption(segment, 'preview', endUs, result));
    }
  }

  if (
    silenceUs >= SILENCE_END_US
    || endUs - segment.startedUs >= MAX_SEGMENT_US
  ) {
    finishSegment(activeRecognizer, segment, segment.lastVoiceUs);
  }
}

async function pushAudioFrame(
  request: Extract<WorkerRequest, { type: 'audio.frame' }>
): Promise<void> {
  if (!sessionId || !recognizer || !request.samples.byteLength) {
    return;
  }
  const activeRecognizer = recognizer;
  const pcm = new Int16Array(request.samples);
  const samples = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    samples[index] = (pcm[index] ?? 0) / 32768;
  }

  const merged = new Float32Array(vadInputBuffer.length + samples.length);
  merged.set(vadInputBuffer);
  merged.set(samples, vadInputBuffer.length);
  vadInputBuffer = merged;

  while (vadInputBuffer.length >= VAD_WINDOW_SAMPLES) {
    const block = vadInputBuffer.slice(0, VAD_WINDOW_SAMPLES);
    vadInputBuffer = vadInputBuffer.slice(VAD_WINDOW_SAMPLES);
    await processAudioBlock(activeRecognizer, block);
  }
}

async function handleWorkerRequest(request: WorkerRequest): Promise<void> {
  if (request.type === 'asr.start') {
    sessionId = request.sessionId;
    vadInputBuffer = new Float32Array(0);
    vadSamplesProcessed = 0;
    recentBlocks.length = 0;
    speechBlockStreak = 0;
    silenceUs = 0;
    resetVadStreamState();
    postEvent({
      type: 'session.started',
      sessionId,
      modelId: `${MODEL_ID}+${VAD_MODEL_ID}`
    });
    postStatus(
      asrReady && vadReady
        ? '本地人声检测与中文识别引擎已就绪'
        : '正在加载本地人声与识别模型'
    );
    return;
  }

  if (request.type === 'audio.frame') {
    await pushAudioFrame(request);
    return;
  }

  if (request.type === 'asr.seek') {
    activeSegment?.stream.free();
    activeSegment = null;
    recentBlocks.length = 0;
    vadInputBuffer = new Float32Array(0);
    speechBlockStreak = 0;
    silenceUs = 0;
    resetVadStreamState();
    return;
  }

  if (request.type === 'asr.stop') {
    postStatus('正在生成最后一段字幕');
    if (activeSegment && recognizer) {
      if (vadInputBuffer.length) {
        activeSegment.stream.acceptWaveform(SAMPLE_RATE, vadInputBuffer);
      }
      finishSegment(recognizer, activeSegment, activeSegment.lastVoiceUs);
    }
    postEvent({
      type: 'session.stopped',
      sessionId
    });
    sessionId = '';
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  requestQueue = requestQueue
    .then(() => handleWorkerRequest(event.data))
    .catch((error) => {
      postEvent({
        type: 'session.error',
        sessionId,
        message: error instanceof Error ? error.message : '语音识别失败',
        recoverable: false
      });
    });
};
