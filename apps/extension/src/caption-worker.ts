import type {
  CaptionPreviewEvent,
  CaptionWorkerEvent,
  CaptionWorkerRequest,
  FinalCaptionEvent,
  RawAsrCaptionEvent
} from '../../../packages/protocol/src/index';

import {
  applyPunctuation,
  PUNCTUATION_LABELS,
  tokenizePunctuationText
} from './punctuation-engine';
import { splitChineseCaption } from './sentence-segmenter';

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
const ortRuntimeBase = new URL('runtime/onnxruntime-web/', self.location.href).href;
let punctuationSession: OrtSession | null = null;
let punctuationTokenIds: Map<string, number> | null = null;
let punctuationUnknownId = 0;

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
    for (let classIndex = 0; classIndex < PUNCTUATION_LABELS.length; classIndex += 1) {
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

async function initializePostProcessing(): Promise<void> {
  try {
    await loadPunctuationModel();
  } catch (error) {
    console.error('Failed to initialize punctuation model', error);
    postEvent({
      type: 'caption.error',
      error: error instanceof Error ? error.message : '中文标点模型加载失败'
    });
  }
  postEvent({ type: 'caption.ready' });
}

function postEvent(event: CaptionWorkerEvent): void {
  self.postMessage(event);
}

async function createPreview(
  event: RawAsrCaptionEvent
): Promise<CaptionPreviewEvent> {
  const punctuatedText = await addPunctuation(event.text);
  const parts = splitChineseCaption(
    punctuatedText,
    event.audioStartUs,
    event.audioEndUs
  );

  return {
    type: 'caption.preview',
    sessionId: event.sessionId,
    parentSegmentId: event.segmentId,
    parts: parts.map((part, index) => ({
      segmentId: `${event.segmentId}_p${index + 1}`,
      text: part.text,
      audioStartUs: part.audioStartUs,
      audioEndUs: part.audioEndUs,
      stable: false
    })),
    processingMs: event.processingMs
  };
}

async function createFinal(
  event: RawAsrCaptionEvent
): Promise<FinalCaptionEvent[]> {
  const punctuatedText = await addPunctuation(event.text);
  const parts = splitChineseCaption(
    punctuatedText,
    event.audioStartUs,
    event.audioEndUs
  );

  return parts.map((part, index) => ({
    type: 'caption.final',
    sessionId: event.sessionId,
    segmentId: `${event.segmentId}_c${index + 1}`,
    parentSegmentId: event.segmentId,
    audioStartUs: part.audioStartUs,
    audioEndUs: part.audioEndUs,
    text: part.text,
    processingMs: event.processingMs
  }));
}

async function handleRawCaption(event: RawAsrCaptionEvent): Promise<void> {
  if (event.kind === 'preview') {
    postEvent(await createPreview(event));
    return;
  }
  for (const finalEvent of await createFinal(event)) {
    postEvent(finalEvent);
  }
}

void initializePostProcessing();

const pendingRequests: CaptionWorkerRequest[] = [];
let processing = false;

async function processRequests(): Promise<void> {
  processing = true;
  try {
    while (pendingRequests.length) {
      const request = pendingRequests.shift()!;
      try {
        if (request.type === 'caption.raw') {
          await handleRawCaption(request.event);
        } else {
          postEvent({ type: 'caption.drained' });
        }
      } catch (error) {
        postEvent({
          type: 'caption.error',
          error: error instanceof Error ? error.message : '字幕后处理失败'
        });
      }
    }
  } finally {
    processing = false;
  }
}

function enqueueRequest(request: CaptionWorkerRequest): void {
  if (
    request.type === 'caption.raw'
    && request.event.kind === 'preview'
  ) {
    const previous = pendingRequests.at(-1);
    if (
      previous?.type === 'caption.raw'
      && previous.event.kind === 'preview'
    ) {
      pendingRequests[pendingRequests.length - 1] = request;
    } else {
      pendingRequests.push(request);
    }
  } else if (request.type === 'caption.raw') {
    for (let index = pendingRequests.length - 1; index >= 0; index -= 1) {
      const pending = pendingRequests[index];
      if (
        pending?.type === 'caption.raw'
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

self.onmessage = (event: MessageEvent<CaptionWorkerRequest>) => {
  enqueueRequest(event.data);
};
