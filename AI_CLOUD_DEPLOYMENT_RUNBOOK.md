# Codex Web 新云服务器部署与运维手册（供 AI 执行）

> 核验日期：2026-08-26
>
> 适用范围：全新的 Ubuntu 24.04 LTS 云服务器；Ubuntu 22.04 可参考执行。其他发行版必须先改写软件源、包名和服务命令，不得直接照抄。
>
> 默认形态：Codex Web、Supervisor、租户 Worker 和 Codex CLI 都运行在云服务器；运维人员或 AI 通过 SSH 管理云服务器。Nginx 默认安装并作为唯一公网入口。域名与公网证书是可选项。

本文是一份“可交给另一个 AI 执行”的部署运行手册。执行者必须逐阶段完成检查，记录非敏感证据，并在每个验收点通过后再继续。不要为了让命令成功而降低隔离、公开内部端口或跳过认证。

> **部署结果边界：**本文默认先交付一个可登录、可提交任务、可持久运行的基础版。宿主/root bridge、Remote Worker、语音、个人记忆提取、冷存储、共享 Codex 认证和自发布协调器都随公开仓库提供实现，但默认关闭，必须逐项询问、配置和验收。不要因为源码存在就自动启用高权限或外发数据的功能。

## 1. 先确认基础版和可选扩展

Codex Web 公开版当前支持的完整部署链路是：

```text
浏览器
  │ HTTPS（有域名）或 SSH 隧道（无域名）
  ▼
Nginx :80/:443
  ▼
127.0.0.1:37821/codex-web
  ▼
Codex Web 容器（Web UID 10001）
  ▼
Supervisor → 租户 Worker（非 root UID 11001）→ Codex CLI
  ▼
持久化卷：应用状态、租户目录、Codex 运行时
```

先让用户逐项回答下面的问题，并把答案写入部署记录；只记录“是/否”和配置名称，不记录秘密。基础版先完成，扩展一次只开一个：

| 模式 | 状态 | 用途 |
| --- | --- | --- |
| 基础版：云端内置租户 Worker | **默认** | Codex Web 与 Codex CLI 在云服务器容器内运行。先完成本文第 3～10 节。 |
| SSH 远端 Codex | 可选 | 运维者通过 SSH 直接使用宿主机 Codex，不加入 Web 队列，见第 11 节。 |
| 语音转写 | 可选 | 同时配置 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL` 和 HTTPS `PUBLIC_BASE_URL`，见 [`docs/DEPLOYMENT_OPTIONS.md`](docs/DEPLOYMENT_OPTIONS.md)。 |
| 个人记忆/上下文提取 | 可选 | 同时配置 `PERSONAL_MEMORY_API_KEY`、`PERSONAL_MEMORY_BASE_URL`，先完成数据披露和小样本验收。 |
| 宿主/root bridge | **高风险、必须明确同意** | 独立 root 进程可访问配置的宿主路径并运行宿主 Codex；见第 12 节和可选部署指南。 |
| 办公电脑 Remote Worker | 可选 | 需要保留的 host-root Web 账号、HTTPS、Enrollment Token 和随仓库构建的发布包；见第 13 节。 |
| 加密冷存储 | 可选、高级 | Provider CLI、远端 ID、`age` recipient/identity 和单独调度器必须全部准备，见可选部署指南。 |
| 共享 Codex 认证/账号管理 | 可选、高风险 | 需要 root bridge 和审核过的共享认证策略；不包含维护者当前登录状态。 |
| 自发布协调器 | 可选 | `deploy/` 下的队列与 systemd 模板必须审阅路径、备份和回滚后才安装。 |

如果用户说“部署本机 Worker”，AI 必须先确认他指的是基础版 Compose 自动管理的云端租户 Worker，还是办公电脑 Remote Worker。后者使用网页中的 **＋新建远程 Worker** 生成一次性安装器；不要再创建第二套常驻服务，也不要把私有登录文件带入公开仓库。

详细的逐项询问、依赖、禁用和验收流程见 [`docs/DEPLOYMENT_OPTIONS.md`](docs/DEPLOYMENT_OPTIONS.md)。本手册的后续章节负责基础版生产部署；用户回答“否”的扩展保持 `.env` 空值并跳过，不得为了“完整”而配置。

## 2. AI 执行纪律与停止条件

### 2.1 必须遵守

1. 先读仓库根目录的 `AGENTS.md`、`README.md`、`.env.example`、`compose.yaml` 和 `docs/DEPLOYMENT.md`，再核对本文与当前提交是否仍一致。
2. 记录将部署的 Git 提交：`git rev-parse HEAD`。生产环境优先固定到已审阅的提交或发布标签，不要无审阅地跟随浮动分支。
3. 密码、API Key、登录令牌、Cookie、私钥、完整 `.env`、`auth.json` 内容不得进入聊天、命令日志、Git、工单或交付报告。需要秘密时，让人类在可信终端中输入。
4. Codex Web 的宿主端口只绑定 `127.0.0.1:37821`；公网只开放 SSH、HTTP 和 HTTPS。不要直接暴露 37821，也不要公开 Codex `app-server`。
5. 不要把 Docker Socket 挂入应用容器，不要把租户 Worker 改成 root，不要移除 Compose 中的只读根文件系统、能力限制、资源限制或安全配置。
6. `docker compose down -v` 会删除持久卷，生产环境禁止执行。任何恢复、迁移或清理动作都必须先确认备份。
7. Docker 管理权限等价于宿主机 root 权限。默认使用 `sudo docker ...`，不要为了省略 `sudo` 随意把普通用户加入 `docker` 组。

### 2.2 必须暂停并向用户报告

- 服务器不是预期的 Ubuntu，或已有未知业务占用 80、443、37821。
- 工作树有未确认修改，当前提交与用户要求的版本不一致。
- 云安全组、DNS、域名所有权、SSH 密钥或 Codex 登录需要用户操作。
- 内存低于 4 GiB、磁盘空间明显不足，或无法满足备份要求。建议至少 8 GiB 内存和 30 GiB 可用磁盘；实际容量还要考虑用户上传文件、镜像和日志增长。
- 任何命令将覆盖现有 Nginx、数据库、证书、用户文件或防火墙策略。
- 用户要求宿主/root bridge，但没有书面授权、备份、绝对路径、root 服务运行时或共享认证策略。
- 用户要求 Remote Worker，但没有 host-root Web 账号、HTTPS `PUBLIC_BASE_URL`、至少 32 字符的 Enrollment Token 或当前提交构建出的发布包。
- 用户要求冷存储，但缺少 provider CLI、远端 ID、`age` recipient/identity、恢复演练或独立调度器。
- 用户要求语音/个人记忆，但未完成数据发送范围、费用和失败后的禁用方式确认。

### 2.3 账号模型和“可使用”的准确含义

部署涉及数类彼此独立的身份，AI 不得把它们混为同一个账号：

| 身份 | 在哪里配置 | 用途 | 本文是否覆盖 |
| --- | --- | --- | --- |
| 云服务器 SSH 管理用户 | 云服务器的 Unix 用户、`authorized_keys` | 安装、更新和备份服务 | 是，第 4 节 |
| Codex Web Owner | `.env` 中的 `APP_USERNAME`、`APP_DISPLAY_NAME`、`APP_PASSWORD_HASH` | 登录网页工作区 | 是，第 7 节 |
| OpenAI/Codex 身份 | Owner 租户的 `CODEX_HOME` | 让 Codex CLI 真正执行 Agent 任务 | 是，第 8 节，但必须由人类完成授权 |
| 域名与 DNS 管理身份 | 域名注册商或 DNS 服务商 | 设置解析、完成可选证书签发 | 流程覆盖，外部账号由用户提供 |
| Remote Worker 机器身份 | 可选扩展的短期安装授权、Enrollment Token 与机器凭据 | 注册办公电脑执行器 | 第 13 节；令牌只在可信终端使用 |

默认部署**没有默认明文密码**，也没有开放注册。应用第一次启动时，会使用 `.env` 中的配置建立或更新固定 Owner 账号；Owner 必须同时满足以下条件才能真正使用平台：

1. `APP_PASSWORD_HASH` 是有效的 bcrypt 哈希，`SESSION_SECRET` 至少 32 个字符。
2. 人类能用 `APP_USERNAME` 和原始密码登录网页。
3. UID 11001 对应的 Owner 租户已经执行 Codex 登录，且 `codex login status` 成功。
4. 从网页提交一个真实的最小任务并收到最终结果，而不只是健康接口成功。

Web 密码与 OpenAI/Codex 登录是两套凭据：Web 密码正确但 Codex 未授权时，用户能进入页面却不能正常完成 Agent 任务；反过来，Codex 已授权也不代表知道 Web 密码。

公开版数据库和运行时已经提供受保护的用户管理 CLI、固定 host-root 身份、项目/账号隔离和可选共享认证；但这些能力不是基础版自动部署的一部分。**不要手工向 SQLite 的 `users` 表插入账号**，也不要在没有 UID/GID、租户目录和认证策略审查时批量建号。需要多账号时使用仓库提供的 CLI，并逐个完成租户、配额、备份和删除验收。

启用多账号或 host-root 前，仍必须逐项验收：账号创建、改密、禁用、
强制注销和审计；固定且不复用的 Unix UID/GID、租户目录和 Worker
生命周期；每租户 Codex 认证策略或审核过的共享认证策略；以及配额、
备份、删除、迁移和跨账号隔离。公开仓库提供的是受保护 CLI 和可选模块，
不是“创建账号即完成隔离”的承诺。

基础版完成标准仍然是“一个普通 Web 账号可用”。如果启用 host-root，必须额外创建保留用户名 `owner`、UUID `00000000-0000-4000-8000-000000000010` 的账号；因此普通基础账号不要占用 `owner`，否则先改名再创建 host-root。Remote Worker 的引导和执行器管理当前也只开放给这个 host-root 账号。

### 2.4 Owner 改密、改名与强制下线

Owner 改密时，先按第 7 节生成新的 bcrypt 哈希，再用安全编辑器修改 `.env` 中的 `APP_PASSWORD_HASH`。改用户名或显示名时修改相应的 `APP_USERNAME`、`APP_DISPLAY_NAME`。然后重建应用容器以重新读取配置：

```bash
cd /opt/codex-web
sudoedit .env
sudo docker compose config --quiet
sudo docker compose up -d --force-recreate app
sudo docker compose ps
```

只更换密码不会主动撤销此前已经签发的 Web 会话。若怀疑账号或会话泄露，应同时生成新的 `SESSION_SECRET`，重建容器并验证旧浏览器会话已失效；这会强制所有 Web 会话重新登录。不要删除持久卷，也不要把新旧秘密写入交付报告。

Codex 授权的撤销与重登必须仍以 UID 11001 和第 8 节相同的 `HOME`、`CODEX_HOME` 执行。修改 Web 密码不会修改 Codex 授权，轮换 `SESSION_SECRET` 也不会注销 Codex CLI。

## 3. 收集变量并做服务器预检

先从用户取得下列信息。秘密只记录“已提供/未提供”，不要记录值。

| 变量 | 示例或默认值 | 说明 |
| --- | --- | --- |
| `SSH_TARGET` | `deploy@example-host` | SSH 用户和地址；不要把真实生产地址写回公开仓库。 |
| `APP_DIR` | `/opt/codex-web` | 服务器上的安装目录。 |
| `CODEX_WEB_REF` | 经审阅的标签或提交 | 未指定时可先检出 `master`，但部署报告必须写明最终提交。 |
| `BASE_PATH` | `/codex-web` | 反向代理和应用必须一致。 |
| `CODEX_WEB_PORT` | `37821` | 只监听宿主回环地址。 |
| `DOMAIN` | 可空 | 有域名时启用 Nginx HTTPS 和自动证书。 |
| `LE_EMAIL` | 可空 | 申请 Let's Encrypt 证书时使用。 |
| `APP_USERNAME` | 由用户决定 | Web 登录账号。 |
| `APP_DISPLAY_NAME` | 由用户决定 | 页面显示名。 |

再逐项询问扩展选择（只记录是否启用）：

| 选择 | 启用条件 | 默认值 |
| --- | --- | --- |
| 语音转写 | DashScope/OpenAI-compatible ASR 的 Key、Base URL、HTTPS 公网地址 | 关闭；两个 `DASHSCOPE_*` 留空 |
| 个人记忆提取 | 外部模型 Key、Base URL，并同意发送范围 | 关闭；两个 `PERSONAL_MEMORY_*` 留空 |
| 宿主/root bridge | 明确 root 授权、宿主绝对路径、root 服务和共享认证策略 | 关闭；四个 `CODEX_WEB_*` 路径留空 |
| Remote Worker | host-root Web 账号、HTTPS、≥32 字符 Enrollment Token、匹配发布包 | 关闭；`REMOTE_WORKER_ENROLLMENT_TOKEN` 留空 |
| 加密冷存储 | Provider CLI、远端 ID、age 密钥、恢复演练和独立调度器 | 关闭；四个 `CODEX_WEB_COLD_STORAGE_*` 留空 |
| 共享 Codex 认证/账号管理 | root bridge 与审核过的 source/lock/policy 文件 | 关闭；认证文件不挂载 |
| 自发布协调器 | 审阅过的路径、备份/回滚策略和 systemd 安装许可 | 关闭；不安装 `deploy/` units |

如果未来可能启用 host-root 或 Remote Worker，基础版的 `APP_USERNAME`
不要取 `owner`：该名称保留给 UUID
`00000000-0000-4000-8000-000000000010` 的 host-root 账号。已有安装若占用
`owner`，先在安全窗口改为其他唯一用户名并重建 app，再创建 host-root。

SSH 登录后先做只读检查：

```bash
set -o errexit -o nounset -o pipefail
date -Is
id
uname -a
cat /etc/os-release
df -h /
free -h
timedatectl status
sudo ss -lntup
```

然后在云厂商控制台检查安全组：

- SSH 端口仅允许可信来源地址；确认新 SSH 会话可用后再收紧旧规则。
- 有域名并申请 HTTP-01 证书时，允许公网 TCP 80 和 443。
- 无域名、仅用 SSH 隧道时，不需要开放 80/443，也绝不能开放 37821。
- 如果配置 AAAA 记录，必须确认服务器的 IPv6 路由和防火墙均可达；否则不要添加 AAAA。

## 4. 建立安全的 SSH 管理入口

如果云厂商只提供 root，先创建专用管理用户并安装公钥。以下用户名只是示例，执行前让用户确认：

```bash
sudo adduser deploy
sudo usermod -aG sudo deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
```

在**另一个终端**验证公钥可以登录并可以 `sudo`。只有验证成功，且用户明确同意后，才可以在 `/etc/ssh/sshd_config.d/` 中禁用密码登录或 root 登录。修改后先执行：

```bash
sudo sshd -t
sudo systemctl reload ssh
```

防火墙先放行 SSH，再启用。下面默认使用 Ubuntu 的 UFW；若服务器已有 nftables、iptables 或厂商防火墙策略，先暂停并合并规则，不能覆盖：

```bash
sudo ufw allow OpenSSH
sudo ufw status verbose
sudo ufw enable
```

有域名部署时再执行：

```bash
sudo ufw allow 'Nginx Full'
sudo ufw status verbose
```

## 5. 安装基础软件、Docker 和 Nginx

新服务器可以更新软件索引并安装基础包。对已经承载其他业务的服务器，执行系统升级或重启前必须另行征得同意。

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl dnsutils git gnupg jq nginx openssl snapd ufw
sudo systemctl enable --now nginx
```

按 Docker 官方 Ubuntu 仓库安装 Engine 和 Compose 插件：

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
ARCH="$(dpkg --print-architecture)"
echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

验证安装：

```bash
sudo docker version
sudo docker compose version
sudo docker run --rm hello-world
sudo nginx -t
```

注意：Docker 发布的端口可能绕过部分 UFW 规则。Codex Web 的 Compose 文件已将宿主端口显式绑定到 `127.0.0.1`；每次升级后都要复核这一点。

## 6. 获取并验证 Codex Web 源码

公开仓库可以直接使用 HTTPS 克隆：

```bash
sudo install -d -m 0755 /opt/codex-web
sudo chown "$(id -un):$(id -gn)" /opt/codex-web
git clone https://github.com/Raytto/codex-web.git /opt/codex-web
cd /opt/codex-web
git fetch --tags --prune
git switch master
git pull --ff-only
git status --short
git rev-parse HEAD
```

如果部署私有分叉，优先使用只读 Deploy Key 或受限的机器凭据；私钥只存放在部署用户的 `~/.ssh/`，权限设为 `600`，不要复制到项目目录。

在写入生产配置前运行仓库测试镜像：

```bash
cd /opt/codex-web
sudo docker build --target test -t codex-web-test:preflight .
```

测试失败就停止，不得继续部署。

## 7. 创建生产 `.env`

复制模板并收紧权限：

```bash
cd /opt/codex-web
cp .env.example .env
chmod 600 .env
```

至少填写以下值：

```dotenv
BASE_PATH=/codex-web
APP_USERNAME=<由用户输入>
APP_DISPLAY_NAME=<由用户输入>
APP_PASSWORD_HASH=<bcrypt 哈希，不是明文密码>
SESSION_SECRET=<至少 32 字节的随机值>
PUBLIC_BASE_URL=<见下文>
```

`.env.example` 中标为 Optional 的配置默认全部留空。不要为了消除“未配置”
提示而填写伪值：语音、个人记忆、host-root、Remote Worker 和冷存储都会
以“未启用”状态安全运行。需要扩展时，按
[`docs/DEPLOYMENT_OPTIONS.md`](docs/DEPLOYMENT_OPTIONS.md) 一次只配置一项，
重启并完成该项验收后再继续。

值的生成规则：

- `SESSION_SECRET` 可由人类在可信终端运行 `openssl rand -base64 48` 生成，然后直接粘贴到服务器的安全编辑器。不要让 AI 回显结果。
- `APP_PASSWORD_HASH` 必须通过仓库的 `npm run hash-password` 或 `scripts/hash-password.mjs` 生成。密码至少 12 个字符。不要把真实密码直接写进可保存的命令、聊天或自动化日志。
- 最稳妥的方式是在可信工作站安装 Node.js 22，克隆同一提交后运行 `npm ci`，再由人类交互输入密码并只把最终 bcrypt 哈希粘贴进 `.env`。
- 如果只能在服务器生成，先安装 Node.js 22，或临时进入官方 Node 22 容器；人类必须在交互终端输入且完成后清除变量。不要把示例占位符当成真实密码。

有域名时：

```dotenv
PUBLIC_BASE_URL=https://codex.example.com/codex-web
```

无域名、只通过 SSH 隧道访问时：

```dotenv
PUBLIC_BASE_URL=http://localhost:37821/codex-web
```

保持 `.env.example` 中的上传、存储和租户隔离默认值，除非用户明确要求调整。修改限制时，要同时检查 Nginx 的 `client_max_body_size`。

提交启动前检查，但不要把配置内容输出到日志：

```bash
test "$(stat -c '%a' .env)" = 600
sudo docker compose config --quiet
git status --short
```

预期 `git status` 不显示 `.env`；如果显示，立即停止并检查 `.gitignore`，不要提交。

## 8. 构建、启动并登录云端 Codex

Compose 使用一个预先存在的外部网络；首次部署时创建一次，后续不要在
`down` 时删除它：

```bash
sudo docker network inspect codex-web-egress >/dev/null 2>&1 \
  || sudo docker network create codex-web-egress
```

构建并启动完整栈：

```bash
cd /opt/codex-web
sudo docker compose build --pull
sudo docker compose up -d
sudo docker compose ps
```

检查容器内和宿主回环健康状态：

```bash
sudo docker compose exec app curl -fsS http://127.0.0.1:37821/codex-web/api/health
curl -fsS http://127.0.0.1:37821/codex-web/api/health
sudo ss -lntp | grep 37821
```

最后一条必须显示 `127.0.0.1:37821`，不能是 `0.0.0.0:37821` 或公网地址。

租户 Worker 已由 Supervisor 自动管理，不需要额外安装。使用仓库默认拥有者租户 UID 登录 Codex：

```bash
cd /opt/codex-web
sudo docker compose exec --user 11001:11001 \
  -e HOME=/app/tenants/00000000-0000-4000-8000-000000000001 \
  -e CODEX_HOME=/app/tenants/00000000-0000-4000-8000-000000000001/codex-home \
  app codex login --device-auth
```

由人类在浏览器完成授权。若设备授权不可用，可使用第 11 节的 SSH 端口转发方法；不要把 `auth.json` 通过聊天或不安全渠道传输。验证时必须使用同一个 UID、`HOME` 和 `CODEX_HOME`：

```bash
sudo docker compose exec --user 11001:11001 \
  -e HOME=/app/tenants/00000000-0000-4000-8000-000000000001 \
  -e CODEX_HOME=/app/tenants/00000000-0000-4000-8000-000000000001/codex-home \
  app codex login status
```

`auth.json` 可能包含可直接使用的登录材料，安全等级等同密码。它应只存在于受限的持久租户目录中，禁止提交、打印或备份到不受保护的位置。

## 9. 默认安装和配置 Nginx

### 9.1 有域名的配置

先确认 DNS 的 A 记录（以及确实可用时的 AAAA 记录）指向当前云服务器：

```bash
dig +short codex.example.com A
dig +short codex.example.com AAAA
```

创建 `/etc/nginx/conf.d/00-codex-web-websocket-map.conf`：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

创建 `/etc/nginx/sites-available/codex-web`，将域名替换成用户的真实域名：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name codex.example.com;

    location = /codex-web {
        return 308 /codex-web/;
    }

    location /codex-web/ {
        proxy_pass http://127.0.0.1:37821;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 2048m;
    }
}
```

启用站点。只有确认默认站点没有承载其他业务后，才可以移除它的软链接：

```bash
sudo ln -sfn /etc/nginx/sites-available/codex-web /etc/nginx/sites-enabled/codex-web
sudo nginx -t
sudo systemctl reload nginx
curl -fsS http://codex.example.com/codex-web/api/health
```

如果出现 502，先检查回环健康接口和 `docker compose ps`，不要通过把 37821 开放到公网来绕过问题。

### 9.2 申请并验证 HTTPS 证书

默认使用 Certbot 的 Nginx 插件和 Let's Encrypt。HTTP-01 验证要求公网能够访问 TCP 80：

```bash
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sfn /snap/bin/certbot /usr/local/bin/certbot
sudo certbot --nginx \
  -d codex.example.com \
  -m admin@example.com \
  --agree-tos \
  --no-eff-email \
  --redirect
```

验证自动续期和 HTTPS：

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep -E 'certbot|snap.certbot'
curl -fsS https://codex.example.com/codex-web/api/health
curl -I http://codex.example.com/codex-web/
```

通配符证书必须使用 DNS-01，并针对 DNS 服务商选择相应插件；不要用手工 DNS 验证作为无人值守续期方案。若公司已有证书平台，应改为公司的签发与续期流程。

### 9.3 无域名的安全访问

无域名时不要申请证书，也不要把 37821 改成公网监听。保持 Nginx 可不对公网开放，从用户本机建立 SSH 隧道：

```bash
ssh -N -L 37821:127.0.0.1:37821 deploy@server-address
```

然后访问 `http://localhost:37821/codex-web/`。如果本机 37821 被占用，可以把左侧端口改为其他值，例如 `47821:127.0.0.1:37821`。

## 10. 首次上线验收

AI 必须逐项通过并将**非敏感摘要**写入交付报告：

- [ ] 记录 OS、Codex Web Git 提交和部署时间。
- [ ] `docker compose ps` 中应用健康，重启策略正常。
- [ ] 回环健康接口返回成功，37821 仅监听 `127.0.0.1`。
- [ ] 有域名时，HTTP 自动跳转 HTTPS，证书域名匹配，续期演练通过。
- [ ] 外部安全组和宿主防火墙只开放预期的 SSH、80、443；无域名方案只开放 SSH。
- [ ] Web 登录成功，错误密码无法登录，会话 Cookie 不通过明文公网传输。
- [ ] `codex login status` 在 UID 11001 的正确租户目录中成功。
- [ ] 从 Web 创建一个最小测试对话或任务，观察流式输出并确认页面刷新后仍存在。
- [ ] 上传一个非敏感小文件并下载，确认附件链路正常。
- [ ] `docker compose restart` 后登录状态、对话和附件仍然存在。
- [ ] 备份流程已执行一次，并在隔离环境至少演练过一次恢复。

基础版通过后，只有用户在第 1 节回答“是”的扩展才进入额外验收。每个
扩展必须单独记录配置名称、数据去向、测试结果和可逆禁用动作；回答“否”
的项目应明确写成“未启用”，不能用“代码已存在”代替运行证据。

排查日志时限制行数并先脱敏：

```bash
sudo docker compose logs --tail=200 app
sudo journalctl -u nginx --since '-30 minutes' --no-pager
```

禁止把完整日志直接贴到公开渠道；其中可能包含用户名、路径、任务内容或请求元数据。

## 11. 可选：从本机通过 SSH 使用云端 Codex

这是“人在本机操作远端 Codex”的方式，不会把本机注册为 Codex Web 的 Worker。

### 11.1 普通 SSH 终端

在本机 `~/.ssh/config` 中配置一个明确的别名：

```sshconfig
Host codex-cloud
    HostName server-address
    User deploy
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

验证：

```bash
ssh codex-cloud
```

如果需要在宿主机直接运行 Codex CLI，应在宿主机单独安装官方 Codex CLI，并以目标 SSH 用户完成 `codex login`；这与容器中 UID 11001 的登录状态互不相同。不要把容器租户的 `auth.json` 复制到普通 SSH 用户目录，除非用户明确理解凭据边界和风险。

### 11.2 支持 SSH 连接的 Codex 客户端

官方 Codex 客户端的远程连接要求：

1. 本机能够用 SSH 别名无交互连接远端。
2. 远端已安装并登录 Codex CLI，且 `codex` 位于 SSH 登录 Shell 的 `PATH` 中。
3. 在客户端设置的 Connections 中添加该 SSH 主机。

该客户端会通过 SSH 在远端启动 Codex `app-server`。`app-server` 不应直接暴露在公网或共享网络；应始终通过 SSH、VPN 或可信私网传输。

无图形环境时，Codex 登录可优先尝试：

```bash
codex login --device-auth
codex login status
```

若设备授权不可用，可从本机建立官方登录回调使用的端口转发后，在远端运行 `codex login`：

```bash
ssh -L 1455:localhost:1455 codex-cloud
codex login
```

登录材料不得进入 Shell 历史或聊天。使用 API Key 时应从环境变量通过标准输入传递，并在完成后清除临时环境变量。

## 12. 可选：宿主/root bridge（高风险，必须明确同意）

这不是普通“本机 Worker”开关。它会在宿主机启动独立的 **root Node.js
进程**，以 `HOME=/root` 运行 Codex，并按配置访问宿主知识库、项目和
Codex Home。只有用户明确理解该权限边界、同意路径和备份/撤销方案后
才可以继续；没有同意时保持四个 `CODEX_WEB_*` 路径为空。

保留用户名 `owner` 和 UUID
`00000000-0000-4000-8000-000000000010` 专用于 host-root。普通基础账号
如果已经使用 `owner`，先改 `.env` 的 `APP_USERNAME` 为其他唯一名称并
重建 app，再执行 `manage-user.js create-host-root owner`；禁止手工修改
SQLite `users` 表。Remote Worker 的引导和执行器管理也只对该 host-root
账号开放。

### 12.1 前置检查和路径边界

- 用户已确认 root 进程能够读写哪些绝对路径，且已有可恢复备份。
- 宿主安装 Node.js ≥22.13；在与 app 相同的提交上执行 `npm ci && npm run build`。
- 准备 `CODEX_WEB_HOST_TENANT_ROOT`、`CODEX_WEB_KNOWLEDGE_ROOT`、
  `CODEX_WEB_CODEX_HOME` 和 socket 目录；目录权限按 root 与 Web GID
  明确设置，不使用整个 `/` 或宿主 home 作为未审查根目录。
- app 容器看 socket 的路径（例如 `/run/codex-web-host/host.sock`）和
  root 服务看 socket 的路径（例如 `/opt/codex-web/.state/host-bridge/host.sock`）
  可以不同，不能把容器路径误写给宿主服务。
- 共享 Codex 认证必须提供 source、lock、policy 三个受保护文件；不把
  当前登录信息、`auth.json` 或密钥提交到仓库。

### 12.2 启用、验收和禁用

1. 备份并记录用户同意；先确认 socket 目录没有被其他服务占用。
2. 在 app `.env` 设置四个路径（socket 使用容器路径），配置并审核共享
   认证策略；执行 `docker compose config --quiet`。
3. 仅在基础账号不再占用 `owner` 后创建保留账号：

   ```bash
   sudo docker compose exec app \
     node dist-server/server/manage-user.js create-host-root owner "Host owner"
   ```

   生成密码只在可信终端交付并立即改密，不写入报告。
4. 用 root 启动 `dist-server/server/host-root-server.js`，注入宿主 socket、
   三个绝对根、`CWW_DATABASE_PATH`、`CODEX_RUNTIME_PATH` 和共享认证变量。
   可将 [`docs/DEPLOYMENT_OPTIONS.md`](docs/DEPLOYMENT_OPTIONS.md) §4 的
   systemd 单元复制为起点，放在 `/etc/systemd/system/`，把秘密放入权限
   为 `600` 的 `/etc/codex-web/host-root.env`；不要把路径和凭据直接写进
   命令行历史。启动前检查 `npm run build`，然后执行
   `sudo systemctl daemon-reload && sudo systemctl enable --now codex-web-host-root`。
   启动后确认 socket 为 `0660`、root 所有且 Web GID 可访问。
5. 重建 app，host-root 登录后只做一个只读项目目录浏览和无副作用任务；
   普通租户必须看不到宿主路径；停止 root 服务时 host 任务必须失败关闭。
6. 禁用时先停止/屏蔽 root 服务，再清空 app 的路径变量并重建；按需要禁用
   host-root 账号。保留宿主数据必须由用户另行确认。

本仓库不提供自动 root systemd 安装器：服务名、MAC 策略、路径和 GID 属于
目标主机安全策略，必须由管理员审核后落地。完整选项矩阵见
[`docs/DEPLOYMENT_OPTIONS.md`](docs/DEPLOYMENT_OPTIONS.md)。

## 13. 可选：部署办公电脑上的 Remote Worker

Remote Worker 不需要 root bridge 进程来执行桌面任务，但当前 Web 的引导、
执行器管理和项目路由要求登录保留的 host-root Web 账号；因此仍要先按第
12 节处理账号冲突和权限确认。它只建立出站 WSS，不在办公电脑开放入站端口。

1. 设置 HTTPS `PUBLIC_BASE_URL` 和随机、至少 32 字符的
   `REMOTE_WORKER_ENROLLMENT_TOKEN`；Docker 构建会把 Windows/macOS 发布包
   放入 `/app/worker-release`。
2. host-root 登录网页，打开项目/执行器对话，选择 **＋新建远程 Worker**，
   生成对应系统的一次性短期安装器链接。不要把链接贴到公开渠道。
3. 在办公电脑以普通用户运行安装器，完成本机 Codex 登录并选择机器显示名；
   不要以 Windows Administrator 或 Unix root 执行日常任务。
4. 验收在线心跳、版本/容量、只读任务、取消任务、断网重连、文件大小和
   SHA-256 校验。下线时先撤销/禁用执行器，再停止 Worker；全部机器退役后
   才移除 Enrollment Token。

如果没有 HTTPS、host-root 账号、Enrollment Token 或匹配发布包，保持该功能
关闭。OS 安装细节见 [`remote-worker/README.md`](remote-worker/README.md)。

## 14. 备份与恢复

Compose 使用命名卷保存应用状态、租户目录和 Codex 运行时。实际卷名带 Compose 项目前缀，先解析，不要猜：

```bash
cd /opt/codex-web
sudo docker compose config --volumes
sudo docker volume ls
```

备份前停止接收新任务并等待正在运行的任务结束。为保证 SQLite 和文件状态一致，维护窗口内停止应用：

```bash
sudo docker compose stop
```

然后把 `.env` 单独放入受访问控制且加密的秘密备份，并逐个备份 `app-data`、`tenant-data`。`codex-runtime` 可以由镜像重新播种，但备份它能加快同版本恢复。以下是模板，`ACTUAL_VOLUME_NAME` 和 `/var/backups/codex-web` 必须先确认：

```bash
sudo install -d -m 0700 /var/backups/codex-web
sudo docker run --rm \
  -v ACTUAL_VOLUME_NAME:/source:ro \
  -v /var/backups/codex-web:/backup \
  alpine:3.22 \
  tar -C /source -czf /backup/ACTUAL_VOLUME_NAME-YYYYMMDD-HHMMSS.tar.gz .
```

生成校验和并重新启动：

```bash
cd /var/backups/codex-web
sha256sum *.tar.gz > SHA256SUMS
cd /opt/codex-web
sudo docker compose start
sudo docker compose ps
```

恢复必须在隔离环境先演练。生产恢复时先停止栈、确认目标卷、保留现状快照，再把归档解压到空的新卷；不要向未知的非空卷直接覆盖。恢复后检查权限、健康接口、登录状态、对话和附件，再切换流量。

## 15. 安全更新与回滚

更新前记录旧提交、备份数据并检查发布说明：

```bash
cd /opt/codex-web
git status --short
git rev-parse HEAD
git fetch --tags --prune
git log --oneline --decorate HEAD..origin/master
```

如果有未确认的本地修改就停止。选择目标提交后执行测试、构建和滚动重建：

```bash
git switch --detach TARGET_COMMIT
sudo docker build --target test -t codex-web-test:upgrade .
sudo docker compose build --pull
sudo docker compose up -d
sudo docker compose ps
curl -fsS http://127.0.0.1:37821/codex-web/api/health
```

升级后重复第 10 节验收。应用回滚时切回已记录的旧提交并重新构建；数据结构如果发生不可逆迁移，必须使用与旧版本匹配的备份恢复，不能只切 Git。任何时候都不要用 `down -v` 作为“重新安装”。

## 16. 常见故障定位

| 现象 | 优先检查 | 不要做 |
| --- | --- | --- |
| Nginx 502 | 回环健康接口、容器状态、端口绑定、Nginx error log | 不要公开 37821 |
| 页面路径或静态资源 404 | `.env` 的 `BASE_PATH`、`PUBLIC_BASE_URL`、Nginx `location` 是否都是 `/codex-web` | 不要靠任意 rewrite 猜路径 |
| 流式响应中断 | `proxy_buffering off`、代理超时、上游日志 | 不要关闭认证 |
| 上传返回 413 | Nginx `client_max_body_size` 与应用上传上限 | 不要无限制放大且不评估磁盘 |
| Codex 显示未登录 | 是否以 UID 11001 和正确 `HOME`、`CODEX_HOME` 检查 | 不要复制其他用户的 `auth.json` |
| 证书 HTTP-01 失败 | DNS、80 端口、安全组、UFW、AAAA 可达性 | 不要临时开放应用内部端口 |
| 容器启动后立即退出 | `docker compose ps`、最近 200 行日志、`.env` 必填项 | 不要打印完整 `.env` |
| Worker 任务无响应 | Supervisor 状态、租户配额、资源限制、Codex 登录 | 不要改成 root 运行 |

## 17. AI 交付报告模板

交付报告应简短、可复核且不含秘密：

```text
Codex Web 部署结果
- 服务器系统：<发行版和版本>
- Git 提交：<完整 SHA>
- 访问方式：<HTTPS 域名 / SSH 隧道；不要写私密 IP>
- 应用健康：<通过/失败>
- 端口边界：<37821 仅回环；公网端口摘要>
- Nginx：<配置检查与重载结果>
- TLS：<证书颁发者、到期日、续期演练；无域名则写不适用>
- Codex 登录：<已登录/待人类授权；绝不附令牌>
- 云端租户 Worker：<健康/异常>
- 选项决策：<语音、个人记忆、root bridge、Remote Worker、冷存储、共享认证、自发布：逐项写未启用/已启用>
- Root bridge：<未启用/已启用；书面授权、socket ACL、root 服务状态；不附路径秘密>
- Remote Worker：<未启用/已启用；机器显示名、版本、最后心跳；不附令牌>
- 语音/个人记忆/冷存储：<未启用或验收摘要；写数据去向和恢复结果，不附 Key/密钥>
- 持久化重启测试：<通过/失败>
- 备份：<完成时间、受保护的位置、恢复演练结果；不附秘密内容>
- 待办与风险：<逐项列出>
```

## 18. 权威资料

- 本仓库：`README.md`、`compose.yaml`、`.env.example`、`docs/DEPLOYMENT.md`、`docs/DEPLOYMENT_OPTIONS.md`、`docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`remote-worker/README.md`
- OpenAI Codex 身份验证：https://developers.openai.com/codex/auth/
- OpenAI Codex 远程连接：https://developers.openai.com/codex/app/remote/
- Docker Engine on Ubuntu：https://docs.docker.com/engine/install/ubuntu/
- Docker Compose plugin：https://docs.docker.com/compose/install/linux/
- Nginx 官方软件包：https://nginx.org/en/linux_packages.html
- Certbot Nginx 指引：https://certbot.eff.org/instructions?ws=nginx&os=snap
- Let's Encrypt 验证方式：https://letsencrypt.org/docs/challenge-types/
- Ubuntu OpenSSH Server：https://documentation.ubuntu.com/server/how-to/security/openssh-server/
- Ubuntu 防火墙：https://documentation.ubuntu.com/server/how-to/security/firewalls/
- GitHub Deploy Key：https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys

执行时应以仓库当前提交及上述官方文档为准。若两者与本文冲突，AI 必须暂停、说明差异并让用户确认更新方案，而不是静默套用旧命令。
