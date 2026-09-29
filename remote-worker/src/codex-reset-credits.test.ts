import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResetCredits, mergeResetCredits, unavailableResetCredits } from "./codex-reset-credits.js";
const now = new Date("2026-09-23T04:00:00Z");
const expiry = (days: number) => now.getTime() / 1000 + days * 86400;
const credit = (id: string, days: number | null) => ({ id, status: "available", resetType: "codexRateLimits", expiresAt: days === null ? null : expiry(days) });

test("reset counts are authoritative; earliest expiry considers usable unique detail rows", () => {
  const result = normalizeResetCredits({ rateLimitResetCredits: { availableCount: 3, credits: [credit("late", 3), credit("forever", null), credit("early", 1)] } }, now);
  assert.equal(result.availableCount, 3);
  assert.equal(result.earliestExpiresAt, new Date(expiry(1) * 1000).toISOString());
  assert.equal(result.expiryStatus, "complete");
  assert.deepEqual(Object.keys(result).sort(), ["availableCount", "checkedAt", "earliestExpiresAt", "expiryStatus", "state", "updatedAt"]);
});

test("capped, duplicate, expired, redeemed, foreign and malformed rows cannot claim complete expiry coverage", () => {
  const rows = [credit("one", 2), credit("one", 2), credit("expired", -1), { ...credit("used", 1), status: "redeemed" }, { ...credit("other", 1), resetType: "unknown" }, { ...credit("broken", 1), expiresAt: "invalid" }];
  const result = normalizeResetCredits({ rateLimitResetCredits: { availableCount: 5, credits: rows } }, now);
  assert.equal(result.availableCount, 5);
  assert.equal(result.earliestExpiresAt, new Date(expiry(2) * 1000).toISOString());
  assert.equal(result.expiryStatus, "partial");
  assert.equal(normalizeResetCredits({ rateLimitResetCredits: { availableCount: 1, credits: [] } }, now).expiryStatus, "partial");
});

test("zero, unknown and non-expiring credits remain distinct", () => {
  for (const availableCount of [null, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeResetCredits({ rateLimitResetCredits: { availableCount } }, now).state, "unavailable");
  }
  assert.equal(normalizeResetCredits({}, now).availableCount, null);
  assert.equal(normalizeResetCredits({ rateLimitResetCredits: null }, now).availableCount, null);
  const zero = normalizeResetCredits({ rateLimitResetCredits: { availableCount: 0, credits: [credit("stale", 1)] } }, now);
  assert.equal(zero.availableCount, 0); assert.equal(zero.earliestExpiresAt, null);
  const unknown = normalizeResetCredits({ rateLimitResetCredits: { availableCount: 3, credits: null } }, now);
  assert.equal(unknown.expiryStatus, "unknown");
  const forever = normalizeResetCredits({ rateLimitResetCredits: { availableCount: 1, credits: [credit("forever", null)] } }, now);
  assert.equal(forever.expiryStatus, "complete"); assert.equal(forever.earliestExpiresAt, null);
});

test("failed reads preserve the last good observation date and ignore out-of-order reads", () => {
  const good = normalizeResetCredits({ rateLimitResetCredits: { availableCount: 3 } }, now);
  const failed = unavailableResetCredits("error", new Date(now.getTime() + 1000));
  const merged = mergeResetCredits(good, failed);
  assert.equal(merged.availableCount, 3); assert.equal(merged.updatedAt, good.updatedAt); assert.equal(merged.state, "error");
  assert.deepEqual(mergeResetCredits(merged, good), merged);
});
