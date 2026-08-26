# Deployment profiles and optional features

This guide is the decision point for a new installation. Deploy the safe base
profile first, then enable extensions one at a time. An extension is enabled
only after the operator answers **yes**, supplies its own configuration, and
passes that extension's acceptance checks. Leaving its values blank is a
supported configuration; the code remains in the repository but the feature
stays inactive.

The guide is intentionally explicit about authority and data movement. A
browser user must never be surprised by a root process, a cloud upload, a
desktop executor, or an external memory model.

## 1. Start with the base profile

The base profile provides:

- one Web login and one isolated, non-root tenant Worker;
- local projects, project mode/sidebar, conversation moves within that user's
  projects, uploads, resumable voice drafts, and normal Codex task execution;
- SQLite/data/tenant persistence in the Compose state directory;
- no host filesystem bridge, no Docker socket, no desktop Worker, no cloud cold
  storage, and no external personal-memory extraction.

Before first start, ask the operator these questions and record only the
answers (never the secrets):

| Question | If **yes** | If **no** |
| --- | --- | --- |
| Do you want a normal cloud/container tenant? | Deploy the base profile. | Do not deploy Codex Web. |
| Do you want microphone transcription? | Configure the Voice extension. | Leave both `DASHSCOPE_*` values blank. |
| Should draft/conversation context be sent to an external memory model? | Configure Personal Memory after a data-review. | Keep `PERSONAL_MEMORY_*` blank. |
| Should this service access host files or run Codex as host root? | Obtain explicit root-bridge consent and follow §4. | Do not create the root account or service. |
| Should a Windows/macOS computer execute Web tasks? | Configure the Remote Worker extension. | Leave the enrollment token blank. |
| Should conversations be encrypted and copied to remote cold storage? | Configure a provider, `age`, retention and a scheduler, then follow §6. | Leave all cold-storage values blank. |
| Should the operator use Codex account switching/shared auth? | Enable it only together with the root bridge and a reviewed auth policy. | Keep shared-auth files absent. |
| Should this checkout self-publish approved commits? | Install the opt-in queue/systemd templates in `deploy/`. | Do not install them. |

The first five answers are a minimum deployment decision record. Do not turn a
`no` into a later automatic migration. Re-ask and re-accept every extension if
the operator changes their mind.

### Base installation

1. Clone a reviewed commit and keep `.env` outside Git. Copy `.env.example`,
   set `BASE_PATH`, `APP_USERNAME`, `APP_DISPLAY_NAME`, a bcrypt
   `APP_PASSWORD_HASH`, a random `SESSION_SECRET`, and the final
   `PUBLIC_BASE_URL`.
2. Create the external Compose network once:

   ```bash
   sudo docker network inspect codex-web-egress >/dev/null 2>&1 \
     || sudo docker network create codex-web-egress
   ```

3. Run `sudo docker compose config --quiet`, `sudo docker compose build --pull`,
   and `sudo docker compose up -d`. The published port must remain bound to
   `127.0.0.1`; put TLS and the `/codex-web/` path at the reverse proxy.
4. Check `docker compose ps`, the container health check, and
   `curl --fail http://127.0.0.1:37821/codex-web/api/health` (adjust the path
   when `BASE_PATH` is intentionally different).
5. Have the human operator complete Codex authorization in the base tenant,
   then submit one harmless test task. Do not copy an `auth.json` from another
   user or print it in a log.
6. Back up the state volumes before enabling any extension.

The base profile is complete when login, a small task, an upload/download, a
container restart, and a backup/restore rehearsal all pass. Do not add an
extension merely because its source files are present.

## 2. Extension contract

For every extension use this loop:

1. Ask the yes/no question above and explain the authority, cost, and data
   destination in plain language.
2. Take a pre-change backup and record the commit, configuration names (not
   values), and intended scope.
3. Configure only that extension. Run `docker compose config --quiet`; restart
   or rebuild only what the extension requires.
4. Perform its acceptance test and inspect recent, redacted logs.
5. Record how to disable it. Disabling means removing/blanking its values and
   restarting; it does not erase existing data. Delete data only as a separate,
   confirmed operation.

The following matrix is the short version. The detailed procedures are below.

| Extension | Default | Minimum configuration | Extra authority/data path | Disable test |
| --- | --- | --- | --- | --- |
| Voice transcription | Off | `DASHSCOPE_API_KEY` + `DASHSCOPE_BASE_URL` + HTTPS `PUBLIC_BASE_URL` | Audio and bounded context go to the configured ASR endpoint | Blank both `DASHSCOPE_*`, restart, microphone is unavailable |
| Personal Memory extraction | Off | `PERSONAL_MEMORY_API_KEY` + `PERSONAL_MEMORY_BASE_URL` | Bounded draft/history context goes to the configured model; local memory files remain user data | Blank both `PERSONAL_MEMORY_*`, extraction is reported unconfigured |
| Host/root bridge | Off | Root host service, Unix socket, four host paths, shared-auth policy | Root process can read/write configured host paths and launch host Codex | Stop/disable root service and clear socket/path values |
| Remote Worker | Off | Host-root Web account, HTTPS `PUBLIC_BASE_URL`, ≥32-char enrollment token, bundled release | Desktop user's local files/Codex are used only for approved projects | Revoke/disable executor, remove token, stop Worker |
| Encrypted cold storage | Off | Provider CLI + Drive/remote ID + `age` recipient/identity + scheduler | Encrypted archives leave the server; keys and provider credentials stay outside Git | Stop scheduler, clear four values, verify no new upload |
| Shared Codex auth/account management | Off | Root bridge plus reviewed source/lock/policy files | One protected authority file may serve selected accounts; it is not public login state | Stop bridge and remove policy/mount |
| Self-publish coordinator | Off | Reviewed path and systemd queue templates | Can build/restart the configured checkout after an explicit queued request | Disable `.path` and remove/retain queue per operator policy |

## 3. Voice transcription (optional)

Voice is usable only when both `DASHSCOPE_API_KEY` and
`DASHSCOPE_BASE_URL` are non-empty. Set an HTTPS `PUBLIC_BASE_URL`; browsers
will not grant microphone access on an insecure, non-local origin. The default
model is `qwen3.5-omni-plus`, or set `DASHSCOPE_ASR_MODEL`.

The browser first stores the complete recording in account/conversation-scoped
IndexedDB. If connectivity disappears during upload, the composer keeps the
recording, marks it failed, and offers retry or delete. A retry reuses the same
client recording UUID; the server's receipt prevents a duplicate transcription
and rejects a changed payload under that UUID. Browser drafts and server
receipts are pruned after 24 hours.

Before enabling, tell the operator that audio and bounded context (draft text,
attachment names, a small text prefix, recent messages, terms, and at most two
small images) are sent to the configured endpoint. Test with a non-sensitive
recording, interrupt connectivity after upload starts, restore the network,
retry, and confirm the same recording produces one result. To disable, blank
both values and recreate the app container; existing local drafts are not
automatically deleted.

## 4. Host/root bridge (high-risk, explicit consent)

This is not a convenience switch. The bridge is a separate host-side Node.js
process that must run as **root**. It can launch Codex with `HOME=/root`, browse
the configured knowledge/project roots, and perform host-side maintenance. Do
not enable it unless the operator understands that a prompt executed through
the host executor has host-root authority and has explicitly approved the
paths, backup plan, and incident response.

### Account and path prerequisites

The reserved host-root Web identity is UUID
`00000000-0000-4000-8000-000000000010` and username `owner`. The ordinary base
account is UUID `...0001`; usernames are unique. Therefore:

- if the base account may later use the bridge or Remote Worker, choose a base
  `APP_USERNAME` other than `owner` (for example `admin`) from the beginning;
- if an existing base install already uses `owner`, rename that Web account in
  `.env` and restart first, then create the reserved host-root account;
- never edit the `users` table by hand and never reuse the host-root UUID for a
  normal member.

The host process needs Node.js ≥22.13, a built checkout, root-owned or
carefully ACLed directories for:

- `CODEX_WEB_HOST_TENANT_ROOT` (host tenant state),
- `CODEX_WEB_KNOWLEDGE_ROOT` (host project root),
- `CODEX_WEB_CODEX_HOME` (host Codex Home and login state), and
- the Unix socket directory shared with the app container.

The app sees the socket at `/run/codex-web-host/host.sock` (the Compose mount
path); the host service must use the corresponding host path, for example
`/opt/codex-web/.state/host-bridge/host.sock`. Do not use one path value for
both processes when the paths differ across the container boundary.

### Opt-in procedure

1. Take a backup and obtain written/recorded consent. Confirm that no other
   service owns the chosen socket or host directories.
2. Set the four `CODEX_WEB_*` path values in the app `.env`; keep the socket
   value at the **container** path. Leave them blank until consent and paths are
   ready. Configure a reviewed `CWW_SHARED_CODEX_AUTH_FILE`, lock and policy
   for the host service; never commit the files.
3. Build the host-side artifacts with Node 22 (`npm ci && npm run build`).
   The root service must run `dist-server/server/host-root-server.js` from the
   same reviewed commit as the app.
4. Create the reserved account using the supported CLI only after the base
   username no longer occupies `owner`:

   ```bash
   sudo docker compose exec app \
     node dist-server/server/manage-user.js create-host-root owner "Host owner"
   ```

   Capture the generated password in a secure terminal, deliver it once to the
   operator, and remove it from shell/log history. Change it after first login.
5. Install a host service using your platform's least-privilege/systemd
   conventions. A reviewable starting point (adapt paths, package manager,
   MAC policy, and the Node binary to the host) is:

   ```ini
   # /etc/systemd/system/codex-web-host-root.service
   [Unit]
   Description=Codex Web opt-in host root bridge
   Wants=network-online.target
   After=network-online.target

   [Service]
   Type=simple
   User=root
   Group=root
   WorkingDirectory=/opt/codex-web
   EnvironmentFile=/etc/codex-web/host-root.env
   ExecStart=/usr/bin/node /opt/codex-web/dist-server/server/host-root-server.js
   Restart=on-failure
   RestartSec=5s
   UMask=0077

   [Install]
   WantedBy=multi-user.target
   ```

   The root-only environment file must contain the host-side socket path, the
   three absolute host roots, `CWW_DATABASE_PATH` pointing to the Compose data
   volume's SQLite file, `CODEX_RUNTIME_PATH`, `CODEX_WEB_WEB_GID=10001`, and
   the reviewed shared-auth source/lock/policy paths. Protect the file with
   `chmod 600`; do not put its values in Git. Start it only after
   `npm run build` succeeds; verify the socket is mode `0660`, owned by root
   and the app Web GID.
6. Recreate the app, then verify: the host executor is visible only to the
   host-root account; a project-directory list and a harmless read-only host
   task succeed; a normal tenant still cannot see host paths; stopping the
   bridge makes host tasks fail closed.

There is deliberately no automatic root-service installer in this repository:
service names, filesystem paths, MAC policies, and the Web GID are host policy
decisions. Keep the process supervised, log only redacted status, and test a
full stop/restart. To disable, stop and mask the host service, remove the
socket/path environment from the app, recreate the app, and disable the
reserved Web account if it should no longer be usable. Keep host data only if
the operator explicitly wants it retained.

## 5. Remote Worker (optional desktop executor)

Remote Worker is separate from the root bridge process, but the current Web
bootstrap and executor-management APIs are restricted to the reserved
host-root Web account. You therefore need that account and an HTTPS public URL;
the root bridge service itself is not required for a desktop Worker job.

Set a random `REMOTE_WORKER_ENROLLMENT_TOKEN` of at least 32 characters and
keep it server-side. The Docker image contains matching Windows and macOS
release packages under `/app/worker-release`; do not copy a private login or
current `auth.json` into the repository. The Worker opens only outbound WSS and
uses the desktop user's own Codex login and filesystem permissions.

After the host-root account logs in:

1. Open the project/executor dialog and choose **＋新建远程 Worker**.
2. Generate the one-time Windows or macOS installer URL. It expires after a
   short period and is single-use; send it only to the intended operator.
3. Run the installer as the normal desktop user, choose a machine display name,
   and complete the local Codex login. Do not run daily tasks as Windows
   Administrator or Unix root.
4. Confirm an online heartbeat, version, capacity, a read-only test task, a
   cancelled task, reconnect after network loss, and file size/hash checks.
5. Revoke or disable the executor before retiring the machine. Remove the
   enrollment token only after all intended Workers have been retired, then
   recreate the app.

If no token, public HTTPS URL, or release package is available, leave the
feature off; the base tenant continues to work. See
[`remote-worker/README.md`](../remote-worker/README.md) for OS-specific details.

## 6. Encrypted cold storage (optional and advanced)

Cold storage is not enabled merely by filling one variable. Configure all four
values together:

```dotenv
CODEX_WEB_COLD_STORAGE_CLI=/absolute/path/to/provider-cli
CODEX_WEB_COLD_STORAGE_DRIVE_ID=<provider-specific-id>
CODEX_WEB_COLD_STORAGE_AGE_RECIPIENT=<age-recipient>
CODEX_WEB_COLD_STORAGE_AGE_IDENTITY=/secure/path/age-identity.txt
```

The runtime image does not bundle your cloud provider CLI, cloud credentials,
`age` identity, or a retention scheduler. Provide audited binaries and a
credential mechanism in the execution environment (or build a reviewed
derived image), then run the cold-storage CLI's dry-run before any archive
upload. Verify that an archive can be restored on a separate host with the
identity key. Store the identity and provider credentials outside Git and
outside public issue reports.

Use a separately reviewed timer/cron for retention and upload; there is no
implicit background upload in the base Compose profile. Acceptance requires a
manifest/hash check, an encrypted remote object, a successful restore, and a
documented deletion/retention policy. To disable, stop the scheduler, clear all
four values, recreate the app, and verify that a new archive remains `local`
or fails closed. Existing remote archives and keys are not deleted by this
switch.

## 7. Personal Memory, shared auth, and self-publish

### Personal Memory and personal context

The repository includes the memory/context UI and per-account files. Without
both `PERSONAL_MEMORY_API_KEY` and `PERSONAL_MEMORY_BASE_URL`, extraction is
reported as unconfigured and no external model call is made. If enabled, tell
the operator exactly which bounded draft/history context is sent, which model
and region receive it, and how to delete the resulting entries. Test one
non-sensitive fact, inspect the evidence/source list, then disable and verify no
new extraction is queued.

### Shared Codex authentication and account management

These controls are optional and require a reviewed shared-auth source file,
refresh lock, and policy file. They do not synchronize the maintainer's current
Codex login. Mount only the selected authority directory, keep permissions
restricted, and test account switching plus lock/recovery before allowing a
second account. Without the root bridge and policy, the account-management
surface stays unavailable.

### Self-publish coordinator

The queue, rebuild script, coordinator, and systemd `.service`/`.path` templates
under `deploy/` are opt-in. Review `CODEX_WEB_*` paths, backup and rollback
commands, and the single-consumer lock before enabling them. A queued request
must reference a clean, reviewed commit; health and migration checks remain
mandatory after every publish. Do not install the templates on a machine that
has not first completed the base backup/restore rehearsal.

## 8. Per-extension rollback record

For each enabled option, keep a short non-secret record:

```text
Extension: <voice | memory | root bridge | remote worker | cold storage | ...>
Decision: yes
Commit: <full SHA>
Configuration names: <names only; no values>
Authority/data destination: <one sentence>
Acceptance: <commands and observed result>
Disable/rollback: <exact reversible action>
```

This record makes a later “why is this running?” question answerable without
publishing passwords, API keys, tokens, cookies, private keys, provider IDs, or
Codex login files.
