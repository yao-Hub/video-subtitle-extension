# 第二版开发会话交接

| 项目 | 内容 |
| --- | --- |
| 当前阶段 | 第一版验收完成，第二版规划中 |
| 第一版基线与提交 | `5a3a873 完成第一版本地实时中文字幕` |
| Git 远端 | `ssh://git@ssh.github.com:443/yao-Hub/video-subtitle-extension.git` |
| 默认分支 | `main` |
| 产品形态 | 纯 Chrome Manifest V3 扩展 |
| 第一版输出 | 简体中文实时字幕 |
| 运行位置 | 用户浏览器本地 |
| 远程或本地辅助服务 | 无 |
| 交接日期 | 2026-11-06 |

## 1. 新会话如何恢复上下文

新会话不应依赖当前聊天窗口的历史消息。进入仓库后先读取：

```text
AGENTS.md
docs/v2-session-handoff.md
docs/current-runtime-architecture.md
docs/v1-implementation-status.md
```

涉及产品范围、模型选型或翻译能力时再读取：

```text
docs/automatic-audio-translation-subtitles.md
```

可以直接把下面的启动提示发送给新会话：

```text
请先读取 AGENTS.md 和 docs/v2-session-handoff.md，恢复第一版基线和第二版约束。
确认当前 Git 状态、第一版架构和未实现范围后，再根据我接下来给出的第二版需求
制定方案。不要重新实现第一版已经完成的功能，也不要在未获授权时提交或推送。
```

## 2. 产品业务目标

产品将不同语言视频的语音生成简体中文字幕，不使用视频网站自带字幕。目标字幕语言固定为简体中文，不提供结果语言选择。

目标链路（第二版及以后）：

```text
视频标签页音频
→ 音频捕获与格式转换
→ 人声检测
→ 不同源语言语音识别与语言判定
→ 生成简体中文字幕
→ 中文标点恢复与分句
→ 实时中文字幕 UI
```

最终目标包括：

- 用户可启动当前标签页音频识别。
- 视频没有平台字幕时仍能生成字幕。
- 识别过程在浏览器本地完成，不上传音频。
- 后续支持自动识别不同源语言，并将非中文语音翻译为简体中文字幕。
- 目标字幕语言固定为简体中文，不提供结果语言选择。
- 实时显示临时字幕，并在语音段结束后显示终稿。
- 支持字幕时间轴、自动滚动和点击字幕跳转视频。
- 已生成区间回放时不重复识别。

## 3. 第二版范围状态

第二版范围尚未在交接文档中定稿，必须根据用户新会话中的最新要求确认。

已确认的产品边界：

| 项目 | 结论 |
| --- | --- |
| 业务目标 | 将不同语言视频的语音生成简体中文字幕 |
| 目标字幕语言 | 简体中文，固定不变 |
| 结果语言选择 | 不支持，不纳入第二版及后续产品范围 |

当前最可能的第二版方向是不同源语言到简体中文字幕的本地识别与翻译能力：

| 候选能力 | 当前状态 | 关键问题 |
| --- | --- | --- |
| 源语言自动检测 | 未实现 | 需要语言识别模型或基于 ASR 结果的路由 |
| 多语言语音识别 | 未实现 | 当前只有中英双语 Zipformer |
| 浏览器内翻译为简体中文 | 未实现 | 需要确定翻译模型、包体和性能 |
| 双语字幕 | 未实现 | 需要原文和译文对齐及 UI 展示 |
| 多语言标点 | 未实现 | 当前 CT-Punc 主要针对中文和英文 |

不得把候选能力直接视为已确认范围。开始设计前先让用户确认：

1. 首批支持哪些源语言。
2. 是否需要双语字幕。
3. 是否接受扩展包体和内存占用增加。
4. 是否仍然要求完全离线。

## 4. 第一版已交付能力

| 能力 | 状态 |
| --- | --- |
| 当前标签页音频捕获 | 已实现 |
| 原视频声音继续播放 | 已实现 |
| 16 kHz 单声道 PCM 和 20 ms 分帧 | 已实现 |
| Silero VAD v5 人声检测 | 已实现 |
| 自适应 VAD 开关阈值 | 已实现 |
| Streaming Zipformer 中英双语识别 | 已实现 |
| 实时临时字幕和终稿替换 | 已实现 |
| CT-Punc 标点恢复 | 已实现 |
| 模型标点驱动分句 | 已实现 |
| 长句宽度兜底切分 | 已实现 |
| 字幕自动滚动和手动滚动保护 | 已实现 |
| 点击终稿跳转视频 | 已实现 |
| 已生成区间暂停识别 | 已实现 |
| 跳转后旧异步结果隔离 | 已实现 |
| 多视频页面状态保护 | 已实现 |
| 关闭弹窗、关闭标签页或音轨结束时清理 | 已实现 |
| 完全浏览器本地运行 | 已实现 |

第一版没有实现：

- 非中文视频翻译为中文。
- 自动语言检测。
- 浏览器内翻译 Worker。
- 双语字幕。
- SRT/VTT 导出。
- 字幕历史持久化。
- 说话人分离。
- iframe 视频完整适配。

## 5. 当前运行架构

```text
视频标签页
→ chrome.tabCapture
→ Offscreen Document
→ AudioWorklet
→ VAD Worker
→ ASR Worker
→ Punctuation Worker
→ Segmentation Worker
→ Offscreen 串行投递
→ Background
→ Panel
```

各阶段职责：

| 阶段 | 技术 | 输出 | 代码入口 |
| --- | --- | --- | --- |
| 页面播放器状态 | DOM 事件和视频状态协议 | 播放时间、暂停、倍速、视频 ID | `page-bridge.ts` |
| 音频捕获 | `chrome.tabCapture`、Offscreen、MediaStream | 标签页音频流 | `background.ts`、`offscreen.ts` |
| 音频转换 | AudioWorklet | 16 kHz、单声道、PCM16、20 ms 帧 | `audio-capture-processor.ts` |
| 人声检测 | Silero VAD v5、ONNX Runtime Web | 语音开始、语音帧、语音结束 | `vad-worker.ts`、`adaptive-vad.ts` |
| 语音识别 | Streaming Zipformer、Sherpa-ONNX WASM | 原始预览和终稿文本 | `asr-worker.ts` |
| 标点恢复 | CT-Punc int8、ONNX Runtime Web | 带标点文本 | `punctuation-worker.ts` |
| 字幕分句 | 模型标点优先、宽度兜底 | `caption.preview`、`caption.final` | `segmentation-worker.ts` |
| 会话与消息编排 | Chrome 消息、串行队列 | 有序 UI 事件 | `offscreen.ts`、`background.ts` |
| UI 与时间轴 | React、视频锚点 | 字幕列表和播放控制 | `panel.tsx` |

## 6. 关键技术决策

| 决策 | 原因 |
| --- | --- |
| 不读取平台字幕 | 用户需求是根据视频音频自动生成字幕 |
| 完全浏览器本地运行 | 不要求用户购买服务器或启动本地服务 |
| 分阶段独立 Worker | VAD、ASR、标点和分句状态互不耦合，故障可隔离 |
| 事件驱动播放器状态 | 页面脚本监听播放器事件，并按字幕区间边界调度 |
| 自适应 VAD 阈值 | 根据 Silero 概率、噪声底和信号峰值计算 |
| 模型标点优先分句 | 尽量由 CT-Punc 决定语义边界，宽度只做无边界兜底 |
| 预览组整体替换 | 同一语音段只保留最新预览组，避免新旧预览并存 |
| `recognitionEpoch` 隔离 | 暂停、恢复和跳转后拒绝旧 ASR、标点和分句结果 |
| `videoId` 和 `sequence` | 防止多视频页面和页面状态乱序污染当前视频 |
| Background 会话串行队列 | 避免快速启动、停止、关闭和错误清理互相竞态 |
| 正式构建压缩且无 sourcemap | 降低发布产物体积，避免把调试源码映射打进 `dist` |

## 7. 关键代码与文档

| 路径 | 用途 |
| --- | --- |
| `apps/extension/src/background.ts` | 标签页、窗口、Offscreen、会话队列和消息路由 |
| `apps/extension/src/offscreen.ts` | 音频流、Worker 生命周期、识别代次和事件调度 |
| `apps/extension/src/page-bridge.ts` | 视频检测、播放器事件、视频 ID 和边界定时器 |
| `apps/extension/src/panel.tsx` | 启动停止、字幕 UI、时间轴、去重和滚动 |
| `apps/extension/src/adaptive-vad.ts` | VAD 概率的自适应开关阈值 |
| `apps/extension/src/recognition-gate.ts` | 已生成区间识别门控和下一区间边界 |
| `packages/protocol/src/index.ts` | 全链路消息协议 |
| `scripts/build-extension.mjs` | 构建根目录 `dist` |
| `docs/current-runtime-architecture.md` | 当前运行架构、模型职责和执行顺序 |
| `docs/automatic-audio-translation-subtitles.md` | 总体技术方案和后续多语言设计 |
| `docs/v1-implementation-status.md` | 第一版实现、验证和未实现范围 |

## 8. 当前模型边界

| 模型 | 当前作用 | 第二版影响 |
| --- | --- | --- |
| Silero VAD v5 | 人声概率和语音段起止 | 可继续复用，多语言场景需重新评估阈值标定 |
| Streaming Zipformer | 中英双语语音转文字 | 不能覆盖全部源语言，需要多模型路由或替换 |
| CT-Punc | 中文和英文标点恢复 | 其他语言需要对应标点模型或策略 |
| 翻译模型 | 当前不存在 | 需要在本地翻译 Workers 中新增 |

多语言设计不能只更换 ASR 模型。必须同时考虑：

- 语言检测。
- ASR 模型路由和加载策略。
- 标点模型语言覆盖。
- 翻译模型与固定的简体中文输出约束。
- 模型体积、内存和低端设备降级。
- 实时字幕延迟。

## 9. 质量门禁

每次代码修改后执行：

```powershell
npm run verify
```

该命令包含：

1. TypeScript 严格类型检查。
2. 字幕文本去重测试。
3. 自适应 VAD 测试。
4. 识别区间门控测试。
5. 分句测试。
6. 标点模块测试。
7. 最新 `dist` 构建。

涉及 Markdown 时执行：

```powershell
npx --yes markdownlint-cli2@0.18.1 README.md docs/current-runtime-architecture.md docs/automatic-audio-translation-subtitles.md docs/v1-implementation-status.md docs/v2-session-handoff.md apps/extension/public/THIRD_PARTY_NOTICES.md
```

第一版最后一次验证结果：

| 项目 | 结果 |
| --- | --- |
| `npm run verify` | 通过 |
| 单元测试 | 19 项通过 |
| Markdown 校验 | 0 错误 |
| `dist` | 已生成，约 295.3 MiB |
| sourcemap | 未生成 |

## 10. 第二版开始前的检查清单

1. 确认工作区和远端 `main` 状态。
2. 确认第一版是否有尚未提交的用户改动。
3. 让用户明确第二版范围和首批源语言。
4. 优先复用现有协议、Worker 隔离和识别代次机制。
5. 先形成模型与资源预算，再改 UI 和业务代码。
6. 每一阶段的输入、输出、失败模式和性能边界都要写入设计文档。
7. 每次代码改动后重新构建 `dist`。
8. 功能完成并验证后展示改动摘要；未经用户明确要求不提交、不推送。
