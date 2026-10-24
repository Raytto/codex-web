import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ANTIGRAVITY_VERIFIED_VERSION, runAntigravityCommand, ensureAntigravityInstalled, managedAntigravityExecutable, readAntigravityModels } from "./antigravity-runtime.js";
import { launchWindowsGeminiTerminal, windowsGeminiTerminalAvailable } from "./gemini-login-terminal.js";
import type { AgentOptions } from "./protocol.js";
import type { GeminiAccountLoginView, GeminiAccountRequest, GeminiAccountResult, GeminiAccountsState, GeminiAccountView } from "./gemini-account-types.js";
import { readAntigravityUsage, unavailableAntigravityUsage } from "./antigravity-usage.js";
import type { AntigravityUsage } from "./antigravity-usage-types.js";

export type GeminiRuntime = { home: string; executable: string; accountId: string; env: NodeJS.ProcessEnv };
type Entry = Omit<GeminiAccountView, "active" | "authenticated">;
type Registry = { version: 1; activeAccountId: string | null; accounts: Entry[] };
type Login = GeminiAccountLoginView & { home: string; child: ChildProcess | null; output: string; selectedGoogle: boolean; codeSubmitted: boolean; checking: boolean; finishing: boolean; timer: ReturnType<typeof setTimeout> };
type Options = { installRuntime?: () => Promise<string>; root: string; assertSwitchAllowed(): void; executable?: () => string | null; now?: () => Date;
  readModels?: (runtime: GeminiRuntime) => Promise<AgentOptions | null>;
  readUsage?: (runtime: GeminiRuntime, previous?: AntigravityUsage) => Promise<AntigravityUsage>;
  launchLogin?: (runtime: GeminiRuntime) => ChildProcess;
  platform?: NodeJS.Platform;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = new Set(["starting", "waiting"]);
const LOGIN_MS = 15 * 60_000;
const safeLabel = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 60) || "Gemini 账号";

/** Credentials never leave these node-local profiles or enter the web database. */
export class GeminiAccountManager {
  private readonly root: string;
  private readonly profiles: string;
  private readonly loginsRoot: string;
  private readonly index: string;
  private readonly logins = new Map<string, Login>();
  private readonly checkedVersions = new Map<string, Promise<void>>();
  private readonly modelReads = new Map<string, Promise<AgentOptions | null>>();
  private readonly usageReads = new Map<string, Promise<AntigravityUsage>>();
  private readonly usageCache = new Map<string, { value: AntigravityUsage; readAt: number }>();
  private readonly now: () => Date;
  private closed = false;
  private provisionedExecutable: string | null = null;

  constructor(private readonly options: Options) {
    this.root = path.resolve(options.root);
    this.profiles = path.join(this.root, "profiles");
    this.loginsRoot = path.join(this.root, "logins");
    this.index = path.join(this.root, "index.json");
    this.now = options.now ?? (() => new Date());
    for (const directory of [this.root, this.profiles, this.loginsRoot]) privateDirectory(directory);
    for (const name of fs.readdirSync(this.loginsRoot)) if (UUID.test(name)) fs.rmSync(path.join(this.loginsRoot, name), { recursive: true, force: true });
  }

  private availability(): { executable: string | null; loginAvailable: boolean; error?: string } {
    const platform = this.options.platform ?? process.platform;
    if (!["linux", "win32"].includes(platform)) return { executable: null, loginAvailable: false, error: "此节点的 Gemini 登录暂不支持安全隔离的凭据存储；Codex 可继续使用。" };
    if (!this.options.launchLogin && platform === "linux" && !fs.existsSync("/usr/bin/script")) return { executable: null, loginAvailable: false, error: "此节点缺少 Gemini 登录所需的终端组件 script。" };
    if (!this.options.launchLogin && platform === "win32" && !windowsGeminiTerminalAvailable()) return { executable: null, loginAvailable: false, error: "此节点尚未安装 Gemini 登录所需的 ConPTY 组件，请升级或修复 Worker 后重试。" };
    const executable = this.provisionedExecutable ?? (this.options.executable ? this.options.executable() : managedAntigravityExecutable(this.root));
    if (!executable) return { executable: null, loginAvailable: true, error: "此节点尚未安装 Antigravity CLI；首次登录将下载并校验 Google 官方运行程序。" };
    return { executable, loginAvailable: true };
  }

  private runtime(home: string, accountId: string, executable: string): GeminiRuntime {
    return { home, accountId, executable, env: geminiProfileEnvironment(home) };
  }

  private models(runtime: GeminiRuntime): Promise<AgentOptions | null> {
    const pending = this.modelReads.get(runtime.home); if (pending) return pending;
    const read = Promise.resolve().then(async () => {
      if (this.options.readModels) return this.options.readModels(runtime);
      await this.verifyExecutable(runtime);
      // Account status and catalog share a probe. A short status-only timeout
      // would also cancel a concurrent catalog/run check and hide valid models.
      return readAntigravityModels({ executable: runtime.executable, env: runtime.env, cwd: runtime.home, timeoutMs: 15_000 });
    })
      .finally(() => this.modelReads.delete(runtime.home));
    this.modelReads.set(runtime.home, read); return read;
  }

  private verifyExecutable(runtime: GeminiRuntime): Promise<void> {
    const stat = fs.statSync(runtime.executable);
    const key = `${runtime.executable}:${stat.size}:${stat.mtimeMs}`;
    const pending = this.checkedVersions.get(key); if (pending) return pending;
    const checked = runAntigravityCommand(["--version"], { executable: runtime.executable, env: runtime.env, cwd: runtime.home, timeoutMs: 5_000 }).then(result => {
      if (result.code !== 0 || result.stdout.trim() !== ANTIGRAVITY_VERIFIED_VERSION) throw new Error("Gemini 引擎版本未经账号隔离验证，请重新安装受管版本。");
    }).catch(error => {
      // Transient process/network failures must not poison all future refreshes.
      // A different runtime check may have replaced this entry in the meantime.
      if (this.checkedVersions.get(key) === checked) this.checkedVersions.delete(key);
      throw error;
    });
    this.checkedVersions.clear(); this.checkedVersions.set(key, checked);
    return checked;
  }

  async listAccounts(): Promise<GeminiAccountsState> {
    const availability = this.availability();
    const registry = this.readRegistry();
    const deadline = Date.now() + 24_000; // Leave room in the 30s host/worker RPC.
    let statusTimedOut = false;
    let statusIncomplete = false;
    const accounts = await mapLimited(registry.accounts, 4, async (entry) => {
      let authenticated = false;
      if (availability.executable) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) statusTimedOut = true;
        else {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // Only stop this caller's wait. A catalog/run may share the probe.
            const result = await Promise.race([
              this.models(this.runtime(this.profile(entry.id), entry.id, availability.executable)),
              new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), remaining); }),
            ]);
            if (result === "timeout") statusTimedOut = true;
            else authenticated = Boolean(result?.models.length);
          } catch (error) {
            if (error instanceof Error && error.message.includes("查询超时")) statusTimedOut = true;
            else statusIncomplete = true;
            // Never infer authentication from a saved record.
          } finally { if (timer) clearTimeout(timer); }
        }
      }
      return { ...entry, active: entry.id === registry.activeAccountId, authenticated };
    });
    const current = this.readRegistry();
    const authenticatedById = new Map(accounts.map(account => [account.id, account.authenticated]));
    const currentAccounts = current.accounts.map(entry => ({ ...entry, active: entry.id === current.activeAccountId, authenticated: authenticatedById.get(entry.id) ?? false }));
    // Probe failures are not proof that credentials expired. Do not expose raw
    // CLI errors, which may contain account or connection details.
    const error = availability.error ?? (statusTimedOut ? "部分账号状态查询超时，请稍后刷新。"
      : statusIncomplete ? "部分账号状态查询未完成，请稍后刷新。" : undefined);
    return { accounts: currentAccounts, activeAccountId: current.activeAccountId, runtimeAvailable: Boolean(availability.executable), loginAvailable: availability.loginAvailable, ...(error ? { error } : {}) };
  }

  async getActiveRuntime(): Promise<GeminiRuntime | null> {
    const availability = this.availability();
    const registry = this.readRegistry();
    if (!availability.executable || !registry.activeAccountId || !registry.accounts.some(entry => entry.id === registry.activeAccountId)) return null;
    const runtime = this.runtime(this.profile(registry.activeAccountId), registry.activeAccountId, availability.executable);
    try { if (!(await this.models(runtime))?.models.length) return null; } catch { return null; }
    // Activation/deletion may have happened while the CLI was checking credentials.
    if (this.readRegistry().activeAccountId !== runtime.accountId) return null;
    return runtime;
  }

  async getModelCatalog(): Promise<AgentOptions | null> {
    const availability = this.availability();
    const registry = this.readRegistry();
    if (!availability.executable || !registry.activeAccountId || !registry.accounts.some(entry => entry.id === registry.activeAccountId)) return null;
    try {
      const catalog = await this.models(this.runtime(this.profile(registry.activeAccountId), registry.activeAccountId, availability.executable));
      return this.readRegistry().activeAccountId === registry.activeAccountId ? catalog : null;
    } catch { return null; }
  }

  async getUsage(accountId?: string, refresh = false): Promise<AntigravityUsage> {
    if (accountId !== undefined) requireUuid(accountId);
    const registry = this.readRegistry(), id = accountId ?? registry.activeAccountId;
    if (!id || !registry.accounts.some(entry => entry.id === id)) return unavailableAntigravityUsage(null, "当前机器尚未启用 Google 账号。", this.now());
    const executable = this.availability().executable;
    if (!executable) return unavailableAntigravityUsage(id, "当前机器的 Antigravity 服务不可用。", this.now());
    const cached = this.usageCache.get(id);
    const age = this.now().getTime() - (cached?.readAt ?? 0);
    // A manual refresh is still throttled; concurrent menus/account cards share
    // one probe. Failed reads retain values and their original sample times.
    let value: AntigravityUsage;
    if (cached && age >= 0 && age < (refresh ? 5_000 : cached.value.state === "ok" ? 60_000 : 15_000)) value = cached.value;
    else {
      let pending = this.usageReads.get(id);
      if (!pending) {
        if (this.usageReads.size >= 2) return { ...(cached?.value ?? unavailableAntigravityUsage(id, "", this.now())), state: "error", checkedAt: this.now().toISOString(), error: "当前机器正在查询其他账号用量，请稍后刷新。已有数值为上次成功查询结果。" };
        const runtime = this.runtime(this.profile(id), id, executable);
        pending = Promise.resolve().then(async () => {
          if (!this.options.readUsage) await this.verifyExecutable(runtime);
          return this.options.readUsage ? this.options.readUsage(runtime, cached?.value)
            : readAntigravityUsage({ executable, env: runtime.env, cwd: runtime.home, accountId: id, previous: cached?.value });
        }).catch((): AntigravityUsage => ({ ...(cached?.value ?? unavailableAntigravityUsage(id, "", this.now())),
          state: "error", checkedAt: this.now().toISOString(), error: "Antigravity 用量查询未完成，请稍后刷新。已有数值为上次成功查询结果。" }))
          .then(result => {
            if (this.readRegistry().accounts.some(entry => entry.id === id)) this.usageCache.set(id, { value: result, readAt: this.now().getTime() });
            return result;
          }).finally(() => this.usageReads.delete(id));
        this.usageReads.set(id, pending);
      }
      value = await pending;
    }
    const current = this.readRegistry();
    if (!current.accounts.some(entry => entry.id === id) || (!accountId && current.activeAccountId !== id)) return unavailableAntigravityUsage(null, "Google 账号已变更，请刷新用量。", this.now());
    return value;
  }

  async beginLogin(label: string): Promise<GeminiAccountLoginView> {
    if (this.closed) throw new Error("账号管理服务正在停止。");
    const availability = this.availability();
    if (!availability.loginAvailable) throw new Error(availability.error);
    if (this.readRegistry().accounts.length >= 20) throw new Error("此节点最多保存 20 个 Gemini 账号。");
    if ([...this.logins.values()].some(login => LIVE.has(login.status))) throw new Error("此节点已有 Gemini 登录正在进行，请先完成或取消。");
    const id = crypto.randomUUID(), createdAt = this.now().toISOString();
    const home = path.join(this.loginsRoot, id);
    privateDirectory(home);
    const timer = setTimeout(() => { if (this.logins.has(id)) this.cancelLogin(id, "Google 登录已超时，请重新发起。"); }, LOGIN_MS);
    timer.unref();
    const login: Login = { id, label: safeLabel(label), status: "starting", verificationUrl: null, requiresCode: false,
      message: null, accountId: null, createdAt, expiresAt: new Date(this.now().getTime() + LOGIN_MS).toISOString(), home,
      child: null, output: "", selectedGoogle: false, codeSubmitted: false, checking: false, finishing: false, timer };
    this.logins.set(id, login);
    void this.launch(login, availability.executable);
    return this.loginView(login);
  }

  private async launch(login: Login, installed: string | null): Promise<void> {
    let executable = installed;
    if (!executable) {
      login.message = "正在下载并校验 Google 官方 Antigravity CLI…";
      try { executable = await (this.options.installRuntime ? this.options.installRuntime() : ensureAntigravityInstalled({ root: this.root, env: geminiProfileEnvironment(login.home) })); this.provisionedExecutable = executable; }
      catch { this.failLogin(login, "Antigravity CLI 下载或校验失败，请检查此节点网络后重新尝试。"); return; }
      if (this.closed || !LIVE.has(login.status)) return;
    }
    const home = login.home;
    const runtime = this.runtime(home, login.id, executable);
    try {
      if (!this.options.launchLogin) await this.verifyExecutable(runtime);
      if (this.closed || !LIVE.has(login.status)) return;
      login.child = this.options.launchLogin ? this.options.launchLogin(runtime)
        : (this.options.platform ?? process.platform) === "win32" ? launchWindowsGeminiTerminal(runtime.executable, home, runtime.env)
        : spawn("/usr/bin/script", ["-q", "-f", "-e", "-c", `stty cols 240 rows 80 && exec ${shellQuote(runtime.executable)}`, "/dev/null"], {
          cwd: home, env: { ...runtime.env, TERM: "xterm-256color", SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22" }, stdio: ["pipe", "pipe", "pipe"], detached: true,
        });
      const output = (data: Buffer) => this.loginOutput(login, data.toString("utf8"));
      login.child.stdout?.on("data", output);
      login.child.stderr?.on("data", output);
      login.child.on("error", () => this.failLogin(login, "Antigravity CLI 无法启动，请检查此节点的安装。"));
      login.child.on("close", () => {
        login.child = null;
        if (!LIVE.has(login.status) || login.finishing) return;
        void this.verifyLogin(login, true);
      });
    } catch { this.failLogin(login, "Antigravity CLI 登录终端无法启动。"); }
  }

  loginStatus(id: string): GeminiAccountLoginView {
    const login = this.login(id);
    if (LIVE.has(login.status) && this.now().getTime() >= Date.parse(login.expiresAt)) return this.cancelLogin(id, "Google 登录已超时，请重新发起。");
    if (LIVE.has(login.status) && login.codeSubmitted) void this.verifyLogin(login);
    return this.loginView(login);
  }

  submitCode(id: string, codeValue: string): GeminiAccountLoginView {
    const login = this.login(id);
    this.loginStatus(id);
    const code = codeValue.trim();
    if (!code || code.length > 4_096 || /[\r\n\0]/.test(code)) throw new Error("请粘贴有效的 Google 授权码。");
    if (login.status !== "waiting" || !login.requiresCode || !login.child?.stdin?.writable) throw new Error("此登录当前不接受授权码，请重新发起登录。");
    login.requiresCode = false; login.codeSubmitted = true; login.message = "正在核验 Google 授权结果…";
    login.child.stdin.write(`${code}\r`);
    return this.loginView(login);
  }

  cancelLogin(id: string, message = "已取消 Google 登录。"): GeminiAccountLoginView {
    const login = this.login(id);
    if (LIVE.has(login.status)) {
      login.status = "cancelled"; login.message = message; login.requiresCode = false;
      void this.stop(login).then(() => this.cleanupLogin(login)); this.expireLogin(login);
    }
    return this.loginView(login);
  }

  async activate(id: string): Promise<GeminiAccountsState> {
    requireUuid(id);
    if (this.closed) throw new Error("账号管理服务正在停止。");
    this.options.assertSwitchAllowed();
    const availability = this.availability();
    if (!availability.executable) throw new Error(availability.error);
    if (!this.readRegistry().accounts.some(entry => entry.id === id)) throw new Error("Gemini 账号不存在。");
    let authenticated = false;
    try { authenticated = Boolean((await this.models(this.runtime(this.profile(id), id, availability.executable)))?.models.length); } catch { /* Fail closed on expired login. */ }
    if (!authenticated) throw new Error("此 Gemini 账号登录已失效或暂不可用，请重新登录后再试。");
    if (this.closed) throw new Error("账号管理服务正在停止。");
    this.options.assertSwitchAllowed();
    const registry = this.readRegistry(), entry = registry.accounts.find(item => item.id === id);
    if (!entry) throw new Error("Gemini 账号已删除。");
    registry.activeAccountId = id; entry.lastUsedAt = this.now().toISOString(); this.writeRegistry(registry);
    return this.listAccounts();
  }

  async delete(id: string): Promise<GeminiAccountsState> {
    requireUuid(id); if (this.closed) throw new Error("账号管理服务正在停止。"); this.options.assertSwitchAllowed();
    // A live CLI read may refresh its local token/cache. Do not remove the
    // profile underneath that process and let it recreate deleted credentials.
    if (this.usageReads.has(id)) throw new Error("正在读取此账号用量，请查询完成后再删除。");
    const registry = this.readRegistry();
    if (!registry.accounts.some(entry => entry.id === id)) throw new Error("Gemini 账号不存在。");
    registry.accounts = registry.accounts.filter(entry => entry.id !== id);
    if (registry.activeAccountId === id) registry.activeAccountId = null;
    this.writeRegistry(registry);
    fs.rmSync(this.profile(id), { recursive: true, force: true });
    this.usageCache.delete(id);
    return this.listAccounts();
  }

  async handle(request: GeminiAccountRequest): Promise<GeminiAccountResult> {
    switch (request.action) {
      case "list": return { state: await this.listAccounts() };
      case "catalog": return { catalog: await this.getModelCatalog() };
      case "usage": return { usage: await this.getUsage(request.accountId, request.refresh) };
      case "login_start": return { login: await this.beginLogin(request.label ?? "") };
      case "login_status": return { login: this.loginStatus(request.loginId ?? "") };
      case "login_cancel": return { login: this.cancelLogin(request.loginId ?? "") };
      case "login_code": return { login: this.submitCode(request.loginId ?? "", request.code ?? "") };
      case "activate": return { state: await this.activate(request.accountId ?? "") };
      case "delete": return { state: await this.delete(request.accountId ?? "") };
      default: throw new Error("Gemini 账号操作无效。");
    }
  }

  close(): void {
    this.closed = true;
    for (const login of this.logins.values()) { if (LIVE.has(login.status)) this.cancelLogin(login.id); clearTimeout(login.timer); }
  }

  private loginOutput(login: Login, chunk: string): void {
    if (!LIVE.has(login.status) || login.finishing) return;
    login.output = (login.output + chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).slice(-32_000);
    // The user explicitly chose Google login in Codex Web. Never choose the Cloud/API-key option.
    if (!login.selectedGoogle && /Select login method:/i.test(login.output)) { login.selectedGoogle = true; login.child?.stdin?.write("\r"); }
    const url = googleAuthorizationUrl(login.output);
    if (url && !login.codeSubmitted) { login.verificationUrl = url; login.status = "waiting"; login.requiresCode = /Paste the authorization code below:|authorization code\.\.\.|copy the code[\s\S]{0,200}paste it below:/i.test(login.output); login.message = "请打开 Google 登录页，完成授权后粘贴返回的授权码。"; }
    if (login.codeSubmitted && /authentication failed|invalid_grant|failed to exchange|sign-in failed/i.test(login.output)) { this.failLogin(login, "Google 授权未通过，请重新发起登录。"); return; }
    if (/successfully (?:signed|logged) in|authentication successful|signed in as/i.test(login.output)) { login.codeSubmitted = true; void this.verifyLogin(login); }
  }

  private async verifyLogin(login: Login, exited = false): Promise<void> {
    if (login.checking || login.finishing || !LIVE.has(login.status)) return;
    login.checking = true;
    let authenticated = false;
    try {
      const executable = this.availability().executable;
      if (executable) authenticated = Boolean((await this.models(this.runtime(login.home, login.id, executable)))?.models.length);
    } catch { /* CLI exit 0 and OAuth text are not proof of authentication. */ }
    finally { login.checking = false; }
    if (!LIVE.has(login.status)) return;
    if (!authenticated) { if (exited) this.failLogin(login, "Google 登录未完成，或此账号尚无 Antigravity 使用权限。请重新尝试。"); return; }
    login.finishing = true;
    await this.stop(login);
    if (!LIVE.has(login.status)) return;
    try {
      const registry = this.readRegistry();
      if (registry.accounts.length >= 20) throw new Error("此节点最多保存 20 个 Gemini 账号。");
      const id = crypto.randomUUID();
      fs.renameSync(login.home, this.profile(id));
      const entry: Entry = { id, label: login.label, email: null, createdAt: this.now().toISOString(), lastUsedAt: null };
      registry.accounts.push(entry);
      if (!registry.activeAccountId) {
        try { this.options.assertSwitchAllowed(); registry.activeAccountId = id; entry.lastUsedAt = this.now().toISOString(); } catch { /* Keep the new login saved; active tasks retain their account. */ }
      }
      this.writeRegistry(registry);
      login.status = "completed"; login.accountId = id;
      login.message = registry.activeAccountId === id ? "Google 登录已完成，此账号已启用。"
        : registry.activeAccountId ? "Google 登录已保存；可在账号管理中切换到此账号。"
          : "Google 登录已保存；当前 Gemini 任务或节点维护结束后，请在账号管理中启用此账号。";
      login.requiresCode = false;
      this.expireLogin(login);
    } catch { login.finishing = false; this.failLogin(login, "Google 登录结果未能保存，请重新尝试。"); }
  }

  private failLogin(login: Login, message: string): void {
    if (!LIVE.has(login.status)) return;
    login.status = "failed"; login.message = message; login.requiresCode = false;
    void this.stop(login).then(() => this.cleanupLogin(login)); this.expireLogin(login);
  }
  private stop(login: Login): Promise<void> {
    const child = login.child; login.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const kill = (signal: NodeJS.Signals) => {
        if (!this.options.launchLogin && child.pid) { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } }
        else child.kill(signal);
      };
      const force = setTimeout(() => kill("SIGKILL"), 1_000); force.unref();
      const deadline = setTimeout(finish, 2_000); deadline.unref();
      function finish() { clearTimeout(force); clearTimeout(deadline); resolve(); }
      child.once("close", finish); kill("SIGTERM");
    });
  }
  private cleanupLogin(login: Login): void { fs.rmSync(login.home, { recursive: true, force: true }); }
  private expireLogin(login: Login): void {
    clearTimeout(login.timer); login.output = "";
    login.timer = setTimeout(() => this.logins.delete(login.id), 10 * 60_000); login.timer.unref();
  }
  private login(id: string): Login { requireUuid(id); const login = this.logins.get(id); if (!login) throw new Error("Google 登录验证不存在或已过期。"); return login; }
  private loginView(login: Login): GeminiAccountLoginView {
    const { id, label, status, verificationUrl, requiresCode, message, accountId, createdAt, expiresAt } = login;
    return { id, label, status, verificationUrl, requiresCode, message, accountId, createdAt, expiresAt };
  }
  private profile(id: string): string { requireUuid(id); return path.join(this.profiles, id); }
  private readRegistry(): Registry {
    if (!fs.existsSync(this.index)) return { version: 1, activeAccountId: null, accounts: [] };
    try {
      if (!fs.lstatSync(this.index).isFile() || fs.lstatSync(this.index).isSymbolicLink()) throw new Error("index type");
      const value = JSON.parse(fs.readFileSync(this.index, "utf8")) as Registry;
      if (value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 20 || !(value.activeAccountId === null || UUID.test(value.activeAccountId))) throw new Error("index shape");
      const ids = new Set<string>();
      for (const entry of value.accounts) {
        if (!UUID.test(entry.id) || ids.has(entry.id) || typeof entry.label !== "string" || !entry.label || entry.label.length > 60 || !Number.isFinite(Date.parse(entry.createdAt)) || !(entry.email === null || typeof entry.email === "string") || !(entry.lastUsedAt === null || Number.isFinite(Date.parse(entry.lastUsedAt)))) throw new Error("entry shape");
        ids.add(entry.id);
        const stat = fs.lstatSync(this.profile(entry.id)); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("profile type");
      }
      if (value.activeAccountId !== null && !ids.has(value.activeAccountId)) throw new Error("active reference");
      return { version: 1, activeAccountId: value.activeAccountId, accounts: value.accounts.map(({ id, label, email, createdAt, lastUsedAt }) => ({ id, label, email, createdAt, lastUsedAt })) };
    } catch { throw new Error("Gemini 账号登记文件异常，已停止读取，原文件保持不变。"); }
  }
  private writeRegistry(registry: Registry): void {
    const temporary = `${this.index}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(registry), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, this.index);
  }
}

export function geminiProfileEnvironment(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of Object.keys(env)) if (/^(CODEX_|CWW_SHARED_CODEX_|GEMINI_|GOOGLE_|ANTIGRAVITY_|AGY_)/.test(name)) delete env[name];
  // AGY's SSH detector bypasses the OS keyring in favor of its private CLI token file.
  // Keep that marker on every invocation, including catalog queries and execution;
  // the unavailable Linux bus provides a second barrier against an existing desktop login.
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_RUNTIME_DIR: path.join(home, ".run"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, ".dbus-unavailable")}`, SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22", AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
  return env;
}

export function googleAuthorizationUrl(output: string): string | null {
  for (const match of output.matchAll(/https:\/\/[^\s<>\x00-\x20]+/g)) {
    try {
      const candidate = match[0].replace(/[)\]"',;]+$/, ""), url = new URL(candidate);
      if (url.protocol === "https:" && url.hostname === "accounts.google.com" && !url.username && !url.password && (url.pathname.startsWith("/o/oauth2/") || url.pathname === "/signin/oauth") && url.searchParams.get("state") && url.searchParams.get("code_challenge") && url.searchParams.get("client_id") && url.searchParams.get("response_type") === "code" && url.searchParams.get("redirect_uri") === "https://antigravity.google/oauth-callback") return url.toString();
    } catch { /* Untrusted CLI output is never rendered as a login link. */ }
  }
  return null;
}
function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Gemini 账号目录必须为本机普通目录。");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}
function requireUuid(id: string): void { if (!UUID.test(id)) throw new Error("Gemini 账号标识无效。"); }
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

async function mapLimited<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await fn(values[index]!); }
  }));
  return results;
}
