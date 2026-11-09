import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { autoResetAttemptId, consumeAccountResetCredit, earliestResetCredit, redeemEarliestReset } from "./codex-reset-consumer.js";
import { isPersistableWorkerMessage, parseServerMessage } from "./protocol-validation.js";

const future = () => Math.floor(Date.now() / 1000) + 86400;
const credit = (id: string, expiresAt: number | null) => ({ id, expiresAt, status: "available", resetType: "codexRateLimits" });
const limits = (credits = [credit("forever", null), credit("late", future() + 1000), credit("early", future())]) => ({
  accountId: "fixture-account", rateLimitResetCredits: { availableCount: credits.length, credits },
  rateLimitsByLimitId: { codex: { primary: { usedPercent: 10, resetsAt: future() }, secondary: { usedPercent: 20, resetsAt: future() + 1000 } } },
});
function temporary(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reset-consume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test("earliest expiry selection requires complete unique valid details and puts non-expiring cards last", () => {
  assert.equal(earliestResetCredit(limits()), "early");
  assert.equal(earliestResetCredit(limits([credit("z", null), credit("a", null)])), "a");
  assert.equal(earliestResetCredit(limits([credit("z", future()), credit("a", future())])), "a");
  assert.equal(earliestResetCredit(limits([])), null);
  for (const value of [
    { rateLimitResetCredits: { availableCount: 3, credits: [credit("one", future())] } },
    { rateLimitResetCredits: { availableCount: 1, credits: null } },
    limits([credit("same", future()), credit("same", future())]),
    limits([credit("expired", 1)]), limits([{ ...credit("bad", future()), expiresAt: NaN }]),
    limits([{ ...credit("used", future()), status: "redeemed" }]),
  ]) assert.throws(() => earliestResetCredit(value), /明细/);
});

test("lost response and fresh browser attempt retry pinned card/key, then replay durable success without another consume", async (t) => {
  const root = temporary(t), attemptId = crypto.randomUUID();
  let reads = 0, calls = 0;
  const requests: unknown[] = [];
  const rpc = async (method: string, params: unknown) => {
    if (method === "account/rateLimits/read") { reads++; return calls ? limits([credit("late", future() + 1000)]) : limits(); }
    assert.equal(method, "account/rateLimitResetCredit/consume"); requests.push(params); calls++;
    if (calls === 1) throw new Error("lost response after server consumed card");
    return { outcome: "alreadyRedeemed" };
  };
  await assert.rejects(redeemEarliestReset(rpc, root, "fixture-account", attemptId), /lost response/);
  const retryId = crypto.randomUUID();
  const recovered = await redeemEarliestReset(rpc, root, "fixture-account", retryId);
  assert.equal(recovered.attemptId, attemptId); assert.equal(recovered.outcome, "alreadyRedeemed");
  assert.deepEqual(requests, Array(2).fill({ creditId: "early", idempotencyKey: attemptId }));
  assert.equal(recovered.resetCredits.availableCount, 1); assert.equal(recovered.quota?.remainingPercent, 80);
  assert.equal(recovered.refreshed, true); assert.equal(fs.existsSync(path.join(root, "pending.json")), false);
  await redeemEarliestReset(rpc, root, "fixture-account", attemptId);
  await redeemEarliestReset(rpc, root, "fixture-account", retryId);
  assert.equal(calls, 2); assert.ok(reads >= 5);
  assert.doesNotMatch(JSON.stringify(recovered), /creditId|fixture-account|early/);
});

test("identity mismatch, incomplete details and no credits never call consume", async (t) => {
  const root = temporary(t);
  for (const response of [ { ...limits(), accountId: "wrong" }, { ...limits(), rateLimitResetCredits: { availableCount: 5, credits: [] } } ]) {
    await assert.rejects(redeemEarliestReset(async (method) => { assert.equal(method, "account/rateLimits/read"); return response; }, root, "fixture-account", crypto.randomUUID()));
    assert.equal(fs.existsSync(path.join(root, "pending.json")), false);
  }
  const result = await redeemEarliestReset(async (method) => { assert.equal(method, "account/rateLimits/read"); return limits([]); }, root, "fixture-account", crypto.randomUUID());
  assert.equal(result.outcome, "noCredit");
});

test("successful consume survives failed refresh and retry does not spend another credit", async (t) => {
  const root = temporary(t), id = crypto.randomUUID(); let consumed = false, calls = 0;
  const rpc = async (method: string) => {
    if (method === "account/rateLimits/read") { if (consumed) throw Error("refresh offline"); return limits(); }
    calls++; consumed = true; return { outcome: "reset" };
  };
  const result = await redeemEarliestReset(rpc, root, "fixture-account", id);
  assert.equal(result.outcome, "reset"); assert.equal(result.refreshed, false);
  consumed = false;
  const again = await redeemEarliestReset(rpc, root, "fixture-account", id);
  assert.equal(again.outcome, "reset"); assert.equal(calls, 1);
});

test("real isolated CLI transport deduplicates clicks, pins earliest ID, cleans temp auth, and preserves source auth", async (t) => {
  const root = temporary(t), authFile = path.join(root, "auth.json"), executable = path.join(root, "fake.js");
  const log = path.join(root, "requests");
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { account_id: "fixture-account", refresh_token: "private-fixture", access_token: "fixture" } }));
  const before = fs.readFileSync(authFile, "utf8");
  fs.writeFileSync(executable, `const fs=require('fs'),readline=require('readline'),path=require('path');
  const auth=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,'auth.json')));if(auth.tokens.refresh_token)throw Error('refresh not stripped');
  readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
  const result=m.method==='account/rateLimits/read'?${JSON.stringify(limits())}:m.method==='account/rateLimitResetCredit/consume'?{outcome:'reset'}:{};
  console.log(JSON.stringify({id:m.id,result}));});`);
  const options = { executable, authFile, expectedAccountId: "fixture-account", temporaryRoot: path.join(root, "temp"), journalRoot: path.join(root, "journal"), attemptId: crypto.randomUUID() };
  const first = consumeAccountResetCredit(options);
  await assert.rejects(consumeAccountResetCredit({ ...options, attemptId: crypto.randomUUID() }), /正在使用/);
  const [one, two] = await Promise.all([first, consumeAccountResetCredit(options)]);
  await consumeAccountResetCredit(options);
  assert.equal(one.attemptId, two.attemptId); assert.equal(one.outcome, "reset");
  const messages = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(messages.filter(m => m.method.endsWith("/consume")).length, 1);
  assert.equal(messages.find(m => m.method.endsWith("/consume")).params.creditId, "early");
  assert.equal(fs.readFileSync(authFile, "utf8"), before); assert.deepEqual(fs.readdirSync(options.temporaryRoot), []);
  const wire = { type: "codex_accounts_result", requestId: crypto.randomUUID(), ok: true, resetResult: one };
  assert.equal(isPersistableWorkerMessage(wire), true);
});

test("Worker strict protocol accepts reset operations and rejects missing keys and action-confused fields", () => {
  const base = { type: "codex_accounts", requestId: crypto.randomUUID(), accountId: crypto.randomUUID(), action: "reset_credit", attemptId: crypto.randomUUID() };
  assert.equal(parseServerMessage(JSON.stringify(base)).ok, true);
  for (const value of [{ ...base, attemptId: undefined }, { ...base, refreshUsage: true }, { ...base, action: "delete" }, { ...base, creditId: "client-choice" }]) {
    assert.equal(parseServerMessage(JSON.stringify(value)).ok, false);
  }
});

test("automatic use rechecks the exact expiration window, never falls through to a changed/unknown/non-expiring card", async t => {
  const root = temporary(t), due = Math.floor(Date.now() / 1000) + 1800, expiry = new Date(due * 1000).toISOString();
  for (const [response, expected] of [
    [limits([credit('too-early', due + 7200)]), new Date((due + 7200) * 1000).toISOString()],
    [limits([credit('changed', due + 60)]), expiry], [limits([credit('forever', null)]), expiry],
    [limits([]), expiry], [limits([credit('expired', 1)]), new Date(1000).toISOString()],
    [{ ...limits(), rateLimitResetCredits: { availableCount: 2, credits: [credit('partial', due)] } }, expiry],
  ] as const) {
    const operation = redeemEarliestReset(async method => { assert.equal(method, 'account/rateLimits/read'); return response; }, root, 'fixture-account', crypto.randomUUID(), expected);
    if (response.rateLimitResetCredits.credits?.[0]?.id === 'too-early' || response.rateLimitResetCredits.credits?.[0]?.id === 'partial') await assert.rejects(operation);
    else {
      const result = await operation; assert.equal(result.outcome, 'notDue');
      assert.equal(isPersistableWorkerMessage({ type: 'codex_accounts_result', requestId: crypto.randomUUID(), ok: true, resetResult: result }), true);
    }
    assert.equal(fs.existsSync(path.join(root, 'pending.json')), false);
  }
  const id = autoResetAttemptId('fixture-account', expiry); let consumed = 0;
  const rpc = async (method: string) => { if (method === 'account/rateLimits/read') return limits([credit('due', due)]); consumed++; return { outcome: 'reset' }; };
  await redeemEarliestReset(rpc, root, 'fixture-account', id, expiry);
  await redeemEarliestReset(rpc, root, 'fixture-account', id, expiry);
  assert.equal(consumed, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), 'utf8'));
  assert.equal(receipt.source, 'auto_expiry'); assert.equal(receipt.autoExpiresAt, expiry); assert.ok(receipt.createdAt && receipt.completedAt);
  assert.notEqual(id, autoResetAttemptId('another-account', expiry));
  assert.notEqual(id, autoResetAttemptId('fixture-account', new Date((due + 60) * 1000).toISOString()));
});

test("automatic retries recover only their pinned card and cannot take over an unresolved manual operation", async t => {
  const root = temporary(t), due = Math.floor(Date.now() / 1000) + 100, expiry = new Date(due * 1000).toISOString();
  const id = autoResetAttemptId('fixture-account', expiry); let calls = 0;
  const rpc = async (method: string, params: unknown) => {
    if (method === 'account/rateLimits/read') return calls ? limits([credit('next', future())]) : limits([credit('due', due)]);
    assert.deepEqual(params, { creditId: 'due', idempotencyKey: id }); calls++;
    if (calls === 1) throw Error('lost response'); return { outcome: 'alreadyRedeemed' };
  };
  await assert.rejects(redeemEarliestReset(rpc, root, 'fixture-account', id, expiry), /lost response/);
  assert.equal((await redeemEarliestReset(rpc, root, 'fixture-account', id, expiry)).outcome, 'alreadyRedeemed');
  assert.equal(calls, 2);
  const manualRoot = path.join(root, 'manual');
  await assert.rejects(redeemEarliestReset(async method => { if (method === 'account/rateLimits/read') return limits([credit('due', due)]); throw Error('uncertain'); }, manualRoot, 'fixture-account', crypto.randomUUID()));
  await assert.rejects(redeemEarliestReset(async () => { throw Error('must not send'); }, manualRoot, 'fixture-account', id, expiry), /另一笔/);
});

test("automatic reset guard passes actual Worker parsing only for reset_credit with a valid ISO timestamp", () => {
  const payload = { type: 'codex_accounts', requestId: crypto.randomUUID(), action: 'reset_credit', accountId: crypto.randomUUID(), attemptId: crypto.randomUUID(), autoExpiresAt: new Date().toISOString() };
  assert.equal(parseServerMessage(JSON.stringify(payload)).ok, true);
  for (const changed of [{ autoExpiresAt: true }, { autoExpiresAt: 'invalid' }, { action: 'list' }, { action: 'activate' }]) {
    assert.equal(parseServerMessage(JSON.stringify({ ...payload, ...changed })).ok, false);
  }
});

test("automatic isolated CLI sessions share a per-account expiry key across machine journals without exposing credentials", async t => {
  const root = temporary(t), authFile = path.join(root, 'auth.json'), executable = path.join(root, 'fake.js');
  const log = path.join(root, 'requests'), consumed = path.join(root, 'upstream-receipt');
  const due = Math.floor(Date.now() / 1000) + 1800, expiry = new Date(due * 1000).toISOString();
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { account_id: 'fixture-account', refresh_token: 'private-fixture', access_token: 'fixture' } }));
  const before = fs.readFileSync(authFile, 'utf8');
  fs.writeFileSync(executable, `const fs=require('fs'),readline=require('readline'),path=require('path');
    if(JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,'auth.json'))).tokens.refresh_token)throw Error('refresh not stripped');
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};
      if(m.method==='account/rateLimits/read')result=${JSON.stringify(limits([credit('due', due)]))};
      if(m.method==='account/rateLimitResetCredit/consume'){
        fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m.params)+'\\n');
        if(fs.existsSync(${JSON.stringify(consumed)})){if(fs.readFileSync(${JSON.stringify(consumed)},'utf8')!==m.params.idempotencyKey)throw Error('duplicate physical spend');result={outcome:'alreadyRedeemed'};}
        else{fs.writeFileSync(${JSON.stringify(consumed)},m.params.idempotencyKey);result={outcome:'reset'};}
      } console.log(JSON.stringify({id:m.id,result}));});`);
  const options = { executable, authFile, expectedAccountId: 'fixture-account', temporaryRoot: path.join(root, 'temp'), autoExpiresAt: expiry };
  const first = await consumeAccountResetCredit({ ...options, journalRoot: path.join(root, 'server'), attemptId: crypto.randomUUID() });
  const second = await consumeAccountResetCredit({ ...options, journalRoot: path.join(root, 'worker'), attemptId: crypto.randomUUID() });
  const replay = await consumeAccountResetCredit({ ...options, journalRoot: path.join(root, 'server'), attemptId: crypto.randomUUID() });
  assert.equal(first.outcome, 'reset'); assert.equal(second.outcome, 'alreadyRedeemed'); assert.equal(replay.outcome, 'reset');
  assert.equal(first.attemptId, second.attemptId); assert.equal(first.attemptId, autoResetAttemptId('fixture-account', expiry));
  const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.equal(fs.readFileSync(authFile, 'utf8'), before); assert.deepEqual(fs.readdirSync(options.temporaryRoot), []);
  assert.doesNotMatch(JSON.stringify([first, second]), /private-fixture|creditId|fixture-account/);
});

test("low-quota guard rechecks fresh limits, pins earliest card, and recovers an ambiguous operation without spending another", async t => {
  const { lowQuotaKey, resetQuota } = await import('./codex-reset-policy.js');
  const { normalizeResetCredits } = await import('./codex-reset-credits.js');
  const root = temporary(t), data = limits();
  data.rateLimitsByLimitId.codex.secondary.usedPercent = 99;
  const key = lowQuotaKey(resetQuota(data), normalizeResetCredits(data))!;
  assert.ok(key);
  const attempt = autoResetAttemptId('fixture-account', `quota:${key}`); let calls = 0;
  const rpc = async (method: string, params: unknown) => {
    if (method === 'account/rateLimits/read') return calls ? limits([credit('next', future()+5000)]) : data;
    calls++; assert.deepEqual(params, { idempotencyKey: attempt, creditId: 'early' });
    if (calls === 1) throw Error('lost response');
    return { outcome: 'alreadyRedeemed' };
  };
  await assert.rejects(redeemEarliestReset(rpc, root, 'fixture-account', attempt, undefined, key), /lost response/);
  const recovered = await redeemEarliestReset(rpc, root, 'fixture-account', attempt, undefined, key);
  assert.equal(recovered.outcome, 'alreadyRedeemed'); assert.equal(calls, 2);
  await redeemEarliestReset(rpc, root, 'fixture-account', attempt, undefined, key); assert.equal(calls,2);
  const receipt = JSON.parse(fs.readFileSync(path.join(root,`${attempt}.json`),'utf8'));
  assert.equal(receipt.source,'auto_quota'); assert.equal(receipt.autoLowQuota,key);
  for (const value of [limits(), { ...data, rateLimitsByLimitId: {} }, limits([])]) {
    const skipped = await redeemEarliestReset(async method => { assert.equal(method,'account/rateLimits/read'); return value; }, temporary(t), 'fixture-account', crypto.randomUUID(), undefined, key);
    assert.equal(skipped.outcome,'notDue');
  }
});

test("low quota keys reject unknown, stale, partial, and above-threshold windows and cross Worker parser correctly", async () => {
  const { lowQuotaKey, resetQuota } = await import('./codex-reset-policy.js');
  const { normalizeResetCredits } = await import('./codex-reset-credits.js');
  const data = limits(), summary = normalizeResetCredits(data);
  for (const [used, eligible] of [[98.99,false],[99,true],[99.5,true],[100,true],[101,true],[-1,false],[NaN,false]] as const) {
    data.rateLimitsByLimitId.codex.primary.usedPercent = used;
    assert.equal(Boolean(lowQuotaKey(resetQuota(data), summary)),eligible);
  }
  assert.equal(lowQuotaKey({ remainingPercent: NaN, resetAt: new Date(future()*1000).toISOString() },summary),null);
  assert.equal(lowQuotaKey({ remainingPercent: 0, resetAt: '2000-01-01T00:00:00.000Z' },summary),null);
  data.rateLimitsByLimitId.codex.primary.usedPercent=100;
  const key = lowQuotaKey(resetQuota(data),summary)!;
  const payload={type:'codex_accounts',requestId:crypto.randomUUID(),action:'reset_credit',accountId:crypto.randomUUID(),attemptId:crypto.randomUUID(),autoLowQuota:key};
  assert.ok(parseServerMessage(JSON.stringify(payload)).ok);
  for(const patch of [{autoLowQuota:true},{autoLowQuota:'[]'},{action:'list'},{autoExpiresAt:new Date().toISOString()}])
    assert.equal(parseServerMessage(JSON.stringify({...payload,...patch})).ok,false);
  assert.notEqual(autoResetAttemptId('first',`quota:${key}`), autoResetAttemptId('second',`quota:${key}`));
});

test("low-quota isolated CLI sessions deduplicate across machine journals with the real transport", async t => {
  const { lowQuotaKey, resetQuota } = await import("./codex-reset-policy.js");
  const { normalizeResetCredits } = await import("./codex-reset-credits.js");
  const root = temporary(t), authFile = path.join(root, 'auth.json'), executable = path.join(root, 'fake.js');
  const log = path.join(root, 'requests'), consumed = path.join(root, 'upstream-receipt');
  const due = Math.floor(Date.now() / 1000) + 1800, expiry = new Date(due * 1000).toISOString();
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { account_id: 'fixture-account', refresh_token: 'private-fixture', access_token: 'fixture' } }));
  const before = fs.readFileSync(authFile, 'utf8');
  const data = limits([credit("due", due)]); data.rateLimitsByLimitId.codex.primary.usedPercent = 100;
  const quotaKey = lowQuotaKey(resetQuota(data), normalizeResetCredits(data))!;
  fs.writeFileSync(executable, `const fs=require('fs'),readline=require('readline'),path=require('path');
    if(JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,'auth.json'))).tokens.refresh_token)throw Error('refresh not stripped');
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};
      if(m.method==='account/rateLimits/read')result=${JSON.stringify(data)};
      if(m.method==='account/rateLimitResetCredit/consume'){
        fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m.params)+'\\n');
        if(fs.existsSync(${JSON.stringify(consumed)})){if(fs.readFileSync(${JSON.stringify(consumed)},'utf8')!==m.params.idempotencyKey)throw Error('duplicate physical spend');result={outcome:'alreadyRedeemed'};}
        else{fs.writeFileSync(${JSON.stringify(consumed)},m.params.idempotencyKey);result={outcome:'reset'};}
      } console.log(JSON.stringify({id:m.id,result}));});`);
  const options = { executable, authFile, expectedAccountId: 'fixture-account', temporaryRoot: path.join(root, 'temp'), autoLowQuota: quotaKey };
  const first = await consumeAccountResetCredit({ ...options, journalRoot: path.join(root, 'server'), attemptId: crypto.randomUUID() });
  const second = await consumeAccountResetCredit({ ...options, journalRoot: path.join(root, 'worker'), attemptId: crypto.randomUUID() });
  const replay = await consumeAccountResetCredit({ ...options, journalRoot: path.join(root, 'server'), attemptId: crypto.randomUUID() });
  assert.equal(first.outcome, 'reset'); assert.equal(second.outcome, 'alreadyRedeemed'); assert.equal(replay.outcome, 'reset');
  assert.equal(first.attemptId, second.attemptId); assert.equal(first.attemptId, autoResetAttemptId('fixture-account', `quota:${quotaKey}`));
  const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.equal(fs.readFileSync(authFile, 'utf8'), before); assert.deepEqual(fs.readdirSync(options.temporaryRoot), []);
  assert.doesNotMatch(JSON.stringify([first, second]), /private-fixture|creditId|fixture-account/);
});
