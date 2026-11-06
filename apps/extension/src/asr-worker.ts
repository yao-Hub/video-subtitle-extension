import type {
  AsrWorkerEvent,
  RawAsrCaptionEvent
} from '../../../packages/protocol/src/index';

// The ASR worker only produces raw recognition text.
// Sentence splitting and punctuation post-processing live in caption-worker.

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

interface BufferedFrame {
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
      timestampUs: number;
      samples: ArrayBuffer;
    }
  | { type: 'asr.stop' }
  | { type: 'asr.seek' };

declare function importScripts(...urls: string[]): void;
declare function createOnlineRecognizer(
  module: WorkerModule,
  config: OnlineRecognizerConfig
): Recognizer;

const MODEL_ID = 'streaming-zipformer-bilingual-zh-en-2023-02-20';
const SAMPLE_RATE = 16_000;
const FRAME_US = 20_000;
const PRE_ROLL_US = 300_000;
const SILENCE_END_US = 650_000;
const MAX_SEGMENT_US = 12_000_000;
const PARTIAL_INTERVAL_US = 250_000;
const SPEECH_RMS_THRESHOLD = 0.008;
const SPEECH_START_FRAMES = 3;
const runtimeBase = new URL('runtime/sherpa-onnx/', self.location.href).href;

let recognizer: Recognizer | null = null;
let sessionId = '';
const recentFrames: BufferedFrame[] = [];
let speechStreak = 0;
let silenceUs = 0;
let segmentCounter = 0;
let activeSegment: ActiveSegment | null = null;

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
  postEvent({ type: 'worker.ready' });
  postStatus('中文识别引擎已就绪');
}

const workerModule: WorkerModule = {
  locateFile: (fileName) => new URL(fileName, runtimeBase).toString(),
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

try {
  importScripts(
    new URL('sherpa-onnx-asr.js', runtimeBase).toString(),
    new URL('sherpa-onnx-wasm-main-asr.js', runtimeBase).toString()
  );
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
  for (const frame of recentFrames) {
    stream.acceptWaveform(SAMPLE_RATE, frame.samples);
  }
  activeSegment = {
    segmentId: `seg_${segmentCounter.toString().padStart(8, '0')}`,
    stream,
    startedUs: recentFrames[0]!.startUs,
    lastVoiceUs: endUs,
    lastPartialAtUs: endUs,
    lastText: ''
  };
  recentFrames.length = 0;
  speechStreak = 0;
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
  recentFrames.length = 0;
  speechStreak = 0;
  silenceUs = 0;
}

function pushAudioFrame(
  request: Extract<WorkerRequest, { type: 'audio.frame' }>
): void {
  if (!sessionId || !recognizer || !request.samples.byteLength) {
    return;
  }
  const activeRecognizer = recognizer;

  const pcm = new Int16Array(request.samples);
  const samples = new Float32Array(pcm.length);
  let sumSquares = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = (pcm[index] ?? 0) / 32768;
    samples[index] = sample;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  const isSpeech = rms >= SPEECH_RMS_THRESHOLD;
  const endUs = request.timestampUs + FRAME_US;

  if (!activeSegment) {
    recentFrames.push({
      samples,
      startUs: request.timestampUs,
      endUs
    });
    while (
      recentFrames.length > 1
      && endUs - (recentFrames[0]?.startUs ?? endUs) > PRE_ROLL_US
    ) {
      recentFrames.shift();
    }
    speechStreak = isSpeech ? speechStreak + 1 : 0;
    if (speechStreak >= SPEECH_START_FRAMES) {
      startSegment(activeRecognizer, endUs);
    }
    return;
  }

  const segment = activeSegment;
  segment.stream.acceptWaveform(SAMPLE_RATE, samples);
  if (isSpeech) {
    segment.lastVoiceUs = endUs;
    silenceUs = 0;
  } else {
    silenceUs += FRAME_US;
  }

  if (
    isSpeech
    && endUs - segment.lastPartialAtUs >= PARTIAL_INTERVAL_US
  ) {
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

function handleWorkerRequest(request: WorkerRequest): void {
  if (request.type === 'asr.start') {
    sessionId = request.sessionId;
    postEvent({
      type: 'session.started',
      sessionId,
      modelId: MODEL_ID
    });
    postStatus(recognizer ? '中文识别引擎已就绪' : '正在加载中文识别模型');
    return;
  }

  if (request.type === 'audio.frame') {
    pushAudioFrame(request);
    return;
  }

  if (request.type === 'asr.seek') {
    activeSegment?.stream.free();
    activeSegment = null;
    recentFrames.length = 0;
    speechStreak = 0;
    silenceUs = 0;
    return;
  }

  if (request.type === 'asr.stop') {
    postStatus('正在生成最后一段字幕');
    if (activeSegment && recognizer) {
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
  handleWorkerRequest(event.data);
};
