# From the minimum install to a complete workstation

[中文详细步骤](SETUP_GUIDE.zh-CN.md) · [Quick start](../README.en.md#quick-start) · [Upgrade checks](UPGRADE_20261108.md)

Start with a working password login and a real text task. Enable optional services individually, using your own accounts, paths and keys. This repository contains no account state, device bindings, personal memories or cloud backups. “Settings” means the personal settings menu in Codex Web; the container, host bridge and remote computers are separate execution locations.

## Minimum runnable installation

You need Linux, Git, Docker Engine, Compose v2, Buildx and an account authorized to use Codex. Follow the root README: clone `main`, run `scripts/build-image.sh`, copy `.env.example`, generate your own password hash and random session secret, initialize permissions, create the egress network and start Compose. The builder exports a committed Git tree and removes its own bounded cache. No host npm installation, speech API or cloud drive is required.

Use a normal username such as `admin`; `owner` is reserved if you later create the explicit host administrator. Quote the bcrypt hash in `.env`, keep it private and readable only by the configured Web identity. Web UID and tenant execution UID remain separate. Default Compose does not mount the Docker socket or host projects.

After the health check, log in with your website username and original password. Run the README's `codex login --device-auth` command under the **tenant's UID, HOME and CODEX_HOME**, finish authorization yourself, and check `codex login status` in the same environment. Website passwords, Codex account authorization and API keys are separate. Keep `auth.json` out of Git, chat and logs. See [official Codex authentication](https://learn.chatgpt.com/docs/auth).

Complete one real text task, a small upload/result download and a container restart. Health alone does not verify model access. For a remote server, use an SSH tunnel initially; before microphone or Worker use, configure HTTPS, preserve `BASE_PATH`, forward SSE/WebSocket traffic and set `PUBLIC_BASE_URL` to the final URL including its prefix.

## Configuration and enable/disable matrix

| Capability | Prerequisite / where to obtain it | Where to configure | Verify and disable |
| --- | --- | --- | --- |
| Website | Self-generated bcrypt hash and random secret; required | Private `.env`: `APP_USERNAME`, `APP_PASSWORD_HASH`, `SESSION_SECRET` | Login/logout; disable the account or stop the site |
| Codex | Your authorized Codex account; account limits apply | Tenant/host/Worker Codex Home, according to the chosen executor | Real task and `codex login status`; log out on that executor |
| Gemini / Antigravity | Google OAuth; vendor access and limits | Settings → Account management → node → add Gemini account | Real task using the node catalog; remove/log out the node account |
| Recorded speech | Audio-capable compatible Chat Completions service; API billing | `DASHSCOPE_API_KEY`, `DASHSCOPE_BASE_URL`, `DASHSCOPE_ASR_MODEL` | Short recording and offline retry; clear key and recreate app |
| Continuous voice | Explicit host account/project, HTTPS/microphone, OpenAI API access to GPT-Live | `CODEX_WEB_LIVE_*`; private server key file | Call, interrupt, delegate, verify original task, hang up; set enabled=false |
| API memory extraction | Compatible text model supporting JSON output; separate API billing | `PERSONAL_MEMORY_PROVIDER=api`, API_KEY, BASE_URL and MODEL | Inspect candidate sources and run audit; disable personal memory or clear config |
| Managed Codex memory | Existing executor Codex authorization and selected supported model | `PERSONAL_MEMORY_PROVIDER=codex-cli`, MODEL and EFFORT | Inspect actual provider/model audit; disable or switch provider |
| Cloud lifecycle/backup | Your drive authorization, storage quota, age identity and matching recipient | Separate host-side `STORAGE_*` environment and backup plan | Isolated restore drill; stop maintenance schedules while retaining recovery |

Unset optional credentials leave those integrations inactive. There is no single “all features API key.” API access/budgets, subscription benefits, available models and vendor limits must be checked in your own accounts.

## Recorded speech

This release uses an audio-capable **Chat Completions** contract with `input_audio`. It does not implement OpenAI's `/audio/transcriptions` contract; changing only the endpoint cannot convert protocols. A separate in-progress transcription adapter is outside this release.

Obtain a regional/workspace key from [Model Studio](https://help.aliyun.com/en/model-studio/get-api-key), then select an audio-input model and matching base URL from the [Qwen-Omni documentation](https://help.aliyun.com/en/model-studio/qwen-omni). Put the three values in private `.env`, without appending `/chat/completions` to the base URL. Recreate app, permit the microphone and test the explicit recording button. Check transcription, submission and retry after a network interruption. The context budget can include draft text, recent messages, filenames and bounded images; use `TRANSCRIPTION_CONTEXT_*` to control it. Clearing the key stops new cloud transcription without deleting historical records.

## PP Dot and continuous voice

PP Dot now ships as code: a fixed coordinator, cross-project delegation, task ledger, source-linked memory, corrections/forgetting and result review. Text coordination needs no voice key. In this edition its authority is limited to the explicitly configured host administrator and that account's projects/devices.

Follow [host/Worker deployment](DEPLOYMENT_OPTIONS.md) to create the reserved host account with `create-host-root owner`, configure the bridge and its roots/socket/auth policy, and select the unique active server project matching `CODEX_WEB_KNOWLEDGE_ROOT`. Do not convert a normal tenant into root or add Docker access to base Compose. If a normal user already owns the reserved name, resolve that conflict through user management without overwriting its identity. Enable PP Dot in feature selection, delegate a harmless task and inspect its target conversation and source-linked result. A finished model turn alone is not business acceptance.

Continuous voice uses **GPT-Live WebSocket with client delegation**, not a Realtime WebRTC adapter. Check [the official connection protocol](https://developers.openai.com/api/reference/typescript/resources/live/methods/connect) and [delegation contract](https://developers.openai.com/api/docs/guides/live-delegation). Create your own project key on the [OpenAI API platform](https://platform.openai.com/api-keys), check model access and [pricing](https://developers.openai.com/api/docs/pricing), and store the key in a private file readable by Web UID 10001. The key never goes to the browser.

A documented enablement example (not a shipped default):

```dotenv
CODEX_WEB_LIVE_ENABLED=true
CODEX_WEB_LIVE_API_KEY_FILE=/app/data/secrets/live-api-key
CODEX_WEB_LIVE_ENDPOINT=wss://api.openai.com/v1/live/sessions
CODEX_WEB_LIVE_MODEL=gpt-live-1
CODEX_WEB_LIVE_VOICE=marin
CODEX_WEB_LIVE_PROXY_URL=
```

Mount/create that private file yourself. The optional proxy is operator-selected; a failed configured proxy does not silently fall back to direct access. Recreate app and verify connection feedback, continuous input, playback interruption, a small delegated task and hang-up. Ordinary project calls submit work to their original conversation; Dot calls delegate through its ledger. Hanging up does not cancel tasks. “Stop speaking” affects playback; explicit cancellation affects execution. Codex live steering requires the active model/effort; Antigravity additions wait for the next turn. Disable with `CODEX_WEB_LIVE_ENABLED=false` and recreate app, retaining text history and tasks.

## Remote computers and Google models

Choose “new Remote Worker” in project creation, authorize installation on your own machine and follow [the Worker guide](../remote-worker/README.md). Devices receive independent credentials after enrollment. Test online status, your directory, a harmless task, artifact return, cancellation and reconnect on the real machine. Clearing the enrollment token does not revoke existing device grants; revoke the device explicitly.

Add Google accounts through the chosen node's account-management UI and finish [Antigravity OAuth](https://antigravity.google/docs/install). The implementation uses a supported node-local Antigravity CLI, downloaded only when explicitly selected; the base image does not include it. Standalone [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/) is not automatically this application's node authorization. Models and reasoning levels come from the actual node catalog. Engine switching keeps project files and a bounded message handoff, not the entire native session. Remove/log out the node account to disable that engine.

## Projects, schedules and personal tools

Create your own projects and enable boards, opportunity cards and judgments in feature selection; no topics or records are seeded. Project menus manage skills and recurring schedules. Test one schedule with the intended timezone/model, then confirm persistence after restart. Pause/delete the schedule to stop future runs; stopping one execution is different. One-time waits retain their time/event target and original/new-conversation choice; cancel them in the wait card.

Complete workflows default to `MAX_ACTIVE_WORKFLOWS=-1`, retaining ownership across waits and resumed turns until completion evidence is accepted. Per-conversation serialization, device capacity, disk watermarks, quotas and container limits still apply. Optional `TASK_MEMORY_GUARD=true` requires configured systemd scopes, `CODEX_WEB_TASK_SCOPE_OWNER`, `CODEX_WEB_TENANT_CONTAINER_NAME` and the tenant slice. Missing protection blocks launch; it does not disable safety. Base installations retain their existing Compose and scheduling limits.

Opportunity discovery learns explicit feedback and respects the pending cap. Judgment probabilities must come from the user; semantic outcomes require user confirmation, and absent evidence is unresolved. Archive topics/cancel checks or turn off account features without deleting history. Boards also have the server switch `CWW_PARA_ENABLED=false`.

## Personal memory

Enable it in personal settings only after choosing what messages may go to the extractor. Candidates and audits remain account-scoped with source references; task-specific instructions do not become global preferences.

The API path retains the compatible text/JSON endpoint. Obtain a key from your chosen provider's official platform (for example the [OpenAI quickstart](https://developers.openai.com/api/docs/quickstart)); do not reuse a speech URL or Live WebSocket endpoint. The managed Codex path uses the user's existing authorization and an explicitly chosen model, in a temporary read-only process with tools/project rules disabled. It does not require `PERSONAL_MEMORY_API_KEY`. Configure model/effort for the app supervisor and host service as applicable; Compose forwards them to tenant children. Authorization and quota failures preserve pending work.

Verify a synthetic preference, its sources, the recorded provider/model and later correction/forgetting. Turning off extraction or clearing required configuration leaves previous memory intact; deleting/forgetting is a separate action.

## Storage, upgrade and acceptance

Use [storage lifecycle setup](STORAGE_LIFECYCLE.md) for age keys, drive authorization, maintenance and portable recovery. Catalogue entries are metadata; restore a registered cold file before reading it. Test round trips in isolated data and an empty destination before scheduling archival. Keep encryption identity recovery separate from the cloud backup. Base installs still need consistent local backups.

For every upgrade: preserve edits → back up state and `.env` → record old commit/image → pull main → build → initialize/start → login/text task/file checks → validate retained state → test enabled integrations → restore drill. Never open a migrated database with an incompatible old image; restore the matching state snapshot with the old image. See [build/rollback](BUILD_AND_STORAGE.md) and [this release's migration boundaries](UPGRADE_20261108.md). Synthetic protocol tests do not prove real paid API calls, physical-device audio or Worker upgrades.

Known voice limitation at this source baseline: after network congestion, late older audio may re-enter playback and transcript aggregation may not reflect playback order. Fresh-turn playback suppression/recovery is a separate unfinished change, not included here. Use the explicit stop-playback/hang-up controls and verify real-device behavior; this release does not promise latest-turn-only playback under degraded networks.
