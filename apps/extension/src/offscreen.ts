import type {
  AsrWorkerEvent,
  InferenceEvent,
  OffscreenEventMessage,
  OffscreenRequest,
  PunctuationWorkerEvent,
  PunctuationWorkerRequest,
  PunctuatedCaptionEvent,
  RawAsrCaptionEvent,
  RuntimeResponse,
  SegmentationWorkerEvent,
  SegmentationWorkerRequest,
  VadWorkerEvent,
  VadWorkerRequest
} from '../../../packages/protocol/src/index';

interface ActiveCapture {
  vadWorker: Worker;
  asrWorker: Worker;
  punctuationWorker: Worker | null;
  segmentationWorker: Worker | null;
  sessionId: string;
  mediaStream: MediaStream;
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
  monitorGain: GainNode;
  analysisGain: GainNode;
  vadStopWaiter: (() => void) | null;
  stopWaiter: (() => void) | null;
  recognitionPaused: boolean;
  recognitionEpoch: number;
}

let activeCapture: ActiveCapture | null = null;
let pendingStoppedEvent:
  Extract<AsrWorkerEvent, { type: 'session.stopped' }> | null = null;
let deliverySequence = 0;
let deliveryQueue = Promise.resolve();

function success<T = undefined>(data?: T): RuntimeResponse<T> {
  return { ok: true, data };
}

function notifyInferenceEvent(event: InferenceEvent): Promise<void> {
  const sequencedEvent: InferenceEvent = (
    event.type === 'caption.preview' || event.type === 'caption.final'
  )
    ? {
        ...event,
        deliverySequence: deliverySequence += 1
      }
    : event;
  const message: OffscreenEventMessage = {
    target: 'background',
    type: 'inference.event',
    event: sequencedEvent
  };
  deliveryQueue = deliveryQueue.then(async () => {
    try {
      await chrome.runtime.sendMessage(message);
    } catch {
      // The service worker may be restarting; the active worker still owns the session.
    }
  });
  return deliveryQueue;
}

function forwardRawCaption(event: RawAsrCaptionEvent): void {
  if (event.kind === 'preview') {
    void notifyInferenceEvent({
      type: 'caption.preview',
      recognitionEpoch: event.recognitionEpoch,
      sessionId: event.sessionId,
      parentSegmentId: event.segmentId,
      parts: [{
        segmentId: `${event.segmentId}_raw_preview`,
        text: event.text,
        audioStartUs: event.audioStartUs,
        audioEndUs: event.audioEndUs
      }],
      processingMs: event.processingMs
    });
    return;
  }

  void notifyInferenceEvent({
    type: 'caption.final',
    recognitionEpoch: event.recognitionEpoch,
    sessionId: event.sessionId,
    segmentId: `${event.segmentId}_raw`,
    parentSegmentId: event.segmentId,
    audioStartUs: event.audioStartUs,
    audioEndUs: event.audioEndUs,
    text: event.text,
    processingMs: event.processingMs
  });
}

async function completeStoppedSession(): Promise<void> {
  const event = pendingStoppedEvent;
  pendingStoppedEvent = null;
  if (event) {
    await notifyInferenceEvent(event);
  }
  activeCapture?.stopWaiter?.();
}

function forwardPunctuatedCaption(event: PunctuatedCaptionEvent): void {
  if (event.kind === 'preview') {
    void notifyInferenceEvent({
      type: 'caption.preview',
      recognitionEpoch: event.recognitionEpoch,
      sessionId: event.sessionId,
      parentSegmentId: event.segmentId,
      parts: [{
        segmentId: `${event.segmentId}_p1`,
        text: event.text,
        audioStartUs: event.audioStartUs,
        audioEndUs: event.audioEndUs
      }],
      processingMs: event.processingMs
    });
    return;
  }
  void notifyInferenceEvent({
    type: 'caption.final',
    recognitionEpoch: event.recognitionEpoch,
    sessionId: event.sessionId,
    segmentId: `${event.segmentId}_c1`,
    parentSegmentId: event.segmentId,
    audioStartUs: event.audioStartUs,
    audioEndUs: event.audioEndUs,
    text: event.text,
    processingMs: event.processingMs
  });
}

function createPunctuationWorker(): Promise<Worker> {
  const worker = new Worker(chrome.runtime.getURL('punctuation-worker.js'));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('标点 Worker 启动超时'));
    }, 60_000);
    let ready = false;

    worker.onmessage = (event: MessageEvent<PunctuationWorkerEvent>) => {
      const message = event.data;
      if (message.type === 'punctuation.ready' && !ready) {
        ready = true;
        window.clearTimeout(timeout);
        resolve(worker);
        return;
      }

      if (message.type === 'punctuation.result') {
        const capture = activeCapture;
        if (
          !capture
          || capture.punctuationWorker !== worker
          || capture.recognitionPaused
          || message.event.recognitionEpoch !== capture.recognitionEpoch
        ) {
          return;
        }
        const segmentationWorker = capture.segmentationWorker;
        if (segmentationWorker) {
          segmentationWorker.postMessage({
            type: 'segmentation.punctuated',
            event: message.event
          } satisfies SegmentationWorkerRequest);
        } else {
          forwardPunctuatedCaption(message.event);
        }
        return;
      }

      if (message.type === 'punctuation.drained') {
        const capture = activeCapture;
        if (!capture || capture.punctuationWorker !== worker) {
          return;
        }
        const segmentationWorker = capture.segmentationWorker;
        if (segmentationWorker) {
          segmentationWorker.postMessage({
            type: 'segmentation.flush'
          } satisfies SegmentationWorkerRequest);
        } else {
          void completeStoppedSession();
        }
        return;
      }

      if (message.type === 'punctuation.error') {
        const capture = activeCapture;
        if (!capture || capture.punctuationWorker !== worker) {
          return;
        }
        void notifyInferenceEvent({
          type: 'session.status',
          sessionId: capture.sessionId,
          message: `标点恢复失败，保留识别文本：${message.error}`
        });
      }
    };

    worker.onerror = (event) => {
      if (!ready) {
        ready = true;
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message || '标点 Worker 启动失败'));
        return;
      }
      if (activeCapture?.punctuationWorker === worker) {
        activeCapture.punctuationWorker = null;
      }
      worker.terminate();
      const sessionId = activeCapture?.sessionId || '';
      if (sessionId) {
        void notifyInferenceEvent({
          type: 'session.status',
          sessionId,
          message: '标点 Worker 已停止，继续输出原始识别字幕'
        });
      }
    };
  });
}

function createSegmentationWorker(): Promise<Worker> {
  const worker = new Worker(chrome.runtime.getURL('segmentation-worker.js'));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('分句 Worker 启动超时'));
    }, 60_000);
    let ready = false;

    worker.onmessage = (event: MessageEvent<SegmentationWorkerEvent>) => {
      const message = event.data;
      if (message.type === 'segmentation.ready' && !ready) {
        ready = true;
        window.clearTimeout(timeout);
        resolve(worker);
        return;
      }

      if (message.type === 'caption.preview' || message.type === 'caption.final') {
        const capture = activeCapture;
        if (
          !capture
          || capture.segmentationWorker !== worker
          || capture.recognitionPaused
          || message.recognitionEpoch !== capture.recognitionEpoch
        ) {
          return;
        }
        void notifyInferenceEvent(message);
        return;
      }

      if (message.type === 'segmentation.drained') {
        if (activeCapture?.segmentationWorker !== worker) {
          return;
        }
        void completeStoppedSession();
        return;
      }

      if (message.type === 'segmentation.error') {
        const capture = activeCapture;
        if (!capture || capture.segmentationWorker !== worker) {
          return;
        }
        void notifyInferenceEvent({
          type: 'session.status',
          sessionId: capture.sessionId,
          message: `字幕分句失败，保留识别文本：${message.error}`
        });
      }
    };

    worker.onerror = (event) => {
      if (!ready) {
        ready = true;
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message || '分句 Worker 启动失败'));
        return;
      }
      if (activeCapture?.segmentationWorker === worker) {
        activeCapture.segmentationWorker = null;
      }
      worker.terminate();
      const sessionId = activeCapture?.sessionId || '';
      if (sessionId) {
        void notifyInferenceEvent({
          type: 'session.status',
          sessionId,
          message: '分句 Worker 已停止，继续输出标点后文本'
        });
      }
      void completeStoppedSession();
    };
  });
}

function createVadWorker(sessionId: string): Promise<Worker> {
  const worker = new Worker(chrome.runtime.getURL('vad-worker.js'));
  worker.postMessage({
    type: 'vad.start',
    sessionId
  } satisfies VadWorkerRequest);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('人声检测 Worker 启动超时'));
    }, 60_000);
    let ready = false;

    worker.onmessage = (event: MessageEvent<VadWorkerEvent>) => {
      const message = event.data;
      if (message.type === 'vad.ready' && !ready) {
        ready = true;
        window.clearTimeout(timeout);
        resolve(worker);
        return;
      }

      if (message.type === 'vad.speech-start') {
        const capture = activeCapture;
        if (
          !capture
          || capture.vadWorker !== worker
          || capture.recognitionPaused
        ) {
          return;
        }
        capture.asrWorker.postMessage({
          type: 'asr.speech-start',
          recognitionEpoch: capture.recognitionEpoch,
          startUs: message.startUs
        });
        return;
      }

      if (message.type === 'vad.speech-frame') {
        const capture = activeCapture;
        if (
          !capture
          || capture.vadWorker !== worker
          || capture.recognitionPaused
        ) {
          return;
        }
        capture.asrWorker.postMessage({
          type: 'asr.speech-frame',
          samples: message.samples,
          startUs: message.startUs,
          endUs: message.endUs
        }, [message.samples]);
        return;
      }

      if (message.type === 'vad.speech-end') {
        const capture = activeCapture;
        if (!capture || capture.vadWorker !== worker) {
          return;
        }
        capture.asrWorker.postMessage({
          type: 'asr.speech-end',
          endUs: message.endUs
        });
        return;
      }

      if (message.type === 'vad.stopped') {
        if (activeCapture?.vadWorker === worker) {
          activeCapture.vadStopWaiter?.();
        }
        return;
      }

      if (message.type === 'vad.error') {
        if (!ready) {
          ready = true;
          window.clearTimeout(timeout);
          worker.terminate();
          reject(new Error(message.error));
          return;
        }
        if (activeCapture?.vadWorker !== worker) {
          return;
        }
        void notifyInferenceEvent({
          type: 'session.error',
          sessionId,
          message: message.error,
          recoverable: false
        });
        void cleanupCapture();
      }
    };

    worker.onerror = (event) => {
      if (!ready) {
        ready = true;
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message || '人声检测 Worker 启动失败'));
        return;
      }
      if (activeCapture?.vadWorker !== worker) {
        return;
      }
      void notifyInferenceEvent({
        type: 'session.error',
        sessionId,
        message: event.message || '人声检测 Worker 异常退出',
        recoverable: false
      });
      void cleanupCapture();
    };
  });
}

function createAsrWorker(sessionId: string): Promise<Worker> {
  const worker = new Worker(chrome.runtime.getURL('asr-worker.js'));
  worker.postMessage({
    type: 'asr.start',
    sessionId
  });
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('本地中文模型加载超时'));
    }, 60_000);
    let ready = false;

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as AsrWorkerEvent;
      if (message?.type === 'worker.ready' && !ready) {
        ready = true;
        window.clearTimeout(timeout);
        resolve(worker);
        return;
      }

      if (message?.type === 'worker.error' && !ready) {
        ready = true;
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error(message.error || '中文模型加载失败'));
        return;
      }

      if (message?.type === 'asr.caption') {
        const capture = activeCapture;
        if (
          !capture
          || capture.asrWorker !== worker
          || capture.recognitionPaused
          || message.recognitionEpoch !== capture.recognitionEpoch
        ) {
          return;
        }
        const punctuationWorker = capture.punctuationWorker;
        if (punctuationWorker) {
          punctuationWorker.postMessage({
            type: 'punctuation.raw',
            event: message
          } satisfies PunctuationWorkerRequest);
        } else {
          forwardRawCaption(message);
        }
        return;
      }

      if (message?.type === 'session.stopped') {
        if (activeCapture?.asrWorker !== worker) {
          return;
        }
        pendingStoppedEvent = message;
        const punctuationWorker = activeCapture?.punctuationWorker;
        if (punctuationWorker) {
          punctuationWorker.postMessage({
            type: 'punctuation.flush'
          } satisfies PunctuationWorkerRequest);
        } else {
          void completeStoppedSession();
        }
        return;
      }

      if (
        message?.type === 'session.status'
        || message?.type === 'session.error'
        || message?.type === 'session.started'
      ) {
        void notifyInferenceEvent(message);
      }
    };

    worker.onerror = (event) => {
      if (!ready) {
        ready = true;
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message || '中文识别 Worker 启动失败'));
        return;
      }
      if (activeCapture?.asrWorker !== worker) {
        return;
      }
      void notifyInferenceEvent({
        type: 'session.error',
        sessionId,
        message: event.message || '中文识别 Worker 异常退出',
        recoverable: false
      });
      void cleanupCapture();
    };
  });
}

async function startCapture(
  streamId: string
): Promise<RuntimeResponse<{ startedAtEpochMs: number }>> {
  await cleanupCapture();
  await deliveryQueue;
  deliverySequence = 0;

  const sessionId = `cs_${Date.now().toString(36)}_${crypto.randomUUID()}`;
  const vadWorker = await createVadWorker(sessionId);
  let asrWorker: Worker;
  try {
    asrWorker = await createAsrWorker(sessionId);
  } catch (error) {
    vadWorker.terminate();
    throw error;
  }
  const punctuationWorkerPromise = createPunctuationWorker().catch((error) => {
    console.error('Punctuation worker unavailable; using raw captions', error);
    return null;
  });
  const segmentationWorkerPromise = createSegmentationWorker().catch((error) => {
    console.error('Segmentation worker unavailable; using raw captions', error);
    return null;
  });

  let mediaStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      } as MediaTrackConstraints,
      video: false
    });

    audioContext = new AudioContext({ latencyHint: 'interactive' });
    await audioContext.audioWorklet.addModule(
      chrome.runtime.getURL('audio-capture-processor.js')
    );

    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit'
    });
    const monitorGain = audioContext.createGain();
    monitorGain.gain.value = 1;
    const analysisGain = audioContext.createGain();
    analysisGain.gain.value = 0;

    sourceNode.connect(monitorGain);
    monitorGain.connect(audioContext.destination);
    sourceNode.connect(workletNode);
    workletNode.connect(analysisGain);
    analysisGain.connect(audioContext.destination);

    const capture: ActiveCapture = {
      vadWorker,
      asrWorker,
      punctuationWorker: null,
      segmentationWorker: null,
      sessionId,
      mediaStream,
      audioContext,
      sourceNode,
      workletNode,
      monitorGain,
      analysisGain,
      vadStopWaiter: null,
      stopWaiter: null,
      recognitionPaused: false,
      recognitionEpoch: 1
    };
    activeCapture = capture;
    const audioTrack = mediaStream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error('音频捕获未返回音轨');
    }
    audioTrack.addEventListener('ended', () => {
      if (activeCapture !== capture) {
        return;
      }
      void notifyInferenceEvent({
        type: 'session.error',
        sessionId,
        message: '音频捕获轨道已结束，会话已停止',
        recoverable: false
      });
      void cleanupCapture();
    }, { once: true });
    void notifyInferenceEvent({
      type: 'session.status',
      sessionId,
      message: '本地人声检测与识别引擎已就绪'
    });
    void notifyInferenceEvent({
      type: 'recognition.epoch',
      sessionId,
      epoch: capture.recognitionEpoch
    });
    void Promise.all([
      punctuationWorkerPromise,
      segmentationWorkerPromise
    ]).then(([punctuationWorker, segmentationWorker]) => {
      if (!punctuationWorker || !segmentationWorker) {
        punctuationWorker?.terminate();
        segmentationWorker?.terminate();
        return;
      }
      if (activeCapture === capture) {
        capture.punctuationWorker = punctuationWorker;
        capture.segmentationWorker = segmentationWorker;
        return;
      }
      punctuationWorker.terminate();
      segmentationWorker.terminate();
    });

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (activeCapture !== capture) {
        return;
      }
      if (capture.recognitionPaused) {
        return;
      }
      const pcm = event.data;
      capture.vadWorker.postMessage({
        type: 'audio.frame',
        samples: pcm
      }, [pcm]);
    };

    await audioContext.resume();
    return success({ startedAtEpochMs: Date.now() });
  } catch (error) {
    activeCapture = null;
    vadWorker.terminate();
    asrWorker.terminate();
    void punctuationWorkerPromise.then((worker) => worker?.terminate());
    void segmentationWorkerPromise.then((worker) => worker?.terminate());
    for (const track of mediaStream?.getTracks() || []) {
      track.stop();
    }
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close();
    }
    throw error;
  }
}

async function cleanupCapture(): Promise<void> {
  const capture = activeCapture;
  if (!capture) {
    return;
  }
  activeCapture = null;
  capture.workletNode.port.onmessage = null;
  capture.workletNode.disconnect();
  capture.sourceNode.disconnect();
  capture.monitorGain.disconnect();
  capture.analysisGain.disconnect();
  for (const track of capture.mediaStream.getTracks()) {
    track.stop();
  }
  if (capture.audioContext.state !== 'closed') {
    await capture.audioContext.close();
  }
  capture.vadStopWaiter?.();
  capture.vadWorker.terminate();
  capture.asrWorker.terminate();
  capture.punctuationWorker?.terminate();
  capture.segmentationWorker?.terminate();
  pendingStoppedEvent = null;
}

async function stopCapture(): Promise<void> {
  const capture = activeCapture;
  if (!capture) {
    return;
  }

  capture.workletNode.port.onmessage = null;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 2_500);
    capture.vadStopWaiter = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    capture.vadWorker.postMessage({ type: 'vad.stop' });
  });
  capture.vadStopWaiter = null;

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 2_500);
    capture.stopWaiter = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    capture.asrWorker.postMessage({ type: 'asr.stop' });
  });

  capture.stopWaiter = null;
  await cleanupCapture();
}

async function resetRecognition(capture: ActiveCapture): Promise<void> {
  capture.recognitionEpoch += 1;
  capture.vadWorker.postMessage({ type: 'vad.seek' });
  capture.asrWorker.postMessage({ type: 'asr.seek' });
  await notifyInferenceEvent({
    type: 'recognition.epoch',
    sessionId: capture.sessionId,
    epoch: capture.recognitionEpoch
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || !message.request) {
    return;
  }

  const request = message.request as OffscreenRequest;
  let operation: Promise<RuntimeResponse>;
  if (request.type === 'capture.start') {
    operation = startCapture(request.streamId);
  } else if (request.type === 'capture.stop') {
    operation = stopCapture().then(() => success());
  } else if (request.type === 'capture.pause') {
    const capture = activeCapture;
    operation = (async () => {
      if (capture) {
        capture.recognitionPaused = true;
        await resetRecognition(capture);
      }
      return success();
    })();
  } else if (request.type === 'capture.resume') {
    const capture = activeCapture;
    operation = (async () => {
      if (capture) {
        capture.recognitionPaused = false;
        await resetRecognition(capture);
      }
      return success();
    })();
  } else {
    const capture = activeCapture;
    operation = capture
      ? resetRecognition(capture).then(() => success())
      : Promise.resolve(success());
  }
  void operation
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies RuntimeResponse));
  return true;
});

window.addEventListener('beforeunload', () => {
  void cleanupCapture();
});

