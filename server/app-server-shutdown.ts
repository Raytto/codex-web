import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// App servers are spawned in a private Linux process group. The npm CLI is a
// wrapper: killing only its PID can leave the native session writer running.
export function liveAppServerGroup(pgid: number): { pid: number; state: string }[] {
  const live: { pid: number; state: string }[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // Zombies have closed their descriptors and cannot retain a writer.
      if (Number(fields[2]) === pgid && !["Z", "X"].includes(fields[0])) {
        live.push({ pid: Number(entry), state: fields[0] });
      }
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return live;
}

export async function shutdownAppServer(
  child: ChildProcess,
  exited: Promise<void>,
  options: {
    processGroup: boolean;
    graceMs?: number;
    killMs?: number;
    onEscalation?: (members: { pid: number; state: string }[]) => void;
  },
): Promise<void> {
  let didExit = false;
  void exited.then(() => { didExit = true; });
  const pgid = options.processGroup ? child.pid : undefined;
  const released = () => didExit && (!pgid || liveAppServerGroup(pgid).length === 0);
  const wait = async (ms: number) => {
    const deadline = performance.now() + ms;
    do {
      if (released()) return true;
      await delay(Math.min(50, Math.max(1, deadline - performance.now())));
    } while (performance.now() < deadline);
    return released();
  };
  if (child.stdin?.writable) child.stdin.end();
  if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGTERM");
  if (await wait(options.graceMs ?? 10_000)) return;

  // Force only the private group created for this turn, never a shared host
  // group or an arbitrary PID tree. Keep the exit barrier after escalation.
  if (pgid) {
    const members = liveAppServerGroup(pgid);
    if (members.length) {
      // Diagnostics must not prevent releasing the writer.
      try { options.onEscalation?.(members); } catch { /* best effort */ }
      try { process.kill(-pgid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    if (await wait(options.killMs ?? 5_000)) return;
  }
  throw new Error("Codex app server did not exit after shutdown; session ownership is not released");
}
