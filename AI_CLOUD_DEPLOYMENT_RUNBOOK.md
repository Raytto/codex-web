# Codex Web 新云服务器部署与运维手册（供 AI 执行）

> 核验日期：2026-08-10
>
> 适用范围：全新的 Ubuntu 24.04 LTS 云服务器；Ubuntu 22.04 可参考执行。其他发行版必须先改写软件源、包名和服务命令，不得直接照抄。
>
> 默认形态：Codex Web、Supervisor、租户 Worker 和 Codex CLI 都运行在云服务器；运维人员或 AI 通过 SSH 管理云服务器。Nginx 默认安装并作为唯一公网入口。域名与公网证书是可选项。

本文是一份“可交给另一个 AI 执行”的部署运行手册。执行者必须逐阶段完成检查，记录非敏感证据，并在每个验收点通过后再继续。不要为了让命令成功而降低隔离、公开内部端口或跳过认证。

> **部署结果边界：**完整执行本文可以得到一个可登录、可提交任务、可持久运行的**单一 Owner 公开版 Codex Web**。它不等于带管理员宿主桥、网页账号管理、多个可执行租户和桌面 Remote Worker 网关的私有完整 Agent 平台；这些扩展未随公开仓库发布。

## 1. 先确认部署模式

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

术语容易混淆，执行前必须选择以下一种或多种模式：

| 模式 | 状态 | 用途 |
| --- | --- | --- |
| A. 云端内置租户 Worker | **默认且公开仓库已支持** | Codex Web 与 Codex CLI 都在云服务器容器内运行。本文第 3～10 节完成这一模式。 |
| B. 从本机通过 SSH 使用远端 Codex | **可选，独立于 Codex Web 队列** | 运维者用 SSH 终端，或用支持 SSH 连接的 Codex 客户端，直接连接云服务器上的 Codex。见第 11 节。 |
| C. 本机 Remote Worker 接入 Codex Web | **可选扩展，公开仓库目前未随附** | 让办公电脑主动连回 Web 网关并在本机项目中执行任务。必须同时取得协议兼容的服务端网关和 Worker 包；见第 12 节。 |

如果用户说“部署本机 Worker”，AI 必须先确认他指的是模式 A 的“云服务器本机租户 Worker”，还是模式 C 的“用户办公电脑 Remote Worker”。模式 A 随 Compose 自动启动，不要再创建第二套服务。模式 C 不能仅凭公开仓库中的架构说明自行虚构安装命令。

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
- 用户要求模式 C，但仓库中没有实际的服务端网关和 Worker 包。

### 2.3 账号模型和“可使用”的准确含义

部署涉及数类彼此独立的身份，AI 不得把它们混为同一个账号：

| 身份 | 在哪里配置 | 用途 | 本文是否覆盖 |
| --- | --- | --- | --- |
| 云服务器 SSH 管理用户 | 云服务器的 Unix 用户、`authorized_keys` | 安装、更新和备份服务 | 是，第 4 节 |
| Codex Web Owner | `.env` 中的 `APP_USERNAME`、`APP_DISPLAY_NAME`、`APP_PASSWORD_HASH` | 登录网页工作区 | 是，第 7 节 |
| OpenAI/Codex 身份 | Owner 租户的 `CODEX_HOME` | 让 Codex CLI 真正执行 Agent 任务 | 是，第 8 节，但必须由人类完成授权 |
| 域名与 DNS 管理身份 | 域名注册商或 DNS 服务商 | 设置解析、完成可选证书签发 | 流程覆盖，外部账号由用户提供 |
| Remote Worker 机器身份 | 可选扩展的 Enrollment 与机器凭据 | 注册办公电脑执行器 | 公开版不提供，见第 12 节 |

默认部署**没有默认明文密码**，也没有开放注册。应用第一次启动时，会使用 `.env` 中的配置建立或更新固定 Owner 账号；Owner 必须同时满足以下条件才能真正使用平台：

1. `APP_PASSWORD_HASH` 是有效的 bcrypt 哈希，`SESSION_SECRET` 至少 32 个字符。
2. 人类能用 `APP_USERNAME` 和原始密码登录网页。
3. UID 11001 对应的 Owner 租户已经执行 Codex 登录，且 `codex login status` 成功。
4. 从网页提交一个真实的最小任务并收到最终结果，而不只是健康接口成功。

Web 密码与 OpenAI/Codex 登录是两套凭据：Web 密码正确但 Codex 未授权时，用户能进入页面却不能正常完成 Agent 任务；反过来，Codex 已授权也不代表知道 Web 密码。

公开版数据库已经具备按用户隔离部分 Web 数据的基础结构，但当前公开运行时只配置了固定 Owner 的 Unix 租户身份，也没有受支持的账号管理页面、注册接口或建号 CLI。**不要手工向 SQLite 的 `users` 表插入账号**：新账号即使可以登录，也没有对应的受控 Unix Worker 身份，任务执行会失败。要交付真正的多账号平台，必须另行实现并审查以下能力：

- 账号创建、改密、禁用、强制注销和审计界面或受保护 CLI；
- 每个账号固定且不复用的 Unix UID/GID、租户目录和 Worker 生命周期；
- 每租户 Codex 认证策略，或经过明确安全评估的共享认证策略；
- 配额、备份、删除、迁移和跨账号隔离测试。

在这些能力进入公开仓库并通过测试前，本文的完成标准始终是“一个 Owner 可用”，而不是“任意创建多个账号”。

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

## 12. 可选：部署办公电脑上的 Remote Worker

### 12.1 当前公开版边界

公开 Codex Web 仓库描述了 Remote Worker 扩展边界，但目前不包含可直接部署的管理员宿主桥、Remote Worker 服务端网关或桌面 Worker 包。因此 AI 在执行前必须检查：

```bash
cd /opt/codex-web
find . -maxdepth 3 -type d -iname '*remote*worker*' -print
rg -n "Remote Worker|remote-worker|worker gateway" README.md docs server scripts 2>/dev/null
```

如果只有文档或协议说明而没有实际服务端和客户端实现，必须停止模式 C，报告“公开版缺少配套组件”，并建议使用模式 A 或第 11 节的 SSH 方案。不得创建一个看似成功、实际没有接入 Web 调度的本地常驻进程。

### 12.2 取得扩展后必须满足的架构要求

只有拿到与当前 Codex Web 提交协议兼容的**服务端网关和 Worker 包**后，才继续。实现应至少满足：

- Worker 只主动建立出站 `WSS` 连接，不在办公电脑开放入站端口。
- 首次注册使用短期 Enrollment 凭据，随后换取可轮换、可撤销的机器凭据；秘密不写入 Git、命令行历史或普通日志。
- 每个任务启动独立的本地 `codex app-server`，限定工作目录或项目白名单，完成后清理子进程。
- 服务端有身份校验、离线队列、容量控制、幂等任务 ID、断线重连和审计记录。
- 文件传输校验大小和哈希，禁止任意路径读取与路径穿越。
- Worker 版本、协议版本、Node.js/Codex CLI 版本有明确兼容矩阵。
- Nginx 的 WSS 路由保留 `Upgrade`/`Connection` 请求头，并使用 HTTPS 证书。
- 不直接把 Codex `app-server` 暴露到公网。

### 12.3 通用部署顺序

不同扩展的真实命令必须以其同版本 README 为准，不能复用其他私有环境中的主机名、令牌或脚本名。通用顺序如下：

1. 在服务端部署并迁移 Remote Worker 网关，配置独立的加密密钥和短期 Enrollment Token。
2. 为 `/codex-web/...` 下的 WSS 路由配置 Nginx，执行 `nginx -t` 后重载。
3. 在办公电脑安装扩展要求的 Node.js 与 Codex CLI，并以实际桌面用户执行 `codex login status`。
4. 在批准的本机项目目录中测试 Codex；不要用管理员/root 身份运行日常任务。
5. 通过扩展提供的安装器注册系统服务或用户登录任务。凭据应写入操作系统受限目录或凭据库。
6. 从服务端确认机器在线、版本兼容、容量正确，再提交一个只读测试任务。
7. 验证断网重连、任务取消、进程回收、文件校验、注销与凭据撤销。
8. 交付时只报告机器显示名、版本、最后心跳和测试结果，不报告令牌。

## 13. 备份与恢复

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

## 14. 安全更新与回滚

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

## 15. 常见故障定位

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

## 16. AI 交付报告模板

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
- Remote Worker 扩展：<未启用/已启用及版本/公开版缺少组件>
- 持久化重启测试：<通过/失败>
- 备份：<完成时间、受保护的位置、恢复演练结果；不附秘密内容>
- 待办与风险：<逐项列出>
```

## 17. 权威资料

- 本仓库：`README.md`、`compose.yaml`、`.env.example`、`docs/DEPLOYMENT.md`、`docs/ARCHITECTURE.md`
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
