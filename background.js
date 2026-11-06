let popupWindowId = null;

function buildPopupUrl(sourceTabId) {
  return chrome.runtime.getURL(`popup/popup.html?sourceTabId=${sourceTabId}`);
}

function openOrFocusPopup(sourceTabId) {
  const popupUrl = buildPopupUrl(sourceTabId);

  if (!popupWindowId) {
    chrome.windows.create(
      {
        url: popupUrl,
        type: 'popup',
        width: 430,
        height: 720,
        focused: true
      },
      (createdWindow) => {
        popupWindowId = createdWindow?.id ?? null;
      }
    );
    return;
  }

  chrome.windows.update(popupWindowId, { focused: true }, () => {
    if (chrome.runtime.lastError) {
      popupWindowId = null;
      openOrFocusPopup(sourceTabId);
      return;
    }

    chrome.tabs.query({ windowId: popupWindowId }, (tabs) => {
      const popupTab = tabs?.[0];
      if (!popupTab?.id) {
        return;
      }
      chrome.tabs.update(popupTab.id, { url: popupUrl });
    });
  });
}

function proxyToTab(tabId, payload, sendResponse) {
  chrome.tabs.sendMessage(tabId, payload, (response) => {
    if (chrome.runtime.lastError) {
      sendResponse({
        status: 'error',
        msg: chrome.runtime.lastError.message || '向标签页发送消息失败'
      });
      return;
    }

    sendResponse(response || { status: 'success' });
  });
}

chrome.action.onClicked.addListener((tab) => {
  const sourceTabId = Number(tab?.id || 0);
  if (!sourceTabId) {
    return;
  }
  openOrFocusPopup(sourceTabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    sendResponse({ status: 'error', msg: '无效消息' });
    return;
  }

  if (message.type === 'getTabAudioStreamId') {
    const sourceTabId = Number(message.sourceTabId || 0);
    const consumerTabId = Number(sender?.tab?.id || 0);

    if (!sourceTabId || !consumerTabId) {
      sendResponse({ status: 'error', msg: '参数缺失，无法申请音频流' });
      return;
    }

    chrome.tabCapture.getMediaStreamId(
      {
        targetTabId: sourceTabId,
        consumerTabId
      },
      (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          sendResponse({
            status: 'error',
            msg: chrome.runtime.lastError?.message || '获取 tab 音频流 ID 失败'
          });
          return;
        }

        sendResponse({ status: 'success', streamId });
      }
    );

    return true;
  }

  if (message.type === 'getVideoState') {
    const tabId = Number(message.tabId || 0);
    if (!tabId) {
      sendResponse({ status: 'error', msg: 'tabId 无效' });
      return;
    }

    proxyToTab(tabId, { type: 'getVideoState' }, sendResponse);
    return true;
  }

  if (message.type === 'jumpToTime') {
    const tabId = Number(message.tabId || 0);
    if (!tabId) {
      sendResponse({ status: 'error', msg: 'tabId 无效' });
      return;
    }

    proxyToTab(
      tabId,
      {
        type: 'jumpToTime',
        seconds: Number(message.seconds || 0)
      },
      sendResponse
    );
    return true;
  }

  if (message.type === 'pingVideo') {
    const tabId = Number(message.tabId || 0);
    if (!tabId) {
      sendResponse({ status: 'error', msg: 'tabId 无效' });
      return;
    }

    proxyToTab(tabId, { type: 'pingVideo' }, sendResponse);
    return true;
  }

  sendResponse({ status: 'error', msg: `未知消息类型: ${message.type}` });
});
