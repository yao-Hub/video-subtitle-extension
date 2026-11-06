import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  captionsShareOverlappingText,
  normalizeCaptionText
} from './caption-text';
import {
  getNextRecognitionBoundary,
  shouldRecognizeAtTime
} from './recognition-gate';
import type {
  BackgroundRequestMessage,
  ExtensionRequest,
  FinalCaptionEvent,
  InferenceEvent,
  PanelContext,
  PanelEventMessage,
  PanelVideoStateMessage,
  RuntimeResponse,
  SessionRuntimeState,
  VideoState
} from '../../../packages/protocol/src/index';

type CaptionRow = Omit<FinalCaptionEvent, 'type'> & {
  type: 'caption.partial' | 'caption.final';
  videoStartMs: number;
  videoEndMs: number;
};

interface StatusState {
  type: 'idle' | 'active' | 'error';
  text: string;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    `${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
  ].join(':');
}

function timeRangesOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number
): boolean {
  return startA <= endB + 300 && startB <= endA + 300;
}

function shouldMergeFinalCaption(existing: CaptionRow, incoming: CaptionRow): boolean {
  if (
    existing.type !== 'caption.final'
    || !timeRangesOverlap(
      incoming.videoStartMs,
      incoming.videoEndMs,
      existing.videoStartMs,
      existing.videoEndMs
    )
  ) {
    return false;
  }
  return captionsShareOverlappingText(incoming.text, existing.text);
}

async function sendRequest<T>(request: ExtensionRequest): Promise<T> {
  const message: BackgroundRequestMessage = {
    target: 'background',
    request
  };
  const response = await chrome.runtime.sendMessage(message) as RuntimeResponse<T>;
  if (!response?.ok) {
    throw new Error(response?.error || '扩展后台没有返回结果');
  }
  return response.data as T;
}

function Panel(): React.JSX.Element {
  const [tabId, setTabId] = useState(0);
  const [video, setVideo] = useState<VideoState>({
    hasVideo: false,
    videoId: '',
    sequence: 0,
    currentTime: 0,
    paused: true,
    playbackRate: 1
  });
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<StatusState>({
    type: 'idle',
    text: '正在检查当前页面'
  });
  const [captions, setCaptions] = useState<CaptionRow[]>([]);
  const [latestProcessingMs, setLatestProcessingMs] = useState(0);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const startedAtRef = useRef(0);
  const timelineAnchorRef = useRef<{
    videoTimeMs: number;
    audioElapsedMs: number;
    playbackRate: number;
  } | null>(null);
  const tabIdRef = useRef(0);
  const runningRef = useRef(false);
  const captionListRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const lastSeekAtRef = useRef(0);
  const lastDeliverySequenceRef = useRef(0);
  const lastVideoSequenceRef = useRef(0);
  const activeRecognitionEpochRef = useRef(0);
  const lastVideoSyncRef = useRef<{
    videoId: string;
    currentTime: number;
    paused: boolean;
    playbackRate: number;
    syncedAt: number;
  } | null>(null);
  const captionsRef = useRef<CaptionRow[]>(captions);
  const videoStateRef = useRef(video);
  const recognitionPausedRef = useRef(false);
  captionsRef.current = captions;
  videoStateRef.current = video;

  function reportError(error: unknown, fallback: string): void {
    setStatus({
      type: 'error',
      text: error instanceof Error ? error.message : fallback
    });
  }

  function clearPartialCaptions(): void {
    const finals = captionsRef.current.filter(
      (caption) => caption.type === 'caption.final'
    );
    captionsRef.current = finals;
    setCaptions(finals);
  }

  function syncRecognitionGate(videoTimeMs: number): void {
    if (!runningRef.current) {
      return;
    }
    const shouldRecognize = shouldRecognizeAtTime(
      videoTimeMs,
      captionsRef.current
    );

    if (!shouldRecognize && !recognitionPausedRef.current) {
      recognitionPausedRef.current = true;
      setStatus({
        type: 'idle',
        text: '正在回放已生成字幕区间，识别已暂停'
      });
      clearPartialCaptions();
      void sendRequest({ type: 'panel.pause-recognition' }).catch((error) => {
        if (!recognitionPausedRef.current) {
          return;
        }
        recognitionPausedRef.current = false;
        reportError(error, '暂停识别失败');
      });
      return;
    }

    if (shouldRecognize && recognitionPausedRef.current) {
      recognitionPausedRef.current = false;
      setStatus({
        type: 'active',
        text: '继续识别未生成的时间区间'
      });
      void sendRequest({ type: 'panel.resume-recognition' }).catch((error) => {
        if (recognitionPausedRef.current) {
          return;
        }
        recognitionPausedRef.current = true;
        reportError(error, '恢复识别失败');
      });
    }
  }

  function scheduleVideoBoundary(nextVideo: VideoState): void {
    if (!tabIdRef.current) {
      return;
    }
    const boundaryVideoTimeMs = (
      runningRef.current && !nextVideo.paused
    )
      ? getNextRecognitionBoundary(
          nextVideo.currentTime * 1000,
          captionsRef.current
        )
      : null;
    void sendRequest({
      type: 'panel.schedule-video-boundary',
      tabId: tabIdRef.current,
      videoId: nextVideo.videoId,
      boundaryVideoTimeMs
    }).catch((error) => {
      reportError(error, '字幕边界调度失败');
    });
  }

  function updateOffset(nextVideo: VideoState, force = false): void {
    const previousVideoId = videoStateRef.current.videoId;
    if (previousVideoId && nextVideo.videoId !== previousVideoId) {
      captionsRef.current = [];
      setCaptions([]);
      setStatus({ type: 'idle', text: '视频已切换，等待字幕状态同步' });
    }
    videoStateRef.current = nextVideo;
    setVideo(nextVideo);
    if (!runningRef.current || !startedAtRef.current) {
      return;
    }
    const now = Date.now();
    const previous = lastVideoSyncRef.current;
    const elapsedSeconds = previous ? (now - previous.syncedAt) / 1000 : 0;
    const expectedDelta = (
      previous
      && !previous.paused
      && !nextVideo.paused
    )
      ? elapsedSeconds * nextVideo.playbackRate
      : 0;
    const actualDelta = previous
      ? nextVideo.currentTime - previous.currentTime
      : 0;
    const timelineChanged = (
      force
      || !previous
      || previous.videoId !== nextVideo.videoId
      || previous.paused !== nextVideo.paused
      || previous.playbackRate !== nextVideo.playbackRate
      || Math.abs(actualDelta - expectedDelta) > 0.75
    );
    if (timelineChanged) {
      timelineAnchorRef.current = {
        videoTimeMs: nextVideo.currentTime * 1000,
        audioElapsedMs: now - startedAtRef.current,
        playbackRate: nextVideo.playbackRate
      };
    }
    lastVideoSyncRef.current = {
      videoId: nextVideo.videoId,
      currentTime: nextVideo.currentTime,
      paused: nextVideo.paused,
      playbackRate: nextVideo.playbackRate,
      syncedAt: now
    };
    syncRecognitionGate(nextVideo.currentTime * 1000);
    scheduleVideoBoundary(nextVideo);
  }

  function getVideoTimeMs(audioUs: number): number {
    const anchor = timelineAnchorRef.current;
    if (!anchor) {
      return audioUs / 1000;
    }
    return (
      anchor.videoTimeMs
      + (audioUs / 1000 - anchor.audioElapsedMs) * anchor.playbackRate
    );
  }

  async function refreshContext(): Promise<PanelContext> {
    const sourceTabId = Number(
      new URLSearchParams(window.location.search).get('sourceTabId') || 0
    );
    const context = await sendRequest<PanelContext>({
      type: 'panel.get-context',
      sourceTabId: sourceTabId || undefined
    });
    setTabId(context.tabId);
    tabIdRef.current = context.tabId;
    lastVideoSequenceRef.current = context.video.sequence;
    updateOffset(context.video);
    return context;
  }

  useEffect(() => {
    void refreshContext()
      .then((context) => {
        if (!runningRef.current) {
          setStatus({
            type: 'idle',
            text: context.video.hasVideo
              ? '已检测到视频，可以启动字幕'
              : '当前标签页未检测到视频'
          });
        }
      })
      .catch((error) => {
        setStatus({
          type: 'error',
          text: error instanceof Error ? error.message : '无法读取当前页面'
        });
      });

    void sendRequest<SessionRuntimeState>({
      type: 'panel.get-runtime-state'
    }).then((state) => {
      runningRef.current = state.running;
      setRunning(state.running);
      startedAtRef.current = state.startedAtEpochMs;
      if (state.sourceTabId) {
        tabIdRef.current = state.sourceTabId;
        setTabId(state.sourceTabId);
      }
      if (state.running) {
        setStatus({ type: 'active', text: '字幕会话正在运行' });
      }
    }).catch((error) => {
      setStatus({
        type: 'error',
        text: error instanceof Error ? error.message : '读取字幕状态失败'
      });
    });
  }, []);

  useEffect(() => {
    const listener = (
      message: PanelEventMessage | PanelVideoStateMessage
    ) => {
      if (message?.target !== 'panel') {
        return;
      }

      if (message.type === 'video.state') {
        if (tabIdRef.current && message.tabId !== tabIdRef.current) {
          return;
        }
        if (
          message.state.sequence <= lastVideoSequenceRef.current
          && message.state.videoId === videoStateRef.current.videoId
        ) {
          return;
        }
        lastVideoSequenceRef.current = message.state.sequence;
        updateOffset(message.state);
        return;
      }

      if (message.type !== 'inference.event') {
        return;
      }
      const event: InferenceEvent = message.event;
      if (
        'sessionId' in event
        && event.sessionId
        && activeSessionId
        && event.sessionId !== activeSessionId
      ) {
        return;
      }

      if (event.type === 'session.started') {
        lastDeliverySequenceRef.current = 0;
        activeRecognitionEpochRef.current = 0;
        recognitionPausedRef.current = false;
        setActiveSessionId(event.sessionId);
        setStatus({
          type: 'active',
          text: `正在生成简体中文字幕 · ${event.modelId}`
        });
        return;
      }

      if (event.type === 'session.stopped') {
        runningRef.current = false;
        recognitionPausedRef.current = false;
        activeRecognitionEpochRef.current = 0;
        if (tabIdRef.current) {
          void sendRequest({
            type: 'panel.schedule-video-boundary',
            tabId: tabIdRef.current,
            videoId: videoStateRef.current.videoId,
            boundaryVideoTimeMs: null
          }).catch((error) => {
            reportError(error, '清除字幕边界调度失败');
          });
        }
        setRunning(false);
        setStatus({ type: 'idle', text: '会话已停止' });
        return;
      }

      if (event.type === 'session.status') {
        setStatus({
          type: 'active',
          text: event.message
        });
        return;
      }

      if (event.type === 'session.error') {
        if (!event.recoverable) {
          runningRef.current = false;
          setRunning(false);
        }
        setStatus({ type: 'error', text: event.message });
        return;
      }

      if (event.type === 'recognition.epoch') {
        activeRecognitionEpochRef.current = event.epoch;
        clearPartialCaptions();
        return;
      }

      if (event.type === 'caption.preview') {
        if (event.recognitionEpoch !== activeRecognitionEpochRef.current) {
          return;
        }
        if (
          event.deliverySequence !== undefined
          && event.deliverySequence <= lastDeliverySequenceRef.current
        ) {
          return;
        }
        if (event.deliverySequence !== undefined) {
          lastDeliverySequenceRef.current = event.deliverySequence;
        }
        if (Date.now() - lastSeekAtRef.current < 400) {
          return;
        }
        setLatestProcessingMs(event.processingMs);
        setStatus({ type: 'active', text: '实时字幕识别中' });
        setCaptions((previous) => {
          const next = previous.filter(
            (item) => (
              item.segmentId !== event.parentSegmentId
              && item.parentSegmentId !== event.parentSegmentId
            )
          );
          for (const part of event.parts) {
            const row: CaptionRow = {
              type: 'caption.partial',
              recognitionEpoch: event.recognitionEpoch,
              sessionId: event.sessionId,
              segmentId: part.segmentId,
              parentSegmentId: event.parentSegmentId,
              audioStartUs: part.audioStartUs,
              audioEndUs: part.audioEndUs,
              text: part.text,
              processingMs: event.processingMs,
              videoStartMs: getVideoTimeMs(part.audioStartUs),
              videoEndMs: getVideoTimeMs(part.audioEndUs)
            };
            next.push(row);
          }
          next.sort((first, second) => (
            first.videoStartMs - second.videoStartMs
            || first.segmentId.localeCompare(second.segmentId)
          ));
          return next;
        });
        return;
      }

      if (event.recognitionEpoch !== activeRecognitionEpochRef.current) {
        return;
      }
      if (
        event.deliverySequence !== undefined
        && event.deliverySequence <= lastDeliverySequenceRef.current
      ) {
        return;
      }
      if (event.deliverySequence !== undefined) {
        lastDeliverySequenceRef.current = event.deliverySequence;
      }
      setLatestProcessingMs(event.processingMs);
      setStatus({
        type: 'active',
        text: '终稿字幕生成中'
      });

      setCaptions((previous) => {
        const row: CaptionRow = {
          ...event,
          videoStartMs: getVideoTimeMs(event.audioStartUs),
          videoEndMs: getVideoTimeMs(event.audioEndUs)
        };
        let next = previous.filter((item) => item.segmentId !== event.segmentId);
        next = next.filter((item) => (
          item.segmentId !== event.parentSegmentId
          && !(
            item.parentSegmentId === event.parentSegmentId
            && item.type === 'caption.partial'
          )
        ));
        const mergeIndex = next.findIndex((item) => (
          shouldMergeFinalCaption(item, row)
        ));
        if (mergeIndex < 0) {
          next.push(row);
        } else {
          const existing = next[mergeIndex]!;
          const preferred = (
            normalizeCaptionText(row.text).length
            >= normalizeCaptionText(existing.text).length
          )
            ? row
            : existing;
          next[mergeIndex] = {
            ...preferred,
            audioStartUs: Math.min(existing.audioStartUs, row.audioStartUs),
            audioEndUs: Math.max(existing.audioEndUs, row.audioEndUs),
            videoStartMs: Math.min(existing.videoStartMs, row.videoStartMs),
            videoEndMs: Math.max(existing.videoEndMs, row.videoEndMs)
          };
        }
        next.sort((first, second) => (
          first.videoStartMs - second.videoStartMs
          || first.segmentId.localeCompare(second.segmentId)
        ));
        return next;
      });
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [activeSessionId]);

  useEffect(() => {
    if (!running || !tabId) {
      return;
    }

    void sendRequest<VideoState>({
      type: 'panel.get-video-state',
      tabId
    }).then((nextVideo) => {
      lastVideoSequenceRef.current = nextVideo.sequence;
      updateOffset(nextVideo);
    }).catch((error) => {
      reportError(error, '读取播放器状态失败');
    });
  }, [running, tabId]);

  useEffect(() => {
    if (!runningRef.current) {
      return;
    }
    const currentVideo = videoStateRef.current;
    syncRecognitionGate(currentVideo.currentTime * 1000);
    scheduleVideoBoundary(currentVideo);
  }, [captions]);

  useLayoutEffect(() => {
    if (!autoScrollRef.current) {
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const list = captionListRef.current;
        if (list) {
          list.scrollTop = list.scrollHeight;
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [captions]);

  function handleCaptionScroll(): void {
    const list = captionListRef.current;
    if (!list) {
      return;
    }
    const distanceToBottom = (
      list.scrollHeight - list.scrollTop - list.clientHeight
    );
    const isNearBottom = distanceToBottom < 24;
    autoScrollRef.current = isNearBottom;
    setShowScrollToLatest(!isNearBottom);
  }

  function scrollToLatest(): void {
    const list = captionListRef.current;
    if (!list) {
      return;
    }
    autoScrollRef.current = true;
    setShowScrollToLatest(false);
    list.scrollTo({
      top: list.scrollHeight,
      behavior: 'smooth'
    });
  }

  async function start(): Promise<void> {
    setStatus({ type: 'idle', text: '正在启动音频捕获' });
    setCaptions([]);
    lastDeliverySequenceRef.current = 0;
    activeRecognitionEpochRef.current = 0;
    lastVideoSyncRef.current = null;
    timelineAnchorRef.current = null;
    recognitionPausedRef.current = false;
    setLatestProcessingMs(0);
    autoScrollRef.current = true;
    setShowScrollToLatest(false);
    setActiveSessionId('');
    try {
      const context = await refreshContext();
      if (!context.video.hasVideo) {
        throw new Error('当前标签页未检测到视频');
      }

      const state = await sendRequest<SessionRuntimeState>({
        type: 'panel.start',
        sourceTabId: context.tabId
      });

      startedAtRef.current = state.startedAtEpochMs;
      runningRef.current = true;
      setRunning(true);
      updateOffset(context.video, true);
      setStatus({ type: 'active', text: '音频捕获已启动' });
    } catch (error) {
      runningRef.current = false;
      setRunning(false);
      setStatus({
        type: 'error',
        text: error instanceof Error ? error.message : '字幕启动失败'
      });
    }
  }

  async function stop(): Promise<void> {
    setStatus({ type: 'idle', text: '正在结束会话' });
    try {
      await sendRequest<SessionRuntimeState>({ type: 'panel.stop' });
      runningRef.current = false;
      startedAtRef.current = 0;
      recognitionPausedRef.current = false;
      if (tabIdRef.current) {
        void sendRequest({
          type: 'panel.schedule-video-boundary',
          tabId: tabIdRef.current,
          videoId: videoStateRef.current.videoId,
          boundaryVideoTimeMs: null
        }).catch((error) => {
          reportError(error, '清除字幕边界调度失败');
        });
      }
      setRunning(false);
      setActiveSessionId('');
      setStatus({ type: 'idle', text: '会话已停止' });
    } catch (error) {
      setStatus({
        type: 'error',
        text: error instanceof Error ? error.message : '停止字幕失败'
      });
    }
  }

  async function jumpToCaption(caption: CaptionRow): Promise<void> {
    if (caption.type !== 'caption.final' || !tabIdRef.current) {
      return;
    }
    try {
      const targetSeconds = caption.videoStartMs / 1000;
      lastSeekAtRef.current = Date.now();
      updateOffset({
        ...video,
        hasVideo: true,
        currentTime: targetSeconds,
        paused: false
      }, true);
      setCaptions((previous) => previous.filter(
        (item) => item.type === 'caption.final'
      ));
      await sendRequest({
        type: 'panel.jump-to-time',
        tabId: tabIdRef.current,
        seconds: targetSeconds
      });
      setTimeout(() => {
        void sendRequest<VideoState>({
          type: 'panel.get-video-state',
          tabId: tabIdRef.current
        }).then((nextVideo) => {
          lastVideoSequenceRef.current = nextVideo.sequence;
          updateOffset(nextVideo);
        }).catch((error) => {
          reportError(error, '更新播放器状态失败');
        });
      }, 120);
    } catch (error) {
      setStatus({
        type: 'error',
        text: error instanceof Error ? error.message : '跳转失败'
      });
    }
  }

  const finalCount = captions.filter((item) => item.type === 'caption.final').length;

  return (
    <main className="app">
      <header className="hero">
        <div className="hero-row">
          <div>
            <h1>实时中文字幕</h1>
            <p>实时识别当前标签页音频，生成中文字幕。</p>
          </div>
        </div>
      </header>

      <section className="panel" aria-label="字幕控制">
        <button
          className="button button-primary"
          disabled={running}
          onClick={() => void start()}
          type="button"
        >
          {running ? '运行中' : '启动中文字幕'}
        </button>
        <button
          className="button button-danger"
          disabled={!running}
          onClick={() => void stop()}
          type="button"
        >
          停止
        </button>
      </section>

      <section className="status" aria-live="polite">
        <div className="status-line">
          <span className={`status-dot ${status.type}`} />
          <span>{status.text}</span>
        </div>
        <div className="meta">
          <span className="pill">
            {video.hasVideo ? '已检测到视频' : '未检测到视频'}
          </span>
          <span className="pill">字幕：{finalCount}</span>
          <span className="pill">
            处理：{latestProcessingMs > 0 ? `${Math.round(latestProcessingMs)}ms` : '-'}
          </span>
        </div>
      </section>

      <section className="captions">
        {captions.length === 0 ? (
          <div className="empty">
            启动后会在本地识别标签页音频，临时字幕会由终稿自动替换。
          </div>
        ) : (
          <div
            className="caption-list"
            onScroll={handleCaptionScroll}
            ref={captionListRef}
          >
            {captions.map((caption) => (
              <article
                className={`caption ${caption.type === 'caption.final' ? 'final' : 'partial'}`}
                key={caption.segmentId}
                onClick={() => void jumpToCaption(caption)}
              >
                <div className="caption-time">
                  {formatTime(caption.videoStartMs / 1000)}
                  {' → '}
                  {formatTime(caption.videoEndMs / 1000)}
                  {caption.type === 'caption.partial' && (
                    <span className="caption-badge">实时</span>
                  )}
                </div>
                <div className="caption-text">{caption.text}</div>
              </article>
            ))}
          </div>
        )}
        {showScrollToLatest && (
          <button
            className="scroll-latest"
            onClick={scrollToLatest}
            type="button"
          >
            ↓ 回到最新
          </button>
        )}
      </section>
    </main>
  );

}

createRoot(document.getElementById('root')!).render(<Panel />);

