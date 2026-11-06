import type {
  AsrWorkerEvent,
  CaptionWorkerEvent,
  CaptionWorkerRequest,
  InferenceEvent,
  OffscreenEventMessage,
  OffscreenRequest,
  RawAsrCaptionEvent,
  RuntimeResponse
} from '../../../packages/protocol/src/index';

interface ActiveCapture {
  asrWorker: Worker;
  captionWorker: Worker | null;
  sessionId: string;
  mediaStream: MediaStream;
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
  monitorGain: GainNode;
  analysisGain: GainNode;
  stopWaiter: (() => void) | null;
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
      sessionId: event.sessionId,
      parentSegmentId: event.segmentId,
      parts: [{
        segmentId: `${event.segmentId}_raw_preview`,
        text: event.text,
        audioStartUs: event.audioStartUs,
        audioEndUs: event.audioEndUs,
        stable: false
      }],
      processingMs: event.processingMs
    });
    return;
  }

  void notifyInferenceEvent({
    type: 'caption.final',
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

function createCaptionWorker(): Promise<Worker> {
  const worker = new Worker(chrome.runtime.getURL('caption-worker.js'));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('字幕后处理 Worker 启动超时'));
    }, 60_000);
    let ready = false;

    worker.onmessage = (event: MessageEvent<CaptionWorkerEvent>) => {
      const message = event.data;
      if (message.type === 'caption.ready' && !ready) {
        ready = true;
        window.clearTimeout(timeout);
        resolve(worker);
        return;
      }

      if (message.type === 'caption.preview' || message.type === 'caption.final') {
        void notifyInferenceEvent(message);
        return;
      }

      if (message.type === 'caption.drained') {
        void completeStoppedSession();
        return;
      }

      if (message.type === 'caption.error') {
        const sessionId = activeCapture?.sessionId || '';
        void notifyInferenceEvent({
          type: 'session.status',
          sessionId,
          message: `字幕后处理失败，保留原始识别：${message.error}`
        });
      }
    };

    worker.onerror = (event) => {
      if (!ready) {
        ready = true;
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message || '字幕后处理 Worker 启动失败'));
        return;
      }
      if (activeCapture?.captionWorker === worker) {
        activeCapture.captionWorker = null;
      }
      worker.terminate();
      const sessionId = activeCapture?.sessionId || '';
      if (sessionId) {
        void notifyInferenceEvent({
          type: 'session.status',
          sessionId,
          message: '字幕后处理 Worker 已停止，继续输出原始识别字幕'
        });
      }
      void completeStoppedSession();
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
        const captionWorker = activeCapture?.captionWorker;
        if (captionWorker) {
          captionWorker.postMessage({
            type: 'caption.raw',
            event: message
          } satisfies CaptionWorkerRequest);
        } else {
          forwardRawCaption(message);
        }
        return;
      }

      if (message?.type === 'session.stopped') {
        pendingStoppedEvent = message;
        const captionWorker = activeCapture?.captionWorker;
        if (captionWorker) {
          captionWorker.postMessage({
            type: 'caption.flush'
          } satisfies CaptionWorkerRequest);
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
  const asrWorker = await createAsrWorker(sessionId);
  const captionWorkerPromise = createCaptionWorker().catch((error) => {
    console.error('Caption worker unavailable; using raw captions', error);
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
      asrWorker,
      captionWorker: null,
      sessionId,
      mediaStream,
      audioContext,
      sourceNode,
      workletNode,
      monitorGain,
      analysisGain,
      stopWaiter: null
    };
    activeCapture = capture;
    void captionWorkerPromise.then((captionWorker) => {
      if (activeCapture === capture) {
        capture.captionWorker = captionWorker;
      } else {
        captionWorker?.terminate();
      }
    });

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (activeCapture !== capture) {
        return;
      }
      const pcm = event.data;
      capture.asrWorker.postMessage({
        type: 'audio.frame',
        samples: pcm
      }, [pcm]);
    };

    await audioContext.resume();
    return success({ startedAtEpochMs: Date.now() });
  } catch (error) {
    activeCapture = null;
    asrWorker.terminate();
    void captionWorkerPromise.then((captionWorker) => {
      captionWorker?.terminate();
    });
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
  capture.asrWorker.terminate();
  capture.captionWorker?.terminate();
  pendingStoppedEvent = null;
}

async function stopCapture(): Promise<void> {
  const capture = activeCapture;
  if (!capture) {
    return;
  }

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
  } else {
    activeCapture?.asrWorker.postMessage({ type: 'asr.seek' });
    operation = Promise.resolve(success());
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

