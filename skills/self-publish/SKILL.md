---
name: self-publish
description: Queue, build, verify, and publish a Codex Web checkout with a single-consumer coordinator.
---

# Codex Web self-publish

Use this skill only when the repository owner explicitly asks to publish a
clean checkout. It never reads or copies `.env` files, database files,
authentication files, tenant data, cold-storage archives, or private keys.

## Safe flow

1. Confirm the intended branch is `main` or `master`, the worktree is clean,
   and the target commit is the one the owner named.
2. Run `deploy/codex-web-request-rebuild` to persist a request in the local
   queue. Set `CODEX_WEB_START_COORDINATOR=true` only when the owner wants the
   request consumed immediately.
3. The coordinator serializes requests, builds through `docker compose`, runs
   the repository verification suite, starts the service, and checks the
   configured health URL. Set paths and service names through `CODEX_WEB_*`
   environment variables; no production topology is assumed.
4. Keep the request database, status snapshot, build logs, and rollback notes
   under the operator-selected state root. They are operational evidence and
   must not be committed to the repository.

## Optional integrations

Remote Workers, host/root bridges, shared Codex authentication,
voice transcription, personal memory extraction, and cloud cold storage are
feature modules in the codebase. They remain inactive until their explicit
tokens, endpoints, sockets, or provider binaries are configured. A clone with
none of those settings must still run the local workspace.
