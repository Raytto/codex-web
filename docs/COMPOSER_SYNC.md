# Composer submission and draft reconciliation

Successful sends clear the submitted text and quote. Failed sends keep them for
retry. An unrelated ordinary draft remains saved while a queued prompt is edited
and is restored when that edit completes or is cancelled. File-only submissions
retain their attachments in instruction mode.

Conversation GET responses can arrive after a send, edit, cancellation or clear.
Every composer hydration path, including initial draft loading and queued-edit
recovery, must check the conversation's mutation generation. Reads delivered
during a mutation are ignored for the composer; ending the mutation invalidates
reads started before or during it, even on failure. Pending queue metadata uses
the same check. Background draft saves are suspended across these mutations.
Clearing text also updates the synchronous refs used by background saves.

Voice recording context also carries the pending-prompt ID, including local
audio recovery after a reload. Transcribing an edit must never save its text in
the ordinary composer draft. Record-and-send uses the same queued-edit submit
handler as the Send button, so success clears the submitted input and restores
only a genuinely independent draft. Transcription receipts are scoped to both
the conversation and pending edit; an already submitted receipt must not be
attached to the restored ordinary draft. If recognition finishes after leaving
that edit, retain the audio for retry in its original edit instead of writing or
sending to another composer.

## Browser regression

The runner uses an isolated real HTTP API and SQLite database with automatic job
execution disabled. It creates and deletes its own conversations. The shared
scenario additionally arms a future wake so it can be used for authenticated
production acceptance without starting a model job.

After building, use an installed Playwright module and browser:

```sh
npm run build
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/chromium \
TEST_RUNTIME=/path/to/private/runtime \
node scripts/check-composer-race.mjs
```

The desktop and mobile viewport checks delay real GET responses until after
successful submissions, then verify text clearing, queue state, subsequent
typing, failure/retry, unrelated draft restoration, edit cancellation, reload,
and attachment-only instruction mode. `--expect-bug` verifies that the old
application bundle reproduces queued-edit text restoration. The exported
`run` in `scripts/composer-race-scenario.mjs` accepts an authenticated browser
context for the same production checks. This does not emulate an iOS keyboard.

`scripts/check-composer-voice-edit.mjs` additionally exercises the microphone
callbacks with synthetic audio, real draft/queue/transcription HTTP routes and
an isolated database. Only its local speech provider returns fixed text. Its
`--expect-bug` mode reproduces the former 409 on record-and-send followed by a
successful manual retry that restores a duplicate ordinary draft.

`scripts/composer-voice-edit-scenario.mjs` is reusable with an authenticated
production context and a synthetic speech WAV (`audioBase64`). It uses the real
production speech endpoint, respects its account rate limit and covers direct
send, stop-to-text, independent drafts, submission failure/retry, a late result
after cancellation, audio recovery after reload and ordinary voice sending.
Production callers must clean up the fixture's transcription/audio receipts as
well as its dedicated conversations. Synthetic microphone input does not verify
physical microphone permissions or iOS Safari recording behavior.

## Submission liveness

The composer submission lock covers writes, not subsequent detail/sidebar reads.
After the write confirms, normal and voice sends release their mutation guard and
start reconciliation in the background. A late or stalled GET must not prevent
new typing or queued actions. Voice sends also release the lock if the user
switched conversations while the request was in flight.

Steering has its own in-flight guard: queue actions cannot double-submit, while
the composer stays editable. An accepted queued item is removed immediately and
its mutation generation advances before refreshing the conversation.

Composer writes (draft save/delete, create/send, queued edit/restore/delete/steer)
have a 45-second deadline spanning both response headers and JSON body. Multipart
sends with new files retain a 10-minute upload budget. Abort releases the UI and
preserves input; writes are never automatically retried because a timeout cannot
prove whether the server accepted the mutation. The notice asks the user to check
messages and the queue before retrying. Independent upload/ASR controls are unchanged.


`scripts/check-composer-submission.mjs` reuses an isolated real API and tests desktop
and mobile viewports with a stalled post-send GET, editable input during steering,
a rejected steering request, and an aborted draft write followed by one retry.
`--expect-bug` reproduces the former shared lock. The shared
`scripts/composer-submission-scenario.mjs` is safe for production acceptance using
its own wake-held conversations. Its failure/stall cases inject network behavior;
it does not claim to verify model-side steering delivery. Request unit tests also
cover stalls while reading the response body and caller cancellation.
