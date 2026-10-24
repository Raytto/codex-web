import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { GeminiAccountManager, geminiProfileEnvironment, googleAuthorizationUrl, type GeminiRuntime } from "./gemini-accounts.js";
import { isPersistableWorkerMessage, parseServerMessage } from "./protocol-validation.js";
import type { AgentOptions } from "./protocol.js";
import { assertGeminiAccountChangeAllowed } from "./gemini-account-guard.js";
const catalog: AgentOptions = { models: [{ id: "antigravity:gemini", label: "Gemini", description: "", reasoningEfforts: ["high"] }], reasoningEfforts: [{ id: "high", label: "High" }], defaults: { model: "antigravity:gemini", reasoningEffort: "high" } };
const authUrl = "https://accounts.google.com/o/oauth2/auth?client_id=example&state=some-state&code_challenge=pkce&response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback";
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
function fixture(t: test.TestContext, options: { readModels?: (runtime: GeminiRuntime) => Promise<AgentOptions | null>; assertSwitchAllowed?: () => void; now?: () => Date; executable?: () => string | null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-gemini-accounts-"));
  const children: ChildProcess[] = [];
  const manager = new GeminiAccountManager({ root, platform: "linux", executable: () => process.execPath, assertSwitchAllowed: () => {}, readModels: async () => null,
    installRuntime: async () => { throw new Error("fixture refuses installation"); },
    launchLogin: () => { const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] }); children.push(child); return child; }, ...options });
  t.after(async () => { manager.close(); for (const child of children) child.kill("SIGKILL"); await tick(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, manager, children };
}
function prompt(child: ChildProcess): void {
  child.stdout!.emit("data", Buffer.from(`Select login method:\n\u001b]8;;${authUrl}\u001b\\Open authorization page\u001b]8;;\u001b\\\nPaste the authorization code below:`));
}

async function completeLogin(manager: GeminiAccountManager, children: ChildProcess[], label: string): Promise<string> {
  const login = await manager.beginLogin(label); prompt(children.at(-1)!);
  manager.submitCode(login.id, "fixture-code"); manager.loginStatus(login.id);
  for (let i = 0; i < 50 && manager.loginStatus(login.id).status !== "completed"; i++) await tick();
  const completed = manager.loginStatus(login.id);
  assert.equal(completed.status, "completed"); assert.ok(completed.accountId);
  return completed.accountId;
}

test("Gemini account guard ignores Codex activity but blocks Gemini execution and maintenance", () => {
  assert.doesNotThrow(() => assertGeminiAccountChangeAllowed({ activeModels: ["gpt-6-astra", "gpt-5.6-luna", null], runningGeminiJobs: 0 }));
  assert.throws(() => assertGeminiAccountChangeAllowed({ activeModels: ["gpt-6-astra", "antigravity:gemini"] }), /Gemini 任务执行/);
  assert.throws(() => assertGeminiAccountChangeAllowed({ runningGeminiJobs: 1 }), /Gemini 任务执行/);
  assert.throws(() => assertGeminiAccountChangeAllowed({ maintenance: true, activeModels: ["gpt-6-astra"] }), /停止或升级/);
});

test("first Google login auto-activates during Codex activity and explicit Google account switching stays independent", async t => {
  const activeModels = ["gpt-6-astra"];
  const { manager, children } = fixture(t, { readModels: async () => catalog,
    assertSwitchAllowed: () => assertGeminiAccountChangeAllowed({ activeModels }) });
  const first = await completeLogin(manager, children, "First Google");
  assert.equal((await manager.listAccounts()).activeAccountId, first);
  assert.deepEqual(await manager.getModelCatalog(), catalog);
  const second = await completeLogin(manager, children, "Second Google");
  assert.equal((await manager.listAccounts()).activeAccountId, first, "another login must not change an existing selection");
  assert.equal((await manager.activate(second)).activeAccountId, second, "Codex execution must not block explicit activation");
  activeModels.push("antigravity:gemini");
  await assert.rejects(manager.activate(first), /Gemini 任务执行/);
  await assert.rejects(manager.delete(second), /Gemini 任务执行/);
  assert.equal((await manager.listAccounts()).activeAccountId, second);
  activeModels.pop();
  assert.equal((await manager.delete(first)).accounts.length, 1, "Codex execution must not block deleting an unused Google account");
});

test("a saved inactive Google account can be enabled through its normal action after a genuine Gemini busy period", async t => {
  const activeModels = ["antigravity:gemini"];
  const { manager, children } = fixture(t, { readModels: async () => catalog,
    assertSwitchAllowed: () => assertGeminiAccountChangeAllowed({ activeModels }) });
  const login = await manager.beginLogin("Deferred Google"); prompt(children[0]!);
  manager.submitCode(login.id, "fixture-code"); manager.loginStatus(login.id);
  for (let i = 0; i < 50 && manager.loginStatus(login.id).status !== "completed"; i++) await tick();
  const completed = manager.loginStatus(login.id);
  assert.equal(completed.status, "completed"); assert.ok(completed.accountId); assert.match(completed.message!, /启用此账号/);
  const saved = await manager.listAccounts();
  assert.equal(saved.accounts[0]!.authenticated, true); assert.equal(saved.activeAccountId, null);
  assert.equal(await manager.getModelCatalog(), null);
  activeModels.splice(0, 1, "gpt-6-astra");
  const enabled = await manager.handle({ action: "activate", accountId: completed.accountId });
  assert.equal(enabled.state!.activeAccountId, completed.accountId);
  assert.deepEqual(await manager.getModelCatalog(), catalog);
  assert.equal((await manager.getActiveRuntime())?.accountId, completed.accountId);
});

test("an account activation rechecks Gemini execution after awaiting credential verification", async t => {
  const activeModels = ["gpt-6-astra"];
  let deferredAccount: string | undefined, release!: (value: AgentOptions) => void;
  const { manager, children } = fixture(t, { readModels: async runtime => runtime.accountId === deferredAccount
    ? new Promise<AgentOptions>(resolve => { release = resolve; }) : catalog,
    assertSwitchAllowed: () => assertGeminiAccountChangeAllowed({ activeModels }) });
  const first = await completeLogin(manager, children, "First");
  const second = await completeLogin(manager, children, "Second");
  deferredAccount = second;
  const activation = manager.activate(second);
  await tick(); activeModels.push("antigravity:gemini"); release(catalog);
  await assert.rejects(activation, /Gemini 任务执行/);
  deferredAccount = undefined;
  assert.equal((await manager.listAccounts()).activeAccountId, first, "an admitted Gemini run must retain the previous account");
  manager.close();
  await assert.rejects(manager.activate(second), /正在停止/);
});

test("profiles scrub inherited auth and force an isolated Linux credential fallback", () => {
  const base = { HOME: "/unrelated", CODEX_HOME: "/codex", CWW_SHARED_CODEX_AUTH_FILE: "/sensitive", GEMINI_API_KEY: "secret", GOOGLE_APPLICATION_CREDENTIALS: "/cloud", ANTIGRAVITY_GEMINI_DIR: "/shared", AGY_ADC_AUTH: "true", AGY_LLM_GATEWAY_URL: "https://other.invalid", AGY_ACCOUNT: "other", PATH: "/bin", CWW_JOB_ID: "job" };
  const env = geminiProfileEnvironment("/profile", base);
  assert.equal(env.HOME, "/profile"); assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/profile/.dbus-unavailable"); assert.equal(env.XDG_CONFIG_HOME, "/profile/.config");
  for (const name of ["CODEX_HOME", "CWW_SHARED_CODEX_AUTH_FILE", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "ANTIGRAVITY_GEMINI_DIR", "AGY_ADC_AUTH", "AGY_LLM_GATEWAY_URL", "AGY_ACCOUNT"]) assert.equal(env[name], undefined);
  assert.equal(env.CWW_JOB_ID, "job"); assert.equal(base.HOME, "/unrelated");
});

test("only complete Google PKCE links are accepted, including OSC hyperlinks", () => {
  assert.equal(googleAuthorizationUrl(`\u001b]8;;${authUrl}\u001b\\label`), authUrl);
  assert.equal(googleAuthorizationUrl(authUrl.replace("accounts.google.com", "accounts.google.com.evil.test")), null);
  assert.equal(googleAuthorizationUrl(authUrl.replace("antigravity.google", "evil.test")), null);
  assert.equal(googleAuthorizationUrl("https://accounts.google.com/o/oauth2/auth?state=partial"), null);
});

test("missing runtime has no accounts/catalog and cannot start a fake login", async t => {
  const { manager } = fixture(t, { executable: () => null });
  assert.equal((await manager.listAccounts()).runtimeAvailable, false);
  assert.equal(await manager.getModelCatalog(), null);
  assert.equal(await manager.getActiveRuntime(), null);
  const login = await manager.beginLogin("test"); await tick();
  assert.equal(manager.loginStatus(login.id).status, "failed");
});

test("parallel account, catalog and run checks share a full-budget CLI probe without caching failures", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-gemini-catalog-budget-"));
  const executable = path.join(root, "agy.cjs");
  const stateFile = path.join(root, "probe-state.json"), captureFile = path.join(root, "probe-calls.txt");
  fs.writeFileSync(stateFile, JSON.stringify({ delayMs: 4_200, authenticated: true }));
  fs.writeFileSync(executable, `
    const fs = require('node:fs');
    if (process.argv.includes('--version')) { process.stdout.write('1.4.6\\n'); process.exit(0); }
    fs.appendFileSync(${JSON.stringify(captureFile)}, 'models\\n');
    const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
    setTimeout(() => {
      if (!state.authenticated) { process.stderr.write('Please sign in.'); process.exitCode = 1; }
      else process.stdout.write(JSON.stringify({ models: ['gemini-fixture-high'] }));
    }, state.delayMs);
  `);
  const manager = new GeminiAccountManager({ root, platform: "linux", executable: () => executable, assertSwitchAllowed: () => {} });
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const id = "76ec966c-d7ce-4082-8278-130b5b8e9ec9";
  fs.mkdirSync(path.join(root, "profiles", id));
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, activeAccountId: id,
    accounts: [{ id, label: "Fixture", email: null, createdAt: new Date().toISOString(), lastUsedAt: null }] }));
  // Status starts first: its former 4s deadline would also cancel the other two.
  const [accounts, models, runtime] = await Promise.all([manager.listAccounts(), manager.getModelCatalog(), manager.getActiveRuntime()]);
  assert.equal(accounts.accounts[0]!.authenticated, true);
  assert.equal(models?.models[0]?.id, "antigravity:gemini-fixture");
  assert.equal(runtime?.accountId, id);
  assert.equal(fs.readFileSync(captureFile, "utf8"), "models\n", "concurrent consumers share one CLI process");
  fs.writeFileSync(stateFile, JSON.stringify({ delayMs: 0, authenticated: false }));
  assert.equal((await manager.listAccounts()).accounts[0]!.authenticated, false, "saved account alone cannot prove authentication");
  fs.writeFileSync(stateFile, JSON.stringify({ delayMs: 0, authenticated: true }));
  assert.equal((await manager.getModelCatalog())?.models.length, 1, "a failed probe must not poison subsequent discovery");
  assert.equal(fs.readFileSync(captureFile, "utf8"), "models\nmodels\nmodels\n");
});

test("a failed native version probe is shared but later account refresh can verify the unchanged executable", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-gemini-version-recovery-"));
  const executable = path.join(root, "agy.cjs"), captureFile = path.join(root, "probe-calls.txt");
  fs.writeFileSync(executable, `
    const fs = require('node:fs');
    const capture = ${JSON.stringify(captureFile)};
    if (process.argv.includes('--version')) {
      const previous = fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : '';
      fs.appendFileSync(capture, 'version\\n');
      if (!previous.includes('version')) { process.stderr.write('Temporary probe failure'); process.exit(1); }
      process.stdout.write('1.4.6\\n'); process.exit(0);
    }
    fs.appendFileSync(capture, 'models\\n');
    process.stdout.write(JSON.stringify({ models: ['gemini-fixture-high'] }));
  `);
  const manager = new GeminiAccountManager({ root, platform: "linux", executable: () => executable, assertSwitchAllowed: () => {} });
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const id = "68a27f57-d7ce-4082-8278-130b5b8e9ec9";
  fs.mkdirSync(path.join(root, "profiles", id));
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, activeAccountId: id,
    accounts: [{ id, label: "Fixture", email: null, createdAt: new Date().toISOString(), lastUsedAt: null }] }));
  const before = fs.statSync(executable);
  const failed = await Promise.all([manager.listAccounts(), manager.getModelCatalog(), manager.getActiveRuntime()]);
  assert.equal(failed[0].accounts[0]!.authenticated, false);
  assert.equal(failed[0].error, "部分账号状态查询未完成，请稍后刷新。");
  assert.equal(failed[1], null); assert.equal(failed[2], null);
  assert.equal(fs.readFileSync(captureFile, "utf8"), "version\n", "concurrent readers share the rejected check");
  const recovered = await Promise.all([manager.listAccounts(), manager.getModelCatalog(), manager.getActiveRuntime()]);
  assert.equal(recovered[0].accounts[0]!.authenticated, true);
  assert.equal(recovered[0].error, undefined);
  assert.equal(recovered[1]?.models[0]?.id, "antigravity:gemini-fixture");
  assert.equal(recovered[2]?.accountId, id);
  assert.equal(fs.readFileSync(captureFile, "utf8"), "version\nversion\nmodels\n");
  assert.equal(fs.statSync(executable).mtimeMs, before.mtimeMs, "recovery must not require replacing the runtime");
  await manager.getModelCatalog();
  assert.equal(fs.readFileSync(captureFile, "utf8"), "version\nversion\nmodels\nmodels\n", "successful version verification remains cached");
});

test("account status distinguishes failed network or JSON probes from a normal empty result without leaking CLI errors", async t => {
  let result: AgentOptions | null = null;
  let failure: Error | null = null;
  const { manager, root } = fixture(t, { readModels: async () => { if (failure) throw failure; return result; } });
  const id = "70bc1e7c-d7ce-4082-8278-130b5b8e9ec9";
  fs.mkdirSync(path.join(root, "profiles", id));
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, activeAccountId: id,
    accounts: [{ id, label: "Fixture", email: null, createdAt: new Date().toISOString(), lastUsedAt: null }] }));
  for (const error of [new Error("Network failed; synthetic-private-detail"), new SyntaxError("Unexpected model JSON; synthetic-private-detail")]) {
    failure = error;
    const state = await manager.listAccounts();
    assert.equal(state.accounts[0]!.authenticated, false);
    assert.equal(state.error, "部分账号状态查询未完成，请稍后刷新。");
    assert.ok(!JSON.stringify(state).includes("synthetic-private-detail"));
  }
  failure = null;
  const empty = await manager.listAccounts();
  assert.equal(empty.accounts[0]!.authenticated, false);
  assert.equal(empty.error, undefined, "a successful empty result is not a failed status query");
  result = catalog;
  const recovered = await manager.listAccounts();
  assert.equal(recovered.accounts[0]!.authenticated, true);
  assert.equal(recovered.error, undefined, "subsequent successful discovery clears the status error");
});

test("account status has a total RPC budget without cancelling a shared catalog probe", async t => {
  const pending: Array<(value: AgentOptions) => void> = [];
  const { manager, root } = fixture(t, { readModels: () => new Promise(resolve => { pending.push(resolve); }) });
  const accounts = Array.from({ length: 20 }, (_, index) => ({
    id: `${String(index).padStart(8, "0")}-d7ce-4082-8278-130b5b8e9ec9`,
    label: `Fixture ${index}`, email: null, createdAt: new Date().toISOString(), lastUsedAt: null,
  }));
  for (const entry of accounts) fs.mkdirSync(path.join(root, "profiles", entry.id));
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, activeAccountId: accounts[0]!.id, accounts }));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const listing = manager.listAccounts();
    const sharedCatalog = manager.getModelCatalog();
    await Promise.resolve();
    assert.equal(pending.length, 4, "the account list must retain its concurrency bound");
    t.mock.timers.tick(24_000);
    const state = await listing;
    assert.match(state.error!, /部分账号状态查询超时/);
    assert.equal(state.accounts.length, 20);
    assert.equal(pending.length, 4, "do not launch more probes after the overall deadline");
    for (const resolve of pending) resolve(catalog);
    assert.deepEqual(await sharedCatalog, catalog, "status timeout must not cancel or poison another consumer");
  } finally {
    for (const resolve of pending) resolve(catalog);
    t.mock.timers.reset();
  }
});

test("Google login success requires authenticated catalog, and credentials stay private", async t => {
  let authenticated = false;
  const { manager, children, root } = fixture(t, { readModels: async runtime => {
    assert.ok(runtime.home.startsWith(root)); return authenticated ? catalog : null;
  } });
  const login = await manager.beginLogin("Google 账号"); prompt(children[0]!);
  const waiting = manager.loginStatus(login.id);
  assert.equal(waiting.status, "waiting"); assert.equal(waiting.requiresCode, true);
  assert.throws(() => manager.submitCode(login.id, "bad\ncode"), /授权码/);
  manager.submitCode(login.id, "one-time-code");
  manager.loginStatus(login.id); await tick();
  assert.equal(manager.loginStatus(login.id).status, "waiting");
  assert.equal((await manager.listAccounts()).accounts.length, 0);
  authenticated = true; manager.loginStatus(login.id);
  for (let i = 0; i < 30 && manager.loginStatus(login.id).status !== "completed"; i++) await tick();
  const completed = manager.loginStatus(login.id); assert.equal(completed.status, "completed");
  const state = await manager.listAccounts(); assert.equal(state.accounts.length, 1); assert.equal(state.accounts[0]!.authenticated, true); assert.equal(state.activeAccountId, completed.accountId);
  const runtime = await manager.getActiveRuntime(); assert.equal(runtime?.accountId, completed.accountId);
  assert.equal(fs.statSync(path.join(root, "index.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runtime!.home).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(state).includes("one-time-code")); assert.ok(!JSON.stringify(state).includes(root));
  authenticated = false;
  assert.equal((await manager.listAccounts()).accounts[0]!.authenticated, false);
  assert.equal(await manager.getModelCatalog(), null); assert.equal(await manager.getActiveRuntime(), null);
  await assert.rejects(manager.activate(completed.accountId!), /失效/);
});

test("cancelled login cannot become an account when an in-flight auth probe completes", async t => {
  let release!: (value: AgentOptions) => void;
  const { manager, children } = fixture(t, { readModels: () => new Promise(resolve => { release = resolve; }) });
  const login = await manager.beginLogin("test"); prompt(children[0]!); manager.submitCode(login.id, "code"); manager.loginStatus(login.id); await tick();
  assert.equal(manager.cancelLogin(login.id).status, "cancelled"); release(catalog); await tick();
  assert.equal(manager.loginStatus(login.id).status, "cancelled"); assert.equal((await manager.listAccounts()).accounts.length, 0);
});

test("a zero-exit CLI without authentication is failure and expired logins reject codes", async t => {
  let now = new Date();
  const { manager, children } = fixture(t, { now: () => now });
  const first = await manager.beginLogin("first"); children[0]!.emit("close", 0); await tick();
  assert.equal(manager.loginStatus(first.id).status, "failed");
  const next = await manager.beginLogin("second"); prompt(children[1]!); now = new Date(now.getTime() + 16 * 60_000);
  assert.equal(manager.loginStatus(next.id).status, "cancelled"); assert.throws(() => manager.submitCode(next.id, "code"), /不接受/);
});

test("Gemini wire requests are bounded and responses are sendable; Codex remains compatible", () => {
  const requestId = "c3741b30-7a0e-4b3b-9ec1-9816437d1910", loginId = "219d0c61-b266-4c16-a91b-0daac0510295";
  const request = { type: "gemini_accounts", requestId, action: "login_code", loginId, code: "test" };
  assert.equal(parseServerMessage(JSON.stringify(request)).ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ ...request, code: "bad\ncode" })).ok, false);
  assert.equal(parseServerMessage(JSON.stringify({ ...request, extra: true })).ok, false);
  assert.equal(parseServerMessage(JSON.stringify({ type: "codex_accounts", requestId, action: "list" })).ok, true);
  assert.equal(isPersistableWorkerMessage({ type: "gemini_accounts_result", requestId, ok: true, state: { accounts: [], activeAccountId: null, runtimeAvailable: false } }), true);
  assert.equal(isPersistableWorkerMessage({ type: "gemini_accounts_result", requestId, ok: true, catalog }), true);
});

test("ConPTY adapter forwards authorization input and terminates without exposing transcript", async () => {
  const { childProcessFromPty } = await import("./gemini-login-terminal.js");
  let data: ((value: string) => void) | undefined, exit: ((event: { exitCode: number }) => void) | undefined;
  const writes: string[] = [];
  let kills = 0;
  const child = childProcessFromPty({ pid: 123, write: value => { writes.push(value); }, kill: () => { kills++; exit!({ exitCode: 0 }); },
    onData: handler => { data = handler; }, onExit: handler => { exit = handler; } });
  const output: string[] = []; child.stdout!.on("data", chunk => output.push(String(chunk)));
  data!("OAuth prompt"); child.stdin!.write("fixture-code\r");
  assert.deepEqual(writes, ["fixture-code\r"]); assert.deepEqual(output, ["OAuth prompt"]);
  let closed = false; child.on("close", () => { closed = true; });
  child.kill("SIGTERM"); assert.equal(kills, 1); assert.equal(closed, true); assert.equal(child.exitCode, 0);
});

test("cancelling first-use installation prevents an orphan Google login process", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-install-cancel-"));
  let finishInstall!: (path: string) => void;
  let launched = 0;
  const manager = new GeminiAccountManager({ root, platform: "linux", executable: () => null, assertSwitchAllowed: () => {},
    installRuntime: () => new Promise(resolve => { finishInstall = resolve; }), launchLogin: () => { launched++; throw new Error("must not launch"); } });
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const state = await manager.listAccounts(); assert.equal(state.runtimeAvailable, false); assert.equal(state.loginAvailable, true);
  const login = await manager.beginLogin("Install"); assert.equal(login.status, "starting");
  manager.cancelLogin(login.id); finishInstall(process.execPath); await tick();
  assert.equal(launched, 0); assert.equal(manager.loginStatus(login.id).status, "cancelled"); assert.equal((await manager.listAccounts()).accounts.length, 0);
});
