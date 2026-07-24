# Deployment

## Local Docker deployment

Follow the root README. Docker named volumes persist the SQLite database, tenant workspaces, Codex login/thread state, and the seeded Codex CLI runtime.

Useful checks:

```bash
docker compose ps
docker compose logs --tail=200 app
curl --fail http://127.0.0.1:37821/codex-web/api/health
```

Back up all three named volumes before upgrades. Keep `.env` outside source control.

Docker grants the application up to 30 minutes after `SIGTERM` to drain active Codex work. New dispatch stops immediately, queued jobs stay persisted, and the container exits once active executions finish. Avoid overriding `stop_grace_period` with a shorter value unless you accept interrupted jobs.

## Reverse proxy

Terminate TLS at your reverse proxy and forward `/codex-web/` to `http://127.0.0.1:37821/codex-web/`. Preserve the path prefix, pass the original host and protocol headers, disable response buffering for event streams, and use a long read timeout for active tasks.

Set `PUBLIC_BASE_URL` to the final HTTPS URL. Do not publish container port 37821 directly to the internet.

For optional voice transcription, keep `DASHSCOPE_API_KEY` only in `.env`. The default context budget is 500 approximate tokens, two images, and 2 MiB per image. Adjust `TRANSCRIPTION_CONTEXT_TOKEN_BUDGET`, `TRANSCRIPTION_CONTEXT_MAX_IMAGES`, and `TRANSCRIPTION_CONTEXT_MAX_IMAGE_BYTES` only after considering request cost and data exposure.

## Updating

```bash
git pull --ff-only
docker compose up -d --build
```

The container seeds a newer bundled Codex CLI into the persistent runtime volume on startup. Existing login and thread state remain in the tenant volume.

After upgrading, verify that archived conversations remain listed under personal settings and that any job interrupted by an ungraceful previous stop has a visible interruption message instead of being retried.
