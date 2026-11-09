import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CodexResetAutoUse, migrateAutoReset, migrateAutoResetPreferences } from "../server/codex-reset-auto-use.js";
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
  const file = path.join(root, "db"); let db = new DatabaseSync(file); migrateAutoReset(db); migrateAutoResetPreferences(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, reopen() { db.close(); db = new DatabaseSync(file); } };
}

test("only complete, healthy, expiring Codex credits inside one hour are scheduled; durable completion is not repeated", async t => {
  const fixture = setup(t), used: string[] = [];
  const accounts = [account("at-boundary"), account("inside", 10), account("too-early", 3601), account("expired", -1), account("forever", null),
    { ...account("partial"), resetCredits: { ...account("a").resetCredits, expiryStatus: "partial" as const } },
    { ...account("auth"), resetCredits: { ...account("a").resetCredits, state: "auth_required" as const } }];
  const dependencies = { now: () => date, executors: () => [executor], accounts: async () => ({ accounts }),
    consume: async (_: string, id: string, attempt: string, expiry: string | undefined) => {
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
    consume: async (_: string, _id: string, attempt: string, expiry: string | undefined) => {
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
  const host = request.agent(app.app); const login = await host.post('/api/auth/login').send({ username: 'host', password: 'Fixture-Pass-2026!' }).expect(200);
  const response = await host.get('/api/codex-accounts/reset-history').expect(200);
  assert.deepEqual(response.body, { records: [], enabled: false, supported: true }); assert.match(response.headers['cache-control'], /no-store/);
  await host.get('/api/codex-accounts/reset-history?executorId=nonexistent').expect(404);
  const id = '11111111-1111-4111-8111-111111111111';
  t.mock.method(app.runner, 'listCodexAccounts', async () => ({ accounts: [{ id, label: 'Fixture', email: null, accountHint: 'fixture', active: true, createdAt: date.toISOString(), lastUsedAt: null }], activeAccountId: id }));
  const route = `/api/codex-accounts/${id}/auto-reset`;
  await host.patch(route).send({ enabled: false }).expect(403);
  await tenant.patch(route).set('X-CSRF-Token', (await tenant.get('/api/session')).body.csrfToken ?? 'fixture').send({ enabled:false }).expect(403);
  await host.patch(route).set('X-CSRF-Token',login.body.csrfToken).send({ enabled: 'false' }).expect(400);
  await host.patch('/api/codex-accounts/missing/auto-reset').set('X-CSRF-Token',login.body.csrfToken).send({ enabled:false }).expect(404);
  for (const enabled of [false,true]) {
    const saved = await host.patch(route).set('X-CSRF-Token',login.body.csrfToken).send({ enabled }).expect(200);
    assert.equal(saved.body.enabled, enabled);
    assert.equal(app.db.sqlite.prepare('SELECT enabled FROM codex_auto_reset_preferences WHERE executor_id=? AND account_id=?').get('local-host',id)?.enabled, Number(enabled));
    assert.match(saved.headers['cache-control'],/no-store/);
  }

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

test("low-quota threshold, fresh data, per-machine preference and post-reset recovery prevent repeated spending", async t => {
  const fixture = setup(t); let now = date;
  const low = (id: string, percent: number | null) => ({ ...account(id, 86400), quotaRemainingPercent: percent,
    quotaResetAt: new Date(date.getTime() + 7200_000).toISOString(), quotaUpdatedAt: now.toISOString() });
  let accounts = [low('boundary', 1), low('zero', 0), low('fraction', 0.5), low('above', 1.01), low('unknown', null),
    { ...low('stale', 0), quotaUpdatedAt: new Date(date.getTime() - 121_000).toISOString() }, low('disabled', 0)];
  const used: string[] = [];
  const deps = { now: () => now, executors: () => [{ ...executor, lowQuotaSupported: true }], accounts: async () => ({ accounts }),
    consume: async (_: string, id: string, attempt: string, expiry: string | undefined, key?: string) => {
      assert.equal(expiry, undefined); assert.ok(key); used.push(id); return success(attempt);
    } };
  let service = new CodexResetAutoUse(fixture.db, deps);
  assert.equal(service.enabled('host', 'disabled'), true);
  service.setEnabled('host', 'disabled', false);
  assert.equal(service.enabled('other-machine', 'disabled'), true);
  await service.tick(); assert.deepEqual(used, ['boundary', 'zero', 'fraction']);
  fixture.reopen(); service = new CodexResetAutoUse(fixture.db, deps);
  assert.equal(service.enabled('host', 'disabled'), false);
  now = new Date(date.getTime() + 360_000);
  accounts = [low('zero', 0)]; await service.tick(); assert.equal(used.length, 3);
  // A different card/window still cannot cascade without a confirmed recovery above the threshold.
  accounts = [{ ...low('zero', 0), quotaResetAt: new Date(now.getTime() + 7200_000).toISOString() }];
  await service.tick(); assert.equal(used.length, 3);
  accounts = [low('zero', 80)]; await service.tick();
  accounts = [{ ...low('zero', 0), quotaResetAt: new Date(now.getTime() + 7200_000).toISOString() }];
  await service.tick(); assert.equal(used.length, 4);
  assert.equal(service.history('host')[0].reason, 'quota');
  // The old scheduler's 24-hour expiry guard must reject all quota records after rollback.
  assert.ok(service.history('host').every(row=>Date.parse(row.expires_at!)+86_400_000<date.getTime()));
});

test("disabling stops expiry consumption and persisted retry, including a setting change during an account read", async t => {
  const fixture = setup(t); let now = date, calls = 0, disableWhileReading = false;
  const service = new CodexResetAutoUse(fixture.db, { now: () => now, executors: () => [executor],
    accounts: async () => { if (disableWhileReading) service.setEnabled('host','b',false); return { accounts: [account('a'), account('b')] }; },
    consume: async () => { calls++; throw Error('uncertain'); } });
  service.setEnabled('host', 'b', false); await service.tick(); assert.equal(calls, 1);
  service.setEnabled('host', 'a', false); service.setEnabled('host', 'b', true); disableWhileReading = true;
  now = new Date(date.getTime() + 300_000); await service.tick(); assert.equal(calls, 1);
  service.setEnabled('host', 'a', true); await service.tick(); assert.equal(calls, 2);
});

test("preference migration preserves all old expiration receipts and defaults new accounts to enabled", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-migration-')); const db = new DatabaseSync(path.join(root,'db'));
  t.after(() => { db.close(); fs.rmSync(root,{recursive:true,force:true}); });
  migrateAutoReset(db);
  db.prepare(`INSERT INTO codex_auto_reset_uses VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('id','host','server','a','label',expiresAt,'attempt','completed','reset',1,date.toISOString(),date.toISOString(),date.toISOString());
  migrateAutoResetPreferences(db);
  const row = db.prepare('SELECT * FROM codex_auto_reset_uses').get();
  assert.equal(row?.outcome,'reset'); assert.equal(row?.reason,'expiry'); assert.equal(row?.trigger_key,`expiry:${expiresAt}`);
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
});

test("all saved copies share pending, cooldown and recovery protection even when card counts change before quota catches up", async t => {
  const fixture=setup(t);let now=date,used=0;
  const fingerprint='a'.repeat(64);
  let credits=account('a',86400).resetCredits;
  const copies=new Map(['host','remote'].map(id=>[id,{...account(id,86400),resetAccountKey:fingerprint,quotaRemainingPercent:0,quotaResetAt:new Date(date.getTime()+7200_000).toISOString(),quotaUpdatedAt:now.toISOString()}]));
  const service=new CodexResetAutoUse(fixture.db,{now:()=>now,executors:()=>[executor,{...executor,id:'remote'}].map(e=>({...e,lowQuotaSupported:true})),
    accounts:async id=>({accounts:[{...copies.get(id)!,resetCredits:credits}]}),
    consume:async (_:string,_id:string,attempt:string)=>{used++;await new Promise(r=>setImmediate(r));return success(attempt);} });
  await service.tick();assert.equal(used,1);
  // Another machine now sees the next card but still reports the depleted quota.
  now=new Date(date.getTime()+360_000);credits=account('a',172800).resetCredits;
  for(const item of copies.values())item.quotaUpdatedAt=now.toISOString();
  fixture.reopen();await new CodexResetAutoUse(fixture.db,{now:()=>now,executors:()=>[{...executor,id:'remote',lowQuotaSupported:true}],
    accounts:async()=>({accounts:[{...copies.get('remote')!,resetCredits:credits}]}),consume:async()=>{throw Error('must not drain next card');}}).tick();
  assert.equal(used,1);
});

test("disabling an upstream account stops every saved copy, survives restart, and leaves different accounts enabled", async t => {
  const fixture=setup(t),key='b'.repeat(64);let calls=0;
  const deps={now:()=>date,executors:()=>[executor,{...executor,id:'remote'}],
    accounts:async(id:string)=>({accounts:[{...account(id),resetAccountKey:key}]}),consume:async(_:string,_id:string,attempt:string)=>{calls++;return success(attempt);}};
  let service=new CodexResetAutoUse(fixture.db,deps);
  service.setEnabled('host','host',false,key);
  assert.equal(service.enabled('remote','remote',key),false);
  assert.equal(service.enabled('remote','other','c'.repeat(64)),true);
  await service.tick();assert.equal(calls,0);
  fixture.reopen();service=new CodexResetAutoUse(fixture.db,deps);
  assert.equal(service.enabled('remote','remote',key),false);
  service.setEnabled('remote','remote',true,key);await service.tick();assert.equal(calls,1);
});
