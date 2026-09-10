# Durable retries and device credentials

## Logical jobs and attempts

Model-capacity failures return the same logical Job to `queued`. SQLite's
`job_attempt_state` stores the next attempt time, retry count, first capacity
failure, accepted turn/context revision, and initial output/image fingerprints.
Waiting releases running capacity and survives service restarts. Later jobs in
the same conversation cannot overtake the waiting job. Backoff remains
10/30/60/120/180/240/300 seconds, then five minutes; after one hour it becomes
30 minutes with no attempt limit. Cancellation is terminal.

An `input_accepted` control event records the accepted thread/turn before final
success; it is not a visible chat event. After accepted input or meaningful
progress, retry continues the original thread without resending the original
request, images, or accepted personal context. Internal continuation messages
remain available for audit but are hidden from chat and unread anchors.
Uncertain transport interruption after execution is not automatically replayed.

Process files and the original output baseline survive capacity attempts.
The coordinator cleans runtime only at logical completion/cancellation/failure;
startup and periodic sweeps retry terminal cleanup. Remote Workers preserve
`runs/<jobId>/attempt-state.json` and report retained IDs through heartbeat;
the authenticated server authorizes release using job ownership and state.
Files produced before a capacity failure are included in final registration.

## Device authentication and upgrades

Worker 1.19.3 uses an independent random credential bound to its Worker ID.
The server stores only SHA-256 hashes. One-time installation exchanges a
bootstrap link for a 30-minute enrollment grant, consumes the grant at first
registration, and thereafter uses that token only for the enrolled device.
A fresh grant cannot take over an existing Worker ID.

The host-root administrator's session/CSRF-protected API provides
`POST /api/executors/:executorId/worker/credential/rotate|revoke|recover`
(beneath the configured base path). Rotation atomically saves a replacement
on the device before retiring the old credential. A reconnect with the saved
replacement confirms a lost acknowledgement; pending replacements expire in
10 minutes. Revocation closes that device's channel and clears pending/recovery
grants without affecting other devices. Recovery grants expire in 30 minutes
and are bound to an existing device ID. Transfer recovery values only through
a trusted operator channel, never a log or Git file.

The server's `REMOTE_WORKER_ENROLLMENT_TOKEN` remains an opt-in/bootstrap
configuration value; it is not a normal device connection credential. Clearing
it does not revoke previously issued device credentials: revoke each executor
before retiring the extension. Keep release packages free of credentials.

### Existing installations using shared credentials

Back up the database and protected device configuration before upgrading.
Older shared-token Workers are rejected by default. For an explicitly reviewed
migration, create `worker-credential-migration.json` in the configured data root
with `version: 1`, ISO `createdAt`/`expiresAt` timestamps (at most 24 hours apart),
and `workerIds` containing only your existing device UUIDs. Do not commit it.
The migration relies on the administrator's existing trust in those devices;
a shared secret alone cannot prove physical device identity.

This window permits only heartbeat, release upgrade, and credential pairing.
It cannot dispatch tasks, read files/projects, or manage Codex accounts.
Upgrade the Worker to the matching release, confirm the saved independent
credential reconnects, verify the old shared credential is rejected, then
remove the migration manifest. Any active/retired/revoked credential history
permanently prevents fallback to shared authentication. Maintenance blocks
migration until the new app has passed health checks. Do not roll back to an
old shared-token-only gateway after cutover; prefer forward repair or a
reviewed, device-bound recovery grant.

## Cancellation and account state

Worker initialization, thread start/resume, and turn start each have a
120-second RPC bound. Cancellation also works before a turn ID exists and
rejects late responses. Existing turns receive one interrupt; after five seconds
without termination, only that execution's process tree is stopped (Windows
PID-scoped `taskkill /T /F`, POSIX process group). Execution occupancy is released
after the child exits. Normal completion does not kill unrelated background work.

Account-switch gates inspect only the selected executor. Stale rollout
`task_started` markers are reconciled against terminal lifecycle events even
when a native thread read fails. Real active desktop turns still block account
switching; the Worker does not acquire permission to terminate them.

## Verification

`npm test` covers SQLite restart/retry/cancellation, first-attempt artifacts,
content fidelity and real loopback WebSocket credential lifecycle tests.
`npm run test:worker` covers startup/cancel fault injection, rollout lifecycle,
protocol compatibility and retained directories. Linux tests do not replace
Windows process-tree or desktop account-switch acceptance. Test a harmless task,
cancel, reconnect, rotate, and single-device revoke on your own installation.
