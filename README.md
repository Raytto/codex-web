# Codex Web

**中文** · [English](README.en.md)

把 Codex CLI 变成可以在浏览器中使用的自托管工作台：在电脑或手机上发起任务，管理项目、文件和执行记录，关闭页面后仍可回来查看结果。

会话、草稿、附件、队列和执行记录保存在你自己的服务器上。基础部署使用用户名与密码登录，Codex 在独立的低权限租户进程中执行。需要连接其他电脑、使用语音或启用云端冷存储时，再分别配置扩展。

> 本项目由社区独立开发，与 OpenAI 无隶属关系，未获得 OpenAI 的背书或支持。

[快速开始](#快速开始) · [可选能力](#可选能力) · [文档导航](#文档导航) · [云服务器部署手册](AI_CLOUD_DEPLOYMENT_RUNBOOK.md)

## 主要能力

| 场景 | 当前支持 |
| --- | --- |
| 持续处理任务 | 会话与草稿持久化、可编辑和重排的待发送队列、实时工作记录、停止后的中断摘要、归档与恢复 |
| 长流程与自动化 | 一次性定时或外部事件续跑；项目周期任务、时区与执行记录；运行中向 Codex 补充指令 |
| 项目工作 | 项目目录、会话移动、项目技能、跨项目搜索；可选项目看板、机会卡片与判断簿 |
| 文件交付与阅读 | 附件和大文件续传、Markdown/HTML/PDF/EPUB 等预览、文档选区提问、公式、可撤销的公开分享、受控交互 HTML |
| 电脑与手机 | 响应式界面、草稿跨设备恢复、未读结果、主题和字号设置 |
| 扩展执行能力 | 显式配置的宿主桥、Remote Worker，以及受支持节点上的 Gemini / Antigravity 引擎 |

模型及思考深度以所选执行器的实际账号目录为准。Codex 的运行中引导要求与当前任务使用相同模型和思考深度；Gemini / Antigravity 的补充消息排队等待下一轮。切换引擎会传递有界的历史上下文，不等于迁移整个原生会话。

```mermaid
flowchart LR
    browser["浏览器：电脑 / 手机"] --> app["Codex Web：界面、API、队列"]
    app <--> state[("本机持久状态：SQLite、文件、会话")]
    app --> tenant["隔离租户 → Codex CLI"]
    app -. "显式配置后" .-> remote["宿主桥 / Remote Worker"]
```

## 快速开始

以下是 **Linux + Docker 的基础部署**，在可使用 Docker 的 Bash 终端执行。需要 Git、Docker Engine、Compose v2、Buildx，以及能够登录 Codex CLI 的账号；宿主无需安装 Node.js 或 npm 开发依赖。

建议至少准备 4 GB 内存，文档处理等较重任务使用 8 GB 或更多。构建、升级和回滚还需要额外磁盘空间；[构建与容量指南](docs/BUILD_AND_STORAGE.md)区分了镜像、构建峰值和用户数据，旧测量不代表当前安装大小。

### 1. 获取源码并构建

```bash
git clone --branch main https://github.com/Raytto/codex-web.git
cd codex-web
./scripts/build-image.sh
cp .env.example .env
chmod 600 .env
```

请使用 `main`。构建脚本从选定 Git 提交导出源码，使用有资源上限的临时 Buildx builder，并在结束时清理自己的构建缓存。默认生成 `codex-web:local` 基础镜像；已有本地修改应先提交或妥善保留。

### 2. 生成登录密码哈希和会话密钥

在终端输入至少 12 个字符的网页登录密码，输入不会回显：

```bash
read -r -s -p 'Web password (at least 12 characters): ' web_password
printf '\n'
printf '%s' "$web_password" | docker run --rm -i --network none \
  --entrypoint node codex-web:local scripts/hash-password.mjs
unset web_password
```

再生成独立的随机会话密钥：

```bash
docker run --rm --network none --entrypoint node codex-web:local \
  -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 3. 编辑私有 `.env`

| 配置 | 填写方式 |
| --- | --- |
| `APP_USERNAME` | 网页登录名，例如 `admin`。若以后启用宿主桥或 Remote Worker，普通账号不要使用保留名 `owner` |
| `APP_DISPLAY_NAME` | 网页显示名称 |
| `APP_PASSWORD_HASH` | 上一步生成的 bcrypt 哈希；在 `.env` 中用单引号包住完整值，避免 `$` 被 Compose 插值 |
| `SESSION_SECRET` | 上一步生成的随机会话密钥 |
| `PUBLIC_BASE_URL` | 本机试用保留 `http://localhost:37821/codex-web`；公网部署改成包含 `/codex-web` 的实际 HTTPS 地址 |

网页登录与 Codex 授权是两回事。`.env` 只保存在自己的安装环境，不提交到 Git；未使用的语音、个人记忆、宿主桥等配置保持空值。

### 4. 初始化权限并启动

```bash
sudo chown 10001:10001 .env
sudo chmod 600 .env
sudo docker network inspect codex-web-egress >/dev/null 2>&1 \
  || sudo docker network create codex-web-egress
sudo docker compose config --quiet
sudo docker compose up -d --no-build
sudo docker compose ps
```

后续编辑 `.env` 使用有权限的编辑器，Compose 命令使用 `sudo` 或宿主 root。`init-state` 会先初始化数据目录权限，再启动应用；Web 进程读取私有配置，租户执行进程使用不同的 Unix 身份。

等待应用健康后检查：

```bash
curl --fail http://127.0.0.1:37821/codex-web/api/health
```

### 5. 为基础租户登录 Codex

```bash
sudo docker compose exec --user 11001:11001 \
  -e HOME=/app/tenants/00000000-0000-4000-8000-000000000001 \
  -e CODEX_HOME=/app/tenants/00000000-0000-4000-8000-000000000001/codex-home \
  app codex login --device-auth
```

按命令输出完成设备授权，再打开 **http://localhost:37821/codex-web/**，使用第 3 步的网页登录名和第 2 步输入的原始密码登录。先运行一个简单任务，并验证文件上传、下载和重启后的历史保留。

如果服务装在远程服务器上，`localhost` 指那台服务器。可以先用 SSH 端口转发进行试用：

```bash
ssh -L 37821:127.0.0.1:37821 user@your-server
```

公网访问请按[部署说明](docs/DEPLOYMENT.md#reverse-proxy)设置 HTTPS 反向代理，保留 `/codex-web/` 路径及 SSE/WebSocket 支持。默认端口仅绑定回环地址。

## 可选能力

基础镜像只提供主应用、一个固定版本的 Codex CLI、Python/uv、Git 和 FFmpeg 等基础运行工具。扩展按需配置；仓库包含实现不代表已经启用。

| 能力 | 启用条件与说明 |
| --- | --- |
| Office、PDF 转换及文档库 | 构建 `documents` 镜像，增加 LibreOffice、Poppler、字体和 Python 文档/数据包；见[构建指南](docs/BUILD_AND_STORAGE.md) |
| 语音转写 | 配置自己的 `DASHSCOPE_API_KEY`、HTTPS `DASHSCOPE_BASE_URL`、可用的 `DASHSCOPE_ASR_MODEL` 和 HTTPS `PUBLIC_BASE_URL`；音频和有界上下文会发送到所配置的服务 |
| 个人记忆提取 | 配置 `PERSONAL_MEMORY_API_KEY`、`PERSONAL_MEMORY_BASE_URL` 及模型；未配置时不调用外部提取服务 |
| 宿主桥 / Remote Worker | 显式选择可信执行器、配置身份和路径；详见[分层部署](docs/DEPLOYMENT_OPTIONS.md)与[Worker 指南](remote-worker/README.md) |
| Gemini / Antigravity | 在已配置的受支持节点上显式添加账号并授权；基础镜像不附带额外模型 CLI；见[多引擎说明](docs/MULTI_ENGINE.md) |
| 冷存储 / 共享 Codex 认证 | 分别配置存储供应商与加密密钥，或认证来源与策略；默认不附带云盘、密钥或登录态 |
| 项目看板、机会卡片、判断簿 | 按账号在功能选择中启用；公开仓库不预置私人项目、主题或业务记录 |

需要文档工具时，使用相同构建入口：

```bash
CODEX_WEB_BUILD_TARGET=documents ./scripts/build-image.sh
```

构建脚本读取导出的 shell 环境变量，不能只修改 `.env` 就假定它会选择 `documents`。语音模板中的 `transcription-model`、记忆模板中的 `memory-model` 是占位值，启用时应替换为供应商实际支持的模型。完整配置与验收步骤见[分层部署与可选功能指南](docs/DEPLOYMENT_OPTIONS.md)。

## 任务和数据如何保存

- 同一会话串行，多会话可并行；普通账号调度受全局、用户、执行器等限制，相关配置包括 `MAX_GLOBAL_RUNNING_JOBS`、`MAX_RUNNING_JOBS_PER_USER` 和 `MAX_RUNNING_JOBS_PER_EXECUTOR`。
- 关闭浏览器不会删除服务器上的队列、草稿或文件。持久续跑计划可以跨服务重启保留；强制中断的模型执行会留下恢复记录，不保证任意进程能够从中断点自动继续。
- 默认状态位于 `.state/data` 和 `.state/tenants`，包括应用数据库、账号隔离的文件及 Codex 登录/会话状态。它们需要单独备份，不属于源码。
- 默认 Compose 不挂载 Docker socket 或宿主项目目录，也不启动宿主 root bridge。启用可信执行器前先阅读[安全模型](docs/SECURITY.md)。

浏览器负责交互，服务器持久化状态，所选执行器负责实际运行；更完整的关系见[架构说明](docs/ARCHITECTURE.md)。

## 升级与开发

升级前备份状态目录和 `.env`，阅读对应[部署与迁移说明](docs/DEPLOYMENT.md#updating)。在干净的 `main` 工作树中：

```bash
git pull --ff-only
./scripts/build-image.sh
sudo docker compose up -d --no-build
```

需要受管发布时，可选用 `deploy/codex-web-request-rebuild` 与 `deploy/codex-web-rebuild-coordinator`，或安装 `codex-web-self-maintain.service` / `.path` 模板；这些不会随基础安装自动启用。发布队列、状态及回滚材料留在部署者的状态目录。

本地开发需要 **Node.js ≥ 22.13.0**。填写本地 `.env` 后：

```bash
npm ci
npm run lint
npm test
npm run dev
```

开发页面默认位于 `http://127.0.0.1:5173/codex-web/`。`npm test` 构建并运行应用测试；Worker 有独立的 `npm run test:worker` 入口，需要先安装 `remote-worker` 的依赖。贡献方式见[CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档导航

| 需要了解 | 文档 |
| --- | --- |
| 新云服务器从零部署 | [AI 云服务器部署与运维手册](AI_CLOUD_DEPLOYMENT_RUNBOOK.md) |
| 镜像选择、构建、容量与清理 | [构建与存储](docs/BUILD_AND_STORAGE.md) |
| 部署、反向代理、升级与备份 | [部署说明](docs/DEPLOYMENT.md) · [可选功能](docs/DEPLOYMENT_OPTIONS.md) |
| 权限与系统结构 | [安全模型](docs/SECURITY.md) · [架构说明](docs/ARCHITECTURE.md) |
| 定时续跑与项目计划 | [持久续跑](docs/WAKE_AUTOMATION.md) · [项目周期任务](docs/PROJECT_RECURRING_TASKS.md) |
| 项目与个人辅助功能 | [项目看板](docs/features/PERSONAL_KANBAN.md) · [机会卡片](docs/OPPORTUNITY_CARDS.md) · [判断簿](docs/JUDGMENT_BOOK.md) |
| 文档阅读与分享 | [阅读器](docs/READER_PROGRESSIVE_LOADING.md) · [公开分享](docs/PUBLIC_FILE_SHARING.md) · [交互 HTML](docs/WEB_PRESENTATIONS.md) |
| 其他执行器与模型 | [Remote Worker](remote-worker/README.md) · [Gemini / Antigravity](docs/MULTI_ENGINE.md) |
| 最近一轮公开功能升级 | [2026-11-04 升级说明](docs/UPGRADE_20261104.md) |

本页按当前公开 `main` 的实现维护；历史更新和迁移细节放在专题文档中。

## 许可证

[MIT](LICENSE)
