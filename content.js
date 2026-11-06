let currentVideo = null;

function pickBestVideoElement() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (!videos.length) return null;

  let best = null;
  let bestScore = -1;

  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const visibleBoost = (rect.width > 120 && rect.height > 80) ? 1000000 : 0;
    const playingBoost = (!video.paused && !video.ended) ? 500000 : 0;
    const score = area + visibleBoost + playingBoost;

    if (score > bestScore) {
      bestScore = score;
      best = video;
    }
  }

  return best;
}

function ensureCurrentVideo() {
  const next = pickBestVideoElement();
  if (!next) {
    currentVideo = null;
    return null;
  }
  currentVideo = next;
  return currentVideo;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    sendResponse({ status: 'error', msg: '无效消息' });
    return;
  }

  if (message.type === 'getVideoState') {
    const video = ensureCurrentVideo();
    if (!video) {
      sendResponse({ hasVideo: false, currentTime: 0, paused: true, duration: 0 });
      return;
    }

    sendResponse({
      hasVideo: true,
      currentTime: Number(video.currentTime || 0),
      paused: !!video.paused,
      duration: Number(video.duration || 0)
    });
    return;
  }

  if (message.type === 'jumpToTime') {
    const video = ensureCurrentVideo();
    if (!video) {
      sendResponse({ status: 'error', msg: '未找到视频元素' });
      return;
    }

    const target = Math.max(0, Number(message.seconds || 0));
    video.currentTime = target;
    video.play();

    sendResponse({ status: 'success' });
    return;
  }

  if (message.type === 'pingVideo') {
    const video = ensureCurrentVideo();
    sendResponse({ hasVideo: !!video });
    return;
  }

  sendResponse({ status: 'error', msg: '未知消息类型' });
});

window.addEventListener('load', () => {
  ensureCurrentVideo();
});

document.addEventListener('DOMContentLoaded', () => {
  ensureCurrentVideo();
});

document.addEventListener('play', (event) => {
  if (event.target instanceof HTMLVideoElement) {
    currentVideo = event.target;
  }
}, true);
