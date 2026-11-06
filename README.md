# video-subtitle-enhanced

纯 Chrome 扩展实现的中文实时字幕工具。

扩展直接捕获当前标签页音频，在浏览器内部通过 AudioWorklet、Web Worker 和 WebAssembly 完成中文识别。不需要远程服务器，不需要安装 Python，也不需要启动本地辅助服务。

> 当前分句由 CT-Punc 模型输出的标点驱动。实时预览和终稿使用同一套模型标点链路，不再按“但是”“因此”等连接词词典切分，也不会人工补标点；只有在模型没有给出可用边界时，才按字幕最大宽度兜底。

## 当前能力

| 能力                         | 状态   |
| ---------------------------- | ------ |
| 标签页音频捕获               | 已实现 |
| 原视频声音继续播放           | 已实现 |
| 16 kHz 单声道 PCM            | 已实现 |
| 浏览器内 Silero VAD 人声检测 | 已实现 |
| 浏览器内 WASM 中文识别       | 已实现 |
| 临时字幕和终稿替换           | 已实现 |
| CT-Punc 驱动的实时分句       | 已实现 |
| 稳定分句前缀、仅更新尾句     | 已实现 |
| 自动滚动及手动滚动保护       | 已实现 |
| 长句自动切分为多条字幕       | 已实现 |
| 字幕时间轴                   | 已实现 |
| 点击字幕跳转视频             | 已实现 |
| 跳转后重置识别并过滤重复字幕 | 已实现 |
| 独立弹窗窗口                 | 已实现 |
| 完全无远程网络请求           | 已实现 |
| 外语翻译为中文               | 待实现 |
| 多目标语言                   | 待实现 |
| SRT/VTT 导出                 | 待实现 |

当前使用三个神经网络模型：

- Silero VAD v5：负责人声概率检测和语音段起止。
- 中英双语流式 Zipformer：负责把音频识别为原始文字。
- CT-Punc：负责给识别文本补充逗号、句号、问号和顿号。

首阶段只承诺中文视频识别，模型和 WASM 运行时全部打包在扩展中。

第一版的完整实现状态和未实现范围见：

- [第一版实现状态说明](docs/v1-implementation-status.md)
- [当前运行架构与执行流程](docs/current-runtime-architecture.md)

## 架构

```text
视频标签页
  ↓ chrome.tabCapture
Offscreen Document
  ↓ AudioWorklet：16 kHz PCM
ASR Web Worker
  ├── Silero VAD：检测人声并分段
  └── Streaming Zipformer：音频转原始文字
Caption Web Worker
  └── CT-Punc：标点与模型标点分句
Popup Panel
```

ASR Worker 只发送原始 `asr.caption`；Caption Worker 只消费这些原始结果并生成最终字幕事件。
Caption Worker 未就绪、排队或异常时，Offscreen 直接显示原始识别结果，音频捕获和 ASR 不会停止。

运行过程没有 HTTP、WebSocket、localhost 服务或远程 API。

## 工程结构

```text
/
├── apps/extension/
│   ├── public/
│   │   ├── manifest.json
│   │   ├── panel.html
│   │   ├── panel.css
│   │   ├── offscreen.html
│   │   ├── licenses/
│   │   └── THIRD_PARTY_NOTICES.md
│   └── src/
│       ├── background.ts
│       ├── page-bridge.ts
│       ├── offscreen.ts
│       ├── asr-worker.ts
│       ├── caption-worker.ts
│       ├── panel.tsx
│       └── audio-capture-processor.ts
├── packages/protocol/              # 扩展内部消息类型
├── scripts/
│   ├── build-extension.mjs
│   └── fetch-wasm-runtime.mjs
├── tests/
│   ├── browser/wasm-smoke.html
│   └── fixtures/zh.wav
├── vendor/                         # ASR、标点和 ONNX 运行时资源，不提交
├── docs/
└── dist/                           # Chrome 加载目录
```

## 环境要求

- Windows 10/11。
- Node.js 22 或更高版本。
- Chrome 或 Edge 最新稳定版。
- 支持 WebAssembly SIMD 的桌面 CPU。

最终用户只需要安装扩展，不需要 Node.js。Node.js 仅在开发构建阶段使用。

## 首次安装

```powershell
cd D:\project\video-subtitle-extension
npm install
npm run runtime:fetch
npm run build
```

`runtime:fetch` 会下载并校验 Sherpa-ONNX、Silero VAD 与 CT-Punc 模型包，并复制 ONNX Runtime Web：

```text
vendor/sherpa-onnx-web
vendor/vad
vendor/ct-punc
vendor/onnxruntime-web
```

## 加载扩展

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载未打包的扩展程序”。
4. 选择：

```text
D:\project\video-subtitle-extension\dist
```

`dist/manifest.json` 必须直接位于所选目录中。

## 使用

1. 打开包含视频的网页并播放。
2. 点击浏览器工具栏中的扩展图标。
3. Chrome 会打开一个独立字幕弹窗。
4. 首次启动会加载人声检测模型、识别模型、中文标点模型和 WASM 运行时。
5. 点击“启动中文字幕”。
6. 黄色虚线字幕是临时结果，普通字幕是终稿。
7. 点击终稿字幕可跳转到对应视频时间。

## 开发验证

```powershell
npm run typecheck
npm run test:punctuation
npm run test:segmenter
npm run build
```

浏览器 WASM 烟雾测试：

```powershell
npm run test:browser
```

然后打开：

```text
http://127.0.0.1:8123/tests/browser/wasm-smoke.html
```

该测试只使用静态文件服务器提供测试页面，不运行语音识别服务。识别仍在浏览器 Worker 中完成。

## 安全与隐私

- 扩展不需要网络权限。
- CSP 只允许扩展自身资源。
- 音频不写入磁盘。
- 字幕只保存在当前会话内存中。
- 不读取或抓取网页平台字幕。
- 不包含账号、遥测或远程分析。

## 当前限制

- 扩展包较大，包含识别、标点和推理运行时资源。
- 模型加载需要一定时间，首次启动更明显。
- VAD 使用 Silero 概率阈值，复杂音乐、混响和远场声音仍可能误判。
- 实时预览和终稿都使用 CT-Punc 恢复中文标点，再由模型标点决定字幕边界；无标点时按最大宽度兜底。
- 当前只做中文识别，不做外语翻译。
- 尚未实现 SRT/VTT 导出和历史记录。
- iframe 内的视频可能无法检测和跳转。
- 标签页中的其他声音也会被捕获。

## 设计文档

- [纯浏览器扩展中文字幕技术方案](docs/automatic-audio-translation-subtitles.md)

## 第三方组件

- Sherpa-ONNX 1.13.7，Apache-2.0。
- Streaming Zipformer bilingual zh-en 模型，Apache-2.0。
- Silero VAD v5，MIT。
- CT-Punc int8，Apache-2.0。

完整说明见 `THIRD_PARTY_NOTICES.md` 和 `licenses/`。
