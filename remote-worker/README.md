# Codex Web Remote Worker

Runs on a trusted Windows computer and makes that computer's local Codex available only to the `owner` administrator in Codex Web. It opens one outbound WSS connection, exposes directory browsing using the current Windows user's permissions, and starts one local `codex app-server` process per active task.

## Install

Requires Node.js 22.13 or later and a logged-in local Codex CLI.

```powershell
.\scripts\install.ps1 -EnrollmentToken '<server token>' -MachineName 'worker-host' -ServerHttpUrl 'https://your-codex-web.example'
```

Runtime state, credentials and logs are stored in `%LOCALAPPDATA%\CodexWebWorker`; they are never stored in Git. The scheduled task starts after the current Windows user logs on so it shares that user's Codex Home and ChatGPT App session history.

The machine name is supplied during registration and becomes the prefix used by Codex Web, for example `[worker-host]work`. No folder allowlist is required: the project picker exposes every drive and directory accessible to the Windows account running the Worker.

Codex Web administrators can instead use the Codex Web project dialog's **＋新建远程 Worker** entry. The generated one-time installer supports Windows and macOS, downloads the matching release package, prepares Node.js and the Worker-local Codex runtime, and registers automatic user-login startup. The installer asks only for the machine display name; the server enrollment credential is exchanged once and is not embedded in the release archive.

## Update and diagnostics

The initial installation may use a sparse Git checkout containing only this directory. For an existing checkout, install the package updater once with:

```powershell
.\scripts\install-updater.ps1
.\scripts\status.ps1
```

This installs stable launchers and the independent `Codex Web Remote Worker
Update` task without changing Worker ID, machine name, token or Codex Home. New
source-based installations receive it automatically. After this bootstrap, Codex
Agent can queue **升级 Worker** from the server: it closes that node's dispatch
gate, waits for a fresh zero-job heartbeat, then downloads an authenticated,
versioned ZIP. The independent task verifies the pinned size, SHA-256, version,
tag and commit, atomically switches release directories, and requires the new
Worker to authenticate within 90 seconds. Failure automatically restores and
restarts the previous package. Node updates do not use Git, `npm ci`, a compiler
or the repository working tree.
The release and recovery contract is covered by this section and the scripts
under `remote-worker/scripts/`; the repository intentionally does not install a
separate update service on the server. Keep the Worker package and its local
state outside the Git working tree.

For an existing installation, keep the Worker checkout in an operator-selected
local directory (the examples use `C:\codex-web-worker`) and choose a stable
machine name for the scheduled task. `update.ps1` waits for the previous task
instance to stop before updating and uses a `finally` guard to start it again
even when the pull, dependency install, or tests fail. The installer applies
the same guard when replacing the scheduled task and explicitly restarts the
existing instance so a changed machine name or executable path takes effect.
The Worker lock contains its process ID and automatically recovers a stale lock
left by a forced task stop or Windows restart.

The installer also adds a one-minute recovery trigger to the same scheduled
task. `MultipleInstances=IgnoreNew` makes these checks harmless while the Worker
is running, while an externally stopped instance starts again within one minute.
Existing installations keep their registered machine name during maintenance;
use `install.ps1 -RenameMachine -MachineName <name>` only for an intentional
rename. The task is allowed to run on battery power and starts when a missed
trigger becomes available.

The Worker opens no inbound port. Its only network paths are the outbound WSS control channel and task-scoped HTTPS file transfers. It starts a separate local app-server process for each active task (up to the configured capacity; `0` means unlimited), and new work remains queued on the server while the machine is offline. Worker 1.14.0 can persist a capacity change sent through the authenticated server control channel and apply it immediately without restarting or interrupting active tasks.

Worker 1.15.0 streams task attachments and results with `Authorization: Bearer`; it never loads a whole transfer into `arrayBuffer`/`readFileSync`. Every transfer has a declared length, byte count and SHA-256 check, and every run uses a strict UUID-owned directory that is swept only after the 24-hour protection window when absent from `activeJobs`. Supplemental steer attachments are downloaded into the same run and sent to the existing turn, never a replayed turn. Automatic result collection resolves real paths beneath the project root, caps the manifest at 20 files/100 MiB, and reports every bounded omission reason in the final response.

Worker 1.15.1 reads the complete Codex rate-limit snapshot for quota display, prefers the explicit general `codex` bucket, and reports the tightest primary/secondary window. Sparse rate-limit notifications trigger a full refresh instead of being mistaken for a complete 100%-remaining snapshot.

Worker 1.15.2 keeps externally launched Codex turns live when a separate observer sees a premature persisted completion but the turn still has an in-progress item or explicit commentary without a final answer. Commentary stays in the real-time activity card until a final answer is persisted, preventing false unread replies and missing running indicators.

Worker 1.15.3 snapshots only the active Codex thread's `%CODEX_HOME%/generated_images/<thread-id>` directory before and after a controlled turn. When imagegen writes a new image outside the project tree and the turn did not already publish an explicit project image, the Worker uploads that new thread-owned image through the normal bounded result channel. Project realpath containment remains unchanged; other threads and pre-existing generated images are never collected.

Worker 1.15.4 treats a persisted `final_answer` on a completed Codex turn as terminal even when the rollout retains a stale in-progress item or omits `completedAt`. Completed turns without a final answer continue to stay live while commentary or in-progress work remains, preserving background-process observation without leaving finished legacy threads permanently running.

Worker 1.16.1 adds the Agent-only `newConversation` target to the persistent-wait dynamic tool and `--new-conversation true` to its injected CLI. The server creates the target only when the wait wins its trigger race, so the old remote rollout becomes history and the delayed prompt starts a fresh thread in the same project.

Worker 1.16.2 adds account-scoped Skill bundles. A capable Worker validates and synchronizes the current Codex Web account's enabled Skills into its Codex home before starting each run, while keeping unrelated accounts and existing platform Skills isolated.

Worker 1.16.3 recognizes the phase-less assistant reply used by legacy Codex rollouts as terminal on a completed turn. A stale `inProgress` command can no longer leave those already-finished desktop tasks spinning forever; explicit commentary and turns without an assistant reply remain live.

Worker 1.16.4 stops an older completed commentary-only turn from keeping the whole thread running after a later turn has produced a terminal assistant reply. Commentary on the newest unsuperseded turn remains live, so active desktop work still keeps its running indicator.

Worker 1.16.5 advertises a dedicated conversation-title capability. The server can ask the same machine that owns a project to run a schema-constrained, ephemeral `gpt-5.6-luna`/low Codex naming turn. It creates no Codex Web Job and no durable Codex thread; only the server's separate title audit row persists.

Worker 1.17.1 uses deterministic version packages for managed updates. The
server build is the compile/test boundary; Windows nodes only download, verify,
atomically activate and health-check the prepared runtime. Existing nodes need
one package-updater bootstrap, after which upgrades remain fully unattended from
Codex Web.

Worker 1.17.2 validates every candidate PowerShell script with the node's native
Windows PowerShell 5.1 parser before stopping the old Worker. The two scheduled
tasks use immutable launcher supervisors whose hashes are recorded locally;
the update launcher always executes a separate last-known-good updater, and
ordinary releases cannot replace those files or task actions. A supervisor
protocol change therefore requires an explicit bootstrap, while normal package
updates retain the same last-known-good launchers across activation and rollback.
If Task Scheduler leaves the old Node child alive, the updater terminates it only
after the lock PID, Node executable, active main script, and config path all match.
Repository CI separately requires the full script set to parse under both Windows
PowerShell 5.1 and PowerShell 7.

Both WSS directions now have runtime schemas and independent byte/complexity limits. Offline outbound updates persist atomically in a 500-item/8-MiB outbox; ephemeral status is coalesced and thread items merge by stable IDs before reconnect replay. The outbox excludes the enrollment hello/token and quarantines invalid state. It is restart-recoverable but not an exactly-once transport, so stable job/request/thread/item IDs remain the idempotency boundary.

The server contains a hash-only per-device credential lifecycle schema for a future rotation protocol. Worker 1.15 still authenticates the WSS hello with the existing shared enrollment token. Do not remove or rotate that shared value as if device credentials were already active; the later cutover requires one-time bootstrap, overlapping old/new credentials, acknowledgement, revocation controls and an observed compatibility window.

Worker 1.13.1 advertises optional persistent-wait automation. For each Codex Web-controlled turn, the server may supply a job-scoped token and the Worker injects the bundled `wait-cli.js` path into that turn's tool-shell environment. Codex can register a one-shot time wait or an event/deadline wait; an external supervisor reports through a single-plan HTTPS receipt. No inbound Worker port is added, and a wake always re-enters the server's normal conversation queue. See `docs/WAKE_AUTOMATION.md` in the repository root.

The long-lived Codex observer also forwards account rate-limit changes and performs a read-only reconciliation every 30 seconds. Quota is stored per executor, so desktop Codex activity refreshes the COM/home package percentage without starting or interrupting a Codex Web job.

Remote conversations stay in the normal `%USERPROFILE%\.codex` store. Codex Web
uses Codex app-server `thread/name/set` and `thread/archive` so task titles and
archive state are reflected by the local ChatGPT/Codex App.

Protocol v5 adds behavior-level automatic visibility from the local
ChatGPT/Codex App to Codex Web. The server subscribes the Worker only to active
project IDs and exact working directories. The Worker watches the current
user's Codex session store for persistence changes, debounces them for 1.2
seconds, then uses a long-lived local app-server connection to read the affected
thread. It publishes completed commands, file changes, searches, tool calls,
plan updates and completed turn messages; partial agent-message tokens are not
published. Running threads get a five-second fallback check, projects get a
30-second reconciliation, and each Worker start performs an idempotent full
checkpoint of up to 500 threads per project. A disconnect coalesces deltas
without dropping earlier behavior, and reconnect performs another full
checkpoint.

Threads started by Codex Web are already stored in the same Codex Home and become
visible after the local App reloads its index. The project refresh action
remains as a manual full-scan fallback using `thread/list` and `thread/read`.
Neither path edits the Codex database directly. Automatic sync transmits
structured thread metadata, text messages and behavior metadata only; it does
not transmit file contents or images.

The steady-state cost is one additional local app-server process, one recursive
filesystem watcher, a read of each active thread at most about once every five
seconds as a fallback, and one latest-page project reconciliation every 30
seconds. Session writes may trigger more frequent local reads, but unchanged
token-only snapshots are discarded before WSS transmission. The in-memory
checkpoint keeps item IDs and SHA-256 fingerprints rather than duplicate
message bodies. Startup and reconnect are the expensive path: up to 500 threads
per active project are read serially, split into payloads below 8 MiB, and sent
idempotently. Network and server storage grow with text messages and behavior
metadata, not with project files or images.

Protocol v4 also supports explicit retrieval of an existing local file. The
UI keeps the inline file link and renders a standard result-shaped card below
the message. When the administrator clicks either link, card or download icon,
the server sends `file_fetch` over
the existing WSS connection with a one-time transfer token. Worker 1.8.0
resolves absolute paths anywhere the current Worker account can read; relative
paths are resolved from the project root and may traverse to another readable
location. It still rejects directories, Windows device paths and files over
100 MiB, then uploads the selected bytes over HTTPS. No local file is uploaded
merely because a task or project is refreshed.

Protocol v4 also publishes the target machine's own `model/list` result. Codex
Agent caches that per executor and validates each task against the project's
target machine, so a model or reasoning level shown for worker-host is one worker-host's
Codex actually advertised. The Worker refreshes the catalog at startup and
every 12 hours; the administrator can force a refresh from the project dialog.

Version discovery is separate from installation. The Worker checks the npm
`latest` tag at most every 12 hours unless an administrator explicitly clicks
Check updates. Upgrade is allowed only while both the server and Worker report
zero active jobs. The candidate is installed beneath
`%LOCALAPPDATA%\CodexWebWorker\codex-runtime\releases`, verified with
`codex --version` and a live `model/list`, then selected through an atomic
`current.json` pointer. A failed verification restores the previous pointer.
The managed CLI deliberately continues to use the current Windows user's
normal `%USERPROFILE%\.codex`, preserving login and ChatGPT/Codex App task
history while avoiding replacement of the App's or global CLI's files.

Worker 1.3.1 restarts after a successful managed-runtime switch through the
scheduled task's PowerShell wrapper: the Node process exits with the private
restart code `75`, the wrapper waits three seconds, then launches it again in
the same task instance. This avoids depending on a detached child process,
which Windows Task Scheduler may terminate together with the old task job.
