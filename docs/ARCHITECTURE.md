# Architecture

Codex Web is a single-owner self-hosted application. Express serves the API and built React assets. SQLite stores users, sessions, conversations, messages, job events, settings, and server-side queue state.

The web process runs as UID 10001. A local supervisor launches Codex work as UID 11001 with a tenant-specific `HOME`, `CODEX_HOME`, conversation workspace, and library. The worker has no access to the application database. Files shared between the web process and worker use explicit filesystem ACLs.

The default durable layout keeps each tenant's conversation files below `tenants/<user-id>/conversations/`; host/root and remote-worker paths are separate, explicitly configured roots.

Each conversation has an `uploads`, `outputs`, and temporary runtime area. Generated deliverables, including thread-scoped images emitted by Codex, are copied to durable application storage. Large browser uploads use resumable TUS records and partial files inside the owning tenant; completed image cards request bounded WebP thumbnails instead of transferring originals. Archiving only hides an idle conversation and keeps its complete history and files available for restoration. Deleting is separate: it cancels queued/running jobs, removes the workspace and deliverables, and soft-deletes the database row so messages and events remain available for administrative diagnosis.

Finished Markdown and HTML deliverables remain private by default. An authenticated owner may enable a stable public reader URL. The public API exposes only a minimal file snapshot and an allowlist of same-message output images; it rejects remote, absolute, or traversing references, rewrites approved assets to scoped endpoints, records deduplicated access events in SQLite, and immediately stops serving content when sharing is disabled.

The reader keeps HTML/Markdown in a vertical flow and uses bounded nearby-page rendering for PDF/EPUB. Browser `Range` objects are treated as transient view state: selections and annotations also store validated document-text offsets, so page turns, text-layer remounts, and Safari/WebKit layout changes can recreate the same passage without trusting stale DOM nodes or geometry.

The `html-report` skill is a managed platform asset, alongside the local spreadsheet skill. Its source lives under `skills/html-report/` and includes the instructions, style guide, static template, and validator. `ensureTenant` copies the complete directory into each new user's `CODEX_HOME/skills/`; existing tenants receive the same refresh on the next initialization. The skill does not grant extra filesystem or network access: it only guides the low-privilege worker to produce a static, self-contained HTML deliverable.

Queued prompts and their attachments are stored by the server. The browser is only a view of that state. A queued prompt can be reordered, edited, deleted, or converted into a live steering instruction for the currently running Codex turn. Running and queued states are derived independently so an idle-but-queued conversation is not presented as actively executing.

On graceful shutdown, dispatch stops first and the process waits for active Codex executions to finish; queued work remains durable. If the process disappears while a job is running, startup marks that job interrupted and appends a visible message/event. It does not automatically retry a possibly side-effecting turn.

Whole-turn retries are also side-effect aware. Transient connection failures are retried only before the server observes that execution started. A model-capacity rejection has a narrower exception: it may retry indefinitely only when the attempt produced no meaningful command, file, tool, or stage progress. Capacity delays ramp from seconds to five minutes, then switch to thirty minutes after one hour; every error, wait, and retry start is persisted in the live journal and remains cancellable by the user.

Durable waits store their target conversation and model/reasoning selection in SQLite. A fresh-conversation wait creates its target while the plan is armed, so the browser can select it immediately and service restarts cannot create duplicate targets.

Conversation detail checks the current Codex rollout file size without loading the file. The UI warns at 500 MiB and points the user toward archiving the completed conversation and starting a fresh task.

Optional voice transcription receives a bounded context envelope. The budget is shared across the current draft, attachment names, small heads of text attachments, recent messages, technical terms, and at most a few validated images. Before upload, the browser stores the complete recording in an account/conversation-scoped IndexedDB draft for 24 hours. A client recording UUID and a server-side receipt keyed by that UUID plus audio size/hash make retries safe when the original response is lost; processing receipts recover to a retryable state after restart. Temporary audio remains HMAC-signed and short-lived.

The repository includes optional host-root execution, project routing, Remote Worker, account-management, personal-context, and cold-storage modules. They are fail-closed: without explicit sockets, tokens, provider endpoints, or key files they remain inert. The default Compose profile still excludes Docker socket access, host filesystem mounts, private network routing, and pre-provisioned user data.

## Durable attempt and device state

`job_attempt_state` separates logical Job ownership from individual execution
attempts and persists retry eligibility, accepted context and original artifact
baselines. Device enrollment and pending rotation use separate hash-only tables;
server-authorized runtime release and rollout lifecycle reconciliation travel
on the authenticated outbound Worker channel. See the invariants in
[durable retries and device credentials](JOB_RETRY_AND_DEVICE_CREDENTIALS.md).
Reader/chat selections retain native DOM identity and restored text anchors;
Agent streams preserve literal commands as described in
[content fidelity](AGENT_CONTENT_FIDELITY.md).


## Project boards, task handoffs and reader updates

The [PARA module](features/PARA_BOARD.md) keeps boards, areas, projects, resource versions and conversation relations in additive SQLite tables. Tenant-owned resource files are independent of the source conversation. Triggers capture a primary-project snapshot for Jobs and pending inputs; queue promotion carries the accepted snapshot forward. Reference associations do not inject context or change executor authorization. Revision checks and idempotency keys guard writes, while generation checks discard stale browser reads.

[Recovery checkpoints](TASK_RECOVERY.md) are captured before terminal cleanup and retrieved only across the same conversation/thread with valid job ordering. Successful completion closes prior recovery context. Writer shutdown forms an exit barrier before a new task takes ownership. Raw answer stream events remain durable but no longer consume the visible progress snapshot window.

Worker 1.19.7 carries sanitized reset-credit summaries and optional single-thread rollout byte counts. Reads are bounded and coalesced; account redemption remains on the selected machine with durable receipts. The reader adds paged/continuous PDF and EPUB modes without removing bounded rendering, and memoizes HTML/Markdown document insertion so UI updates preserve native ranges.
