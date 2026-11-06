var Module = self.Module || {};
self.Module = Module;

let runtimeLoaded = false;
let modelLoaded = false;
let whisperInstance = 0;
let busy = false;
let queuedTask = null;

function buildNoEvalApi() {
  const hasDirectApi = (
    typeof Module.init === 'function' &&
    typeof Module.set_audio === 'function' &&
    typeof Module.get_transcribed === 'function'
  );
  if (hasDirectApi) {
    return true;
  }

  const hasCApi = (
    typeof Module.ccall === 'function' &&
    typeof Module._malloc === 'function' &&
    typeof Module._free === 'function' &&
    typeof Module.HEAPF32 !== 'undefined'
  );

  if (!hasCApi) {
    return false;
  }

  Module.init = (modelPath, lang) => {
    return Module.ccall('stream_init', 'number', ['string', 'string'], [modelPath, lang || 'auto']);
  };

  Module.free = (instanceId) => {
    Module.ccall('stream_free', null, ['number'], [Number(instanceId || 0)]);
  };

  Module.set_audio = (instanceId, audioData) => {
    if (!(audioData instanceof Float32Array) || audioData.length === 0) {
      return -1;
    }

    const bytes = audioData.length * 4;
    const ptr = Module._malloc(bytes);

    try {
      Module.HEAPF32.set(audioData, ptr >> 2);
      return Module.ccall(
        'stream_set_audio',
        'number',
        ['number', 'number', 'number'],
        [Number(instanceId || 0), ptr, audioData.length]
      );
    } finally {
      Module._free(ptr);
    }
  };

  Module.get_transcribed = () => Module.ccall('stream_get_transcribed', 'string', [], []);
  Module.get_status = () => Module.ccall('stream_get_status', 'string', [], []);

  return true;
}

function waitForRuntime(timeoutMs = 30000) {
  if (buildNoEvalApi() && typeof Module.FS_createDataFile === 'function') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const startAt = Date.now();

    const timer = setInterval(() => {
      if (buildNoEvalApi() && typeof Module.FS_createDataFile === 'function') {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('WASM runtime initialization timed out'));
      }
    }, 80);
  });
}

async function loadRuntime(streamJsUrl, streamJsCode) {
  if (runtimeLoaded && buildNoEvalApi() && typeof Module.FS_createDataFile === 'function') {
    return;
  }

  // Avoid surfacing native stderr logs as extension "errors" in Chrome.
  Module.print = (_text) => {
    // keep quiet by default
  };
  Module.printErr = (text) => {
    const msg = String(text || '');
    // Forward actionable failures to popup status, swallow noisy model-loading logs.
    if (/failed|error|abort|exception/i.test(msg)) {
      self.postMessage({ type: 'status', level: 'warn', text: msg });
    }
  };
  self.Module = Module;

  if (typeof streamJsCode === 'string' && streamJsCode.length > 0) {
    const streamBlob = new Blob([streamJsCode], { type: 'text/javascript' });
    const streamBlobUrl = URL.createObjectURL(streamBlob);
    importScripts(streamBlobUrl);
    URL.revokeObjectURL(streamBlobUrl);
  } else {
    importScripts(streamJsUrl);
  }

  Module = self.Module || Module;
  await waitForRuntime();
  runtimeLoaded = true;
}

async function loadModel(modelUrl, modelData, preferredLanguage, fallbackLanguage) {
  let bytes = null;

  if (modelData instanceof ArrayBuffer) {
    bytes = new Uint8Array(modelData);
  } else {
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`Model load failed: HTTP ${response.status}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  const modelPath = typeof Module.FS_analyzePath === 'function'
    ? Module.FS_analyzePath('/whisper.bin')
    : null;
  if (modelPath?.exists) {
    Module.FS_unlink('/whisper.bin');
  }

  Module.FS_createDataFile('/', 'whisper.bin', bytes, true, true);

  whisperInstance = Module.init('whisper.bin', preferredLanguage || 'zh');
  if (!whisperInstance) {
    whisperInstance = Module.init('whisper.bin', fallbackLanguage || 'auto');
  }

  if (!whisperInstance) {
    throw new Error('Whisper initialization failed');
  }

  modelLoaded = true;
}

async function init(payload) {
  if (!runtimeLoaded) {
    await loadRuntime(payload.streamJsUrl, payload.streamJsCode);
  }

  if (!modelLoaded || !whisperInstance) {
    await loadModel(
      payload.modelUrl,
      payload.modelData,
      payload.preferredLanguage,
      payload.fallbackLanguage
    );
  }
}

function runTranscribe(task) {
  busy = true;

  try {
    if (!modelLoaded || !whisperInstance) {
      throw new Error('ASR is not initialized');
    }

    const code = Module.set_audio(whisperInstance, task.audio);
    if (code < 0) {
      throw new Error(`set_audio failed: ${code}`);
    }

    const text = String(Module.get_transcribed() || '').trim();
    const status = typeof Module.get_status === 'function' ? String(Module.get_status() || '') : '';

    self.postMessage({
      type: 'result',
      requestId: Number(task.requestId || 0),
      taskKind: task.taskKind || 'final',
      text,
      status,
      currentTime: Number(task.currentTime || 0),
      windowStart: Number(task.windowStart || 0),
      windowEnd: Number(task.windowEnd || 0)
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: Number(task.requestId || 0),
      taskKind: task.taskKind || 'final',
      error: error?.message || 'Transcription failed'
    });
  } finally {
    busy = false;

    if (queuedTask) {
      const nextTask = queuedTask;
      queuedTask = null;
      runTranscribe(nextTask);
    }
  }
}

function dispose() {
  if (typeof Module.free === 'function' && whisperInstance) {
    Module.free(whisperInstance);
  }

  whisperInstance = 0;
  modelLoaded = false;
  busy = false;
  queuedTask = null;

  self.postMessage({ type: 'disposed' });
}

self.onmessage = async (event) => {
  const msg = event.data || {};

  try {
    if (msg.type === 'init') {
      await init(msg);
      self.postMessage({ type: 'ready' });
      return;
    }

    if (msg.type === 'transcribe') {
      if (!(msg.audio instanceof Float32Array)) {
        return;
      }

      const task = {
        requestId: Number(msg.requestId || 0),
        taskKind: String(msg.taskKind || 'final'),
        audio: msg.audio,
        currentTime: Number(msg.currentTime || 0),
        windowStart: Number(msg.windowStart || 0),
        windowEnd: Number(msg.windowEnd || 0)
      };

      if (busy) {
        queuedTask = task;
        return;
      }

      runTranscribe(task);
      return;
    }

    if (msg.type === 'dispose') {
      dispose();
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error?.message || 'Worker internal error'
    });
  }
};
