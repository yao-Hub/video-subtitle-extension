import type {
  CaptionPreviewEvent,
  CaptionWorkerEvent,
  CaptionWorkerRequest,
  FinalCaptionEvent,
  RawAsrCaptionEvent
} from '../../../packages/protocol/src/index';

/*
// Temporarily disabled for ASR validation.
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

const puncRuntimeBase = new URL('runtime/ct-punc/', self.location.href).href;
const ortRuntimeBase = new URL('runtime/onnxruntime-web/', self.location.href).href;
let punctuationSession: OrtSession | null = null;
let punctuationTokenIds: Map<string, number> | null = null;
let punctuationUnknownId = 0;
let punctuationLoadError = '';

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
  const output = await punctuationSession.run({
    inputs: new ort.Tensor('int32', tokenIds, [1, tokenIds.length]),
    text_lengths: new ort.Tensor(
      'int32',
      Int32Array.from([tokenIds.length]),
      [1]
    )
  });
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
    punctuationLoadError = error instanceof Error ? error.message : String(error);
    console.error('Failed to initialize punctuation model', error);
  }
  postEvent({ type: 'caption.ready' });
}
*/

function postEvent(event: CaptionWorkerEvent): void {
  self.postMessage(event);
}

function createPreview(event: RawAsrCaptionEvent): CaptionPreviewEvent {
  // Sentence splitting is temporarily commented out for ASR validation.
  /*
  const parts = splitChineseCaption(
    event.text,
    event.audioStartUs,
    event.audioEndUs,
    { preview: true }
  );
  */
  const parts = [{
    text: event.text,
    audioStartUs: event.audioStartUs,
    audioEndUs: event.audioEndUs
  }];

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
): Promise<FinalCaptionEvent> {
  // Punctuation restoration and sentence splitting are temporarily commented out.
  const text = event.text;
  /*
  const punctuatedText = await addPunctuation(event.text);
  const parts = splitChineseCaption(
    punctuatedText,
    event.audioStartUs,
    event.audioEndUs
  );
  const firstPart = parts[0];
  */

  return {
    type: 'caption.final',
    sessionId: event.sessionId,
    segmentId: `${event.segmentId}_raw`,
    parentSegmentId: event.segmentId,
    audioStartUs: event.audioStartUs,
    audioEndUs: event.audioEndUs,
    text,
    processingMs: event.processingMs
  };
}

async function handleRawCaption(event: RawAsrCaptionEvent): Promise<void> {
  if (event.kind === 'preview') {
    postEvent(createPreview(event));
    return;
  }
  postEvent(await createFinal(event));
}

// initializePostProcessing() is intentionally not called while validation is in progress.
postEvent({ type: 'caption.ready' });

let captionQueue = Promise.resolve();
self.onmessage = (event: MessageEvent<CaptionWorkerRequest>) => {
  const request = event.data;
  captionQueue = captionQueue
    .then(() => {
      if (request.type === 'caption.raw') {
        return handleRawCaption(request.event);
      }
      postEvent({ type: 'caption.drained' });
    })
    .catch((error) => {
      postEvent({
        type: 'caption.error',
        error: error instanceof Error ? error.message : '字幕后处理失败'
      });
    });
};
