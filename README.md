# Codex Web

An unofficial, self-hosted web workspace for the OpenAI Codex CLI. It adds persistent conversations, file uploads and deliverables, server-side task queues, live steering, cancellation, automatic titles, adjustable reading size, light/dark/system appearance modes, and optional voice transcription.

> Codex Web is an independent community project. It is not affiliated with, endorsed by, or supported by OpenAI.

[中文说明](README.zh-CN.md)

## What it includes

- A responsive React chat interface for Codex CLI
- Server-persistent queued prompts with reorder, edit, delete, and steer actions
- Persistent attachments and generated deliverables
- Codex thread persistence across browser restarts
- Soft-deleted conversation audit records while workspace files are removed
- Forced cancellation of running or queued work when a conversation is deleted
- Automatic short task titles, with manual titles taking precedence
- A durable live work journal with retained stage feedback and grouped command steps
- Unread-result markers for completed conversations until their detail is viewed
- Light, dark, and system-following appearance modes
- Select message text and attach it as a removable, server-persisted reference to a new Agent question
- Load only the latest 30 messages initially, then fetch older pages at the top without moving the reader's position
- Optional Alibaba Cloud DashScope voice transcription
- A dedicated Unix identity for the Codex worker inside the container

## Requirements

- Docker Engine with Docker Compose v2
- At least 4 GB RAM; 8 GB is recommended for document-heavy tasks
- A Codex account that can sign in through the Codex CLI
- Node.js 22+ only if you want to run the test suite or password helper locally

## Quick start

1. Copy the configuration template:

   ```bash
   cp .env.example .env
   ```

2. Install development dependencies and generate a password hash:

   ```bash
   npm ci
   npm run hash-password -- 'choose-a-long-unique-password'
   ```

3. Put the generated hash in `APP_PASSWORD_HASH`, set a random `SESSION_SECRET` of at least 32 characters, and adjust `APP_USERNAME` and `APP_DISPLAY_NAME` in `.env`.

4. Build and start the service:

   ```bash
   docker compose up -d --build
   ```

5. Sign the isolated owner worker into Codex:

   ```bash
   docker compose exec --user 11001:11001 \
     -e HOME=/app/tenants/00000000-0000-4000-8000-000000000001 \
     -e CODEX_HOME=/app/tenants/00000000-0000-4000-8000-000000000001/codex-home \
     app codex login --device-auth
   ```

6. Open [http://localhost:37821/codex-web/](http://localhost:37821/codex-web/).

State is stored in Docker named volumes. Closing the browser does not remove queued work or attachments.

## Optional voice transcription

Set `DASHSCOPE_API_KEY` and an HTTPS `PUBLIC_BASE_URL` in `.env` to enable the microphone button. The default model is `qwen3.5-omni-plus`; you can override it with `DASHSCOPE_ASR_MODEL`. Microphone access requires a secure browser context.

Audio is uploaded to your server first and then sent to the DashScope endpoint configured by `DASHSCOPE_BASE_URL`. Leave the key empty to disable the feature completely.

## Reverse proxy

The container binds to loopback by default. Proxy `/codex-web/` to `http://127.0.0.1:37821/codex-web/` and preserve WebSocket/SSE-friendly buffering settings. See [Deployment](docs/DEPLOYMENT.md).

## Development

```bash
npm ci
npm test
npm run dev
```

The default development URL is `http://127.0.0.1:5173/codex-web/`.

## Security model

Codex runs as a dedicated non-root Unix user. The web process can coordinate that worker through a local supervisor but the public edition has no Docker socket, no host filesystem bridge, and no host-root execution path. Review [Security](docs/SECURITY.md) before exposing an instance to the internet.

## License

[MIT](LICENSE)
