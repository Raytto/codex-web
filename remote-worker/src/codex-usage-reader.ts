import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { normalizeResetCredits, unavailableResetCredits, type CodexResetCredits } from "./codex-reset-credits.js";

/** Isolated read, no model turn, no account switching, no reset redemption. */
export async function readAccountResetCredits(options: {
  executable: string; authFile: string; expectedAccountId: string; temporaryRoot: string;
  env?: NodeJS.ProcessEnv;
  // The caller must hold its credential lifecycle lock through commitAuth.
  commitAuth?: (temporaryAuth: string) => void;
}): Promise<CodexResetCredits> {
  fs.mkdirSync(options.temporaryRoot, { recursive: true, mode: 0o700 });
  const home = fs.mkdtempSync(path.join(options.temporaryRoot, "usage-"));
  const authFile = path.join(home, "auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(options.authFile, "utf8"));
    if (auth.tokens?.account_id !== options.expectedAccountId) return unavailableResetCredits("error");
    // Remote observers may own token rotation. In that case, use access-only copies.
    if (!options.commitAuth) auth.tokens.refresh_token = "";
    fs.writeFileSync(authFile, JSON.stringify(auth), { mode: 0o600 });
    const js = options.executable.endsWith(".js");
    const environment = { ...(options.env ?? process.env), CODEX_HOME: home };
    for (const key of ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"]) delete (environment as NodeJS.ProcessEnv)[key];
    const child = spawn(js ? process.execPath : options.executable,
      [...(js ? [options.executable] : []), "app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"'],
      { cwd: home, env: environment, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { try { child.kill(signal); } catch {} });
        } else if (child.pid) process.kill(-child.pid, signal);
      } catch { /* Already exited. */ }
    };
    let result = unavailableResetCredits("error");
    let finished = false;
    let terminateTimer: NodeJS.Timeout | undefined;
    const output = readline.createInterface({ input: child.stdout });
    const send = (id: number, method: string, params: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ id, method, params }) + "\n", () => {});
    };
    await new Promise<void>((resolve) => {
      const finish = () => {
        if (finished) return;
        finished = true;
        child.stdin.end();
        kill("SIGTERM");
        terminateTimer = setTimeout(() => kill("SIGKILL"), 2_000);
        terminateTimer.unref();
      };
      const deadline = setTimeout(finish, 20_000);
      child.once("error", () => { clearTimeout(deadline); resolve(); });
      child.once("close", () => { clearTimeout(deadline); if (terminateTimer) clearTimeout(terminateTimer); resolve(); });
      child.stdin.on("error", () => {});
      output.on("line", (line) => {
        if (finished) return;
        let message: { id?: number; method?: string; result?: Record<string, unknown>; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { return; }
        if (message.method || (message.id !== 1 && message.id !== 2)) return;
        if (message.error) {
          result = unavailableResetCredits(/401|unauthori|expired|refresh.token|log.?in/i.test(message.error.message ?? "") ? "auth_required" : "error");
          finish(); return;
        }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n", () => {});
          send(2, "account/rateLimits/read", {}); // Include detail rows for the earliest expiry.
        } else {
          const accountId = message.result?.accountId;
          result = accountId && accountId !== options.expectedAccountId
            ? unavailableResetCredits("error") : normalizeResetCredits(message.result);
          finish();
        }
      });
      send(1, "initialize", { clientInfo: { name: "pp_agent_account_usage", version: "1.0" } });
    });
    output.close();
    // Even a failed usage read can have refreshed auth; commit only after the writer exits.
    options.commitAuth?.(authFile);
    return result;
  } catch { return unavailableResetCredits("error"); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}
