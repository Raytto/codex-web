# Optional cold-storage maintenance

Cold storage remains disabled until the operator supplies its provider CLI,
Drive ID, `age` recipient/identity, protected provider login and a scheduler.
Use the `CODEX_WEB_COLD_STORAGE_*` names in `.env.example`. Set
`CODEX_WEB_STATE_ROOT` to the actual application state directory; its `data/`
and `tenants/` must be the same state used by the application. Never upload keys,
provider credentials, runtime snapshots, or private archive records to Git.

Normal conversations become candidates after 15 inactive days; explicitly
archived conversations are considered in the next scan. Running/queued jobs,
drafts, pending prompts, armed wake plans, deletion/move states, remote execution
and shared thread/file references retain their safety gates. Messages and
metadata stay local. Eligible files are encrypted with `age`, uploaded, and
downloaded for byte-count/SHA-256 verification before local isolation. Local
isolated copies have a seven-day grace period; purge does not delete remote
ciphertext. Retention settings do not enable cloud transfer by themselves.

From the configured checkout/state environment, after `npm run build`:

```bash
node dist-server/server/conversation-cold-storage-cli.js dry-run --json
node dist-server/server/conversation-cold-storage-cli.js reader-dry-run --json
node dist-server/server/conversation-cold-storage-cli.js archive --limit 1
node dist-server/server/conversation-cold-storage-cli.js archive --all
node dist-server/server/conversation-cold-storage-cli.js maintain
```

`--all` selects one finite snapshot of every eligible candidate and cannot be
combined with `--limit`. Manual archive defaults to one item; positive limits
are no longer capped at 100. `maintain` sequentially archives all eligible voice
recordings, reader resources and conversations, then runs all three seven-day
isolation purges. Failed items and stages do not block later work. The final
exit status is nonzero if any stage failed; failed items are reconsidered at
the next run, never retried indefinitely within the same scan.

Provider listing, directory creation and upload use at most three attempts
with one- and two-second delays. Listings must identify the requested root.
Before retrying an upload, exact ciphertext-name lookup avoids a duplicate;
remote hash/size verification remains mandatory even after a successful upload.

An operator may schedule `maintain` every 15 minutes using a non-overlapping
oneshot service, with an unlimited start timeout for long batches. Run it under
the least-privileged identity that can access the configured state and keys;
no system service is installed by the application. Stop the scheduler and clear
provider settings to disable future transfers. A long batch with measurable
progress is running, not failed. Monitor stage failures, stalled progress and
missed intervals, and rehearse restoration with non-sensitive fixtures before
allowing local purge. See [deployment profiles](DEPLOYMENT_OPTIONS.md).

## Expired public-share leftovers

Only currently enabled, unexpired public documents and their approved images are retained locally. After expiry or explicit closure they become ordinary cold-storage candidates, subject to the existing age, activity, queue, draft and ownership gates. No new timer is installed; operators must configure the optional maintenance schedule themselves.

An already cold conversation may still have local files retained by a share. Archive processing restores and verifies the previous generation under the same conversation lock before combining it with those leftovers. It advances the generation only together with the newly verified manifest. Upload or verification failures retain the previous cloud generation and local material; successful isolation starts a fresh seven-day grace period. Sharing/renewal is rejected during an in-progress archive or restore. See [public-share expiry](PUBLIC_FILE_SHARING.md).
