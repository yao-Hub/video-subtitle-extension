import type {
  PageVideoStateMessage,
  RuntimeResponse,
  VideoState
} from '../../../packages/protocol/src/index';

const bridgeState = globalThis as typeof globalThis & {
  __videoSubtitleBridgeInstalled?: boolean;
};

if (!bridgeState.__videoSubtitleBridgeInstalled) {
  bridgeState.__videoSubtitleBridgeInstalled = true;
  const videoIds = new WeakMap<HTMLVideoElement, string>();
  const bridgeId = crypto.randomUUID();
  let nextVideoId = 1;
  let videoStateSequence = 0;

  function getVideoId(video: HTMLVideoElement): string {
    let videoId = videoIds.get(video);
    if (!videoId) {
      videoId = `${bridgeId}_video_${nextVideoId}`;
      nextVideoId += 1;
      videoIds.set(video, videoId);
    }
    return videoId;
  }

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
    videoStateSequence += 1;
    const video = pickBestVideo();
    if (!video) {
      return {
        hasVideo: false,
        videoId: '',
        sequence: videoStateSequence,
        currentTime: 0,
        paused: true,
        playbackRate: 1
      };
    }

    return {
      hasVideo: true,
      videoId: getVideoId(video),
      sequence: videoStateSequence,
      currentTime: Number(video.currentTime || 0),
      paused: video.paused,
      playbackRate: Number(video.playbackRate || 1)
    };
  }

  function emitVideoState(): void {
    const message: PageVideoStateMessage = {
      target: 'background',
      type: 'page.video-state',
      state: getVideoState()
    };
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  let boundaryTimer: number | null = null;

  for (const eventName of [
    'play',
    'pause',
    'seeking',
    'seeked',
    'ratechange',
    'ended',
    'loadedmetadata',
    'waiting',
    'stalled'
  ]) {
    document.addEventListener(eventName, (event) => {
      if (event.target instanceof HTMLVideoElement) {
        emitVideoState();
      }
    }, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'page.get-video-state') {
      sendResponse(getVideoState());
      return;
    }

    if (message?.type === 'page.schedule-boundary') {
      if (boundaryTimer !== null) {
        window.clearTimeout(boundaryTimer);
        boundaryTimer = null;
      }
      if (message.boundaryVideoTimeMs === null) {
        sendResponse({ ok: true } satisfies RuntimeResponse);
        return;
      }
      const boundaryVideoTimeMs = Number(message.boundaryVideoTimeMs);
      const video = pickBestVideo();
      if (
        !video
        || video.paused
        || !Number.isFinite(boundaryVideoTimeMs)
        || message.videoId !== getVideoId(video)
      ) {
        sendResponse({ ok: true } satisfies RuntimeResponse);
        return;
      }
      const delayMs = (
        boundaryVideoTimeMs - video.currentTime * 1000
      ) / Math.max(0.1, video.playbackRate);
      if (delayMs <= 0) {
        emitVideoState();
        sendResponse({ ok: true } satisfies RuntimeResponse);
        return;
      }
      boundaryTimer = window.setTimeout(() => {
        boundaryTimer = null;
        const currentVideo = pickBestVideo();
        if (!currentVideo || getVideoId(currentVideo) !== message.videoId) {
          return;
        }
        emitVideoState();
      }, delayMs);
      sendResponse({ ok: true } satisfies RuntimeResponse);
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

