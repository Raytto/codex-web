# Durable continuation

Codex Web can persist a one-shot continuation after the current Agent turn ends. This is intended for work that must check again later, or wait for an external process without keeping a model turn alive.

## Modes

- `after`: enqueue a continuation prompt after a bounded delay.
- `event`: wait for an authenticated success or failure receipt, with a deadline prompt as the fallback.

The active plan is stored in SQLite. When it triggers, its selected prompt becomes a normal queued prompt and follows the same per-conversation serialization rules as browser submissions. A resumed turn must create another plan if more waiting is required.

## Agent CLI

Running jobs receive these shell variables:

- `CODEX_WEB_WAIT_CLI`: path to the bundled CLI.
- `CODEX_WEB_AUTOMATION_BASE_URL`: internal API base URL.
- `CODEX_WEB_AUTOMATION_JOB_ID`: the current job id.
- `CODEX_WEB_AUTOMATION_TOKEN`: a signed, short-lived, job-scoped bearer token.

Run `node "$CODEX_WEB_WAIT_CLI" --help` before creating a plan. The `event` command writes a receipt containing the external callback credential. Keep that file in a protected runtime directory that remains available to the external supervisor.

## Security properties

- Job automation tokens are HMAC-signed, expire after 24 hours, and are accepted only while the matching job is running.
- External event tokens are random and returned once. SQLite stores only their keyed hash.
- Browser APIs remain protected by the normal session, CSRF, origin, and ownership checks.
- Event ids are idempotent: duplicate receipts do not enqueue duplicate prompts.
- Only one armed plan is allowed per conversation.
- Receipt contents and bearer tokens must never appear in replies, application logs, or deliverables.

Set `PUBLIC_BASE_URL` when an external supervisor must call the event endpoint through a reverse proxy. The URL must include the configured base path when the deployment does not mount Codex Web at the origin root.
