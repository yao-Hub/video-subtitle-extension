import {
  ASR_SAMPLE_RATE,
  MIN_SPEECH_RMS,
  MIN_TEXT_LENGTH,
  MAX_SUBTITLE_ITEMS,
  INTERIM_ITEM_ID,
  MODEL_CANDIDATES,
  DEFAULT_MODE,
  DEFAULT_MODEL,
  resolveModeConfig
} from './modules/config.js';
import {
  formatTime,
  escapeHtml,
  normalizeText,
  cleanTranscript,
  likelyDuplicateText,
  estimateVideoSec,
  reanchorOffset,
  nextOffset,
  downsampleTo16k,
  getMonoChannel,
  calcRms
} from './modules/utils.js';
import { Segmenter } from './modules/segmenter.js';
import { CloudAsrClient } from './modules/cloud-asr.js';

const state = {
  sourceTabId: 0,
  running: false,
  worker: null,
  workerReady: false,
  workerModelName: '',
  workerBusy: false,
  workerInitPromise: null,
  selectedMode: DEFAULT_MODE,
  selectedModelName: DEFAULT_MODEL,
  selectedModelUrl: '',
  availableModels: [],
  requestId: 0,
  pendingRequests: new Map(),
  queuedFinalTask: null,
  subtitles: [],
  lastAcceptedNorm: '',
  lastVideoState: null,
  syncTimer: null,
  timeline: {
    initialized: false,
    offsetSec: 0
  },
  audio: {
    mediaStream: null,
    context: null,
    source: null,
    worklet: null,
    processor: null,
    muteGain: null,
    capturedSec: 0
  },
  cloud: {
    provider: 'hybrid',
    apiBase: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'whisper-1',
    language: 'zh'
  },
  ui: {
    status: null,
    subtitleList: null,
    startBtn: null,
    stopBtn: null,
    engineTag: null,
    latencyTag: null,
    countTag: null,
    providerSelect: null,
    localModelField: null,
    modelSelect: null,
    modeSelect: null,
    cloudLanguageField: null,
    cloudModelSection: null,
    cloudKeySection: null,
    cloudLanguageSelect: null,
    cloudModelInput: null,
    cloudApiBaseInput: null,
    cloudApiKeyInput: null
  }
};

const segmenter = new Segmenter(resolveModeConfig);
const cloudAsr = new CloudAsrClient();
const ASR_PROVIDER_SET = new Set(['local', 'hybrid', 'cloud']);
const USER_SETTING_KEYS = [
  'asr_model',
  'caption_mode',
  'asr_provider',
  'cloud_api_base',
  'cloud_api_key',
  'cloud_model',
  'cloud_language'
];

function modeConfig() {
  return resolveModeConfig(state.selectedMode);
}

function normalizeProvider(value) {
  const safe = String(value || '').trim();
  if (!ASR_PROVIDER_SET.has(safe)) return 'hybrid';
  return safe;
}

function cloudEnabled() {
  if (state.cloud.provider !== 'cloud' && state.cloud.provider !== 'hybrid') return false;
  return Boolean(state.cloud.apiKey && state.cloud.apiBase);
}

function localEnabledForTask(taskKind) {
  if (state.cloud.provider === 'local') return true;
  return state.cloud.provider === 'hybrid' && taskKind === 'interim';
}

function needsLocalWorker() {
  return state.cloud.provider === 'local' || state.cloud.provider === 'hybrid';
}

function cloudSettings() {
  return {
    apiBase: state.cloud.apiBase,
    apiKey: state.cloud.apiKey,
    model: state.cloud.model,
    language: state.cloud.language,
    timeoutMs: 45000
  };
}

function refreshEngineTag() {
  if (state.cloud.provider === 'cloud') {
    setEngineTag(`云端(${state.cloud.model})`);
    return;
  }
  if (state.cloud.provider === 'hybrid') {
    setEngineTag(`混合(本地:${state.selectedModelName} + 云端:${state.cloud.model})`);
    return;
  }
  setEngineTag(`Whisper(${state.selectedModelName}, ${modeConfig().label})`);
}

function updateProviderUiState() {
  const cloudMode = state.cloud.provider === 'cloud' || state.cloud.provider === 'hybrid';
  const localMode = state.cloud.provider === 'local' || state.cloud.provider === 'hybrid';

  const setVisible = (el, visible) => {
    if (!el) return;
    el.style.display = visible ? '' : 'none';
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
  };

  setVisible(state.ui.localModelField, localMode);
  setVisible(state.ui.cloudLanguageField, cloudMode);
  setVisible(state.ui.cloudModelSection, cloudMode);
  setVisible(state.ui.cloudKeySection, cloudMode);

  if (state.ui.modelSelect) {
    state.ui.modelSelect.disabled = state.cloud.provider === 'cloud' || !state.availableModels.length;
  }
  if (state.ui.cloudLanguageSelect) state.ui.cloudLanguageSelect.disabled = !cloudMode;
  if (state.ui.cloudModelInput) state.ui.cloudModelInput.disabled = !cloudMode;
  if (state.ui.cloudApiBaseInput) state.ui.cloudApiBaseInput.disabled = !cloudMode;
  if (state.ui.cloudApiKeyInput) state.ui.cloudApiKeyInput.disabled = !cloudMode;
}

function setStatus(type, text) {
  if (!state.ui.status) return;
  state.ui.status.textContent = text;

  if (type === 'error') {
    state.ui.status.style.color = '#c62828';
    return;
  }
  if (type === 'loading') {
    state.ui.status.style.color = '#1558cc';
    return;
  }
  if (type === 'success') {
    state.ui.status.style.color = '#0f7a39';
    return;
  }
  state.ui.status.style.color = '#475569';
}

function setEngineTag(text) {
  if (!state.ui.engineTag) return;
  state.ui.engineTag.textContent = `引擎: ${text}`;
}

function setLatencyTag(ms) {
  if (!state.ui.latencyTag) return;
  if (!Number.isFinite(ms) || ms <= 0) {
    state.ui.latencyTag.textContent = '延迟: -';
    return;
  }
  state.ui.latencyTag.textContent = `延迟: ${Math.round(ms)}ms`;
}

function setButtonsState() {
  if (!state.ui.startBtn || !state.ui.stopBtn) return;
  state.ui.startBtn.disabled = state.running;
  state.ui.stopBtn.disabled = !state.running;
}

function updateCountTag() {
  if (!state.ui.countTag) return;
  const count = state.subtitles.filter((x) => !x.interim).length;
  state.ui.countTag.textContent = `字幕: ${count}`;
}

function renderSubtitles() {
  const listEl = state.ui.subtitleList;
  if (!listEl) return;

  if (!state.subtitles.length) {
    listEl.innerHTML = '<div class="no-subtitles">尚未识别到语音字幕，启动后会自动更新</div>';
    updateCountTag();
    return;
  }

  listEl.innerHTML = state.subtitles
    .map((item) => {
      const cls = item.interim ? 'subtitle-item interim' : 'subtitle-item';
      const badge = item.interim ? '<span class="subtitle-badge">实时</span>' : '';
      const displayText = String(item.text || '').trim() || '[空字幕]';
      return `
        <div class="${cls}" data-id="${item.id}" data-time="${item.time}" data-interim="${item.interim ? '1' : '0'}">
          <div class="subtitle-time">${escapeHtml(item.startTime)} ${badge}</div>
          <div class="subtitle-text">${escapeHtml(displayText)}</div>
        </div>
      `;
    })
    .join('');

  listEl.scrollTop = listEl.scrollHeight;
  updateCountTag();
}

function removeInterimSubtitle() {
  const idx = state.subtitles.findIndex((x) => x.id === INTERIM_ITEM_ID);
  if (idx >= 0) {
    state.subtitles.splice(idx, 1);
  }
}

function upsertInterimSubtitle(text, startSec, endSec) {
  const safeText = cleanTranscript(text);
  if (!safeText || safeText.length < MIN_TEXT_LENGTH) return;

  const item = {
    id: INTERIM_ITEM_ID,
    interim: true,
    text: safeText,
    time: Math.max(0, Number(startSec || 0)),
    startTime: `${formatTime(startSec)} -> ${formatTime(endSec)}`
  };

  const idx = state.subtitles.findIndex((x) => x.id === INTERIM_ITEM_ID);
  if (idx >= 0) {
    state.subtitles[idx] = item;
  } else {
    state.subtitles.push(item);
  }
  renderSubtitles();
}

function addFinalSubtitleItem(text, startSec, endSec) {
  const safeText = cleanTranscript(text);
  if (!safeText || safeText.length < MIN_TEXT_LENGTH) return;
  if (likelyDuplicateText(safeText, state.lastAcceptedNorm, MIN_TEXT_LENGTH)) return;

  removeInterimSubtitle();
  state.subtitles.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    interim: false,
    text: safeText,
    time: Math.max(0, Number(startSec || 0)),
    startTime: `${formatTime(startSec)} -> ${formatTime(endSec)}`
  });

  if (state.subtitles.length > MAX_SUBTITLE_ITEMS) {
    state.subtitles = state.subtitles.slice(-MAX_SUBTITLE_ITEMS);
  }

  state.lastAcceptedNorm = normalizeText(safeText);
  renderSubtitles();
}

function initSourceTabIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const raw = Number(params.get('sourceTabId') || 0);
  if (Number.isInteger(raw) && raw > 0) {
    state.sourceTabId = raw;
  }
}

async function runtimeMessage(payload) {
  return chrome.runtime.sendMessage(payload);
}

async function ensureSourceTabId() {
  if (state.sourceTabId) {
    const allTabs = await chrome.tabs.query({ windowType: 'normal' });
    const matched = allTabs.find((tab) => Number(tab?.id || 0) === state.sourceTabId);
    if (matched?.id) return matched.id;
    state.sourceTabId = 0;
  }

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  const tabId = Number(tabs?.[0]?.id || 0);
  if (tabId) {
    state.sourceTabId = tabId;
  }
  return tabId;
}

function audioToVideo(audioSec) {
  return estimateVideoSec(audioSec, state.timeline.offsetSec);
}

function applyTimelineFromVideo(videoCurrentSec, paused) {
  if (!state.timeline.initialized) {
    state.timeline.offsetSec = reanchorOffset(videoCurrentSec, state.audio.capturedSec);
    state.timeline.initialized = true;
    return;
  }

  const next = nextOffset(
    state.timeline.offsetSec,
    state.audio.capturedSec,
    videoCurrentSec,
    paused
  );
  state.timeline.offsetSec = next.offsetSec;
  state.timeline.initialized = true;
}

function buildDispatchTask(rawTask) {
  return {
    taskKind: rawTask.taskKind,
    audio: rawTask.audio,
    windowStart: audioToVideo(rawTask.startAudioSec),
    windowEnd: audioToVideo(rawTask.endAudioSec)
  };
}

function dispatchLocalTask(task, options = {}) {
  const allowWhenStopping = Boolean(options.allowWhenStopping);
  if (!task || !state.workerReady) return;
  if (!state.running && !allowWhenStopping) return;

  if (state.workerBusy) {
    if (task.taskKind === 'final') {
      state.queuedFinalTask = task;
    }
    return;
  }

  const requestId = ++state.requestId;
  state.pendingRequests.set(requestId, {
    sentAt: Date.now(),
    taskKind: task.taskKind,
    windowStart: task.windowStart,
    windowEnd: task.windowEnd
  });

  state.workerBusy = true;
  state.worker.postMessage(
    {
      type: 'transcribe',
      requestId,
      taskKind: task.taskKind,
      audio: task.audio,
      currentTime: task.windowEnd,
      windowStart: task.windowStart,
      windowEnd: task.windowEnd
    },
    [task.audio.buffer]
  );
}

async function dispatchCloudTask(task, options = {}) {
  const allowWhenStopping = Boolean(options.allowWhenStopping);
  if (!task) return;
  if (!state.running && !allowWhenStopping) return;

  const startedAt = Date.now();
  const result = await cloudAsr.transcribe(task, cloudSettings());
  setLatencyTag(Date.now() - startedAt);

  if (!state.running && !allowWhenStopping) return;

  if (result.ok && result.text) {
    addFinalSubtitleItem(
      result.text,
      Number.isFinite(result.startSec) ? result.startSec : task.windowStart,
      Number.isFinite(result.endSec) ? result.endSec : task.windowEnd
    );
    setStatus('success', '云端终稿已校正');
    removeInterimSubtitle();
    renderSubtitles();
    return;
  }

  if (state.cloud.provider === 'hybrid' && state.workerReady) {
    setStatus('info', `云端识别失败，回退本地：${result.error || '未知错误'}`);
    dispatchLocalTask(task, options);
    return;
  }

  setStatus('error', `云端识别失败：${result.error || '未知错误'}`);
}

function dispatchTask(task, options = {}) {
  const allowWhenStopping = Boolean(options.allowWhenStopping);
  if (!task) return;
  if (!state.running && !allowWhenStopping) return;

  if (task.taskKind === 'final' && cloudEnabled()) {
    dispatchCloudTask(task, options);
    return;
  }

  if (localEnabledForTask(task.taskKind)) {
    dispatchLocalTask(task, options);
  }
}

function dispatchPendingFinal() {
  if (!state.running || !state.workerReady || state.workerBusy || !state.queuedFinalTask) return;
  const task = state.queuedFinalTask;
  state.queuedFinalTask = null;
  dispatchLocalTask(task);
}

function processChunk(pcm16k, startAudioSec, endAudioSec) {
  const chunk = {
    data: pcm16k,
    rms: calcRms(pcm16k),
    startAudioSec,
    endAudioSec
  };

  const useInterim = state.selectedMode === 'live' && (state.cloud.provider === 'local' || state.cloud.provider === 'hybrid');
  const tasks = segmenter.pushChunk(chunk, state.selectedMode, useInterim);
  for (const rawTask of tasks) {
    dispatchTask(buildDispatchTask(rawTask));
  }

  dispatchPendingFinal();
}

function onMonoSamples(monoSamples, inputRate) {
  const pcm16k = downsampleTo16k(monoSamples, inputRate);
  if (!pcm16k.length) return;

  const startAudioSec = state.audio.capturedSec;
  const endAudioSec = startAudioSec + pcm16k.length / ASR_SAMPLE_RATE;
  state.audio.capturedSec = endAudioSec;

  processChunk(pcm16k, startAudioSec, endAudioSec);
}

function onInputBuffer(inputBuffer, inputRate) {
  const mono = getMonoChannel(inputBuffer);
  onMonoSamples(mono, inputRate);
}

function handleWorkerResult(msg) {
  state.workerBusy = false;
  const meta = state.pendingRequests.get(msg.requestId);
  state.pendingRequests.delete(msg.requestId);

  if (meta) {
    setLatencyTag(Date.now() - meta.sentAt);
  }

  const taskKind = msg.taskKind || meta?.taskKind || 'final';
  const text = cleanTranscript(msg.text || '');
  const startSec = Number(msg.windowStart || meta?.windowStart || 0);
  const endSec = Number(msg.windowEnd || meta?.windowEnd || startSec);

  if (taskKind === 'interim') {
    if (text) {
      upsertInterimSubtitle(text, startSec, endSec);
      setStatus('info', '实时字幕更新中...');
    }
  } else {
    if (text) {
      addFinalSubtitleItem(text, startSec, endSec);
      setStatus('success', '实时字幕识别中...');
    }
    removeInterimSubtitle();
    renderSubtitles();
  }

  dispatchPendingFinal();
}

function handleWorkerMessage(event) {
  const msg = event.data || {};

  if (msg.type === 'status') {
    if (msg.level === 'warn' && typeof msg.text === 'string' && msg.text.trim()) {
      setStatus('loading', `模型日志: ${msg.text.trim()}`);
    }
    return;
  }

  if (msg.type === 'ready') {
    state.workerReady = true;
    state.workerModelName = state.selectedModelName;
    refreshEngineTag();
    return;
  }

  if (msg.type === 'result') {
    handleWorkerResult(msg);
    return;
  }

  if (msg.type === 'error') {
    state.workerBusy = false;
    setStatus('error', `转录失败: ${msg.error || '未知错误'}`);
    dispatchPendingFinal();
    return;
  }

  if (msg.type === 'disposed') {
    state.workerReady = false;
    state.workerModelName = '';
  }
}

async function discoverAvailableModels() {
  const models = [];

  for (const item of MODEL_CANDIDATES) {
    const url = chrome.runtime.getURL(item.file);
    let ok = false;
    let bytes = 0;

    const headResp = await fetch(url, { method: 'HEAD' });
    if (headResp.ok) {
      ok = true;
      bytes = Number(headResp.headers.get('content-length') || 0);
    } else {
      const getResp = await fetch(url, { method: 'GET' });
      ok = getResp.ok;
      bytes = Number(getResp.headers.get('content-length') || 0);
      getResp.body?.cancel();
    }

    if (ok) {
      models.push({ ...item, url, bytes });
    }
  }

  state.availableModels = models;
}

function refreshModelSelect() {
  const el = state.ui.modelSelect;
  if (!el) return;

  el.innerHTML = '';

  for (const item of state.availableModels) {
    const option = document.createElement('option');
    option.value = item.name;
    option.textContent = item.label;
    el.appendChild(option);
  }

  if (!state.availableModels.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未检测到模型';
    el.appendChild(option);
    el.disabled = true;
    updateProviderUiState();
    return;
  }

  el.disabled = false;
  const picked = state.availableModels.find((x) => x.name === state.selectedModelName) || state.availableModels[0];
  state.selectedModelName = picked.name;
  state.selectedModelUrl = picked.url;
  el.value = picked.name;
  updateProviderUiState();
}

async function loadUserSettings() {
  const data = await chrome.storage.local.get(USER_SETTING_KEYS);
  if (typeof data.asr_model === 'string') {
    state.selectedModelName = data.asr_model;
  }
  if (typeof data.caption_mode === 'string') {
    state.selectedMode = resolveModeConfig(data.caption_mode).key;
  }
  if (typeof data.asr_provider === 'string') {
    state.cloud.provider = normalizeProvider(data.asr_provider);
  }
  if (typeof data.cloud_api_base === 'string' && data.cloud_api_base.trim()) {
    state.cloud.apiBase = data.cloud_api_base.trim();
  }
  if (typeof data.cloud_api_key === 'string') {
    state.cloud.apiKey = data.cloud_api_key.trim();
  }
  if (typeof data.cloud_model === 'string' && data.cloud_model.trim()) {
    state.cloud.model = data.cloud_model.trim();
  }
  if (typeof data.cloud_language === 'string' && data.cloud_language.trim()) {
    state.cloud.language = data.cloud_language.trim();
  }
}

async function saveUserSettings() {
  await chrome.storage.local.set({
    asr_model: state.selectedModelName,
    caption_mode: state.selectedMode,
    asr_provider: state.cloud.provider,
    cloud_api_base: state.cloud.apiBase,
    cloud_api_key: state.cloud.apiKey,
    cloud_model: state.cloud.model,
    cloud_language: state.cloud.language
  });
}

async function ensureWorkerReady() {
  const picked = state.availableModels.find((x) => x.name === state.selectedModelName);
  if (!picked) {
    throw new Error('当前未检测到可用模型，请确认 wasm 目录存在模型文件');
  }
  state.selectedModelUrl = picked.url;

  if (state.workerReady && state.worker && state.workerModelName === state.selectedModelName) {
    return;
  }
  if (state.workerInitPromise) {
    await state.workerInitPromise;
    return;
  }

  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
    state.workerReady = false;
  }

  state.worker = new Worker(chrome.runtime.getURL('asr-worker.js'));
  state.worker.onmessage = handleWorkerMessage;
  state.worker.onerror = (event) => {
    state.workerBusy = false;
    setStatus('error', `ASR Worker 出错: ${event.message || '未知错误'}`);
  };

  state.workerInitPromise = new Promise((resolve, reject) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('Whisper 初始化超时，请重试'));
    }, 90000);

    const listener = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ready' && !done) {
        done = true;
        clearTimeout(timeout);
        state.worker.removeEventListener('message', listener);
        resolve();
      }
      if (msg.type === 'error' && !done) {
        done = true;
        clearTimeout(timeout);
        state.worker.removeEventListener('message', listener);
        reject(new Error(msg.error || 'Whisper 初始化失败'));
      }
    };

    state.worker.addEventListener('message', listener);
  });

  state.worker.postMessage({
    type: 'init',
    streamJsUrl: chrome.runtime.getURL('wasm/stream.wasm/stream.js'),
    modelUrl: state.selectedModelUrl,
    preferredLanguage: 'auto',
    fallbackLanguage: 'zh'
  });
  setEngineTag(`Whisper(${state.selectedModelName}, 加载中...)`);
  await state.workerInitPromise.finally(() => {
    state.workerInitPromise = null;
  });
}

function cleanupAudioPipeline() {
  if (state.audio.worklet) {
    state.audio.worklet.port.onmessage = null;
    state.audio.worklet.disconnect();
  }
  if (state.audio.processor) {
    state.audio.processor.onaudioprocess = null;
    state.audio.processor.disconnect();
  }
  if (state.audio.source) {
    state.audio.source.disconnect();
  }
  if (state.audio.muteGain) {
    state.audio.muteGain.disconnect();
  }

  if (state.audio.mediaStream) {
    for (const track of state.audio.mediaStream.getTracks()) {
      track.stop();
    }
  }
  if (state.audio.context) {
    if (state.audio.context.state !== 'closed') {
      state.audio.context.close();
    }
  }

  state.audio.mediaStream = null;
  state.audio.context = null;
  state.audio.source = null;
  state.audio.worklet = null;
  state.audio.processor = null;
  state.audio.muteGain = null;
  state.audio.capturedSec = 0;
}

async function initAudioPipeline() {
  const tabId = await ensureSourceTabId();
  if (!tabId) throw new Error('无法确定目标标签页');

  const streamIdResp = await runtimeMessage({ type: 'getTabAudioStreamId', sourceTabId: tabId });
  if (streamIdResp?.status !== 'success' || !streamIdResp.streamId) {
    throw new Error(streamIdResp?.msg || '未拿到 tab 音频流 ID');
  }

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamIdResp.streamId
      }
    },
    video: false
  });

  const audioContext = new AudioContext({ latencyHint: 'interactive' });
  const sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const muteGainNode = audioContext.createGain();
  muteGainNode.gain.value = 0;
  muteGainNode.connect(audioContext.destination);

  let workletNode = null;
  let processorNode = null;

  const fallback = (reasonText) => {
    processorNode = audioContext.createScriptProcessor(modeConfig().fallbackBlockSize, 1, 1);
    processorNode.onaudioprocess = (event) => {
      onInputBuffer(event.inputBuffer, audioContext.sampleRate);
    };
    sourceNode.connect(processorNode);
    processorNode.connect(muteGainNode);
    setStatus('info', '音频采集模式: ScriptProcessor（兼容模式，' + reasonText + '）');
  };

  const canUseWorklet = (
    typeof AudioWorkletNode !== 'undefined'
    && !!audioContext.audioWorklet
    && typeof audioContext.audioWorklet.addModule === 'function'
  );

  if (canUseWorklet) {
    try {
      await audioContext.audioWorklet.addModule(chrome.runtime.getURL('popup/audio-capture-processor.js'));
      workletNode = new AudioWorkletNode(audioContext, 'audio-capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: {
          blockSize: modeConfig().workletBlockSize
        }
      });
      workletNode.port.onmessage = (event) => {
        const monoSamples = event.data;
        if (!(monoSamples instanceof Float32Array)) return;
        onMonoSamples(monoSamples, audioContext.sampleRate);
      };
      sourceNode.connect(workletNode);
      workletNode.connect(muteGainNode);
      setStatus('info', '音频采集模式: AudioWorklet');
    } catch (error) {
      fallback(`AudioWorklet 初始化失败: ${error.message}`);
    }
  } else {
    fallback('浏览器不支持 AudioWorklet');
  }

  await audioContext.resume();

  state.audio.mediaStream = mediaStream;
  state.audio.context = audioContext;
  state.audio.source = sourceNode;
  state.audio.worklet = workletNode;
  state.audio.processor = processorNode;
  state.audio.muteGain = muteGainNode;
}

function stopSyncTimer() {
  if (state.syncTimer) {
    clearInterval(state.syncTimer);
    state.syncTimer = null;
  }
}

async function syncTimeline() {
  if (!state.running) return;

  const tabId = await ensureSourceTabId();
  if (!tabId) return;
  const resp = await runtimeMessage({ type: 'getVideoState', tabId });
  if (!resp?.hasVideo) {
    setStatus('error', '未检测到视频元素，时间轴暂停校准');
    return;
  }
  applyTimelineFromVideo(Number(resp.currentTime || 0), Boolean(resp.paused));
  state.lastVideoState = {
    hasVideo: true,
    currentTime: Number(resp.currentTime || 0),
    paused: Boolean(resp.paused),
    duration: Number(resp.duration || 0)
  };
}

function startSyncTimer() {
  stopSyncTimer();
  state.syncTimer = setInterval(syncTimeline, modeConfig().timelineSyncMs);
}

async function precheckVideo() {
  const tabId = await ensureSourceTabId();
  if (!tabId) throw new Error('未找到目标标签页');

  const pingResp = await runtimeMessage({ type: 'pingVideo', tabId });
  if (!pingResp?.hasVideo) throw new Error('当前页面未检测到可播放视频');

  const stateResp = await runtimeMessage({ type: 'getVideoState', tabId });
  if (!stateResp?.hasVideo) throw new Error('无法读取视频时间状态');

  state.lastVideoState = {
    hasVideo: true,
    currentTime: Number(stateResp.currentTime || 0),
    paused: Boolean(stateResp.paused),
    duration: Number(stateResp.duration || 0)
  };

  state.timeline.offsetSec = reanchorOffset(state.lastVideoState.currentTime, state.audio.capturedSec);
  state.timeline.initialized = true;
}

async function startRealtimeSubtitles() {
  if (state.running) return;
  setStatus('loading', '检测视频中...');

  try {
    await precheckVideo();

    if ((state.cloud.provider === 'cloud' || state.cloud.provider === 'hybrid') && !cloudEnabled()) {
      throw new Error('已启用云端识别，但缺少 API Key 或 API Base');
    }

    state.audio.capturedSec = 0;
    state.queuedFinalTask = null;
    state.pendingRequests.clear();
    state.workerBusy = false;
    cloudAsr.clearQueue();
    segmenter.reset();
    removeInterimSubtitle();
    renderSubtitles();

    if (needsLocalWorker()) {
      setStatus('loading', `加载本地模型中（${state.selectedModelName}）...`);
      await ensureWorkerReady();
    } else {
      if (state.worker) {
        state.worker.postMessage({ type: 'dispose' });
        state.worker.terminate();
      }
      state.worker = null;
      state.workerReady = false;
      refreshEngineTag();
    }

    setStatus('loading', '连接标签页音频流...');
    await initAudioPipeline();

    state.running = true;
    setButtonsState();
    startSyncTimer();
    setLatencyTag(0);
    refreshEngineTag();
    setStatus('success', '实时字幕已启动（' + modeConfig().label + '）');
  } catch (error) {
    cleanupAudioPipeline();
    state.running = false;
    setButtonsState();
    setStatus('error', `启动失败: ${error.message}`);
  }
}

function stopRealtimeSubtitles() {
  if (!state.running) {
    setStatus('info', '当前未在运行实时字幕');
    return;
  }

  const tail = segmenter.flushFinal(state.selectedMode, true);
  if (tail) {
    dispatchTask(buildDispatchTask(tail), { allowWhenStopping: true });
  }

  state.running = false;
  segmenter.reset();
  stopSyncTimer();
  cleanupAudioPipeline();
  setButtonsState();
  setLatencyTag(0);
  removeInterimSubtitle();
  renderSubtitles();
  setStatus('success', '实时字幕已停止');
}

async function restartWithSettings(reasonText) {
  if (!state.running) {
    setStatus('info', reasonText);
    return;
  }
  setStatus('loading', `${reasonText}，正在重启...`);
  stopRealtimeSubtitles();
  await startRealtimeSubtitles();
}

async function jumpToSubtitleTime(seconds, rowEl) {
  const tabId = await ensureSourceTabId();
  if (!tabId) {
    setStatus('error', '目标标签页不存在，无法跳转');
    return;
  }

  try {
    const resp = await runtimeMessage({ type: 'jumpToTime', tabId, seconds: Number(seconds || 0) });
    if (resp?.status !== 'success') {
      setStatus('error', `跳转失败: ${resp?.msg || '未知错误'}`);
      return;
    }

    document.querySelectorAll('.subtitle-item.active').forEach((el) => el.classList.remove('active'));
    if (rowEl) rowEl.classList.add('active');

    setStatus('success', `已跳转到 ${formatTime(seconds)}`);
    setTimeout(syncTimeline, 120);
  } catch (error) {
    setStatus('error', `跳转失败: ${error.message}`);
  }
}

function pickUiElements() {
  state.ui.status = document.getElementById('status');
  state.ui.subtitleList = document.getElementById('subtitleList');
  state.ui.startBtn = document.getElementById('startBtn');
  state.ui.stopBtn = document.getElementById('stopBtn');
  state.ui.engineTag = document.getElementById('engineTag');
  state.ui.latencyTag = document.getElementById('latencyTag');
  state.ui.countTag = document.getElementById('countTag');
  state.ui.providerSelect = document.getElementById('providerSelect');
  state.ui.localModelField = document.getElementById('localModelField');
  state.ui.modelSelect = document.getElementById('modelSelect');
  state.ui.modeSelect = document.getElementById('modeSelect');
  state.ui.cloudLanguageField = document.getElementById('cloudLanguageField');
  state.ui.cloudModelSection = document.getElementById('cloudModelSection');
  state.ui.cloudKeySection = document.getElementById('cloudKeySection');
  state.ui.cloudLanguageSelect = document.getElementById('cloudLanguageSelect');
  state.ui.cloudModelInput = document.getElementById('cloudModelInput');
  state.ui.cloudApiBaseInput = document.getElementById('cloudApiBaseInput');
  state.ui.cloudApiKeyInput = document.getElementById('cloudApiKeyInput');
}

function bindEvents() {
  state.ui.startBtn?.addEventListener('click', startRealtimeSubtitles);
  state.ui.stopBtn?.addEventListener('click', stopRealtimeSubtitles);

  state.ui.subtitleList?.addEventListener('click', (event) => {
    const row = event.target.closest('.subtitle-item');
    if (!row || row.getAttribute('data-interim') === '1') return;
    const seconds = Number(row.getAttribute('data-time') || 0);
    jumpToSubtitleTime(seconds, row);
  });

  const onModelSelectChange = async () => {
    const value = state.ui.modelSelect.value;
    const picked = state.availableModels.find((x) => x.name === value);
    if (!picked) return;
    state.selectedModelName = picked.name;
    state.selectedModelUrl = picked.url;
    await saveUserSettings();
    await restartWithSettings(`模型已切换为 ${picked.label}`);
  };
  state.ui.modelSelect?.addEventListener('change', onModelSelectChange);
  state.ui.modelSelect?.addEventListener('input', onModelSelectChange);

  const onModeSelectChange = async () => {
    const value = state.ui.modeSelect.value;
    state.selectedMode = resolveModeConfig(value).key;
    await saveUserSettings();
    refreshEngineTag();
    await restartWithSettings(`字幕模式已切换为 ${modeConfig().label}`);
  };
  state.ui.modeSelect?.addEventListener('change', onModeSelectChange);
  state.ui.modeSelect?.addEventListener('input', onModeSelectChange);

  const onProviderSelectChange = async () => {
    state.cloud.provider = normalizeProvider(state.ui.providerSelect.value);
    refreshEngineTag();
    updateProviderUiState();
    await saveUserSettings();
    await restartWithSettings(`识别引擎已切换为 ${state.ui.providerSelect.options[state.ui.providerSelect.selectedIndex]?.text || state.cloud.provider}`);
  };
  state.ui.providerSelect?.addEventListener('change', onProviderSelectChange);
  state.ui.providerSelect?.addEventListener('input', onProviderSelectChange);

  const onCloudLanguageChange = async () => {
    state.cloud.language = String(state.ui.cloudLanguageSelect.value || 'zh').trim() || 'zh';
    await saveUserSettings();
    await restartWithSettings(`云端语言已切换为 ${state.cloud.language}`);
  };
  state.ui.cloudLanguageSelect?.addEventListener('change', onCloudLanguageChange);
  state.ui.cloudLanguageSelect?.addEventListener('input', onCloudLanguageChange);

  const commitCloudModel = async () => {
    if (!state.ui.cloudModelInput) return;
    const value = String(state.ui.cloudModelInput.value || '').trim();
    state.cloud.model = value || 'whisper-1';
    state.ui.cloudModelInput.value = state.cloud.model;
    await saveUserSettings();
    await restartWithSettings(`云端模型已切换为 ${state.cloud.model}`);
  };
  state.ui.cloudModelInput?.addEventListener('change', commitCloudModel);
  state.ui.cloudModelInput?.addEventListener('blur', commitCloudModel);

  const commitCloudApiBase = async () => {
    if (!state.ui.cloudApiBaseInput) return;
    const value = String(state.ui.cloudApiBaseInput.value || '').trim();
    state.cloud.apiBase = value || 'https://api.openai.com/v1';
    state.ui.cloudApiBaseInput.value = state.cloud.apiBase;
    await saveUserSettings();
    await restartWithSettings('云端 API Base 已更新');
  };
  state.ui.cloudApiBaseInput?.addEventListener('change', commitCloudApiBase);
  state.ui.cloudApiBaseInput?.addEventListener('blur', commitCloudApiBase);

  const commitCloudApiKey = async () => {
    if (!state.ui.cloudApiKeyInput) return;
    state.cloud.apiKey = String(state.ui.cloudApiKeyInput.value || '').trim();
    await saveUserSettings();
    if (state.cloud.provider === 'cloud' || state.cloud.provider === 'hybrid') {
      await restartWithSettings('云端 API Key 已更新');
    }
  };
  state.ui.cloudApiKeyInput?.addEventListener('change', commitCloudApiKey);
  state.ui.cloudApiKeyInput?.addEventListener('blur', commitCloudApiKey);

  window.addEventListener('beforeunload', () => {
    stopRealtimeSubtitles();
    if (state.worker) {
      state.worker.postMessage({ type: 'dispose' });
    }
  });
}

async function prepareSettingsUi() {
  await loadUserSettings();
  await discoverAvailableModels();
  const beforeModel = state.selectedModelName;
  refreshModelSelect();
  if (state.selectedModelName !== beforeModel) {
    await saveUserSettings();
  }

  if (state.ui.modeSelect) {
    state.ui.modeSelect.value = modeConfig().key;
  }
  if (state.ui.providerSelect) {
    state.cloud.provider = normalizeProvider(state.cloud.provider);
    state.ui.providerSelect.value = state.cloud.provider;
  }
  if (state.ui.cloudLanguageSelect) {
    const hasLanguage = Array.from(state.ui.cloudLanguageSelect.options).some((x) => x.value === state.cloud.language);
    state.cloud.language = hasLanguage ? state.cloud.language : 'zh';
    state.ui.cloudLanguageSelect.value = state.cloud.language;
  }
  if (state.ui.cloudModelInput) {
    state.ui.cloudModelInput.value = state.cloud.model || 'whisper-1';
  }
  if (state.ui.cloudApiBaseInput) {
    state.ui.cloudApiBaseInput.value = state.cloud.apiBase || 'https://api.openai.com/v1';
  }
  if (state.ui.cloudApiKeyInput) {
    state.ui.cloudApiKeyInput.value = state.cloud.apiKey || '';
  }
  updateProviderUiState();

  if (!state.availableModels.length && needsLocalWorker()) {
    throw new Error('未找到可用模型，请把 ggml-tiny.bin 或 ggml-base.bin 放到 wasm 目录');
  }

  if (state.availableModels.length && state.availableModels.every((m) => Number(m.bytes || 0) === 0)) {
    setStatus('info', '模型列表已加载（未获取到文件大小，启动时将自动校验模型文件）');
  }
  if ((state.cloud.provider === 'cloud' || state.cloud.provider === 'hybrid') && !state.cloud.apiKey) {
    setStatus('info', '当前为云端识别模式，请先填写云端 API Key');
  }
  refreshEngineTag();
}

async function init() {
  initSourceTabIdFromQuery();
  pickUiElements();
  bindEvents();
  renderSubtitles();
  setButtonsState();

  try {
    await ensureSourceTabId();
    if (!state.sourceTabId) {
      setStatus('error', '未找到目标标签页，请从视频页点击插件图标打开');
      return;
    }

    await prepareSettingsUi();

    const pingResp = await runtimeMessage({ type: 'pingVideo', tabId: state.sourceTabId });
    if (!pingResp?.hasVideo) {
      setStatus('info', '当前标签页未检测到视频，打开视频后再启动');
      return;
    }

    if ((state.cloud.provider === 'cloud' || state.cloud.provider === 'hybrid') && !state.cloud.apiKey) {
      setStatus('info', '准备完成：请先填写云端 API Key，再启动实时字幕');
    } else {
      setStatus('info', '准备完成，点击启动实时字幕开始');
    }
  } catch (error) {
    setStatus('error', `初始化失败: ${error.message}`);
  }
}

document.addEventListener('DOMContentLoaded', init);
