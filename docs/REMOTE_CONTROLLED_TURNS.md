# Remote controlled turn ownership

The server owns the boundary between a user message and execution context. The
Worker continues to receive full workflow/recovery/personal/wait instructions.
These are never removed from model input or native rollout files.

- Before dispatch, store a SHA-256 of the full execution input after normalizing
  Worker attachment transport wrappers, not another copy of personal context.
  The fingerprint retains control blocks so an identical plain desktop send
  cannot claim an in-flight wrapped execution. `remote-execution-prompt.ts` is the shared comparison
  policy for dispatch, import, legacy repair and capacity/routing continuations.
- Persist `(executor, thread, turn) -> Job` on the existing `input_accepted` event.
  This survives terminal cleanup of `job_attempt_state` and supports multiple
  attempts of the same Job. No Worker protocol/version change is required.
- Resolve ownership before importing any assistant items. If an observer wins the
  race, accepted-event reconciliation repairs the existing mapping transactionally.
- Text fallback is one-to-one, constrained to the Job's time window. Completed
  bare-text lookalikes without dispatch/accepted evidence are not sufficient.
  Unknown or incomplete wrappers are not stripped from visible desktop text.
- A turn may contain multiple user steering items. Only its first input claims the
  original Job message. Acknowledged steers persist their own canonical message
  identity; legacy steering envelopes require a unique match within the Job window.
  Delta snapshots do not redefine the first input: existing primary/steer identities
  and raw execution-envelope evidence determine ownership. A steer-only delta can
  arrive before its acknowledgement or before the original input's snapshot.
  Raw refresh also corrects a prior steer-to-original alias without overwriting
  either canonical message. Item identity includes its turn, including fallback IDs.
  Later actual user inputs, even identical ones, are retained.
- Preserve canonical message content, quotes, uploads and final replies. Import
  mapping refresh never overwrites a Job's original message. Controlled stage
  feedback is shown through Job events, not duplicate observer bubbles.

## Repair and recovery

Startup, thread claim and snapshot refresh use the same transactional reconciliation.
Ambiguous candidates, attachment-bearing copies and messages belonging to another
Job are left intact. Proven observer copies are rebound and marked `is_internal=1`,
not deleted. Readers, search and memory extraction exclude these audit rows.

`remote_import_repairs` records the reason and previous message, mapping or event
state in the same transaction, including unread anchors. `quarantine_observer_copy` contains the full old
message row; `claim_user:*` and `suppress_controlled_assistant` contain the mapping
rowid and old message ID; `suppress_controlled_activity` contains the original event
payload; `refresh_steer_mapping` stores the full mapping key and previous message ID;
`repair_unread_anchor` contains the old navigation anchor. These are private business data, never public logs or report attachments.

For a scoped recovery, first make a verified SQLite backup and stop only the
relevant write path using the normal maintenance mechanism. Review the exact audit
IDs and current rows; restore their fields in reverse audit order in one transaction
only if the rows still equal the expected repair result. Do not replace the active
business database with an old snapshot. Reverting application code alone does not
undo a repair. Native rollout remains an independent unmodified source.

Regression tests include actual workflow instructions, wrapper order, recovery,
attachments/quotes, opaque future wrappers via dispatch/accepted identity, live and
completed imports, migration/reopen, duplicate refresh, independent desktop turns,
identical real Jobs, same-turn steering and attachment-protected ambiguous copies.
