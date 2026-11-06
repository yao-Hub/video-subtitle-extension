import type {
  PunctuatedCaptionEvent,
  PunctuationWorkerEvent,
  PunctuationWorkerRequest,
  RawAsrCaptionEvent
} from '../../../packages/protocol/src/index';
import {
  applyPunctuation,
  PUNCTUATION_LABELS,
  tokenizePunctuationText
} from './punctuation-engine';

interface OrtTensor {
  readonly data: Float32Array | Int32Array;
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
    type: 'int32',
    data: Int32Array,
    dims: number[]
  ) => OrtTensor;
}

declare const ort: OrtRuntime;
declare function importScripts(...urls: string[]): void;

const puncRuntimeBase = new URL('runtime/ct-punc/', self.location.href).href;
const ortRuntimeBase = new URL(
  'runtime/onnxruntime-web/',
  self.location.href
).href;

let punctuationSession: OrtSession | null = null;
let punctuationTokenIds: Map<string, number> | null = null;
let punctuationUnknownId = 0;

function postEvent(event: PunctuationWorkerEvent): void {
  self.postMessage(event);
}

async function loadPunctuationModel(): Promise<void> {
  importScripts(new URL('ort.wasm.min.js', ortRuntimeBase).toString());
  ort.env.logLevel = 'error';
  ort.env.wasm.wasmPaths = ortRuntimeBase;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.simd = true;

  const [modelResponse, tokensResponse] = await Promise.all([
    fetch(new URL('model.int8.onnx', puncRuntimeBase)),
    fetch(new URL('tokens.json', puncRuntimeBase))
  ]);
  if (!modelResponse.ok || !tokensResponse.ok) {
    throw new Error('中文标点模型加载失败');
  }

  const [model, tokens] = await Promise.all([
    modelResponse.arrayBuffer(),
    tokensResponse.json() as Promise<string[]>
  ]);
  punctuationTokenIds = new Map(
    tokens.map((token, index) => [token, index])
  );
  punctuationUnknownId = punctuationTokenIds.get('<unk>') ?? 0;
  punctuationSession = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm']
  });
}

async function addPunctuation(text: string): Promise<string> {
  if (!punctuationSession || !punctuationTokenIds || !text.trim()) {
    return text;
  }

  const words = tokenizePunctuationText(text);
  if (!words.length || words.length > 200) {
    return text;
  }

  const tokenIds = Int32Array.from(
    words.map((word) => punctuationTokenIds!.get(word) ?? punctuationUnknownId)
  );
  let output: Record<string, OrtTensor>;
  try {
    output = await punctuationSession.run({
      inputs: new ort.Tensor('int32', tokenIds, [1, tokenIds.length]),
      text_lengths: new ort.Tensor(
        'int32',
        Int32Array.from([tokenIds.length]),
        [1]
      )
    });
  } catch (error) {
    console.error('Punctuation inference failed; using raw ASR text', error);
    return text;
  }

  const logits = output.logits?.data;
  if (!(logits instanceof Float32Array)) {
    return text;
  }

  const predicted: number[] = [];
  for (let index = 0; index < words.length; index += 1) {
    let bestClass = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (
      let classIndex = 0;
      classIndex < PUNCTUATION_LABELS.length;
      classIndex += 1
    ) {
      const score = logits[index * PUNCTUATION_LABELS.length + classIndex];
      if (score !== undefined && score > bestScore) {
        bestScore = score;
        bestClass = classIndex;
      }
    }
    predicted.push(bestClass);
  }
  return applyPunctuation(words, predicted);
}

async function initialize(): Promise<void> {
  try {
    await loadPunctuationModel();
  } catch (error) {
    console.error('Failed to initialize punctuation model', error);
    postEvent({
      type: 'punctuation.error',
      error: error instanceof Error ? error.message : '中文标点模型加载失败'
    });
  }
  postEvent({ type: 'punctuation.ready' });
}

async function punctuate(
  event: RawAsrCaptionEvent
): Promise<PunctuatedCaptionEvent> {
  return {
    kind: event.kind,
    recognitionEpoch: event.recognitionEpoch,
    sessionId: event.sessionId,
    segmentId: event.segmentId,
    audioStartUs: event.audioStartUs,
    audioEndUs: event.audioEndUs,
    text: await addPunctuation(event.text),
    processingMs: event.processingMs
  };
}

const pendingRequests: PunctuationWorkerRequest[] = [];
let processing = false;

async function processRequests(): Promise<void> {
  processing = true;
  try {
    while (pendingRequests.length) {
      const request = pendingRequests.shift()!;
      try {
        if (request.type === 'punctuation.raw') {
          postEvent({
            type: 'punctuation.result',
            event: await punctuate(request.event)
          });
        } else {
          postEvent({ type: 'punctuation.drained' });
        }
      } catch (error) {
        postEvent({
          type: 'punctuation.error',
          error: error instanceof Error ? error.message : '标点恢复失败'
        });
      }
    }
  } finally {
    processing = false;
  }
}

function enqueue(request: PunctuationWorkerRequest): void {
  if (
    request.type === 'punctuation.raw'
    && request.event.kind === 'preview'
  ) {
    const previous = pendingRequests.at(-1);
    if (
      previous?.type === 'punctuation.raw'
      && previous.event.kind === 'preview'
    ) {
      pendingRequests[pendingRequests.length - 1] = request;
    } else {
      pendingRequests.push(request);
    }
  } else if (request.type === 'punctuation.raw') {
    for (let index = pendingRequests.length - 1; index >= 0; index -= 1) {
      const pending = pendingRequests[index];
      if (
        pending?.type === 'punctuation.raw'
        && pending.event.kind === 'preview'
        && pending.event.segmentId === request.event.segmentId
      ) {
        pendingRequests.splice(index, 1);
      }
    }
    pendingRequests.push(request);
  } else {
    pendingRequests.push(request);
  }

  if (!processing) {
    void processRequests();
  }
}

void initialize();
self.onmessage = (event: MessageEvent<PunctuationWorkerRequest>) => {
  enqueue(event.data);
};
