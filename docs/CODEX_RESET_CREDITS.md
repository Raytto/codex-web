# Codex account reset credits

The Codex account-management dialog shows each machine-local account's available reset-credit count and earliest expiration. This is distinct from included-usage percentages and their quota reset times. The adjacent “使用重置卡” button explicitly redeems one credit after confirmation; refreshing alone never consumes a reset.

`account/rateLimits/read` returns the account-level `rateLimitResetCredits` summary. `availableCount` is authoritative; detail rows can be missing or capped. The shared parser in `remote-worker/src/codex-reset-credits.ts` accepts only unique available `codexRateLimits` details with valid future expiration timestamps or explicit null (non-expiring). Only complete detail coverage can produce “最早到期” / “无到期限制”; partial coverage is labeled “已知最早到期”, and missing details are labeled unknown. A reported zero is distinct from unavailable data.

Both task quota pipelines carry the sanitized summary, even without an ordinary quota window. Migration `2026092302` adds `codex_reset_credit_snapshots`; executor and local account UUID identify the snapshot. Failed/unsupported reads retain the last successful value and its original timestamp, with a separate attempt state/time. Out-of-order results cannot overwrite newer observations. Credit IDs and credentials are never included in this stored/displayed payload.

Opening the dialog loads saved data, then posts to the host-administrator-only, CSRF-protected `/api/codex-accounts/refresh-usage`. Visible dialogs refresh every 60 seconds and on focus; there is also a manual button. Each machine deduplicates in-flight account reads and caches results for 30 seconds. Queries use temporary Codex Homes, bounded lifetimes, verified account identity, and no model turns. Account switching is not needed. Process trees and temporary credentials are cleaned up; abandoned usage directories are cleaned on the next manager startup.

On the server, the existing shared credential lock covers source selection, the read and atomic write-back of any rotated authentication. Non-active accounts use their own saved credentials, not the global authority file. On remote machines, independent queries use access-only copies, avoiding competing with desktop/observer refresh-token rotation. If a saved remote access token has expired, the UI shows “登录状态待更新” (or a dated older snapshot); the existing normal Codex login/active-account lifecycle must refresh that credential. Credentials stay on the selected machine.

Worker 1.19.4 adds this payload and explicit refresh support; older workers remain protocol-compatible and may display unknown data. The observer includes reset-credit updates in its notification comparison. The installed Codex itself must support this upstream field; lack of it is not treated as zero.

Tests cover complete/capped/malformed details, duplicates, expiry, non-expiring and zero cases, persistence/reopen, account/machine isolation, stale data, HTTP/CSRF/Worker transport, no-switch credential refresh, process cleanup and rendered card text.

Official protocol: https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt

Worker 1.19.5 fixes the inbound strict validator for `codex_accounts.refreshUsage` (optional boolean, list action only). Ordinary lists omit the field for older Workers. The Worker outbound validator also accepts reset-only quota events with `remainingPercent: null`, and validates reset summaries. The HTTP/WebSocket integration fixture uses the actual Worker request parser; a mock reply alone does not prove transport compatibility. The dialog preserves the initial list error instead of immediately overwriting it with a usage-refresh error.


## Redeeming the earliest expiring credit (Worker 1.19.6)

The host administrator can use the button beside each account's reset summary on the configured host or a paired Remote Worker. A confirmation names the account. The request is CSRF-protected and uses the existing host-administrator-only account management boundary. Older Workers are gated until their managed upgrade completes. The installed Codex must support `account/rateLimitResetCredit/consume`; unsupported versions return an actionable error. No model turn or account activation is involved.

The owning machine reads fresh, complete credit details and verifies the response account identity before sending a consume request. It explicitly supplies the ID of the earliest expiring available `codexRateLimits` credit. Non-expiring credits sort last; ties use the opaque ID deterministically. Missing, capped, duplicate, expired or malformed detail coverage prevents consumption; no fallback delegates card selection to OpenAI. Card IDs remain on the owning machine.

Each logical operation has a UUID idempotency key. The owning machine persists the selected credit/key before sending, retains ambiguous attempts across restarts, and retries the same credit/key. A different browser can recover an unresolved attempt; its request ID is durably bound to the original receipt before proceeding. Same-key concurrent requests share the running operation; different-key concurrent operations for an account are rejected. Completed receipts are retained so old requests cannot redeem another card. Browser local storage retains only a scoped attempt UUID while the result is unresolved. Backend receipts remain local under `reset-receipts/<account UUID>` next to the machine's account registry; they contain no credentials.

`reset`, `alreadyRedeemed`, `nothingToReset` and `noCredit` are distinct outcomes. After completion, a fresh read updates reset-card information and ordinary quota for the targeted account without changing the machine's active account. If refresh fails after redemption, the UI reports the completed operation with refresh pending; it does not silently repeat consumption. Network/authentication errors preserve the same attempt for retry. Server auth rotation uses the existing shared credential lock; remote requests use isolated access-only copies. Temporary credential homes are cleaned up after the CLI process tree exits.

Validation covers selection ordering, incomplete details, wrong identity, zero balance, lost responses, cross-browser recovery, durable receipt replay, concurrent requests, post-redemption refresh failure, real isolated CLI transport with synthetic credentials, host credential rotation, and authenticated HTTP → gateway → actual Worker validator → sanitized reply → database persistence. Tests never spend a real reset credit. True account redemption and iOS visual interaction remain user-triggered acceptance boundaries.

Official consume contract: https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt
