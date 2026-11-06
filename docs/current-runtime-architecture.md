# 当前运行架构与执行流程

| 项目 | 当前状态 |
| --- | --- |
| 产品版本 | `3.0.0` |
| 文档日期 | 2026-11-06 |
| 产品形态 | Chrome Manifest V3 扩展 |
| 当前输出 | 简体中文验证链路 |
| 运行位置 | 浏览器本地 |
| 远程服务器 | 无 |
| 神经网络模型数量 | 2 |

本文描述当前代码实际运行方式。多语言识别、目标语言选择和翻译不在当前实现范围内。

## 1. 模型与运行时

### 1.1 ASR 模型

| 项目 | 内容 |
| --- | --- |
| 模型 | `streaming-zipformer-bilingual-zh-en-2023-02-20` |
| 类型 | 流式 Zipformer 中英双语 ASR |
| 组成 | `encoder.onnx`、`decoder.onnx`、`joiner.onnx`、`tokens.txt` |
| 推理运行时 | Sherpa-ONNX v1.13.7 WebAssembly SIMD |
| 执行位置 | `asr-worker.js` |
| 输入 | 16 kHz、单声道、PCM16 音频帧 |
| 输出 | 原始预览文本和原始终稿文本 |

编码器、解码器、联合网络和词表封装在 Sherpa-ONNX 的 `.data` 虚拟文件系统中，逻辑上属于一个 ASR 模型。

### 1.2 标点模型

| 项目 | 内容 |
| --- | --- |
| 模型 | `sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8` |
| 类型 | CT-Punc 标点恢复，int8 ONNX |
| 文件 | `model.int8.onnx`、`tokens.json` |
| 推理运行时 | ONNX Runtime Web 1.31.1，WASM 单线程 |
| 执行位置 | `caption-worker.js` |
| 标点类别 | 无标点、逗号、句号、问号、顿号 |

### 1.3 非模型能力

| 能力 | 当前实现 |
| --- | --- |
| VAD | 固定 RMS 音量阈值的规则算法 |
| 字幕切分 | 模型标点优先、字幕宽度兜底的确定性算法 |
| 语言检测 | 未实现 |
| 翻译 | 未实现 |

当前只有两个神经网络模型，不存在独立的 VAD、语言检测或翻译模型。

## 2. 组件架构

```text
视频网页
  │ chrome.tabCapture
  ▼
Offscreen Document
  ├── AudioWorklet
  │     └── 混音、16 kHz 重采样、PCM16、20 ms 分帧
  ├── ASR Web Worker
  │     ├── Sherpa-ONNX WASM
  │     ├── 能量 VAD
  │     └── Streaming Zipformer
  └── Caption Web Worker
        ├── ONNX Runtime Web
        ├── CT-Punc
        └── 模型标点驱动分句

Offscreen
  │ 串行 inference.event
  ▼
Background Service Worker
  │ 串行转发
  ▼
Popup Panel
  └── 字幕列表、时间轴、跳转、自动滚动
```

| 组件 | 生命周期 | 主要职责 |
| --- | --- | --- |
| `background.ts` | MV3 Service Worker | 窗口、标签页、音频权限、Offscreen 和事件路由 |
| `page-bridge.ts` | 当前网页标签页 | 查询 `<video>`、执行跳转 |
| `offscreen.ts` | 音频会话期间 | 持有音频流、Worker 和串行事件队列 |
| `audio-capture-processor.ts` | AudioContext 生命周期 | 混音、重采样、PCM16 和分帧 |
| `asr-worker.ts` | 识别会话期间 | ASR、VAD 和原始识别文本 |
| `caption-worker.ts` | 识别会话期间 | CT-Punc、分句和后处理队列 |
| `panel.tsx` | 字幕窗口打开期间 | 启动停止、字幕展示、去重和时间轴 |
| `packages/protocol` | 编译期类型 | 扩展内部消息协议 |

## 3. 启动顺序

```text
用户点击扩展图标
→ Background 打开或复用字幕 Panel
→ Panel 请求当前视频状态
→ 用户点击启动
→ Background 注入 page-bridge 并确认存在 video
→ Background 申请 tabCapture Stream ID
→ Background 创建或复用 Offscreen
→ Offscreen 创建 ASR Worker
→ ASR Worker 加载 WASM 和 ASR 模型
→ ASR Worker 返回 worker.ready
→ Offscreen 后台创建 Caption Worker
→ Offscreen 建立 MediaStream
→ Offscreen 建立 AudioContext 和 AudioWorklet
→ 音频进入扬声器监听分支和 PCM 分析分支
→ Offscreen 返回 startedAtEpochMs
```

Caption Worker 不在采音前置条件中。ASR Worker 就绪后就开始建立音频管线，CT-Punc 模型继续在后台加载。

## 4. 音频处理

```text
MediaStreamSource
├── monitorGain(1.0) → AudioContext.destination
└── AudioWorkletNode → analysisGain(0.0) → AudioContext.destination
```

| 属性 | 当前值 |
| --- | --- |
| 采样率 | 16 kHz |
| 声道 | 单声道 |
| 格式 | signed PCM16 |
| 帧长 | 320 samples |
| 帧时长 | 20 ms |
| 时间戳 | `帧序号 × 20,000 µs` |

PCM `ArrayBuffer` 使用 Transferable 发给 ASR Worker。

## 5. ASR 与 VAD 执行顺序

| 参数 | 当前值 |
| --- | ---: |
| RMS 语音阈值 | `0.008`，约 `-42 dBFS` |
| 连续语音启动 | 3 帧，约 60 ms |
| 前置缓冲 | 300 ms |
| 结束静音 | 650 ms |
| 最长语音段 | 12 秒 |
| 临时结果间隔 | 250 ms |

```text
20 ms 音频帧
→ 计算 RMS
→ 没有活动识别段时维护最多 300 ms 前置缓冲
→ 连续 3 帧超过音量阈值
→ 创建 RecognizerStream
→ 送入前置缓冲和后续音频
→ 每 250 ms 检查流式解码结果
→ 文本变化时发送 asr.caption preview
→ 静音达到 650 ms 或段长达到 12 秒
→ 解码最终文本
→ 发送 asr.caption final
→ 释放 RecognizerStream
```

当前模型配置：

```text
enableEndpoint = 0
decodingMethod = greedy_search
maxActivePaths = 4
modelingUnit = cjkchar
```

分段结束由应用层能量 VAD 控制，没有使用 ASR 模型自带的 endpoint。

## 6. 字幕后处理

ASR Worker 只发送：

```typescript
{
  type: 'asr.caption',
  kind: 'preview' | 'final',
  sessionId,
  segmentId,
  audioStartUs,
  audioEndUs,
  text,
  processingMs
}
```

Offscreen 路由规则：

| 状态 | 行为 |
| --- | --- |
| Caption Worker 已就绪 | 原始文本进入 Caption Worker |
| Caption Worker 尚未就绪 | 原始文本直接转换为 UI 字幕 |
| Caption Worker 异常退出 | 后续原始文本直接转换为 UI 字幕 |

Caption Worker 队列规则：

1. 终稿按到达顺序处理，不丢弃。
2. 尚未处理的旧预览会被最新预览替换。
3. 同段终稿到达时，删除该段仍在等待的预览。
4. `caption.flush` 等待已有任务完成后返回 `caption.drained`。

CT-Punc 执行顺序：

```text
原始文本
→ 清理已有标点
→ 按中文字符和英文词切分
→ 查询 token ID
→ ONNX CT-Punc 推理
→ 每个 token 选择最高分标点类别
→ 将标点写回文本
```

字幕切分规则：

| 规则 | 当前实现 |
| --- | --- |
| 首选边界 | CT-Punc 输出的句号、问号、逗号等 |
| 目标长度 | 20 个字符 |
| 最大长度 | 28 个字符 |
| 无标点兜底 | 在最大宽度内按字符位置切分 |
| 人工补标点 | 不做 |
| 连接词词典 | 不使用 |
| 时间分配 | 按分句字符权重分配原识别段时长 |

一个 ASR 终稿可以产生多条 `caption.final`。

## 7. 从 Worker 到 UI

### 7.1 串行投递

```text
Offscreen 分配 deliverySequence
→ 等待 Background 确认
→ Background 串行转发 Panel
→ Panel 丢弃旧序号
```

Panel 行为：

1. `deliverySequence` 小于等于已处理序号的事件丢弃。
2. 字幕显示使用事件处理顺序，不再按时间重新排序。
3. 同一 `parentSegmentId` 的新预览替换旧预览。
4. 同段终稿到达后删除该段全部临时字幕。

### 7.2 时间轴

```text
videoTimeMs = anchorVideoTimeMs
  + (audioTimeMs - anchorAudioTimeMs) × playbackRate
```

时间轴锚点在开始、暂停恢复、播放器缓冲、跳转和倍速变化时重建。正常播放期间每秒查询视频状态只用于检测变化，不会重新计算已有字幕。

### 7.3 重复字幕合并

| 情况 | 行为 |
| --- | --- |
| 时间重叠且一段文本包含另一段 | 合并 |
| 时间重叠且共享至少 6 个连续字符 | 合并 |
| 文本无关或时间不重叠 | 保留 |

合并后保留更完整文本，并使用两段最早开始时间和最晚结束时间。

## 8. UI 行为

| 功能 | 数据来源 |
| --- | --- |
| 临时字幕 | `caption.preview` |
| 终稿字幕 | `caption.final` |
| 处理耗时 | `processingMs` |
| 识别状态 | `session.status` |
| 错误状态 | `session.error` 或 `caption.error` |

- 点击终稿字幕跳转到对应视频时间。
- 跳转后通过 Offscreen `capture.seek` 释放当前 ASR 流。
- 位于列表底部时自动滚动。
- 用户上滚后暂停自动滚动，并显示“回到最新”。

## 9. 停止顺序

```text
Panel 点击停止
→ Background
→ Offscreen
→ 停止接收新音频
→ ASR 生成最后一个终稿
→ ASR 返回 session.stopped
→ Caption Worker 处理完队列
→ 返回 caption.drained
→ Offscreen 串行发送 session.stopped
→ 停止 MediaStream 轨道
→ 关闭 AudioContext
→ 终止两个 Worker
→ 清理 Offscreen 会话
```

停止等待上限为 2.5 秒，超过后进入资源清理。

## 10. 并发与故障边界

| 工作 | 执行位置 | 阻塞关系 |
| --- | --- | --- |
| 音频重采样 | AudioWorklet | 不做模型推理 |
| ASR 解码 | ASR Worker | 不阻塞 Panel 和 CT-Punc Worker |
| CT-Punc | Caption Worker | 不阻塞 ASR Worker |
| 字幕渲染 | Panel | 不执行模型推理 |
| 窗口和标签页协调 | Background | 不执行模型推理 |

| 故障 | 当前行为 |
| --- | --- |
| ASR 模型加载失败 | 启动失败 |
| ASR Worker 运行中崩溃 | 结束会话 |
| Caption Worker 启动超时 | 原始字幕直接进入 UI |
| CT-Punc 加载失败 | 警告后继续使用原始文本 |
| CT-Punc 单次推理失败 | 当前文本保持原样 |
| Chrome 消息服务暂不可用 | 隔离失败，单条事件可能丢失 |
| 音频流结束 | 需要停止并重新启动 |

## 11. 当前限制

1. ASR 是中英双语模型，当前只承诺中文场景。
2. 输出固定为简体中文字幕。
3. 没有语言检测、目标语言选择和翻译。
4. VAD 使用固定音量阈值。
5. 标点和分句主要针对中文。
6. 每个新会话都会重新加载模型。
7. 只检测顶层页面中面积和播放状态最优的 `<video>`。
8. iframe 和复杂播放器适配不完整。
9. 标签页广告、提示音和背景声也会进入识别。

## 12. 执行摘要

```text
扩展 Panel
→ tabCapture
→ Offscreen + AudioWorklet
→ ASR Worker：能量 VAD + 流式识别
→ Caption Worker：CT-Punc + 模型标点分句
→ Offscreen：编号并串行发送
→ Background：串行转发
→ Panel：展示、去重、时间映射、自动滚动
→ 停止：刷出尾稿并释放资源
```
