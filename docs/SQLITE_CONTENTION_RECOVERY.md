# SQLite contention and interrupted maintenance recovery

The Web process and storage maintenance share one WAL database per instance. A transient writer lock must not terminate Web or release a complete workflow's ownership. Workflow capacity remains an explicit instance setting; database, credentials and deployment identity remain local to each installation.

## Write boundaries

- The independent fanotify helper must never block on its notification pipe. A parent waiting for SQLite can otherwise stop draining that pipe while the SQLite writer waits for a watched-file permission reply. The helper now drains a nonblocking, bounded 8 MiB output queue through its selector. Exceeding the budget closes fanotify and fails the monitor for conservative gap recovery; durable usage markers are not dropped.

- Worker presence and quota are replaceable telemetry. Each key retains the newest value; short 100 ms SQLite attempts back off, with an eight-attempt / ten-second budget and a 256-key cap. Exhaustion is logged; a later peer report can retry. No user/model/tool instruction is replayed.
- Socket, timer and personal-memory failures are caught at their callback boundary. Terminal Worker recovery continues to use retained results and the existing ordered Job event queue; telemetry failure must not prevent a pending execution promise from settling. HTTP lock failures return retryable 503 where they reach the shared error handler.
- Database construction retries close failed connections, at most ten attempts / sixty seconds. Later application initialization also needs a boundary: workflow configuration, Worker/transfer metadata, account/project setup and voice recovery run as individually idempotent steps with short 100 ms attempts and a shared sixty-second startup budget (at most 64 attempts per step). Only this pre-listener phase may synchronously back off. Cold restores and runtime refresh start after initialization; neither createApp nor an external command is replayed. Correct queue indexes are not rebuilt on each startup. Unrelated errors fail immediately, and an exhausted startup closes its connection.
- Voice lexicon timers catch rejected pumps, record a safe failure and leave durable work available for a later normal cycle. Its housekeeping attempts are short. Node-transfer timer/socket error boundaries retain fenced receipts instead of allowing a failure while recording another failure to escape to the Web process.
- Event JSONL serialization, file writes and fsync run outside the database write transaction. Newly prepared partitions are at most 256 events and 1 MiB, revalidated under the writer before registration/deletion. Oversized legacy partitions are preserved with an explicit blocker; never delete unverified rows or reset sequence watermarks.
- File isolation hashes before reserving the writer and rechecks its inode/size/mtime/ctime fingerprint before rename. Process inspection has a bounded budget and fails closed. Intent records, remote verification and isolation grace remain mandatory.
- Observation gaps close in atomic pages of 128 items. The gap stays blocking until the final page, and the fixed safety deadline survives retries. `last_used_at` is never rewritten to pretend a scan or missing observation was real use.
- Replaying an already applied durable usage marker is read-only. Updating a lease to its existing expiry still reserves SQLite's writer and can amplify journal I/O under load. New use is revalidated and committed with its lease in one short transaction; released leases and original usage/grace timestamps retain their meaning.
- Slow catalog transactions log only operation, PID, acquisition wait and hold duration. No SQL values or credentials belong in diagnostics.

## Recovery without losing ownership

`workflow-cli status --database <this-instance-db> --id <workflow>` is read-only and returns `recovery`: running execution, unverified exit, waiting capacity, pending release acceptance, waiting continuation, or ready to resume. `pending_acceptance` identifies registered releases still owned by an unfinished workflow; it does not certify receipt contents.

On restart, interrupted executions explicitly become blocked pending exit verification. A queued successor is not permission to take over. Operators must verify the exact old local process, cgroup/runtime, remote Worker and independent deployment activity as applicable, then use the revision and unsettled Job IDs from a fresh status:

```
workflow-cli recover --database <this-instance-db> --id <workflow> \
  --revision <observed-revision> --run-ids <comma-separated-observed-job-ids> \
  --executors-stopped true --reason <actual-exit-evidence-summary>
```

Recovery atomically compares revision and run identities, rejects running Jobs, settles only the inspected generation, and retains the slot. It does not complete the task, accept a release, queue/replay a prompt, or modify capacity. Continue existing pending instructions/wakes or supply a concrete recovery instruction based on durable deployment/step receipts. Root-only operator confirmation is an assertion after real checks, not automated proof of process exit.

Supervisors persist workflow identity, exact request/SHA, current phase and remaining acceptance before yielding. Use the local deployment controller and retain ownership through a restart. Never replay an instruction simply because metadata persistence was retried.

## Evidence interpretation

Controlled tests exercise independent writer locks, callback errors, restart recovery and usage-marker idempotency. These tests do not identify an operator's historical production writer. Before declaring a repair complete, restore the intended background units, verify observation-gap protection, run a real model/tool task and observe normal maintenance cycles without restart growth. Temporary suspension alone is not a permanent repair.
