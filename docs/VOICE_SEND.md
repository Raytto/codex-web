# Voice messages accepted before transcription

The main task composer sends a recording immediately when its Send button is
pressed. Recording audio, typed text, quote and already-uploaded draft attachments
are durably accepted before ASR runs. Only after HTTP 202 does the composer clear;
the pending-task queue shows “正在进行语音识别…”. Uploading still requires the
page and connection. A failed upload keeps the existing IndexedDB recording for retry.

`POST /conversations/:id/voice-messages` accepts one audio file and consumes that
conversation's server draft attachments in the same SQLite transaction as its
pending prompt and `voice_submissions` receipt. Identity, audio SHA and input
fingerprint prevent duplicate sends after lost responses. A reused recording ID
with different audio/text is rejected. Files still uploading cannot be accepted.
The latest text at Send is captured, including edits made during recording.

`VoiceSubmissionService` processes persisted audio independently of the request.
On startup it resumes interrupted recognition. Provider failures remain visible
and retain audio/files for an explicit “重试识别”; recognition does not silently
retry the whole Codex task. Deleting the pending item cancels its submission and
removes its unregistered audio; late ASR results cannot recreate the task.

The existing queue ordering, model choice, quotes, files, prior voice references
and accepted project context are preserved. The unrecognized item and later items
in its queue cannot dispatch. Completion atomically stores the transcript and
releases the pending item to the usual queue; registered audio follows existing
voice recording retention. SSE updates the queue, with a bounded 3-second fallback
refresh while recognition is pending. Closing or switching the page after
acceptance does not stop recognition or later execution.

Migration `2026101401` is additive. Unrecognized prompts use the pre-existing
non-dispatchable `editing` database state and are distinguished by their receipt;
the UI presents them only in the pending-task queue. This also prevents an older
binary from automatically running incomplete text after rollback. Upgrade again
to resume recognition; do not manually convert these rows to queued. Files live
in the existing protected `voice-recordings` namespace, not a temporary ASR cache.

Stopping a recording for proofreading still transcribes into the input. Editing
an existing pending task, reader dialogs, search and other voice fields retain
their existing proofreading workflow. The ASR provider/model and microphone
permissions are unchanged. Browser automation uses a synthetic microphone fixture;
real iOS audio capture and background-tab upload suspension still need device tests.

## One queue item until execution

An accepted recording appears only in the pending-task queue. Recognition shows
its spinner/status there; editing and immediate insertion remain disabled until
recognition completes. The result replaces the text of the same queue item, which
can then be edited normally. A failure shows its error and explicit retry action
in that item, preserving the recording and attachments. Retrying updates the same
item rather than creating another task.

Refreshing the page preserves the pending status or recognized text without a
chat placeholder. Only when the scheduler materializes the pending prompt for
execution does it become one ordinary user message in the chat. Queue and chat
must not both display the same pending recording. This presentation update adds
no migration, provider setting, dependency or Worker protocol change.

After building, run `node tests/browser/voice-queue.mjs` with an installed
Playwright Chromium. The runner accepts the same optional environment variables
as the composer regression below. It uses an isolated app/database, public
username/password login and `/codex-web` routing. It covers recognizing and
completed states across refresh, editing, mobile failure/retry, deletion, and one
chat message after the real scheduler enters the running state. It also checks
that pumping the queue again cannot dispatch the same item twice. Transcription,
microphone input and the model runner are controlled fixtures: this is not real
ASR, cloud model execution or physical-device microphone acceptance.

## Concurrent composers and latency diagnostics

Client composer text, quotes, files, uploads, pending edits and send/steer locks are
scoped to their conversation (and to the project for an uncreated conversation).
Switching tasks restores that task's own draft; an empty task starts empty. Active
voice sessions remain mounted offscreen until processing settles, so another task
can record while the first uploads or transcribes. Background callbacks address
their original task. Draft save queues are also independent per conversation.

A blue upload arrow inside a spinner is shown in the sending task's sidebar row.
Client upload/submission takes precedence over execution, cold-storage and waiting
icons; after acceptance the normal server state becomes visible again. Paused or
failed file transfers do not pretend to be actively uploading. The transfer state
is local to the browser doing the upload, and does not imply the server already
has the bytes. Leaving the entire page before acknowledgement can interrupt it.

Structured `[voice-timing]` events report multipart receipt/acceptance, audio
preparation, optional image context, each provider attempt/headers, completion,
and the provider's signed audio download. Original and prepared audio IDs are
linked without logging transcript, prompt, signed query, cookies or credentials.
Nginx's dedicated `codex-web-voice.log` adds request length, total duration and
upstream timing with query strings omitted. The same request ID joins proxy/app
records. Proxy total minus upstream time is only an approximate client/proxy
phase; it is not a direct measurement of mobile network throughput.

Run `node tests/browser/composer-isolation.mjs` after build with an installed
Playwright Chromium (optional `PLAYWRIGHT_MODULE_PATH`, `PLAYWRIGHT_BROWSERS_PATH`,
`CWW_BROWSER_TEST_OUTPUT`). The isolated server uses controlled transcription and
held requests to cover parallel text, voice and files, stale completion, retry,
proofreading, sidebar priority and mobile layout. Production ASR/model validation
is a separate authenticated acceptance step. Real iOS microphone behavior remains
a device-test boundary.
