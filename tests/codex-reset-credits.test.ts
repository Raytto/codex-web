import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeResetCredits, unavailableResetCredits } from "../remote-worker/src/codex-reset-credits.js";
import { readAccountResetCredits } from "../remote-worker/src/codex-usage-reader.js";
import { normalizeCodexQuotaUsage } from "../server/app-server-turn.js";
import { CodexAccountManager } from "../server/codex-account-manager.js";
import { AppDatabase } from "../server/db.js";
import { CodexResetCreditDetails } from "../src/codex-reset-credits.js";

const date = new Date("2026-09-23T04:00:00Z");
const input = { rateLimitResetCredits: { availableCount: 3, credits: [
  { id: "late", status: "available", resetType: "codexRateLimits", expiresAt: date.getTime() / 1000 + 86400 * 3 },
  { id: "early", status: "available", resetType: "codexRateLimits", expiresAt: date.getTime() / 1000 + 86400 },
  { id: "forever", status: "available", resetType: "codexRateLimits", expiresAt: null },
] } };

test("reset snapshots persist independently of ordinary quota, scoped by machine and account", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reset-db-"));
  let db = new AppDatabase(root, undefined, false);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  const observation = normalizeResetCredits(input, date);
  const usage = normalizeCodexQuotaUsage({ ...input, rateLimits: { primary: null } });
  assert.ok(usage?.resetCredits); assert.equal(usage.remainingPercent, null);
  db.setExecutorCodexQuota("remote:one", { remainingPercent: null, resetCredits: observation }, a);
  assert.equal(db.getAccountResetCredits("remote:one", a)?.availableCount, 3);
  assert.equal(db.getAccountResetCredits("remote:two", a), null);
  assert.equal(db.getAccountResetCredits("remote:one", b), null);
  db.setAccountResetCredits("remote:one", b, normalizeResetCredits({ rateLimitResetCredits: { availableCount: 0 } }, date));
  assert.equal(db.getExecutorActiveCodexAccount("remote:one"), a);
  db.setAccountResetCredits("remote:one", a, unavailableResetCredits("auth_required", new Date(date.getTime() + 1000)));
  db.close(); db = new AppDatabase(root, undefined, false);
  const saved = db.getAccountResetCredits("remote:one", a);
  assert.equal(saved?.availableCount, 3); assert.equal(saved?.updatedAt, date.toISOString());
  assert.equal(saved?.state, "auth_required");
  assert.equal(db.getAccountResetCredits("remote:one", b)?.availableCount, 0);
});

test("account card renders count, earliest expiry, partial/unknown and stale states honestly", () => {
  const value = normalizeResetCredits(input, date);
  const render = (v = value, now = date.getTime()) => renderToStaticMarkup(createElement(CodexResetCreditDetails, { value: v, now }));
  assert.match(render(), /重置卡剩余.*3 次/); assert.match(render(), /最早到期/);
  assert.match(render({ ...value, expiryStatus: "partial" }), /已知最早到期/);
  assert.match(render({ ...value, earliestExpiresAt: null, expiryStatus: "unknown" }), /到期时间暂无数据/);
  assert.match(render({ ...value, earliestExpiresAt: null }), /无到期限制/);
  assert.doesNotMatch(render({ ...value, availableCount: 0 }), /最早到期|无到期限制/);
  assert.match(render(unavailableResetCredits("auth_required", date)), /登录状态待更新/);
  assert.match(render(value, date.getTime() + 86400 * 1000 * 2), /上次查询.*已到期，请刷新/);
  assert.doesNotMatch(render(), /late|early|forever/);
});

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reset-reader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = path.join(root, "auth", "host-root", "auth.json");
  fs.mkdirSync(path.dirname(authority), { recursive: true });
  fs.writeFileSync(authority, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "account-fixture", id_token: "header.e30.signature", access_token: "access-fixture", refresh_token: "original-fixture" } }));
  const executable = path.join(root, "mock-codex.js");
  fs.writeFileSync(executable, `const fs=require('fs'),path=require('path'),rl=require('readline');
const file=path.join(process.env.CODEX_HOME,'auth.json');
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(!m.id)return;
fs.appendFileSync(${JSON.stringify(path.join(root, "methods"))},m.method+'\\n');
if(m.method==='initialize')return console.log(JSON.stringify({id:m.id,result:{}}));
if(m.method!=='account/rateLimits/read')throw Error('unexpected method');
const a=JSON.parse(fs.readFileSync(file));if(a.tokens.refresh_token){a.tokens.refresh_token='rotated-fixture';fs.writeFileSync(file,JSON.stringify(a));}
console.log(JSON.stringify({id:m.id,result:{accountId:process.env.FAKE_WRONG_ACCOUNT?'other':a.tokens.account_id,rateLimitResetCredits:{availableCount:3,credits:null}}}));
});`);
  return { root, authority, executable };
}

test("isolated reader never redeems, checks identity and cannot rotate access-only source credentials", async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.authority, "utf8");
  const options = { executable: f.executable, authFile: f.authority, expectedAccountId: "account-fixture", temporaryRoot: path.join(f.root, "reads") };
  const value = await readAccountResetCredits(options);
  assert.equal(value.availableCount, 3); assert.equal(value.expiryStatus, "unknown");
  assert.equal(fs.readFileSync(f.authority, "utf8"), before);
  assert.deepEqual(fs.readdirSync(options.temporaryRoot), []);
  assert.equal((await readAccountResetCredits({ ...options, env: { ...process.env, FAKE_WRONG_ACCOUNT: "1" } })).state, "error");
  assert.deepEqual(new Set(fs.readFileSync(path.join(f.root, "methods"), "utf8").trim().split("\n")), new Set(["initialize", "account/rateLimits/read"]));
});

test("server account refresh commits rotated auth under the existing lock, deduplicates and never switches", async (t) => {
  const f = fixture(t);
  const manager = new CodexAccountManager({ authorityFile: f.authority, lockFile: path.join(f.root, "refresh.lock"), policyFile: path.join(f.root, "policy.json"), codexExecutable: f.executable, assertSwitchAllowed() { throw Error("must not switch"); } });
  t.after(() => manager.close());
  const before = await manager.listAccounts();
  const [one, two] = await Promise.all([manager.listAccounts(true), manager.listAccounts(true)]);
  assert.equal(one.activeAccountId, before.activeAccountId); assert.equal(two.activeAccountId, before.activeAccountId);
  assert.equal(one.accounts[0].resetCredits?.availableCount, 3);
  assert.equal(JSON.parse(fs.readFileSync(f.authority, "utf8")).tokens.refresh_token, "rotated-fixture");
  assert.equal(fs.readFileSync(path.join(f.root, "methods"), "utf8").split("account/rateLimits/read").length - 1, 1);
  assert.doesNotMatch(JSON.stringify(one), /access-fixture|rotated-fixture|account-fixture/);
});


test("server redemption holds account lock, refreshes credentials and preserves the active account", async (t) => {
  const f = fixture(t);
  let source = fs.readFileSync(f.executable, "utf8");
  source = source.replace("if(m.method!=='account/rateLimits/read')", "if(m.method==='account/rateLimitResetCredit/consume')return console.log(JSON.stringify({id:m.id,result:{outcome:'reset'}}));\nif(m.method!=='account/rateLimits/read')");
  source = source.replace("credits:null", "credits:[{id:'late',status:'available',resetType:'codexRateLimits',expiresAt:Date.now()/1000+20000},{id:'early',status:'available',resetType:'codexRateLimits',expiresAt:Date.now()/1000+10000},{id:'forever',status:'available',resetType:'codexRateLimits',expiresAt:null}]");
  fs.writeFileSync(f.executable, source);
  const manager = new CodexAccountManager({ authorityFile: f.authority, lockFile: path.join(f.root, "refresh.lock"), policyFile: path.join(f.root, "policy.json"), codexExecutable: f.executable, assertSwitchAllowed() { throw Error("must not switch"); } });
  t.after(() => manager.close());
  const before = await manager.listAccounts();
  const attemptId = crypto.randomUUID();
  const [one, two] = await Promise.all([manager.consumeResetCredit(before.activeAccountId, attemptId), manager.consumeResetCredit(before.activeAccountId, attemptId)]);
  assert.equal(one.outcome, "reset"); assert.equal(one.attemptId, two.attemptId);
  assert.equal((await manager.listAccounts()).activeAccountId, before.activeAccountId);
  assert.equal(JSON.parse(fs.readFileSync(f.authority, "utf8")).tokens.refresh_token, "rotated-fixture");
  assert.equal(fs.readFileSync(path.join(f.root, "methods"), "utf8").split("account/rateLimitResetCredit/consume").length - 1, 1);
});
