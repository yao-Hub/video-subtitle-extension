import type { RuntimeResponse, VideoState } from '../../../packages/protocol/src/index';

const bridgeState = globalThis as typeof globalThis & {
  __videoSubtitleBridgeInstalled?: boolean;
};

if (!bridgeState.__videoSubtitleBridgeInstalled) {
  bridgeState.__videoSubtitleBridgeInstalled = true;

  function pickBestVideo(): HTMLVideoElement | null {
    const videos = Array.from(document.querySelectorAll('video'));
    let best: HTMLVideoElement | null = null;
    let bestScore = -1;

    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const visibleBoost = rect.width > 120 && rect.height > 80 ? 1_000_000 : 0;
      const playingBoost = !video.paused && !video.ended ? 500_000 : 0;
      const score = area + visibleBoost + playingBoost;
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }

    return best;
  }

  function getVideoState(): VideoState {
    const video = pickBestVideo();
    if (!video) {
      return {
        hasVideo: false,
        currentTime: 0
      };
    }

    return {
      hasVideo: true,
      currentTime: Number(video.currentTime || 0)
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'page.get-video-state') {
      sendResponse(getVideoState());
      return;
    }

    if (message?.type === 'page.jump-to-time') {
      const video = pickBestVideo();
      if (!video) {
        sendResponse({
          ok: false,
          error: '当前页面未找到视频'
        } satisfies RuntimeResponse);
        return;
      }

      const seconds = Number(message.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) {
        sendResponse({
          ok: false,
          error: '跳转时间无效'
        } satisfies RuntimeResponse);
        return;
      }

      video.currentTime = seconds;
      void video.play().catch(() => undefined);
      sendResponse({ ok: true } satisfies RuntimeResponse);
    }
  });
}

