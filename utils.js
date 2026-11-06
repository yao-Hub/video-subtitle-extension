/**
 * 实时提取视频音频流（供 stream.wasm 实时转录）
 * @param {HTMLVideoElement} videoElement - 视频元素
 * @returns {MediaStream|null} 音频流
 */
function getVideoAudioStream(videoElement) {
  if (!videoElement || !videoElement.src) {
    console.error('获取音频流失败：无效的视频元素');
    return null;
  }

  try {
    // 直接捕获视频音频流（无连接冲突）
    const stream = videoElement.captureStream();
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      console.error('获取音频流失败：视频无音频轨道');
      return null;
    }
    return new MediaStream(audioTracks);
  } catch (e) {
    console.error('获取音频流失败：', e.message);
    return null;
  }
}

// 保留原有工具函数（timeToSeconds/secondsToTime/parseVTT）
function timeToSeconds(timeStr) {
  const [hours = 0, minutes, seconds] = timeStr.split(/[:.]/);
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function secondsToTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${h}:${m}:${s}`;
}

function parseVTT(vttContent) {
  const subtitles = [];
  const lines = vttContent
    .replace(/WEBVTT/g, '')
    .replace(/NOTE.*\n/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('-->')) {
      const [startTime] = lines[i].split('-->').map(t => t.trim());
      const text = lines[i + 1] || '';
      const time = timeToSeconds(startTime);
      if (text) {
        subtitles.push({ time, startTime, text });
      }
      i++;
    }
  }
  return subtitles;
}