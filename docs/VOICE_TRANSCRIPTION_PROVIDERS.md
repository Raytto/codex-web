# Recorded speech: choose one provider

[中文搭建](SETUP_GUIDE.zh-CN.md) · [English setup](SETUP_GUIDE.en.md)

录音转写把一次录完的语音变成文字；持续通话是另外的 Live 服务，Codex CLI 登录也不会自动提供任何语音 API 密钥。两种录音提供方均可选、通常按供应商规则收费；不配 key/模型时安全不可用，基础文字任务不受影响。

## OpenAI 文件转写 / file transcription

1. 在 [OpenAI API 项目](https://platform.openai.com/api-keys)创建自己的 key，核实账户模型权限、预算及[价格](https://developers.openai.com/api/docs/models/gpt-transcribe)。该适配器使用 `/v1/audio/transcriptions`，不把音频伪装成普通文字消息。[官方文件转写](https://developers.openai.com/api/docs/guides/speech-to-text)
2. 在私有 `.env` 设置以下启用示例。源码模型默认留空；本例模型与端点已在 2026-11-09 官方文档核实，实际访问权仍取决于本人账号。

```dotenv
TRANSCRIPTION_PROVIDER=openai
OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe
OPENAI_TRANSCRIPTION_BASE_URL=https://api.openai.com/v1
OPENAI_TRANSCRIPTION_API_KEY=
OPENAI_TRANSCRIPTION_API_KEY_FILE=/app/data/secrets/transcription-api-key
OPENAI_TRANSCRIPTION_PROXY=direct
OPENAI_TRANSCRIPTION_LANGUAGES=zh,en
```

3. 将自己的 key 保存为上面文件，挂载/保存在本实例状态卷，由 Web UID 10001 读取，模式 0600。也可只设 `OPENAI_TRANSCRIPTION_API_KEY`；仅选一种凭据方式，均不要提交 Git。它与 `CODEX_WEB_LIVE_API_KEY_FILE`、个人记忆 key 分别管理。
4. `direct` 是公开默认。若自己需要代理，可填 HTTP(S) 代理地址；`codex` 表示显式复用自己已配置的 Codex 出口。缺少代理基础设施不能从原站寻找凭据或拓扑。语言可留空自动识别；当前适配器接受逗号分隔的两字母 ISO-639-1 代码，这是本实现的输入范围，不声称支持官方的每一种语言代码格式。
5. 重新创建 app，点“录音输入”并授权麦克风。录制一小段包含自己词库术语的音频，检查上传进度、识别文字、发送/补充到原会话、失败重试和取消。服务记录 provider、实际模型、提示版本与可用的时长统计；时长不是 token 数，也不是最终账单。网络失败后的重试不应重复创建应用提交，但不能保证供应商未计费。
6. 关闭：清空所选提供方 key/模型并重新创建 app；或切回已配置的 `dashscope`。历史音频/转写保留，删除是单独操作。

The English installation procedure is the same: obtain your own API project key and model access; place it in the server-only file shown above (or the dedicated key environment variable); select `openai`, an authorized model and the HTTPS base URL; recreate app; then test a short recording, upload progress, transcript, cancellation and retry. This is separate from Codex authentication, Live calls and memory extraction. Clear the key/model or switch provider to disable new requests. No paid cloud service was exercised merely by running the repository's synthetic tests.

## DashScope compatibility

The default provider remains `dashscope`. Supply your own `DASHSCOPE_API_KEY`, regional/workspace `DASHSCOPE_BASE_URL` and audio-capable `DASHSCOPE_ASR_MODEL`; obtain them from [Model Studio's API-key guide](https://help.aliyun.com/en/model-studio/get-api-key) and [Qwen-Omni documentation](https://help.aliyun.com/en/model-studio/qwen-omni). This path uses Chat Completions with audio input. Changing its URL to an OpenAI file-transcription URL is not a provider migration. Switch the provider field instead. Disable new requests by clearing its key and recreating app.

## Context and privacy

The OpenAI adapter sends bounded prose context as `prompt`, validated literal terms as `keywords[]`, and optional language hints as `languages[]`; it does not embed a term list into the prose prompt. Only relevant account/project context is selected. Browser audio is converted to 16 kHz mono PCM WAV with ffmpeg and rejected if it exceeds the provider byte limit; it is not silently cut off. Existing recording duration/input limits continue to apply. Synthetic tests use generated audio and mocked HTTP/local transports, including real conversion; they are not proof of recognition quality on a user's device or a successful paid API call.

## Bounded context update (2026-11-14)

Dynamic prose defaults to 2000 approximate tokens with the latest ten user/assistant messages. Weighted allocation keeps both the beginning and latest conclusion of long sources; an empty conversation may include its project title. Literal keywords are selected independently, capped at 200 terms, with account/project suppression respected. These controls do not grant a provider key or change any account's endpoint/model. Inspect actual provider/model diagnostics and test your own short recording after changing explicit settings.

正文默认2000近似token、最近10条对话，长资料保留开头与结论；空会话可使用项目名。术语最多200项，去重、禁用词和关键词预算独立生效。已有环境覆盖继续优先；这不等于真实识别质量或付费接口验收。
