# video-subtitle-extension 项目协作说明

## 新会话启动要求

开始任何第二版任务前，必须先完整读取：

1. `docs/v2-session-handoff.md`
2. `docs/current-runtime-architecture.md`
3. `docs/v1-implementation-status.md`

如果任务涉及产品范围、模型选择或多语言方案，还必须读取
`docs/automatic-audio-translation-subtitles.md`。

## 当前基线

- 第一版已由用户验收，进入第二版规划与开发阶段。
- 第一版提交为 `5a3a873 完成第一版本地实时中文字幕`。
- 当前产品形态是纯 Chrome Manifest V3 扩展，不在用户设备外运行字幕服务。
- 第一版固定输出简体中文，多语言识别和目标语言翻译尚未实现。

## 项目约束

- 产品只识别用户主动启动的标签页音频，不读取视频网站字幕。
- 不使用远程服务器、本地 Python 服务、WebSocket 推理服务或 API Key。
- VAD、ASR、标点、分句和后续翻译阶段保持独立架构，不重新合并为单体流程。
- 每次修改代码后必须重新生成根目录 `dist`；`dist` 和模型运行时目录不提交 Git。
- 代码修改完成后运行 `npm run verify`，涉及 Markdown 时同时运行 Markdown 校验。
- 不自动提交或推送。只有用户明确要求时才提交，Commit 信息必须使用中文。
- GitHub 推送统一使用当前 SSH remote。

## 第二版工作原则

- 第二版的具体范围以用户新会话中的最新要求为准，不把候选方案直接当作已确认需求。
- 优先复用第一版已经验证的音频捕获、Worker 隔离、事件协议、时间轴和识别代次机制。
- 新增语言能力时先明确源语言识别、目标语言翻译、模型体积和本地性能边界。
- 不重新引入固定音量阈值、固定轮询或与模型输出不一致的伪功能声明。
