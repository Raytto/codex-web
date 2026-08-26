import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type CodexAccountView = {
  id: string; label: string; email: string | null; accountHint: string; active: boolean;
  createdAt: string; lastUsedAt: string | null;
};
export type CodexAccountsState = { accounts: CodexAccountView[]; activeAccountId: string };
export type CodexAccountLoginView = {
  id: string; status: "starting" | "waiting_for_user" | "succeeded" | "failed" | "cancelled";
  verificationUrl: string | null; userCode: string | null; error: string | null;
  account: CodexAccountView | null; createdAt: string; expiresAt: string;
};

type AccountMetadata = Omit<CodexAccountView, "active" | "accountHint"> & { codexAccountId: string };
type AccountRegistry = { schemaVersion: 1; activeAccountId: string; accounts: AccountMetadata[] };
type LoginSession = CodexAccountLoginView & { label: string; home: string; process: ChildProcess | null; output: string };
type Options = {
  stateRoot: string;
  codexHome: string;
  codexExecutable(): string;
  assertSwitchAllowed(): void;
  now?: () => Date;
};

const ENTRY_ID = /^[0-9a-f-]{36}$/i;
const ACCOUNT_ID = /^[0-9A-Za-z_-]{3,200}$/;
const LOGIN_LIFETIME_MS = 15 * 60_000;
const LOGIN_RETENTION_MS = 10 * 60_000;

/** Keeps reusable Codex credentials on the Windows node. No auth payload is returned to Codex Web. */
export class RemoteCodexAccountManager {
  private readonly authorityFile: string;
  private readonly accountsRoot: string;
  private readonly registryFile: string;
  private readonly loginRoot: string;
  private readonly logins = new Map<string, LoginSession>();
  private readonly now: () => Date;
  private switching = false;

  constructor(private readonly options: Options) {
    this.authorityFile = path.join(options.codexHome, "auth.json");
    this.accountsRoot = path.join(options.stateRoot, "codex-accounts", "accounts");
    this.registryFile = path.join(this.accountsRoot, "index.json");
    this.loginRoot = path.join(options.stateRoot, "codex-accounts", "login-sessions");
    this.now = options.now ?? (() => new Date());
    ensurePrivateDirectory(this.accountsRoot);
    ensurePrivateDirectory(this.loginRoot);
    for (const entry of fs.readdirSync(this.loginRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && ENTRY_ID.test(entry.name)) fs.rmSync(path.join(this.loginRoot, entry.name), { recursive: true, force: true });
    }
  }

  listAccounts(): CodexAccountsState {
    const registry = this.ensureRegistry();
    return this.state(registry);
  }

  activeAccountId(): string {
    return this.ensureRegistry().activeAccountId;
  }

  beginLogin(value: unknown): CodexAccountLoginView {
    const label = normalizeLabel(value);
    const id = crypto.randomUUID();
    const createdAt = this.now().toISOString();
    const home = path.join(this.loginRoot, id, "codex-home");
    ensurePrivateDirectory(home);
    const session: LoginSession = {
      id, label, home, process: null, output: "", status: "starting", verificationUrl: null,
      userCode: null, error: null, account: null, createdAt,
      expiresAt: new Date(this.now().getTime() + LOGIN_LIFETIME_MS).toISOString(),
    };
    this.logins.set(id, session);
    void this.launchLogin(session);
    return this.loginView(session);
  }

  loginStatus(id: string): CodexAccountLoginView {
    const session = this.loginSession(id);
    if (["starting", "waiting_for_user"].includes(session.status) && this.now().getTime() >= Date.parse(session.expiresAt)) {
      return this.cancelLogin(id, "登录验证已超时，请重新发起。");
    }
    return this.loginView(session);
  }

  cancelLogin(id: string, reason = "已取消登录验证。"): CodexAccountLoginView {
    const session = this.loginSession(id);
    if (["starting", "waiting_for_user"].includes(session.status)) {
      session.status = "cancelled";
      session.error = reason;
      this.stopLogin(session);
      this.cleanupLogin(session);
      this.scheduleLoginRemoval(session.id);
    }
    return this.loginView(session);
  }

  activate(accountId: string): CodexAccountsState {
    requireEntryId(accountId);
    this.options.assertSwitchAllowed();
    if (this.switching) throw new Error("Codex 账号正在切换，请稍后重试。");
    this.switching = true;
    try {
      const registry = this.ensureRegistry();
      const target = registry.accounts.find((account) => account.id === accountId);
      if (!target) throw new Error("Codex 账号不存在或已删除。");
      if (registry.activeAccountId !== accountId) {
        const current = registry.accounts.find((account) => account.id === registry.activeAccountId);
        if (!current) throw new Error("当前 Codex 账号记录损坏，已拒绝切换。");
        copyAuth(this.authorityFile, this.accountAuthFile(current.id), current.codexAccountId);
        copyAuth(this.accountAuthFile(target.id), this.authorityFile, target.codexAccountId);
        registry.activeAccountId = target.id;
      }
      target.lastUsedAt = this.now().toISOString();
      writeJson(this.registryFile, registry);
      return this.state(registry);
    } finally {
      this.switching = false;
    }
  }

  delete(accountId: string): CodexAccountsState {
    requireEntryId(accountId);
    const registry = this.ensureRegistry();
    const account = registry.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error("Codex 账号不存在或已删除。");
    if (registry.activeAccountId === accountId) throw new Error("当前账号不能删除，请先切换到其他账号。");
    registry.accounts = registry.accounts.filter((candidate) => candidate.id !== accountId);
    writeJson(this.registryFile, registry);
    fs.rmSync(path.join(this.accountsRoot, accountId), { recursive: true, force: true });
    return this.state(registry);
  }

  close(): void {
    for (const session of this.logins.values()) {
      this.stopLogin(session);
      this.cleanupLogin(session);
    }
    this.logins.clear();
  }

  private async launchLogin(session: LoginSession): Promise<void> {
    try {
      const executable = this.options.codexExecutable();
      const js = executable.toLowerCase().endsWith(".js");
      const command = js ? process.execPath : executable;
      const args = [...(js ? [executable] : []), "login", "--device-auth", "-c", "cli_auth_credentials_store=\"file\""];
      const child = spawn(command, args, {
        env: { ...process.env, HOME: session.home, CODEX_HOME: session.home }, cwd: session.home,
        windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      });
      session.process = child;
      const consume = (chunk: Buffer) => this.consumeLoginOutput(session, chunk.toString("utf8"));
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.once("error", (error) => this.failLogin(session, friendlyLoginError(error.message)));
      child.once("exit", (code, signal) => {
        session.process = null;
        if (session.status === "cancelled" || session.status === "failed") return;
        if (code === 0) this.finishLogin(session);
        else this.failLogin(session, friendlyLoginError(session.output, signal ?? String(code ?? "unknown")));
      });
    } catch (error) {
      this.failLogin(session, friendlyLoginError(error instanceof Error ? error.message : String(error)));
    }
  }

  private consumeLoginOutput(session: LoginSession, chunk: string): void {
    const clean = stripAnsi(chunk).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    session.output = `${session.output}${clean}`.slice(-16_000);
    const url = session.output.match(/https:\/\/[^\s<>'\"]+/i)?.[0]?.replace(/[),.;]+$/, "");
    const code = session.output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/i)?.[0]?.toUpperCase();
    if (url) session.verificationUrl = url;
    if (code) session.userCode = code;
    if (url && code) session.status = "waiting_for_user";
  }

  private finishLogin(session: LoginSession): void {
    try {
      const authFile = path.join(session.home, "auth.json");
      const identity = authIdentity(fs.readFileSync(authFile));
      const registry = this.ensureRegistry();
      let account = registry.accounts.find((candidate) => candidate.codexAccountId === identity.accountId);
      if (account) {
        account.email = identity.email ?? account.email;
        if (session.label) account.label = session.label;
      } else {
        account = {
          id: crypto.randomUUID(), label: session.label || identity.email || `Codex 账号 ${registry.accounts.length + 1}`,
          email: identity.email, codexAccountId: identity.accountId, createdAt: this.now().toISOString(), lastUsedAt: null,
        };
        registry.accounts.push(account);
      }
      copyAuth(authFile, this.accountAuthFile(account.id), identity.accountId);
      writeJson(this.registryFile, registry);
      session.status = "succeeded";
      session.account = this.view(account, registry.activeAccountId);
      session.error = null;
      this.cleanupLogin(session);
      this.scheduleLoginRemoval(session.id);
    } catch (error) {
      this.failLogin(session, friendlyLoginError(error instanceof Error ? error.message : String(error)));
    }
  }

  private failLogin(session: LoginSession, message: string): void {
    if (session.status === "cancelled" || session.status === "succeeded") return;
    session.status = "failed";
    session.error = message;
    this.stopLogin(session);
    this.cleanupLogin(session);
    this.scheduleLoginRemoval(session.id);
  }

  private ensureRegistry(): AccountRegistry {
    const identity = authIdentity(fs.readFileSync(this.authorityFile));
    if (!fs.existsSync(this.registryFile)) {
      const id = crypto.randomUUID();
      const now = this.now().toISOString();
      const registry: AccountRegistry = { schemaVersion: 1, activeAccountId: id, accounts: [{
        id, label: identity.email || "当前 Codex 账号", email: identity.email,
        codexAccountId: identity.accountId, createdAt: now, lastUsedAt: now,
      }] };
      copyAuth(this.authorityFile, this.accountAuthFile(id), identity.accountId);
      writeJson(this.registryFile, registry);
      return registry;
    }
    const registry = parseRegistry(fs.readFileSync(this.registryFile, "utf8"));
    const matching = registry.accounts.find((account) => account.codexAccountId === identity.accountId);
    if (!matching) {
      const id = crypto.randomUUID();
      const now = this.now().toISOString();
      registry.accounts.push({ id, label: identity.email || `Codex 账号 ${registry.accounts.length + 1}`, email: identity.email, codexAccountId: identity.accountId, createdAt: now, lastUsedAt: now });
      registry.activeAccountId = id;
      copyAuth(this.authorityFile, this.accountAuthFile(id), identity.accountId);
      writeJson(this.registryFile, registry);
    } else if (registry.activeAccountId !== matching.id) {
      registry.activeAccountId = matching.id;
      matching.lastUsedAt = this.now().toISOString();
      writeJson(this.registryFile, registry);
    }
    return registry;
  }

  private state(registry: AccountRegistry): CodexAccountsState {
    return { accounts: registry.accounts.map((account) => this.view(account, registry.activeAccountId)), activeAccountId: registry.activeAccountId };
  }
  private view(account: AccountMetadata, activeId: string): CodexAccountView {
    return { id: account.id, label: account.label, email: account.email, accountHint: `••••••${account.codexAccountId.slice(-6)}`, active: account.id === activeId, createdAt: account.createdAt, lastUsedAt: account.lastUsedAt };
  }
  private loginView(session: LoginSession): CodexAccountLoginView {
    return { id: session.id, status: session.status, verificationUrl: session.verificationUrl, userCode: session.userCode, error: session.error, account: session.account, createdAt: session.createdAt, expiresAt: session.expiresAt };
  }
  private loginSession(id: string): LoginSession {
    requireEntryId(id);
    const session = this.logins.get(id);
    if (!session) throw new Error("登录验证已结束或不存在，请重新发起。");
    return session;
  }
  private stopLogin(session: LoginSession): void {
    const child = session.process;
    session.process = null;
    if (!child?.pid) return;
    try { process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  private cleanupLogin(session: LoginSession): void { fs.rmSync(path.dirname(session.home), { recursive: true, force: true }); }
  private scheduleLoginRemoval(id: string): void { const timer = setTimeout(() => this.logins.delete(id), LOGIN_RETENTION_MS); timer.unref(); }
  private accountAuthFile(id: string): string { requireEntryId(id); return path.join(this.accountsRoot, id, "auth.json"); }
}

function normalizeLabel(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("账号备注无效。");
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("账号备注应为 1–60 个字符。");
  return label;
}
function requireEntryId(value: string): void { if (!ENTRY_ID.test(value)) throw new Error("Codex 账号编号无效。"); }
function ensurePrivateDirectory(directory: string): void { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); try { fs.chmodSync(directory, 0o700); } catch {} }
function authIdentity(raw: Buffer): { accountId: string; email: string | null } {
  let auth: { tokens?: { account_id?: unknown; id_token?: unknown }; OPENAI_API_KEY?: unknown };
  try { auth = JSON.parse(raw.toString("utf8")); } catch { throw new Error("Codex 账号凭据不是有效 JSON。"); }
  const accountId = auth.tokens?.account_id;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId) || typeof auth.tokens?.id_token !== "string") throw new Error("Codex 登录缺少可复用的 ChatGPT 账号标识。");
  return { accountId, email: jwtEmail(auth.tokens.id_token) };
}
function jwtEmail(token: unknown): string | null {
  if (typeof token !== "string") return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8")) as { email?: unknown };
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    return email && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
  } catch { return null; }
}
function copyAuth(source: string, target: string, expectedAccountId: string): void {
  if (authIdentity(fs.readFileSync(source)).accountId !== expectedAccountId) throw new Error("Codex 账号凭据与账号记录不匹配。");
  ensurePrivateDirectory(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.auth-${process.pid}-${crypto.randomUUID()}.tmp`);
  try { fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL); try { fs.chmodSync(temporary, 0o600); } catch {} fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function writeJson(file: string, value: unknown): void {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${process.pid}-${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function parseRegistry(raw: string): AccountRegistry {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error("Codex 账号索引不是有效 JSON。"); }
  const registry = value as AccountRegistry;
  if (!registry || registry.schemaVersion !== 1 || !ENTRY_ID.test(registry.activeAccountId) || !Array.isArray(registry.accounts) || registry.accounts.length === 0) throw new Error("Codex 账号索引已损坏。");
  const ids = new Set<string>();
  for (const account of registry.accounts) {
    if (!account || !ENTRY_ID.test(account.id) || ids.has(account.id) || typeof account.label !== "string" || !account.label || account.label.length > 60 || (account.email !== null && typeof account.email !== "string") || !ACCOUNT_ID.test(account.codexAccountId) || typeof account.createdAt !== "string" || (account.lastUsedAt !== null && typeof account.lastUsedAt !== "string")) throw new Error("Codex 账号索引包含无效记录。");
    ids.add(account.id);
  }
  if (!ids.has(registry.activeAccountId)) throw new Error("Codex 账号索引缺少当前账号。");
  return registry;
}
function stripAnsi(value: string): string { return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""); }
function friendlyLoginError(output: string, fallback = "登录验证失败"): string {
  const normalized = stripAnsi(output).toLowerCase();
  if (normalized.includes("timed out") || normalized.includes("expired")) return "登录验证码已过期，请重新发起。";
  if (normalized.includes("network") || normalized.includes("connect") || normalized.includes("tls")) return "目标电脑暂时无法连接登录服务，请稍后重试。";
  if (normalized.includes("codex 账号") || normalized.includes("codex 登录")) return output.slice(0, 240);
  return `${fallback}，请重新发起；若持续失败，请检查设备码登录权限。`;
}
