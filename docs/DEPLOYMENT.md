# Deployment

## Recommended rollout

Use a layered rollout: complete the base Compose installation and its backup,
health, login, task, and restart checks first. Then ask whether each optional
feature is wanted and enable only the selected one. Empty optional environment
variables are intentional and keep the corresponding code path inactive.

The [deployment options guide](DEPLOYMENT_OPTIONS.md) is the canonical
questionnaire and acceptance matrix. It covers voice, personal-memory
extraction, the explicit-consent host/root bridge, Remote Worker, encrypted
cold storage, shared Codex authentication, and the self-publish coordinator.
The [AI cloud runbook](../AI_CLOUD_DEPLOYMENT_RUNBOOK.md) turns the same choices
into an Ubuntu execution checklist.

## Local Docker deployment

Follow the root README. Bind mounts under `.state/` persist SQLite, tenant workspaces and Codex login/thread state. Use the [isolated build and cleanup workflow](BUILD_AND_STORAGE.md); no host development dependency installation is required.

Compose expects the external `codex-web-egress` network. Create it once before
the first `up` (and do not remove it during routine updates):

```bash
sudo docker network inspect codex-web-egress >/dev/null 2>&1 \
  || sudo docker network create codex-web-egress
```

Useful checks:

```bash
docker compose ps
docker compose logs --tail=200 app
curl --fail http://127.0.0.1:37821/codex-web/api/health
```

Back up all three named volumes before upgrades. Keep `.env` outside source control.

Recent releases add SQLite columns for continuation targets and selections, plus the `voice_transcription_receipts` table used for idempotent voice retries. Migrations are additive and run on startup, but the pre-upgrade volume backup remains the rollback boundary; do not start an older image against a database already migrated by a newer release unless that version is documented as backward compatible.

Older installations may still have the legacy workspace layout; the startup
migration preserves those files while converging new tenants on the current
`tenants/<user-id>/conversations/` layout (旧布局 is not a reason to copy data
into the public repository).

Docker grants the application up to 30 minutes after `SIGTERM` to drain active Codex work. New dispatch stops immediately, queued jobs stay persisted, and the container exits once active executions finish. Avoid overriding `stop_grace_period` with a shorter value unless you accept interrupted jobs.

## Reverse proxy

Terminate TLS at your reverse proxy and forward `/codex-web/` to `http://127.0.0.1:37821/codex-web/`. Preserve the path prefix, pass the original host and protocol headers, disable response buffering for event streams, and use a long read timeout for active tasks.

Set `PUBLIC_BASE_URL` to the final HTTPS URL. Do not publish container port 37821 directly to the internet.

Review `MAX_UPLOAD_FILE_BYTES`, `MAX_STORED_BYTES_PER_USER`, and `MINIMUM_FREE_DISK_BYTES` for the host volume before accepting uploads. The defaults allow a 2 GiB individual file, 20 GiB stored per user, and preserve 2 GiB of free space. Large uploads use 8 MiB resumable chunks and unfinished partials expire after 72 hours; all values are configurable in `.env`.

For optional voice transcription, keep `DASHSCOPE_API_KEY` only in `.env`. The default context budget is 500 approximate tokens, two images, and 2 MiB per image. Adjust `TRANSCRIPTION_CONTEXT_TOKEN_BUDGET`, `TRANSCRIPTION_CONTEXT_MAX_IMAGES`, and `TRANSCRIPTION_CONTEXT_MAX_IMAGE_BYTES` only after considering request cost and data exposure.

To verify the offline-retry path, start a recording, interrupt connectivity after the upload begins, and confirm the complete recording remains in the composer with retry and delete actions. Retrying the same recording must produce one transcription even if the first HTTP response was lost; a changed payload with the same client recording UUID must be rejected.

## Updating

```bash
git pull --ff-only
./scripts/build-image.sh
sudo docker compose up -d --no-build
```

The default container runs the pinned image-bundled Codex CLI directly, without copying it to the persistent runtime volume. Existing login/thread state and old runtime releases are preserved; see [runtime migration and rollback](BUILD_AND_STORAGE.md#upgrade-and-rollback).

For source-based publishing, use `deploy/codex-web-request-rebuild` and the
single-consumer `deploy/codex-web-rebuild-coordinator`; the optional
`codex-web-self-maintain.service` and `.path` units can watch the persisted
queue. Configure paths through `CODEX_WEB_*` variables and keep queue, status,
logs, backups, and credentials outside Git.

The platform spreadsheet skill is copied from `skills/local-spreadsheets/` when a tenant is initialized. The HTML report skill is seeded from `account-resources/common/skills/html-report/` into the account library and synchronized as an enabled account skill. Its relative `references/`, `assets/`, and `scripts/` files are included, so a newly created user can follow and validate the report workflow without any extra volume or environment setting. Do not manually place these managed skills under `.system/`.

After upgrading, verify that archived conversations remain listed under personal settings and that any job interrupted by an ungraceful previous stop has a visible interruption message instead of being retried.

On mobile Safari, also verify that selecting text in a Markdown reader survives a viewport/loupe
scroll and that the reader header keeps its back action, title, and file actions usable at narrow
widths.

For PDF and EPUB files, verify that the paginated reader opens only after the preview action,
keeps rendering bounded to nearby pages, and preserves a selected passage or annotation after a
page turn and a text-layer remount. On Safari/WebKit, confirm that the canvas glyphs and selectable
text layer both remain visible; these checks exercise the compatibility paths that avoid browser
font and stream-iterator quirks.

For the reader Agent flow, open an authenticated Markdown file, select a passage, use the Reader
Agent action, and confirm that the quoted passage appears as a removable reference and that the
answer is stored in the file's owning conversation. HTML previews remain sandboxed; only the
authenticated owner can send the reader question.

The public sign-in contract remains username plus password. Keep `APP_USERNAME` and
`APP_PASSWORD_HASH` in the private `.env`; do not add phone-number, SMS, or external credential
proxy settings to a public deployment.

New deployments default to a 14-day Web session (`SESSION_TTL_HOURS=336`). Shorten this value
for shared or higher-risk devices; changing it affects newly issued sessions.

Also verify one empty-task reuse, one timed continuation with the intended same/new-conversation target and model selection, and a normal stop action. The health endpoint confirms the web process; these authenticated checks confirm the migrated queue and browser flow.

## September 2026 upgrade checks

Back up state before the new versioned SQLite migrations. Existing shared-token
Workers need the explicit [credential migration](JOB_RETRY_AND_DEVICE_CREDENTIALS.md)
and matching Worker 1.19.3 package; do not deploy a new gateway and assume old
shared connections remain accepted. Verify independent reconnect, rotate/revoke,
a harmless task and cancellation before closing the migration window.

Check queued capacity recovery after restart, first-attempt file delivery, and
literal copyable commands. New tasks prefer Astra/high only where the catalog
supports them. Run the two `tests/browser/*-selection.mjs` fixtures with
`PLAYWRIGHT_MODULE` pointing to an installed Playwright package and optionally
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`; these fixtures use isolated loopback servers.
Verify long reader quotes, native selection and all selection actions on target
mobile Safari devices separately. Docker's test target includes `.github` so
Worker CI-contract checks can run.

For opted-in storage, use the finite-batch `maintain` command and review
[cold-storage scheduling and restore acceptance](CONVERSATION_COLD_STORAGE.md).
No private scheduler, runtime updater, service or credentials are installed.

The base Compose file has no host bridge volume. After approving and configuring
the root extension, set `CODEX_WEB_HOST_BRIDGE_DIR` and explicitly include
`compose.host-root.yaml` with `docker compose -f compose.yaml -f compose.host-root.yaml`.
The standard build, browser API URLs, Compose environment, health check and Nginx
routes use `/codex-web`; the exact Worker connect route permits WSS upgrades.


## September 30, 2026 upgrade checks

Back up the application database and tenant volumes. Additive migrations create durable recovery checkpoints, reset-credit snapshots, and empty PARA tables, including board/sidebar order. Resource files live in each account's `para-resources/`; include them in tenant backups. Rolling back code does not roll back business data. `CWW_PARA_ENABLED=false` closes the PARA routes without deleting data.

Verify login and static files under `/codex-web`, an empty board, resource upload/collection, a conflicting revision, conversation links, sidebar search/selection, and a draft containing only explicitly selected material. Resources are account-private and count toward the existing quota. Check PDF/EPUB mode changes and HTML/Markdown first selection. See [PARA](features/PARA_BOARD.md) and [task recovery](TASK_RECOVERY.md).

Optional Worker users should deploy the matching 1.20.0 package from this public checkout. Check account usage refresh and rollout-size reads against an idle test device. Reset-credit consumption is a separate, explicit administrator action; automated tests use synthetic credentials and never consume a real card. Older Workers remain gated where capabilities are missing.

Run `npm run verify` and the Docker `test` target. For isolated Chromium checks, set `PLAYWRIGHT_MODULE` to an installed Playwright package entry file and optionally `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Run `node tests/browser/reader-first-selection.mjs` and `node --import tsx tests/browser/para.mjs`; the latter starts a temporary loopback application with fresh synthetic password accounts, uses `/codex-web`, and stubs ASR. It does not log into a deployed installation or start model tasks. `BROWSER_ARTIFACTS_DIR` selects the evidence directory. Target-device Safari and real provider/account operations require separate operator acceptance.

## October 3, 2026 upgrade checks

Back up the database and tenant volumes before upgrading. Migrations `2026093003`–`2026093005` hide the project-board preference once, add lifecycle fields and compatibility mirrors, and give existing enabled unlimited shares 30 days from migration time. Later account opt-ins survive restart; restarts do not renew shares. Review the share list and intentionally renew or disable links before the grace period ends. Restoring older application code does not undo these data migrations.

Verify password login and static/API routing under `/codex-web`, hidden board defaults, account/device preference isolation, lifecycle transitions and required closure notes, revision conflicts, draft clearing and queued voice edits. Test text-before-images, a stalled/broken image, stable text selection and the reader settings menu. Confirm a share and each of its images become unavailable at expiry or revocation and that renewal preserves the URL.

Cold storage stays disabled without its complete optional configuration and scheduler. If configured, rehearse an expired-share residual merge, upload failure and full restoration with synthetic files; do not infer successful archiving from expiry alone. This update retains the existing conversation-thread deletion behavior and does not add a requirement for a host bridge to the base profile.

Run `npm run verify`, Docker's `test` target and the isolated browser runners documented in the feature guides. `tests/browser/para.mjs` covers account settings, project lifecycle, compact cards and sidebar scrolling for two synthetic accounts without model jobs. Additional isolated runners cover delayed composer reads, queued voice edits, expiring shares and progressive reader images. PowerShell, Windows and physical iOS Safari coverage must be recorded separately. Real models, speech providers and account operations require separate operator acceptance.

## October 6, 2026 reader navigation checks

This browser update adds no database migration, environment variable, Worker protocol or container capability. Existing `/codex-web` proxy and SPA fallback routing remain required. Verify normal reading stays in one tab, the return control restores the source page, and a directly opened reader returns to `/codex-web`. Also check Alt-click, native Ctrl/Cmd or middle-click, public-share links, narrow-screen headers, and failed remote transfers. A same-origin page outside `/codex-web` must not become the application's return destination.

After `npm ci`, use an installed Playwright entry file in `PLAYWRIGHT_MODULE` and Chromium in `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, then run `node tests/browser/reader-navigation.mjs`. It serves real UI components under `/codex-web`, uses synthetic API fixtures, and makes no model or production login requests. Run the existing reader selection and progressive-image regressions alongside `npm run verify` and Docker's `test` target. Physical iOS Safari and platform-specific modifier behavior need separate device acceptance.

## Recurring tasks and optional transfer upgrades

The next application startup applies additive migration `2026101001` for recurring schedules and run history. Back up the instance database before upgrading. Existing one-shot waits remain unchanged. Validate the configured time zone, a bounded test schedule, pause/resume and a stopped run before relying on recurring execution. No new cron service or environment variable is required.

Build the matching Worker 1.20.0 release from this public checkout. Optional host bridges must install the same dependency lockfile (including the JS/WASM transfer dependencies) and set `PUBLIC_BASE_URL` to the HTTPS application URL **including** `/codex-web`. Keep `CODEX_WEB_HOST_SOCKET_PATH` empty unless an operator has deliberately configured the bridge; default Compose has no host filesystem or socket mounts.

The generic [Nginx template](../deploy/nginx/codex-web.conf) includes the dedicated `/codex-web/api/node-transfers/connect` WebSocket route, a 2 GiB body limit and 30-minute proxy/body budgets. Preserve the subpath when proxying. Application quotas and smaller reader/share limits still apply. Check both small direct and forced-relay test transfers in your own network, target SHA-256, `committed`, and both cleanup receipts. Local loopback tests do not establish NAT connectivity or Windows behavior.

[Project skills](PROJECT_RECURRING_TASKS.md#项目技能) remain scoped to the selected project. Host operations independently verify project ownership in the bridge database. No account credentials or personal skills are provided. Codex SDK 0.162.1 is pinned; the separately installed Codex CLI/runtime still follows the operator's configured update policy.

## October 14, 2026 voice queue checks

The incremental voice queue presentation update adds no database migration,
environment setting, dependency or Worker protocol change. The slim default
image, optional `documents` target, isolated build/cleanup workflow and normal
upgrade commands above remain unchanged. Keep username/password login,
`/codex-web`, low-privilege tenants and disabled optional providers as configured.

For an installation with voice enabled, verify recognition only in the pending
queue; refresh during recognition and after completion, and confirm the same
item remains. Check a failed recognition and explicit retry, then confirm that
dispatch creates exactly one ordinary user message and removes the queue item.
See [voice queue behavior and the isolated browser regression](VOICE_SEND.md#one-queue-item-until-execution).
The regression uses synthetic audio/transcription and a controlled model runner
with actual scheduler/database transitions; real provider/model and microphone checks
remain separate operator acceptance. An installation with voice disabled does
not need provider credentials merely to upgrade.

### Opportunity navigation and learning upgrade

The optional opportunity-card increment requires no new environment variables or services. Back up your own database/state, then follow the existing immutable build/deploy commands. Startup migrations add topic ordering, learning cursors/history and project-relative knowledge entries without importing topics or schedules. See [opportunity upgrade and migration](OPPORTUNITY_CARDS.md#upgrade-and-migration) for verification and rollback boundaries. Configure your own Markdown knowledge entry and provider only if needed; keep empty/fail-closed defaults otherwise.
