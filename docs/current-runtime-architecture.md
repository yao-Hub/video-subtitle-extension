# 当前运行架构与执行流程

| 项目 | 当前状态 |
| --- | --- |
| 产品版本 | `3.0.0` |
| 文档日期 | 2026-11-06 |
| 产品形态 | Chrome Manifest V3 扩展 |
| 当前输出 | 简体中文验证链路 |
| 运行位置 | 浏览器本地 |
| 远程服务器 | 无 |
| 神经网络模型数量 | 3 |

本文描述当前代码实际运行方式。多语言识别、目标语言选择和翻译不在当前实现范围内。

## 1. 模型清单与职责

当前使用三个相互独立的神经网络模型，依次负责“人声检测”“音频转文字”和“文字加标点”。

| 模型 | 处理阶段 | 核心作用 | 执行位置 |
| --- | --- | --- | --- |
| Silero VAD v5 | ASR 之前 | 判断音频块是否包含人声 | ASR Worker |
| Streaming Zipformer ASR | VAD 之后 | 把人声识别为原始文字 | ASR Worker |
| CT-Punc | ASR 之后 | 为原始文字插入标点 | Caption Worker |

当前没有语言检测、翻译、说话人分离或目标语言模型。

### 1.1 Streaming Zipformer ASR

#### 基本信息

| 项目 | 内容 |
| --- | --- |
| 模型标识 | `streaming-zipformer-bilingual-zh-en-2023-02-20` |
| 模型类型 | 流式 Zipformer 中英双语自动语音识别 |
| 模型文件 | `encoder.onnx`、`decoder.onnx`、`joiner.onnx`、`tokens.txt` |
| 封装位置 | Sherpa-ONNX `.data` 虚拟文件系统 |
| 推理运行时 | Sherpa-ONNX v1.13.7 WebAssembly SIMD |
| 执行位置 | `apps/extension/src/asr-worker.ts` |

编码器、解码器、联合网络和词表是一个 ASR 系统的组成部分，不是三个独立模型。

#### 输入

```text
16 kHz
单声道
Float32 波形送入模型
PCM16 由 Worker 转换成 Float32
每帧 320 samples，持续 20 ms
```

#### 负责的工作

1. 接收当前语音识别流中的音频。
2. 持续更新流式识别结果。
3. 把语音转换成中英文字符。
4. 在语音进行中输出临时预览文本。
5. 在语音段结束时输出最终原始文本。

示例：

```text
音频：“对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢”
ASR 输出：对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢
```

#### 不负责的工作

| 不属于 ASR 模型 | 实际负责组件 |
| --- | --- |
| 判断什么时候开始或结束语音段 | Silero VAD |
| 加逗号、句号、问号 | CT-Punc |
| 把长文本拆成多条字幕 | 字幕切分器 |
| 翻译成其他语言 | 当前未实现 |
| 识别说话人 | 当前未实现 |

ASR 配置使用 `enableEndpoint = 0`，因此识别段起止由应用层 VAD 决定，不使用模型内置端点检测。

#### 输出

```typescript
{
  kind: 'preview' | 'final',
  text: '原始识别文本',
  audioStartUs,
  audioEndUs,
  processingMs
}
```

### 1.2 Silero VAD v5

#### 基本信息

| 项目 | 内容 |
| --- | --- |
| 模型 | `silero-vad-v5` |
| 类型 | 神经网络人声活动检测 |
| 模型文件 | `silero_vad_v5.onnx` |
| 推理运行时 | ONNX Runtime Web 1.31.1，WASM 单线程 |
| 执行位置 | `apps/extension/src/asr-worker.ts` |

#### 输入

```text
AudioWorklet 输出的 16 kHz 单声道 PCM
→ 每 20 ms 一帧
→ ASR Worker 累积为 512 samples，即 32 ms VAD 块
→ 附加前一块末尾 64 samples 作为上下文
→ 输入 Silero VAD
```

#### 负责的工作

1. 输出每个音频块包含人声的概率。
2. 根据正负概率阈值判断人声开始、持续和结束。
3. 在开始时提供最近 300 ms 前置音频。
4. 在人声结束后结束 ASR 识别段。

#### 不负责的工作

| 不属于 Silero VAD | 实际负责组件 |
| --- | --- |
| 识别具体说了什么 | Streaming Zipformer ASR |
| 添加标点 | CT-Punc |
| 翻译文字 | 当前未实现 |

#### 输出

```text
每个 32 ms 音频块的人声概率
→ 语音开始 / 语音继续 / 语音结束
```

### 1.3 CT-Punc

#### 基本信息

| 项目 | 内容 |
| --- | --- |
| 模型标识 | `sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8` |
| 模型类型 | CT-Transformer 标点恢复，int8 ONNX |
| 模型文件 | `model.int8.onnx`、`tokens.json` |
| 推理运行时 | ONNX Runtime Web 1.31.1，WASM 单线程 |
| 执行位置 | `apps/extension/src/caption-worker.ts` |
| 单次输入上限 | 200 个 token；超过时保持原始文本 |

#### 输入

```text
ASR 输出的无标点或弱标点文本
→ 清理原有标点
→ 中文按字符、英文按单词切分
→ 查询 tokens.json 得到 token ID
→ 输入 CT-Punc
```

#### 负责的工作

1. 判断每个文本 token 后面应该使用什么标点。
2. 输出无标点、逗号、句号、问号或顿号。
3. 把选中的标点写回 ASR 文本。
4. 同时处理实时预览文本和最终文本。

示例：

```text
ASR：对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢
CT-Punc：对我做了介绍，那么我想说的是，大家如果对我的研究感兴趣呢。
```

#### 不负责的工作

| 不属于 CT-Punc | 实际负责组件 |
| --- | --- |
| 听音频或识别文字 | ASR 模型 |
| 判断语音段起止 | Silero VAD |
| 把文本拆成多条 UI 字幕 | 字幕切分器 |
| 翻译文本 | 当前未实现 |
| 修正 ASR 错字 | CT-Punc 不承担 ASR 纠错 |

CT-Punc 为每个 token 输出标点类别，字幕切分器再消费这些标点。模型负责标点位置，切分器负责最终字幕排版和最大宽度。

#### 输出

```text
带标点文本
```

### 1.4 三个模型如何协作

```text
PCM 音频
→ Silero VAD：判断是否有人声并确定识别段
→ Streaming Zipformer ASR：音频转文字
→ 无标点原始文本
→ CT-Punc：插入标点
→ 带标点文本
→ 字幕切分器
→ 一条或多条 UI 字幕
```

完整示例：

```text
ASR 输出：
对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢

CT-Punc 输出：
对我做了介绍，那么我想说的是，大家如果对我的研究感兴趣呢。

字幕切分器输出：
1. 对我做了介绍，
2. 那么我想说的是，大家如果对我的研究感兴趣呢。
```

### 1.5 非模型能力

| 能力 | 当前实现 |
| --- | --- |
| 字幕切分 | 模型标点优先、字幕宽度兜底的确定性算法 |
| 语言检测 | 未实现 |
| 翻译 | 未实现 |

当前有三个神经网络模型，不存在语言检测、翻译或目标语言模型。

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
  │     ├── Silero VAD v5
  │     └── Sherpa-ONNX Streaming Zipformer
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
→ ASR Worker 加载 Sherpa ASR、Silero VAD 和 ONNX Runtime
→ ASR Worker 返回 worker.ready
→ Offscreen 后台创建 Caption Worker
→ Offscreen 建立 MediaStream
→ Offscreen 建立 AudioContext 和 AudioWorklet
→ 音频进入扬声器监听分支和 PCM 分析分支
→ Offscreen 返回 startedAtEpochMs
```

ASR Worker 只有在 Silero VAD 和 ASR 模型都就绪后才返回 `worker.ready`。Caption Worker 不在采音前置条件中，CT-Punc 模型继续在后台加载。

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
| 时间戳 | ASR Worker 按累计 sample 数换算 |

PCM `ArrayBuffer` 使用 Transferable 发给 ASR Worker。

## 5. VAD 与 ASR 执行顺序

| 参数 | 当前值 |
| --- | ---: |
| VAD 音频块 | 512 samples，32 ms |
| 人声概率开始阈值 | `0.5` |
| 人声概率结束阈值 | `0.35` |
| 连续人声启动 | 2 个 VAD 块，64 ms |
| 前置缓冲 | 300 ms |
| 结束静音 | 650 ms |
| 最长语音段 | 12 秒 |
| 临时结果间隔 | 250 ms |

```text
20 ms PCM 音频帧
→ 累积为 32 ms VAD 块
→ Silero VAD 输出人声概率
→ 概率 ≥ 0.5 视为人声
→ 连续 2 个 VAD 块有人声后创建语音段
→ 没有活动识别段时维护最多 300 ms 前置缓冲
→ 创建 RecognizerStream
→ 将前置缓冲和后续音频送入 ASR
→ 每 250 ms 检查流式解码结果
→ 文本变化时发送 asr.caption preview
→ 概率 ≤ 0.35 的音频块累计达到 650 ms
→ 或段长达到 12 秒
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

分段结束由 Silero VAD 概率控制，没有使用 ASR 模型自带的 endpoint。

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
| Silero VAD 模型加载失败 | 启动失败 |
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
4. VAD 依赖 Silero 概率阈值，复杂音乐、混响和远场声音仍可能误判。
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
→ ASR Worker：Silero VAD → Streaming ASR
→ Caption Worker：CT-Punc + 模型标点分句
→ Offscreen：编号并串行发送
→ Background：串行转发
→ Panel：展示、去重、时间映射、自动滚动
→ 停止：刷出尾稿并释放资源
```
