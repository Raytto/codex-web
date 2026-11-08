# 从基础安装到完整工作台

[English](SETUP_GUIDE.en.md) · [首页快速安装](../README.md#快速开始) · [升级检查](UPGRADE_20261108.md)

先完成一个能登录、能执行文字任务的最小安装，再逐项启用自己需要的能力。所有账号、路径、域名和密钥由安装者提供；仓库不附带登录态、项目内容、记忆、云盘或真实设备。下文的“设置”指 Codex Web 左下角的个人设置；宿主机、容器和远程电脑是不同执行位置。

## 1. 最小可运行路径

前提：Linux、Git、Docker Engine、Compose v2、Buildx；可访问软件源，且有可授权使用 Codex 的账号。基础镜像只带一个固定版本的 Codex CLI、基础 Python、服务器运行依赖和编译后的网页。不需要在宿主安装 npm，不需要语音 API、云盘、宿主 root bridge 或额外模型 CLI。

1. 按[首页步骤](../README.md#快速开始)克隆 `main`，执行 `./scripts/build-image.sh`。构建使用 Git 中的已提交内容；先保存已有修改，不使用生产目录作为构建上下文。
2. 复制 `.env.example` 为私有 `.env`，填入 `APP_USERNAME`、`APP_DISPLAY_NAME`、本人生成的 `APP_PASSWORD_HASH` 和 `SESSION_SECRET`。建议普通账号名使用 `admin`，为可选宿主管理账号保留 `owner`。bcrypt 值用单引号包住，文件权限按首页设置为 UID/GID 10001、0600。
3. 创建 `codex-web-egress` 网络，运行 `sudo docker compose config --quiet` 和 `sudo docker compose up -d --no-build`。`init-state` 先初始化目录，Web 身份与租户执行身份分开。
4. 检查健康接口，打开浏览器，用自己设置的**用户名和原始密码**登录。这一步不需要 OpenAI API Key。
5. 为基础租户执行首页的 `codex login --device-auth` 命令，按官方页面完成授权。再在相同 UID、HOME、CODEX_HOME 下运行 `codex login status`。设备授权由本人完成；不要把 `auth.json` 放进 Git、聊天或工单。
6. 发送一个简单文字任务，上传一个小文本文件，生成一个结果，再重启容器检查历史和文件仍在。未实际执行模型任务时，健康检查不代表模型已授权。

Codex 的 ChatGPT 登录和 API Key 登录是两种授权方式；可用额度、模型和 API 计费取决于本人账号。此项目的默认流程使用设备登录，不把网页登录密码当作模型凭据。[官方 Codex 认证](https://learn.chatgpt.com/docs/auth)

远程服务器可先用 SSH 隧道访问回环端口。正式使用麦克风和远程 Worker 前配置 HTTPS 反向代理，保留 `BASE_PATH`，支持 SSE 和 WebSocket，并把 `PUBLIC_BASE_URL` 设为包含基础路径的最终 HTTPS 地址。修改 `BASE_PATH` 或品牌配置只需重新创建 app，不需重编译前端。

## 2. 配置不是一把通用 Key

| 能力 | 必填或可选 | 从哪里取得 | 填在哪里 | 不配时 / 验证 / 关闭 |
| --- | --- | --- | --- | --- |
| 网站登录 | 基础必填 | 本人生成密码哈希和随机会话密钥 | `.env` 的 `APP_*`、`SESSION_SECRET` | 无合法配置不能安全上线；验证登录/退出；停服务或禁用账号 |
| Codex 执行 | 文字任务必需 | 官方设备授权；另可使用本人 API 账号 | 对应执行器的 Codex Home；不是网站密码字段 | 任务提示授权不可用；验证一次真实任务；在该执行器退出 Codex |
| Gemini / Antigravity | 可选 | Google 官方 OAuth | 设置 → 账号管理 → 目标节点 → 添加 Gemini 账号 | 未登录不提供相应模型；验证真实 Gemini 任务；退出/移除该节点账号 |
| 录音转写 | 可选、有云调用费用 | Model Studio 的地域/工作空间 API Key 与兼容接口 | `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`DASHSCOPE_ASR_MODEL` | 未配置不可转写；录一条短语验证文本；清空 key 并重新创建 app |
| 持续语音 | 可选、独立 API 访问及费用 | OpenAI API 项目与 GPT-Live 访问权限 | `CODEX_WEB_LIVE_*`，服务端私有密钥文件 | 默认关闭；验证通话与原任务回执；设 `CODEX_WEB_LIVE_ENABLED=false` |
| API 记忆提炼 | 可选、独立模型调用费用 | 本人选择的兼容文本模型供应商 | `PERSONAL_MEMORY_PROVIDER=api` 和 `PERSONAL_MEMORY_API_KEY/BASE_URL/MODEL` | 缺任一配置不提炼；检查个人记忆状态与来源；关闭个人记忆或清空配置 |
| Codex 记忆提炼 | API 路径的可选替代 | 该用户执行器已有 Codex 授权 | `PERSONAL_MEMORY_PROVIDER=codex-cli`、`PERSONAL_MEMORY_MODEL`、`PERSONAL_MEMORY_EFFORT` | 无模型配置不提炼；检查审计结果；切回 api 或关闭个人记忆 |
| 冷存储与备份 | 可选，云盘容量/流量另计 | 本人云盘授权；本人生成的 age 身份与 recipient | 宿主独立 `STORAGE_*` 环境文件；见下文 | 默认关闭；必须做恢复演练；停维护调度，保留恢复入口和密钥 |

## 3. 录音输入与持续语音分别启用

### 录音转写

此发布的录音转写使用支持 `input_audio` 的 OpenAI-compatible **Chat Completions 音频模型**。它不是 OpenAI `/audio/transcriptions` 文件接口，不能只换 URL 就宣称兼容。另一个开发中的转写适配不属于本发布。

1. 在 [Model Studio 申请 API Key](https://help.aliyun.com/en/model-studio/get-api-key)，选择自己的地域与工作空间。
2. 从[Qwen-Omni 官方说明](https://help.aliyun.com/en/model-studio/qwen-omni)取得同地域的兼容接口和具有音频输入能力的模型。把 base URL 填入 `DASHSCOPE_BASE_URL`，不要附加 `/chat/completions`；模型填入 `DASHSCOPE_ASR_MODEL`。示例占位值不能直接调用。
3. 把 key 只写入私有 `.env`。重新创建 app，使用显式录音按钮，授权浏览器麦克风。录一条短语，核对转写、发送和任务历史。
4. 测试断网后的保留、重试和删除；上传重试不应重复提交。草稿、最近对话、附件名和受限图片可能用于转写上下文，预算由 `TRANSCRIPTION_CONTEXT_*` 控制。
5. 清空 `DASHSCOPE_API_KEY` 并重新创建 app 可停止新转写，历史录音/文字不会自动删除。

### PP Dot 与原会话持续语音

PP Dot 的文字总管、台账和长期记忆不需要语音 Key。持续语音沿用已实现的 **GPT-Live WebSocket + client delegation** 协议；并非 Realtime WebRTC 适配器。[官方 Live 连接协议](https://developers.openai.com/api/reference/typescript/resources/live/methods/connect) · [官方委派说明](https://developers.openai.com/api/docs/guides/live-delegation)

1. 先完成下节的显式宿主账号/项目设置，验证 PP Dot 的文字任务。
2. 从 [OpenAI API 平台](https://platform.openai.com/api-keys)创建自己的项目密钥，并核实账户的模型访问、预算及[当前计费](https://developers.openai.com/api/docs/pricing)。Codex 登录不会自动填入这个 API Key；可用 API 赠额与额度以本人账户为准。
3. 把密钥保存为服务器上的独立私有文件，挂载到容器 `/app/data/secrets/live-api-key`（或其他本人指定路径），只允许 Web UID 10001 读取。不要把密钥写进前端或 URL。
4. 在私有 `.env` 设置：

   ```dotenv
   CODEX_WEB_LIVE_ENABLED=true
   CODEX_WEB_LIVE_API_KEY_FILE=/app/data/secrets/live-api-key
   CODEX_WEB_LIVE_ENDPOINT=wss://api.openai.com/v1/live/sessions
   CODEX_WEB_LIVE_MODEL=gpt-live-1
   CODEX_WEB_LIVE_VOICE=marin
   CODEX_WEB_LIVE_PROXY_URL=
   ```

   上述协议、模型和音色是本次核对官方文档后的启用示例，源码默认留空/关闭；使用前仍需核实本人账号访问权。代理可选，仅接受本人配置的代理，不继承源站私有拓扑。配置代理后连接失败不会悄悄换成直连。
5. 重新创建 app，在项目会话的通话按钮中开始。验证连接提示音、连续输入、打断播报、挂断和恢复；提出一个小任务，确认任务在**原会话**执行并有真实结果。PP Dot 中的工作请求则派到其真实目标项目。
6. “先别说”只停播报；挂断不取消后台任务。明确取消当前任务才进入取消流程。引导运行中的 Codex 要求同一模型/思考深度；Antigravity 的补充进入下一轮。
7. 设 `CODEX_WEB_LIVE_ENABLED=false` 并重新创建 app 关闭通话。保留文字会话、台账和已派任务。浏览器麦克风、真机音频和付费服务必须在自己的环境验收；本仓库的合成协议测试不等于云端通话通过。

## 4. PP Dot、宿主与自己的电脑

PP Dot 已包含在公开源码中：固定总管会话、跨项目委派、任务台账、来源记忆、纠正/遗忘、结果复核及语音入口。它只访问当前账号的项目和节点，执行 Agent 不能覆写总管长期记忆。一次回合结束不等于业务验收完成。

公开基础租户仍低权限；宿主与 Remote Worker 属于显式授权的高权限执行器。按[部署选项 §4、§5](DEPLOYMENT_OPTIONS.md)创建 `create-host-root owner` 身份、配置独立根目录/Socket/认证策略，启动宿主服务。不要把普通账号改成 root，也不要把 Docker socket 加入基础 Compose。若普通账号已占用 `owner` 名称，先按现有用户管理流程处理命名冲突，不能重写其 ID。

- 服务器：必须存在与 `CODEX_WEB_KNOWLEDGE_ROOT` 一致的唯一活动服务器项目。登录宿主管理账号后，在功能选择中启用 PP Dot，点击入口，发送一条小的跨项目任务，检查目标会话、任务结果和台账回链。缺项目或模型时会明确提示。
- 远程电脑：在项目创建入口选择“新建远程 Worker”，完成一次性安装授权。安装包只带通用程序，注册后设备使用独立凭据。详情见 [Worker 安装、升级与撤销](../remote-worker/README.md)。验证在线状态、本人目录、小任务、文件回传、取消和重连；云端测试不替代真机验收。
- Gemini：在设置的账号管理中选择服务器或远程节点，再添加 Gemini 账号。通过 [Antigravity 官方授权](https://antigravity.google/docs/install)完成 Google 登录；当前实现使用节点上的受支持 Antigravity CLI，基础镜像不预装。传统 [Gemini CLI 认证](https://geminicli.com/docs/get-started/authentication/)不等于已经授权本项目节点配置。模型目录以该节点实际返回值为准。
- 关闭：功能选择可隐藏 PP Dot 入口，台账仍保留；断开 Worker 或撤销设备凭据可停止远程接单。仅清空 enrollment token 不会撤销已签发设备凭据。停宿主桥前先结束/排空依赖它的任务。

## 5. 项目、周期任务与个人工具

这些模块不预置用户内容，也没有额外的隐藏模型调度器。实际执行仍使用所选执行器的账号额度。

| 模块 | 使用与验证 | 关闭 |
| --- | --- | --- |
| 项目与技能 | 创建本人目录项目，检查新会话归属、跨项目移动和技能文件；远程项目先验证 Worker | 归档项目；停用对应技能 |
| 周期任务 | 项目菜单创建一次短周期任务，核对模型、时区和下一次时间；重启后仍可见 | 暂停/删除周期规则；停止一次执行不等于停规则 |
| 一次性续跑 | 会话中安排指定时间或事件继续，核对原/新会话和等待卡；服务重启后仍在 | 取消等待计划 |
| 完整任务 | 默认 `MAX_ACTIVE_WORKFLOWS=-1`；等待与续跑继承所有权，完成需功能和清理证据 | 可设正整数容量；不能通过结束 Job 冒充完成 |
| 项目看板 | 个人设置的功能选择启用，创建自己的看板与卡片并打开关联会话 | 关闭账号功能；全站 `CWW_PARA_ENABLED=false` 保留数据 |
| 机会卡片 | 启用后创建空主题，填写目标，处理反馈并核对推荐/研究状态 | 关闭账号功能或归档主题 |
| 判断簿 | 本人给出概率和标准，在已有服务器项目讨论；语义结果由本人确认 | 关闭账号功能或取消核验；缺证据不判否 |

完整任务不限不等于所有资源不限：单会话串行、远端设备容量、磁盘水位、用户配额和容器限制继续有效。可选 `TASK_MEMORY_GUARD=true` 要求宿主 systemd 内存范围与显式 `CODEX_WEB_TASK_SCOPE_OWNER`、`CODEX_WEB_TENANT_CONTAINER_NAME`、租户 slice 配置；缺基础设施时排队/拒绝启动，不降级失去保护。基础版继续依靠 Compose 和现有调度上限。

## 6. 个人记忆

在个人设置启用个人记忆，内容保存在本人 library 的 personal 区域。自动提炼仅处理该账号的消息，带来源和审计；项目任务指令不应变成跨项目个人偏好。启用前确认愿意把筛选后的消息送给所选模型。

- **API 路径**：保留既有兼容 Chat Completions 文本提炼接口；明确填写 `PERSONAL_MEMORY_PROVIDER=api`、独立 key、HTTPS base URL 和模型。不要填写录音接口或 Live WebSocket 地址。API key 在所选供应商官方平台申请；例如 [OpenAI 开发者快速开始](https://developers.openai.com/api/docs/quickstart)。本项目该路径要求兼容的 JSON 对象输出，不代表支持供应商所有新接口。
- **Codex 路径**：设 `PERSONAL_MEMORY_PROVIDER=codex-cli`，从本人 Codex 目录中选择 `PERSONAL_MEMORY_MODEL` 和 `PERSONAL_MEMORY_EFFORT`；不需要 `PERSONAL_MEMORY_API_KEY`。受管提炼使用临时、只读、禁工具、禁项目规则的进程；服从执行器授权及资源门禁。仅配置模型不代表登录有效。
- **验证**：让一个合成偏好进入候选，查看提炼状态、来源消息、provider/model 审计及用户资料；修改/遗忘后核对后续上下文。额度、授权、离线失败保留待处理项，不记为成功。
- **关闭**：在个人设置关闭自动提炼；或清空模型/必要 API 配置后重建 app。旧记忆保留，删除/遗忘是单独操作。

## 7. 存储、备份与恢复

本次包含 v3 谱系归档和可选分块存储生命周期：目录索引不是原文，已登记的缺失文件先恢复；原生线程、附件、阅读资源、事件与恢复点各自有来源和状态。实现默认不上传、不删除，不附带云盘身份或密钥。

详细的宿主配置、备份计划、维护命令和恢复演练见 [存储生命周期安装](STORAGE_LIFECYCLE.md)。只在独立的测试数据和空恢复目录完成往返核验后启用维护调度。保留原加密身份；不要为每个功能新建一把互不相关的 key。基础安装也应做本地一致性备份，升级前停写/排空并同时保存 `.env`、状态目录与加密身份的独立副本。

## 8. 每次升级的验收顺序

备份 → 固定旧提交/镜像 → 拉取 `main` → 构建 → 初始化权限 → 启动 → 登录 → 文字任务/附件 → 原有状态 → 逐项启用能力 → 恢复演练。旧镜像不要打开已经由新版本迁移的数据库，回滚需成套恢复匹配的状态快照。详见[构建与回滚](BUILD_AND_STORAGE.md)和[本轮迁移边界](UPGRADE_20261108.md)。

当前语音边界：网络拥塞后，迟到的旧音频可能重新进入播放队列，转写聚合顺序也不等于真实播放顺序。新话轮优先、过时播报抑制的补修尚未纳入本发布。可使用显式停止播报/挂断控制；本版本不承诺弱网下只播放最新话轮，需在自己的真机验收。
