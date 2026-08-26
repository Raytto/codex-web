import crypto from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyCodexProxyEnvironment, selectCodexEgress } from "./codex-egress.js";
import { copyValidatedCodexAuth, validateCodexAuthPayload, withSharedCodexAuthLock } from "./shared-codex-auth.js";

export type CodexAccountView = {
  id: string;
  label: string;
  email: string | null;
  accountHint: string;
  active: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  quotaRemainingPercent?: number | null;
  quotaResetAt?: string | null;
  quotaUpdatedAt?: string | null;
};

export type CodexAccountLoginView = {
  id: string;
  status: "starting" | "waiting_for_user" | "succeeded" | "failed" | "cancelled";
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  account: CodexAccountView | null;
  createdAt: string;
  expiresAt: string;
};

type AccountMetadata = {
  id: string;
  label: string;
  email: string | null;
  codexAccountId: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type AccountRegistry = {
  schemaVersion: 1;
  activeAccountId: string;
  accounts: AccountMetadata[];
};

type LoginSession = CodexAccountLoginView & {
  label: string;
  home: string;
  process: ChildProcess | null;
  output: string;
};

type CodexAccountManagerOptions = {
  authorityFile: string;
  lockFile: string;
  policyFile: string;
  codexExecutable: string;
  assertSwitchAllowed(): void;
  now?: () => Date;
};

const LOGIN_LIFETIME_MS = 15 * 60_000;
const LOGIN_RETENTION_MS = 10 * 60_000;
const ACCOUNT_ID = /^[0-9A-Za-z_-]{3,200}$/;
const ENTRY_ID = /^[0-9a-f-]{36}$/i;

export class CodexAccountManager {
  private readonly authorityFile: string;
  private readonly lockFile: string;
  private readonly policyFile: string;
  private readonly codexExecutable: string;
  private readonly root: string;
  private readonly accountsRoot: string;
  private readonly registryFile: string;
  private readonly loginRoot: string;
  private readonly logins = new Map<string, LoginSession>();
  private readonly now: () => Date;

  constructor(private readonly options: CodexAccountManagerOptions) {
    this.authorityFile = path.resolve(options.authorityFile);
    this.lockFile = path.resolve(options.lockFile);
    this.policyFile = path.resolve(options.policyFile);
    this.codexExecutable = path.resolve(options.codexExecutable);
    this.root = path.dirname(path.dirname(this.authorityFile));
    this.accountsRoot = path.join(this.root, "accounts");
    this.registryFile = path.join(this.accountsRoot, "index.json");
    this.loginRoot = path.join(this.root, "account-login-sessions");
    this.now = options.now ?? (() => new Date());
    this.ensurePrivateDirectory(this.accountsRoot);
    this.ensurePrivateDirectory(this.loginRoot);
    this.removeAbandonedLoginDirectories();
  }

  async listAccounts(): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    return withSharedCodexAuthLock(this.lockFile, () => {
      const registry = this.ensureRegistryUnlocked();
      return {
        accounts: registry.accounts.map((account) => this.view(account, registry.activeAccountId)),
        activeAccountId: registry.activeAccountId,
      };
    });
  }

  async beginLogin(labelValue: unknown): Promise<CodexAccountLoginView> {
    const label = normalizeLabel(labelValue);
    const id = crypto.randomUUID();
    const createdAt = this.now().toISOString();
    const home = path.join(this.loginRoot, id, "codex-home");
    this.ensurePrivateDirectory(home);
    const session: LoginSession = {
      id,
      label,
      home,
      process: null,
      output: "",
      status: "starting",
      verificationUrl: null,
      userCode: null,
      error: null,
      account: null,
      createdAt,
      expiresAt: new Date(this.now().getTime() + LOGIN_LIFETIME_MS).toISOString(),
    };
    this.logins.set(id, session);
    void this.launchLogin(session);
    return this.loginView(session);
  }

  loginStatus(id: string): CodexAccountLoginView {
    const session = this.loginSession(id);
    if (["starting", "waiting_for_user"].includes(session.status) && this.now().getTime() >= Date.parse(session.expiresAt)) {
      this.cancelLogin(id, "登录验证已超时，请重新发起。");
    }
    return this.loginView(session);
  }

  cancelLogin(id: string, reason = "已取消登录验证。"):
  CodexAccountLoginView {
    const session = this.loginSession(id);
    if (["starting", "waiting_for_user"].includes(session.status)) {
      session.status = "cancelled";
      session.error = reason;
      this.stopLoginProcess(session);
      this.cleanupLoginHome(session);
      this.scheduleLoginRemoval(session);
    }
    return this.loginView(session);
  }

  async activate(accountId: string): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    requireEntryId(accountId);
    return withSharedCodexAuthLock(this.lockFile, () => {
      this.options.assertSwitchAllowed();
      const registry = this.ensureRegistryUnlocked();
      const target = registry.accounts.find((account) => account.id === accountId);
      if (!target) throw new Error("Codex 账号不存在或已删除。");
      if (registry.activeAccountId !== accountId) {
        const current = registry.accounts.find((account) => account.id === registry.activeAccountId);
        if (!current) throw new Error("当前 Codex 账号记录损坏，已拒绝切换。");
        this.copyAuth(this.authorityFile, this.accountAuthFile(current.id), current.codexAccountId);
        this.copyAuth(this.accountAuthFile(target.id), this.authorityFile, target.codexAccountId);
        registry.activeAccountId = target.id;
      }
      target.lastUsedAt = this.now().toISOString();
      this.writePolicyShared();
      this.writeRegistry(registry);
      return {
        accounts: registry.accounts.map((account) => this.view(account, registry.activeAccountId)),
        activeAccountId: registry.activeAccountId,
      };
    });
  }

  async delete(accountId: string): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    requireEntryId(accountId);
    return withSharedCodexAuthLock(this.lockFile, () => {
      const registry = this.ensureRegistryUnlocked();
      const account = registry.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error("Codex 账号不存在或已删除。");
      if (registry.activeAccountId === accountId) throw new Error("当前全局账号不能删除，请先切换到其他账号。");
      registry.accounts = registry.accounts.filter((candidate) => candidate.id !== accountId);
      this.writeRegistry(registry);
      fs.rmSync(path.join(this.accountsRoot, accountId), { recursive: true, force: true });
      return {
        accounts: registry.accounts.map((candidate) => this.view(candidate, registry.activeAccountId)),
        activeAccountId: registry.activeAccountId,
      };
    });
  }

  close(): void {
    for (const session of this.logins.values()) {
      this.stopLoginProcess(session);
      this.cleanupLoginHome(session);
    }
    this.logins.clear();
  }

  private async launchLogin(session: LoginSession): Promise<void> {
    try {
      if (!fs.statSync(this.codexExecutable).isFile()) throw new Error("服务器 Codex 登录程序不可用。");
      const controller = new AbortController();
      const egress = await selectCodexEgress({ signal: controller.signal });
      if (session.status === "cancelled") return;
      const environment = applyCodexProxyEnvironment({
        ...process.env,
        HOME: session.home,
        CODEX_HOME: session.home,
      }, egress.proxyUrl);
      const child = spawn(this.codexExecutable, [
        "login",
        "--device-auth",
        "-c",
        "cli_auth_credentials_store=\"file\"",
      ], {
        env: environment,
        cwd: session.home,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      session.process = child;
      const consume = (chunk: Buffer) => this.consumeLoginOutput(session, chunk.toString("utf8"));
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.once("error", (error) => this.failLogin(session, friendlyLoginError(error.message)));
      child.once("exit", (code, signal) => {
        session.process = null;
        if (session.status === "cancelled" || session.status === "failed") return;
        if (code === 0) void this.finishLogin(session);
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
    // Codex device authorization currently emits exactly nine characters as
    // XXXX-XXXXX. Keep this deliberately strict: the CLI banner contains
    // hyphenated prose such as "command-line", which is not a device code.
    const code = session.output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/i)?.[0]?.toUpperCase();
    if (url) session.verificationUrl = url;
    if (code) session.userCode = code;
    if (session.verificationUrl && session.userCode) session.status = "waiting_for_user";
  }

  private async finishLogin(session: LoginSession): Promise<void> {
    try {
      const authFile = path.join(session.home, "auth.json");
      const auth = fs.readFileSync(authFile);
      validateCodexAuthPayload(auth);
      const identity = authIdentity(auth);
      const account = await withSharedCodexAuthLock(this.lockFile, () => {
        const registry = this.ensureRegistryUnlocked();
        let metadata = registry.accounts.find((candidate) => candidate.codexAccountId === identity.accountId);
        if (metadata) {
          if (metadata.id === registry.activeAccountId) {
            this.options.assertSwitchAllowed();
            this.copyAuth(authFile, this.authorityFile, identity.accountId);
          }
          metadata.email = identity.email ?? metadata.email;
          if (session.label) metadata.label = session.label;
        } else {
          metadata = {
            id: crypto.randomUUID(),
            label: session.label || identity.email || `Codex 账号 ${registry.accounts.length + 1}`,
            email: identity.email,
            codexAccountId: identity.accountId,
            createdAt: this.now().toISOString(),
            lastUsedAt: null,
          };
          registry.accounts.push(metadata);
        }
        this.copyAuth(authFile, this.accountAuthFile(metadata.id), identity.accountId);
        this.writeRegistry(registry);
        return this.view(metadata, registry.activeAccountId);
      });
      session.status = "succeeded";
      session.account = account;
      session.error = null;
      this.cleanupLoginHome(session);
      this.scheduleLoginRemoval(session);
    } catch (error) {
      this.failLogin(session, friendlyLoginError(error instanceof Error ? error.message : String(error)));
    }
  }

  private failLogin(session: LoginSession, error: string): void {
    if (session.status === "cancelled" || session.status === "succeeded") return;
    session.status = "failed";
    session.error = error;
    this.stopLoginProcess(session);
    this.cleanupLoginHome(session);
    this.scheduleLoginRemoval(session);
  }

  private ensureRegistryUnlocked(): AccountRegistry {
    let registry: AccountRegistry;
    if (!fs.existsSync(this.registryFile)) {
      const auth = fs.readFileSync(this.authorityFile);
      const identity = authIdentity(auth);
      const id = crypto.randomUUID();
      const now = this.now().toISOString();
      registry = {
        schemaVersion: 1,
        activeAccountId: id,
        accounts: [{
          id,
          label: identity.email || "当前 Codex 账号",
          email: identity.email,
          codexAccountId: identity.accountId,
          createdAt: now,
          lastUsedAt: now,
        }],
      };
      this.copyAuth(this.authorityFile, this.accountAuthFile(id), identity.accountId);
      this.writeRegistry(registry);
      return registry;
    }
    registry = parseRegistry(fs.readFileSync(this.registryFile, "utf8"));
    const authority = authIdentity(fs.readFileSync(this.authorityFile));
    const matching = registry.accounts.find((account) => account.codexAccountId === authority.accountId);
    if (!matching) {
      const id = crypto.randomUUID();
      const now = this.now().toISOString();
      const account: AccountMetadata = {
        id,
        label: authority.email || `Codex 账号 ${registry.accounts.length + 1}`,
        email: authority.email,
        codexAccountId: authority.accountId,
        createdAt: now,
        lastUsedAt: now,
      };
      registry.accounts.push(account);
      registry.activeAccountId = id;
      this.copyAuth(this.authorityFile, this.accountAuthFile(id), authority.accountId);
      this.writeRegistry(registry);
    } else if (registry.activeAccountId !== matching.id) {
      registry.activeAccountId = matching.id;
      matching.lastUsedAt = this.now().toISOString();
      this.writeRegistry(registry);
    }
    return registry;
  }

  private copyAuth(source: string, target: string, expectedAccountId: string): void {
    const sourceIdentity = authIdentity(fs.readFileSync(source));
    if (sourceIdentity.accountId !== expectedAccountId) throw new Error("Codex 账号凭据与账号记录不匹配。");
    this.ensurePrivateDirectory(path.dirname(target));
    copyValidatedCodexAuth(source, target);
    fs.chmodSync(target, 0o600);
  }

  private writeRegistry(registry: AccountRegistry): void {
    parseRegistry(JSON.stringify(registry));
    atomicJsonWrite(this.registryFile, registry, 0o600);
  }

  private writePolicyShared(): void {
    atomicJsonWrite(this.policyFile, { mode: "shared" }, 0o600);
  }

  private view(account: AccountMetadata, activeId: string): CodexAccountView {
    return {
      id: account.id,
      label: account.label,
      email: account.email,
      accountHint: account.codexAccountId.length > 6 ? `••••••${account.codexAccountId.slice(-6)}` : "已验证",
      active: account.id === activeId,
      createdAt: account.createdAt,
      lastUsedAt: account.lastUsedAt,
    };
  }

  private loginView(session: LoginSession): CodexAccountLoginView {
    return {
      id: session.id,
      status: session.status,
      verificationUrl: session.verificationUrl,
      userCode: session.userCode,
      error: session.error,
      account: session.account,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }

  private loginSession(id: string): LoginSession {
    requireEntryId(id);
    const session = this.logins.get(id);
    if (!session) throw new Error("登录验证已结束或不存在，请重新发起。");
    return session;
  }

  private stopLoginProcess(session: LoginSession): void {
    const child = session.process;
    session.process = null;
    if (!child?.pid) return;
    try { process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid, "SIGTERM"); } catch {}
  }

  private cleanupLoginHome(session: LoginSession): void {
    fs.rmSync(path.dirname(session.home), { recursive: true, force: true });
  }

  private scheduleLoginRemoval(session: LoginSession): void {
    const timer = setTimeout(() => this.logins.delete(session.id), LOGIN_RETENTION_MS);
    timer.unref();
  }

  private ensurePrivateDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }

  private accountAuthFile(id: string): string {
    requireEntryId(id);
    return path.join(this.accountsRoot, id, "auth.json");
  }

  private removeAbandonedLoginDirectories(): void {
    for (const entry of fs.readdirSync(this.loginRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && ENTRY_ID.test(entry.name)) fs.rmSync(path.join(this.loginRoot, entry.name), { recursive: true, force: true });
    }
  }
}

function normalizeLabel(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("账号备注无效。");
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("账号备注应为 1–60 个字符。");
  return label;
}

function requireEntryId(value: string): void {
  if (!ENTRY_ID.test(value)) throw new Error("Codex 账号编号无效。");
}

function parseRegistry(raw: string): AccountRegistry {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Codex 账号索引不是有效 JSON。"); }
  const root = value && typeof value === "object" ? value as Partial<AccountRegistry> : null;
  if (!root || root.schemaVersion !== 1 || !ENTRY_ID.test(String(root.activeAccountId ?? "")) || !Array.isArray(root.accounts) || root.accounts.length === 0) {
    throw new Error("Codex 账号索引已损坏。");
  }
  const ids = new Set<string>();
  for (const account of root.accounts) {
    if (!account || typeof account !== "object" || !ENTRY_ID.test(account.id) || ids.has(account.id)
      || typeof account.label !== "string" || !account.label || account.label.length > 60
      || (account.email !== null && typeof account.email !== "string")
      || typeof account.codexAccountId !== "string" || !ACCOUNT_ID.test(account.codexAccountId)
      || typeof account.createdAt !== "string" || (account.lastUsedAt !== null && typeof account.lastUsedAt !== "string")) {
      throw new Error("Codex 账号索引包含无效记录。");
    }
    ids.add(account.id);
  }
  if (!ids.has(root.activeAccountId!)) throw new Error("Codex 账号索引缺少当前账号。");
  return root as AccountRegistry;
}

function authIdentity(raw: Buffer): { accountId: string; email: string | null } {
  validateCodexAuthPayload(raw);
  const auth = JSON.parse(raw.toString("utf8")) as { tokens?: { account_id?: unknown; id_token?: unknown } };
  const accountId = auth.tokens?.account_id;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) throw new Error("Codex 登录缺少有效账号标识。");
  return { accountId, email: jwtEmail(auth.tokens?.id_token) };
}

function jwtEmail(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    return email && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
  } catch {
    return null;
  }
}

function atomicJsonWrite(file: string, value: unknown, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, "wx", mode);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function friendlyLoginError(output: string, fallback = "登录验证失败"):
string {
  const normalized = stripAnsi(output).toLowerCase();
  if (normalized.includes("device") && (normalized.includes("disabled") || normalized.includes("not enabled"))) {
    return "该账号尚未启用设备码登录，请先在 ChatGPT 安全设置或工作区权限中启用后重试。";
  }
  if (normalized.includes("timed out") || normalized.includes("expired")) return "登录验证码已过期，请重新发起。";
  if (normalized.includes("network") || normalized.includes("connect") || normalized.includes("tls")) return "服务器暂时无法连接登录服务，请稍后重试。";
  if (normalized.includes("服务器 codex") || normalized.includes("账号凭据") || normalized.includes("账号索引")) return output.slice(0, 240);
  return `${fallback}，请重新发起；若持续失败，请检查设备码登录权限。`;
}
