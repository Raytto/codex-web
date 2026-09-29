import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export type AccountSessionOptions = {
  executable: string; authFile: string; expectedAccountId: string; temporaryRoot: string;
  env?: NodeJS.ProcessEnv; commitAuth?: (temporaryAuth: string) => void;
};
export type AccountRpc = (method: string, params: unknown) => Promise<Record<string, unknown>>;

/** Credentials and raw account responses remain on the owning machine. */
export async function withAccountSession<T>(options: AccountSessionOptions, run: (rpc: AccountRpc) => Promise<T>): Promise<T> {
  fs.mkdirSync(options.temporaryRoot, { recursive: true, mode: 0o700 });
  const home = fs.mkdtempSync(path.join(options.temporaryRoot, "reset-"));
  const authFile = path.join(home, "auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(options.authFile, "utf8"));
    if (auth.tokens?.account_id !== options.expectedAccountId) throw new Error("账号身份不匹配，未使用重置卡。");
    if (!options.commitAuth) auth.tokens.refresh_token = "";
    fs.writeFileSync(authFile, JSON.stringify(auth), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), CODEX_HOME: home };
    delete env.CODEX_ACCESS_TOKEN; delete env.OPENAI_API_KEY;
    const js = options.executable.endsWith(".js");
    const child = spawn(js ? process.execPath : options.executable,
      [...(js ? [options.executable] : []), "app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"'],
      { cwd: home, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let sequence = 0;
    const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    const fail = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Codex 连接中断，请重试以核对同一次操作。")); } pending.clear(); };
    const closed = new Promise<void>((resolve) => { child.once("close", () => { fail(); resolve(); }); });
    child.on("error", fail); child.stdin.on("error", fail);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method) return;
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) {
        const detail = String(message.error.message ?? "");
        item.reject(new Error(/401|unauthori|expired|refresh.token|log.?in/i.test(detail)
          ? "登录状态待更新，请重新登录后重试。" : message.error.code === -32601
            ? "此机器的 Codex 版本不支持使用重置卡，请先升级 Codex。" : "Codex 请求未确认成功，请重试以核对同一次操作。"));
      } else item.resolve(message.result ?? {});
    });
    const rpc: AccountRpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex 请求超时，请重试以核对同一次操作。")); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", () => {});
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { try { child.kill(signal); } catch {} });
        } else if (child.pid) process.kill(-child.pid, signal);
      } catch {}
    };
    try {
      await rpc("initialize", { clientInfo: { name: "pp_agent_reset_credit", version: "1.0" } });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n", () => {});
      return await run(rpc);
    } finally {
      child.stdin.end(); kill("SIGTERM");
      const timer = setTimeout(() => kill("SIGKILL"), 2_000);
      await closed; clearTimeout(timer); lines.close();
      options.commitAuth?.(authFile);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
