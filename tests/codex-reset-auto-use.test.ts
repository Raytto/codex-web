import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CodexResetAutoUse, migrateAutoReset } from "../server/codex-reset-auto-use.js";
import { normalizeResetCredits } from "../remote-worker/src/codex-reset-credits.js";
import type { ResetConsumption } from "../remote-worker/src/codex-reset-consumer.js";

const date = new Date("2030-01-01T00:00:00.000Z");
const expiresAt = new Date(date.getTime() + 3_600_000).toISOString();
function account(id: string, remaining: number | null = 3600) {
  return { id, label: `合成账号 ${id}`, resetCredits: normalizeResetCredits({ rateLimitResetCredits: { availableCount: 1,
    credits: [{ id: "private-credit", status: "available", resetType: "codexRateLimits", expiresAt: remaining === null ? null : date.getTime() / 1000 + remaining }] } }, date) };
}
const executor = { id: "host", machineName: "服务器", online: true, supported: true };
const success = (attemptId: string): ResetConsumption => ({ attemptId, outcome: "reset", quota: null, refreshed: true, resetCredits: account("a").resetCredits });

test("automatic redemption excludes previously released Workers without the expiration guard", async () => {
  const { RemoteWorkerGateway } = await import("../server/remote-worker-gateway.js");
  for (const [version, expected] of [["", false], ["1.21.1", false], ["1.21.2", false], ["1.21.3", false], ["1.21.4", false], ["1.21.5", true], ["1.22.0", true]] as const) {
    const receiver = { executor: () => ({ worker: { installedVersion: version } }),
      supportsAutoResetCredit: RemoteWorkerGateway.prototype.supportsAutoResetCredit };
    const gateway = receiver as unknown as InstanceType<typeof RemoteWorkerGateway>;
    assert.equal(gateway.supportsAutoResetCredit("remote"), expected, version);
    if (!expected) await assert.rejects(RemoteWorkerGateway.prototype.consumeResetCredit.call(gateway, "remote", "account", "attempt", expiresAt), /升级/);
  }
});

function setup(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-reset-"));
  const file = path.join(root, "db"); let db = new DatabaseSync(file); migrateAutoReset(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, reopen() { db.close(); db = new DatabaseSync(file); } };
}

test("only complete, healthy, expiring Codex credits inside one hour are scheduled; durable completion is not repeated", async t => {
  const fixture = setup(t), used: string[] = [];
  const accounts = [account("at-boundary"), account("inside", 10), account("too-early", 3601), account("expired", -1), account("forever", null),
    { ...account("partial"), resetCredits: { ...account("a").resetCredits, expiryStatus: "partial" as const } },
    { ...account("auth"), resetCredits: { ...account("a").resetCredits, state: "auth_required" as const } }];
  const dependencies = { now: () => date, executors: () => [executor], accounts: async () => ({ accounts }),
    consume: async (_: string, id: string, attempt: string, expiry: string) => {
      const stored = fixture.db.prepare("SELECT state,attempts FROM codex_auto_reset_uses WHERE account_id=?").get(id);
      assert.deepEqual({ ...stored }, { state: "pending", attempts: 1 }); assert.ok(expiry); used.push(id); return id === "inside" ? { ...success(attempt), outcome: "notDue" as const } : success(attempt);
    } };
  await new CodexResetAutoUse(fixture.db, dependencies).tick();
  fixture.reopen(); const resumed = new CodexResetAutoUse(fixture.db, dependencies); await resumed.tick();
  assert.deepEqual(used, ["at-boundary", "inside"]);
  const records = resumed.history("host"); assert.equal(records.length, 2); assert.ok(records.every(r => r.state === "completed" && r.created_at && r.updated_at));
  assert.equal(records.find(r => r.account_id === "inside")?.outcome, "notDue");
  assert.doesNotMatch(JSON.stringify(records), /private-credit|access_token|refresh_token/);
});

test("ambiguous redemption retries the persisted attempt after restart even if fresh data has no credit; errors are not persisted", async t => {
  const fixture = setup(t); let now = date, calls = 0, original = "";
  const dependencies = { now: () => now, executors: () => [executor], accounts: async () => ({ accounts: calls ? [] : [account("a")] }),
    consume: async (_: string, _id: string, attempt: string, expiry: string) => {
      assert.equal(expiry, expiresAt); calls++;
      if (calls === 1) { original = attempt; throw Error("Bearer fixture-secret"); }
      assert.equal(attempt, original); return { ...success(attempt), outcome: "alreadyRedeemed" as const };
    } };
  let service = new CodexResetAutoUse(fixture.db, dependencies); await service.tick(); await service.tick();
  assert.equal(calls, 1); assert.equal(service.history("host")[0].state, "failed");
  fixture.reopen(); now = new Date(date.getTime() + 300_000); service = new CodexResetAutoUse(fixture.db, dependencies); await service.tick();
  assert.equal(calls, 2); assert.equal(service.history("host")[0].outcome, "alreadyRedeemed"); assert.equal(service.history("host")[0].attempts, 2);
  assert.doesNotMatch(JSON.stringify(service.history("host")), /fixture-secret/);
});

test("tick overlap, offline/old machines, independent failures and shutdown do not create extra consumption", async t => {
  const fixture = setup(t); const machines = [executor, { ...executor, id: "offline", online: false }, { ...executor, id: "old", supported: false }, { ...executor, id: "broken" }];
  let release!: () => void, calls = 0; const pending = new Promise<void>(resolve => { release = resolve; });
  const service = new CodexResetAutoUse(fixture.db, { now: () => date, executors: () => machines,
    accounts: async id => { assert.ok(["host", "broken"].includes(id)); if (id === "broken") throw Error("offline"); return { accounts: [account("a"), account("b")] }; },
    consume: async (_: string, _id: string, attempt: string) => { calls++; await pending; return success(attempt); } });
  const first = service.tick(); assert.equal(service.tick(), first);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); service.stop(); release(); await first; await service.tick();
  assert.equal(calls, 1); assert.equal(service.history("offline").length, 0); assert.equal(service.history("host").length, 1);
});

test("unresolved receipt recovery has a bounded window and never reports a failed attempt as a spent credit", async t => {
  const fixture = setup(t); let now = date, calls = 0;
  const service = new CodexResetAutoUse(fixture.db, { now: () => now, executors: () => [executor], accounts: async () => ({ accounts: [account("a")] }),
    consume: async () => { calls++; throw Error("upstream unavailable"); } });
  await service.tick(); now = new Date(Date.parse(expiresAt) + 86_400_001); await service.tick();
  assert.equal(calls, 1); assert.equal(service.history("host")[0].state, "unconfirmed"); assert.equal(service.history("host")[0].outcome, null);
});

test("automatic history is CODEX_WEB-only, read-only, machine scoped and never invokes a consume", async t => {
  const { createApp } = await import('../server/app.js');
  const { HOST_ROOT_USER_ID } = await import('../server/host-root-user.js');
  const { default: request } = await import('supertest');
  const { default: bcrypt } = await import('bcryptjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-history-api-'));
  const app = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, 'data'), tenantRoot: path.join(root, 'tenants'), queueAutoStart: false,
    username: 'tenant', passwordHash: bcrypt.hashSync('Fixture-Pass-2026!', 8), sessionSecret: 'fixture-session-secret-longer-than-thirty-two-characters' });
  t.after(async () => { app.beginShutdown(); await app.waitForBackgroundTasks(); app.remoteWorkers.close(); app.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  t.mock.method(app.runner, 'consumeResetCredit', async () => { throw Error('must not consume'); });
  app.db.createUser({ id: HOST_ROOT_USER_ID, username: 'host', display_name: 'Host', password_hash: bcrypt.hashSync('Fixture-Pass-2026!', 8), role: 'owner', status: 'active', created_at: date.toISOString(), updated_at: date.toISOString() });
  await request(app.app).get('/api/codex-accounts/reset-history').expect(401);
  const tenant = request.agent(app.app); await tenant.post('/api/auth/login').send({ username: 'tenant', password: 'Fixture-Pass-2026!' }).expect(200);
  await tenant.get('/api/codex-accounts/reset-history').expect(403);
  const host = request.agent(app.app); await host.post('/api/auth/login').send({ username: 'host', password: 'Fixture-Pass-2026!' }).expect(200);
  const response = await host.get('/api/codex-accounts/reset-history').expect(200);
  assert.deepEqual(response.body, { records: [], enabled: false, supported: true }); assert.match(response.headers['cache-control'], /no-store/);
  await host.get('/api/codex-accounts/reset-history?executorId=nonexistent').expect(404);
});

test("skipping an already changed expiration updates reset cards without clearing the last known ordinary quota", async t => {
  const { AppDatabase } = await import('../server/db.js'); const { CodexRunner } = await import('../server/codex-runner.js');
  const { HOST_ROOT_USER_ID } = await import('../server/host-root-user.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-skip-quota-')); const db = new AppDatabase(root, undefined, false);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const accountId = '11111111-1111-4111-8111-111111111111';
  db.setAccountCodexQuota('local-host', accountId, { remainingPercent: 74, resetAt: expiresAt, resetCredits: account('a').resetCredits });
  const zero = normalizeResetCredits({ rateLimitResetCredits: { availableCount: 0, credits: [] } }, new Date(date.getTime() + 1000));
  let notified = false;
  const receiver = { db, hostWorkerClient: { consumeResetCredit: async () => ({ ...success('attempt'), resetCredits: zero, quota: null, outcome: 'notDue' }) }, remoteWorkers: { emit: () => { notified = true; } } };
  await CodexRunner.prototype.consumeResetCredit.call(receiver as unknown as InstanceType<typeof CodexRunner>, HOST_ROOT_USER_ID, accountId, 'attempt', 'local-host', expiresAt);
  assert.equal(db.getExecutorCodexQuota('local-host', accountId)?.remainingPercent, 74);
  assert.equal(db.getAccountResetCredits('local-host', accountId)?.availableCount, 0); assert.equal(notified, true);
});
