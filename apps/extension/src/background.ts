import type {
  ExtensionRequest,
  InferenceEvent,
  OffscreenRequestMessage,
  PanelContext,
  PanelEventMessage,
  RuntimeResponse,
  SessionRuntimeState,
  VideoState
} from '../../../packages/protocol/src/index';

let runtimeState: SessionRuntimeState = {
  running: false,
  sourceTabId: 0,
  startedAtEpochMs: 0
};
let panelWindowId: number | null = null;
const PANEL_WINDOW_KEY = 'panelWindowId';
const RUNTIME_STATE_KEY = 'runtimeState';
const runtimeStateReady = chrome.storage.session.get(RUNTIME_STATE_KEY)
  .then((stored) => {
    if (stored[RUNTIME_STATE_KEY]) {
      runtimeState = stored[RUNTIME_STATE_KEY] as SessionRuntimeState;
    }
  })
  .catch((error) => console.error(error));

async function setRuntimeState(next: SessionRuntimeState): Promise<void> {
  runtimeState = next;
  await chrome.storage.session.set({ [RUNTIME_STATE_KEY]: next })
    .catch((error) => console.error(error));
}

async function setPanelWindowId(windowId: number | null): Promise<void> {
  panelWindowId = windowId;
  const operation = windowId === null
    ? chrome.storage.session.remove(PANEL_WINDOW_KEY)
    : chrome.storage.session.set({ [PANEL_WINDOW_KEY]: windowId });
  await operation.catch((error) => console.error(error));
}

function success<T>(data: T): RuntimeResponse<T> {
  return { ok: true, data };
}

async function sendPageRequest<T>(
  tabId: number,
  request: Record<string, unknown>
): Promise<T> {
  const send = async (): Promise<T> => {
    const response = await chrome.tabs.sendMessage(tabId, request) as T | undefined;
    if (response === undefined) {
      throw new Error('页面脚本无响应');
    }
    return response;
  };
  try {
    return await send();
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-bridge.js']
    });
    return await send();
  }
}

async function getVideoState(tabId: number): Promise<VideoState> {
  try {
    return await sendPageRequest<VideoState>(tabId, {
      type: 'page.get-video-state'
    });
  } catch {
    return {
      hasVideo: false,
      currentTime: 0
    };
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: [
      chrome.offscreen.Reason.USER_MEDIA,
      chrome.offscreen.Reason.AUDIO_PLAYBACK
    ],
    justification: '捕获标签页音频并保持视频原声播放'
  });
}

function getTabMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        reject(new Error(
          chrome.runtime.lastError?.message || '无法申请标签页音频流'
        ));
        return;
      }
      resolve(streamId);
    });
  });
}

async function startSession(
  sourceTabId: number
): Promise<RuntimeResponse<SessionRuntimeState>> {
  await runtimeStateReady;
  if (runtimeState.running) {
    throw new Error('字幕会话已在运行');
  }
  if (!sourceTabId) {
    throw new Error('来源标签页无效');
  }
  const video = await getVideoState(sourceTabId);
  if (!video.hasVideo) {
    throw new Error('当前标签页未检测到视频');
  }

  const streamId = await getTabMediaStreamId(sourceTabId);
  await ensureOffscreenDocument();

  const message: OffscreenRequestMessage = {
    target: 'offscreen',
    request: {
      type: 'capture.start',
      streamId
    }
  };
  const response = await chrome.runtime.sendMessage(message) as
    RuntimeResponse<{ startedAtEpochMs: number }>;

  if (!response?.ok || !response.data?.startedAtEpochMs) {
    throw new Error(response?.error || '音频捕获启动失败');
  }

  await setRuntimeState({
    running: true,
    sourceTabId,
    startedAtEpochMs: response.data.startedAtEpochMs
  });
  return success(runtimeState);
}

async function stopSession(): Promise<RuntimeResponse<SessionRuntimeState>> {
  await runtimeStateReady;
  const hasOffscreen = await chrome.offscreen.hasDocument();
  if (!runtimeState.running && !hasOffscreen) {
    return success(runtimeState);
  }
  if (!hasOffscreen) {
    await setRuntimeState({
      running: false,
      sourceTabId: 0,
      startedAtEpochMs: 0
    });
    return success(runtimeState);
  }

  const message: OffscreenRequestMessage = {
    target: 'offscreen',
    request: { type: 'capture.stop' }
  };
  const response = await chrome.runtime.sendMessage(message) as RuntimeResponse;
  if (!response?.ok) {
    throw new Error(response?.error || '停止音频捕获失败');
  }

  await setRuntimeState({
    running: false,
    sourceTabId: 0,
    startedAtEpochMs: 0
  });
  return success(runtimeState);
}

async function getPanelContext(sourceTabId?: number): Promise<PanelContext> {
  let tabId = sourceTabId;
  if (!tabId) {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
      windowType: 'normal'
    });
    tabId = tabs[0]?.id;
    if (!tabId) {
      throw new Error('未找到活动标签页');
    }
  }
  const video = await getVideoState(tabId);

  return {
    tabId,
    video
  };
}

async function openPanel(sourceTabId: number): Promise<void> {
  await runtimeStateReady;
  const panelUrl = chrome.runtime.getURL(`panel.html?sourceTabId=${sourceTabId}`);
  const panelPrefix = chrome.runtime.getURL('panel.html');
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ['popup']
  });
  const panelWindows = windows.filter((window) => (
    window.id !== undefined
    && window.tabs?.some((tab) => tab.url?.startsWith(panelPrefix))
  ));
  const primaryWindow = panelWindows.find((window) => window.id === panelWindowId)
    || panelWindows[0];

  for (const window of panelWindows) {
    if (window.id !== primaryWindow?.id) {
      try {
        await chrome.windows.remove(window.id as number);
      } catch {
        // A stale panel window can already be closing.
      }
    }
  }

  if (primaryWindow?.id !== undefined) {
    const windowId = primaryWindow.id;
    await setPanelWindowId(windowId);
    try {
      await chrome.windows.update(windowId, { focused: true });
      if (runtimeState.running) {
        return;
      }
      const tabs = await chrome.tabs.query({ windowId });
      const panelTabId = tabs[0]?.id;
      if (panelTabId) {
        await chrome.tabs.update(panelTabId, { url: panelUrl });
      }
      return;
    } catch {
      await setPanelWindowId(null);
    }
  }

  const createdWindow = await chrome.windows.create({
    url: panelUrl,
    type: 'popup',
    width: 460,
    height: 780,
    focused: true
  });
  await setPanelWindowId(createdWindow?.id ?? null);
}

async function handleRequest(
  request: ExtensionRequest
): Promise<RuntimeResponse> {
  switch (request.type) {
    case 'panel.get-context':
      return success(await getPanelContext(request.sourceTabId));
    case 'panel.start':
      return startSession(request.sourceTabId);
    case 'panel.stop':
      return stopSession();
    case 'panel.get-runtime-state':
      await runtimeStateReady;
      return success(runtimeState);
    case 'panel.get-video-state':
      return success(await getVideoState(request.tabId));
    case 'panel.jump-to-time': {
      const response = await sendPageRequest<RuntimeResponse>(
        request.tabId,
        {
          type: 'page.jump-to-time',
          seconds: request.seconds
        }
      );
      if (response.ok && runtimeState.running) {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          request: { type: 'capture.seek' }
        } satisfies OffscreenRequestMessage);
      }
      return response;
    }
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    void openPanel(tab.id).catch((error) => console.error(error));
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.get(PANEL_WINDOW_KEY)
    .then(async ({ [PANEL_WINDOW_KEY]: storedWindowId }) => {
      if (windowId !== panelWindowId && windowId !== storedWindowId) {
        return;
      }
      await setPanelWindowId(null);
      await stopSession();
    })
    .catch((error) => console.error(error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.target === 'background'
    && message.type === 'inference.event'
    && sender.url?.endsWith('/offscreen.html')
  ) {
    const event = message.event as InferenceEvent;
    if (event.type === 'session.error' && !event.recoverable) {
      void setRuntimeState({
        running: false,
        sourceTabId: 0,
        startedAtEpochMs: 0
      }).catch((error) => console.error(error));
    }
    const panelMessage: PanelEventMessage = {
      target: 'panel',
      type: 'inference.event',
      event
    };
    void chrome.runtime.sendMessage(panelMessage).catch(() => undefined);
    sendResponse({ ok: true });
    return;
  }

  if (message?.target !== 'background' || !message.request) {
    return;
  }

  void handleRequest(message.request as ExtensionRequest)
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies RuntimeResponse));
  return true;
});

