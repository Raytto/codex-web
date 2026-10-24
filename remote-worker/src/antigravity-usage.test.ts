import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeAntigravityQuota, normalizeAntigravityCredits, readAntigravityUsage } from "./antigravity-usage.js";
import type { AntigravityUsage } from "./antigravity-usage-types.js";
import { GeminiAccountManager } from "./gemini-accounts.js";
import { isPersistableWorkerMessage, parseServerMessage } from "./protocol-validation.js";

const envelope = (name: string, data: unknown) => ({ status: "SUCCESS", num_turns: 0, command: { name, data } });
const quota = (remaining: unknown = 0) => envelope("usage", { groups: [{ name: "Gemini Models", buckets: [{ id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: remaining, reset_time: "2026-10-30T07:54:29Z" }] }] });
const snapshot = (id: string): AntigravityUsage => ({ accountId: id, state: "ok", checkedAt: "2026-10-24T00:00:00.000Z", quotaUpdatedAt: "2026-10-24T00:00:00.000Z", creditsUpdatedAt: "2026-10-24T00:00:00.000Z", groups: normalizeAntigravityQuota(quota(0.9848)), remainingCredits: 0, error: null });

test("AGY native command data preserves zero, unknown, precise fraction, reset and amount; rejects inferred answers", () => {
  assert.equal(normalizeAntigravityQuota(quota())[0]!.buckets[0]!.remainingPercent, 0);
  assert.ok(Math.abs(normalizeAntigravityQuota(quota(0.9980437))[0]!.buckets[0]!.remainingPercent! - 99.80437) < 1e-10);
  assert.equal(normalizeAntigravityQuota(quota())[0]!.buckets[0]!.resetAt, "2026-10-30T07:54:29.000Z");
  for (const invalid of [undefined, null, -1, 1.01, "0", NaN, Infinity]) assert.equal(normalizeAntigravityQuota(quota(invalid))[0]!.buckets[0]!.remainingPercent, invalid === undefined ? 0 : null);
  const bucket = normalizeAntigravityQuota(envelope("usage", { groups: [{ name: "New provider", buckets: [{ id: "custom", name: "Custom", remaining_amount: 0, disabled: true, reset_time: "invalid", access_token: "must not pass" }] }] }))[0]!.buckets[0]!;
  assert.equal(bucket.remainingAmount, 0); assert.equal(bucket.resetAt, null); assert.equal(bucket.disabled, true); assert.equal("access_token" in bucket, false);
  assert.equal(normalizeAntigravityCredits(envelope("credits", { remaining_credits: 0, upgrade_uri: "not forwarded" })), 0);
  for (const missing of [null, undefined, "0", -1]) assert.equal(normalizeAntigravityCredits(envelope("credits", { remaining_credits: missing })), null);
  for (const invalid of [{ ...quota(), num_turns: 1 }, { ...quota(), command: undefined }, envelope("models", {}), { ...quota(), status: "ERROR" }]) assert.throws(() => normalizeAntigravityQuota(invalid));
});

test("AGY reader executes only local slash commands and preserves previous sample time on partial failure", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-usage-reader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "fixture.mjs"), argsLog = path.join(root, "args.jsonl");
  fs.writeFileSync(executable, `import fs from 'node:fs'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(argsLog)},JSON.stringify(args)+'\\n'); if(args.at(-1)==='/usage'){console.error('secret error must not escape');process.exit(1)} console.log(${JSON.stringify(JSON.stringify(envelope("credits", { remaining_credits: 0 })))});`);
  const accountId = crypto.randomUUID(), previous = snapshot(accountId);
  const value = await readAntigravityUsage({ executable, cwd: root, accountId, previous });
  assert.equal(value.state, "partial"); assert.deepEqual(value.groups, previous.groups); assert.equal(value.quotaUpdatedAt, previous.quotaUpdatedAt);
  assert.equal(value.remainingCredits, 0); assert.notEqual(value.creditsUpdatedAt, previous.creditsUpdatedAt); assert.doesNotMatch(value.error!, /secret/);
  assert.deepEqual(fs.readFileSync(argsLog, "utf8").trim().split("\n").map(line => JSON.parse(line)), [["--output-format", "json", "--print", "/usage"], ["--output-format", "json", "--print", "/credits"]]);
  const other = await readAntigravityUsage({ executable, cwd: root, accountId: crypto.randomUUID(), previous });
  assert.deepEqual(other.groups, []); assert.equal(other.quotaUpdatedAt, null);
});

test("usage request/reply passes actual Worker protocol validation and rejects credentials/invalid refresh", () => {
  const requestId = crypto.randomUUID(), accountId = crypto.randomUUID();
  for (const fields of [{}, { accountId }, { accountId, refresh: true }]) assert.equal(parseServerMessage(JSON.stringify({ type: "gemini_accounts", requestId, action: "usage", ...fields })).ok, true);
  for (const fields of [{ refresh: "true" }, { accountId: "../profile" }, { code: "secret" }]) assert.equal(parseServerMessage(JSON.stringify({ type: "gemini_accounts", requestId, action: "usage", ...fields })).ok, false);
  assert.equal(parseServerMessage(JSON.stringify({ type: "gemini_accounts", requestId, action: "list", refresh: true })).ok, false);
  const message = { type: "gemini_accounts_result", requestId, ok: true, usage: snapshot(accountId) };
  assert.equal(isPersistableWorkerMessage(message), true);
  assert.equal(isPersistableWorkerMessage({ ...message, usage: { ...message.usage, access_token: "bad" } }), false);
  assert.equal(isPersistableWorkerMessage({ ...message, usage: { ...message.usage, remainingCredits: -1 } }), false);
});

test("node-local usage deduplicates, caches, never switches accounts, and discards replies after activation/deletion", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-usage-cache-"));
  const id = crypto.randomUUID(), other = crypto.randomUUID(); let now = Date.parse("2026-10-24T00:00:00Z"), calls = 0;
  let release: ((value: AntigravityUsage) => void) | undefined;
  let held = false;
  const manager = new GeminiAccountManager({ root, executable: () => process.execPath, assertSwitchAllowed() { throw new Error("usage must not switch"); }, now: () => new Date(now),
    readUsage: async runtime => { calls++; return held ? new Promise(resolve => { release = resolve; }) : snapshot(runtime.accountId); } });
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const registry = { version: 1, activeAccountId: id as string | null, accounts: [id, other].map(id => ({ id, label: "fixture", email: null, createdAt: new Date(now).toISOString(), lastUsedAt: null })) };
  for (const accountId of [id, other]) fs.mkdirSync(path.join(root, "profiles", accountId));
  const write = () => fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(registry)); write();
  const results = await Promise.all([manager.getUsage(), manager.getUsage()]);
  assert.equal(calls, 1); assert.equal(results[0]!.accountId, id); assert.deepEqual(results[0], results[1]);
  await manager.getUsage(undefined, true); assert.equal(calls, 1, "manual refresh is throttled for 5 seconds");
  await manager.getUsage(other); assert.equal(calls, 2); assert.equal(JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")).activeAccountId, id);
  now += 61_000; held = true;
  const pending = manager.getUsage(); await new Promise(resolve => setImmediate(resolve));
  registry.activeAccountId = other; write(); release!(snapshot(id));
  assert.equal((await pending).state, "unavailable");
  const deletion = manager.getUsage(other, true); await new Promise(resolve => setImmediate(resolve));
  registry.accounts = []; registry.activeAccountId = null; write(); release!(snapshot(other));
  assert.equal((await deletion).state, "unavailable"); assert.equal((await manager.getUsage()).accountId, null);
});

test("account deletion waits for the read-only CLI to exit so credentials cannot be recreated", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-usage-delete-"));
  const id = crypto.randomUUID(); let release: ((value: AntigravityUsage) => void) | undefined;
  const manager = new GeminiAccountManager({ root, executable: () => process.execPath, assertSwitchAllowed() {},
    readUsage: async () => new Promise(resolve => { release = resolve; }) });
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const profile = path.join(root, "profiles", id); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, activeAccountId: id, accounts: [{ id, label: "fixture", email: null, createdAt: new Date().toISOString(), lastUsedAt: null }] }));
  const reading = manager.getUsage(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(manager.delete(id), /正在读取此账号用量/);
  assert.equal(fs.existsSync(profile), true);
  release!(snapshot(id)); await reading;
  const deleted = await manager.delete(id); assert.equal(deleted.accounts.length, 0); assert.equal(fs.existsSync(profile), false);
});
