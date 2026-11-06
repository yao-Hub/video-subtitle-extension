import type {
  AsrWorkerEvent,
  RawAsrCaptionEvent
} from '../../../packages/protocol/src/index';

// This worker only performs streaming ASR on speech frames selected by vad-worker.

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

interface ActiveSegment {
  segmentId: string;
  recognitionEpoch: number;
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
      type: 'asr.speech-start';
      recognitionEpoch: number;
      startUs: number;
    }
  | {
      type: 'asr.speech-frame';
      samples: ArrayBuffer;
      startUs: number;
      endUs: number;
    }
  | {
      type: 'asr.speech-end';
      endUs: number;
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
const PARTIAL_INTERVAL_US = 250_000;
const runtimeBase = new URL(
  'runtime/sherpa-onnx/',
  self.location.href
).href;

let recognizer: Recognizer | null = null;
let sessionId = '';
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
    recognitionEpoch: segment.recognitionEpoch,
    sessionId,
    segmentId: segment.segmentId,
    audioStartUs: segment.startedUs,
    audioEndUs: Math.max(segment.startedUs, endUs),
    text: result.text,
    processingMs: result.processingMs
  };
}

function startSegment(recognitionEpoch: number, startUs: number): void {
  if (!recognizer) {
    return;
  }
  segmentCounter += 1;
  activeSegment = {
    segmentId: `seg_${segmentCounter.toString().padStart(8, '0')}`,
    recognitionEpoch,
    stream: recognizer.createStream(),
    startedUs: startUs,
    lastVoiceUs: startUs,
    lastPartialAtUs: startUs,
    lastText: ''
  };
}

function finishSegment(endUs: number): void {
  if (!recognizer || !activeSegment) {
    return;
  }
  const segment = activeSegment;
  const result = decodeText(recognizer, segment.stream);
  if (result.text) {
    postEvent(createRawCaption(segment, 'final', endUs, result));
  }
  segment.stream.free();
  activeSegment = null;
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

  if (request.type === 'asr.speech-start') {
    startSegment(request.recognitionEpoch, request.startUs);
    return;
  }

  if (request.type === 'asr.speech-frame') {
    if (!recognizer || !activeSegment) {
      return;
    }
    const segment = activeSegment;
    segment.stream.acceptWaveform(
      SAMPLE_RATE,
      new Float32Array(request.samples)
    );
    segment.lastVoiceUs = request.endUs;
    if (request.endUs - segment.lastPartialAtUs >= PARTIAL_INTERVAL_US) {
      segment.lastPartialAtUs = request.endUs;
      const result = decodeText(recognizer, segment.stream);
      if (result.text && result.text !== segment.lastText) {
        segment.lastText = result.text;
        postEvent(createRawCaption(
          segment,
          'preview',
          request.endUs,
          result
        ));
      }
    }
    return;
  }

  if (request.type === 'asr.speech-end') {
    finishSegment(request.endUs);
    return;
  }

  if (request.type === 'asr.seek') {
    activeSegment?.stream.free();
    activeSegment = null;
    return;
  }

  if (request.type === 'asr.stop') {
    postStatus('正在生成最后一段字幕');
    finishSegment(activeSegment?.lastVoiceUs ?? 0);
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
