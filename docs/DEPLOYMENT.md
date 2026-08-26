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

Recent releases add SQLite columns for continuation targets and selections. Migrations are additive and run on startup, but the pre-upgrade volume backup remains the rollback boundary; do not start an older image against a database already migrated by a newer release unless that version is documented as backward compatible.

Docker grants the application up to 30 minutes after `SIGTERM` to drain active Codex work. New dispatch stops immediately, queued jobs stay persisted, and the container exits once active executions finish. Avoid overriding `stop_grace_period` with a shorter value unless you accept interrupted jobs.

## Reverse proxy

Terminate TLS at your reverse proxy and forward `/codex-web/` to `http://127.0.0.1:37821/codex-web/`. Preserve the path prefix, pass the original host and protocol headers, disable response buffering for event streams, and use a long read timeout for active tasks.

Set `PUBLIC_BASE_URL` to the final HTTPS URL. Do not publish container port 37821 directly to the internet.

Review `MAX_UPLOAD_FILE_BYTES`, `MAX_STORED_BYTES_PER_USER`, and `MINIMUM_FREE_DISK_BYTES` for the host volume before accepting uploads. The defaults allow a 2 GiB individual file, 20 GiB stored per user, and preserve 2 GiB of free space. Large uploads use 8 MiB resumable chunks and unfinished partials expire after 72 hours; all values are configurable in `.env`.

For optional voice transcription, keep `DASHSCOPE_API_KEY` only in `.env`. The default context budget is 500 approximate tokens, two images, and 2 MiB per image. Adjust `TRANSCRIPTION_CONTEXT_TOKEN_BUDGET`, `TRANSCRIPTION_CONTEXT_MAX_IMAGES`, and `TRANSCRIPTION_CONTEXT_MAX_IMAGE_BYTES` only after considering request cost and data exposure.

## Updating

```bash
git pull --ff-only
docker compose up -d --build
```

The container seeds a newer bundled Codex CLI into the persistent runtime volume on startup. Existing login and thread state remain in the tenant volume.

Managed skills are copied from the repository's `skills/` directory when a tenant is initialized. The default set includes `local-spreadsheets` and `html-report`; the latter also installs its relative `references/`, `assets/`, and `scripts/` files, so a newly created user can follow and validate the report workflow without any extra volume or environment setting. Do not manually place these managed skills under `.system/`.

After upgrading, verify that archived conversations remain listed under personal settings and that any job interrupted by an ungraceful previous stop has a visible interruption message instead of being retried.

The public sign-in contract remains username plus password. Keep `APP_USERNAME` and
`APP_PASSWORD_HASH` in the private `.env`; do not add phone-number, SMS, or external credential
proxy settings to a public deployment.

New deployments default to a 14-day Web session (`SESSION_TTL_HOURS=336`). Shorten this value
for shared or higher-risk devices; changing it affects newly issued sessions.

Also verify one empty-task reuse, one timed continuation with the intended same/new-conversation target and model selection, and a normal stop action. The health endpoint confirms the web process; these authenticated checks confirm the migrated queue and browser flow.
