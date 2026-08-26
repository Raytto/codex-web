# Deployment templates

The files in this directory are generic, opt-in templates. They do not contain
the maintainer's hosts, domains, credentials, database, tenants, or current
login state.

Install the base Compose profile and complete its backup/restore rehearsal
before installing any template. The host/root bridge, Remote Worker, cloud
cold-storage scheduler, shared Codex auth, and self-publish coordinator are
separate decisions; none is enabled just because its files are present. See
[`docs/DEPLOYMENT_OPTIONS.md`](../docs/DEPLOYMENT_OPTIONS.md) for the
questionnaire, prerequisites, acceptance checks, and disable paths.

`codex-web-request-rebuild` records a clean Git commit in a durable queue;
`codex-web-rebuild-coordinator` consumes that queue one request at a time;
`codex-web-rebuild` builds, verifies, starts Compose, and checks health. Set
`CODEX_WEB_*` variables for a different checkout, state root, health URL,
Compose file, or service integration. Install the systemd units only after
reviewing those paths for your machine.
