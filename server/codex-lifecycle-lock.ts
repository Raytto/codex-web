import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type SpawnOptionsWithoutStdio } from "node:child_process";

const heldHomes = new Set<string>();

export function codexHomeRuntimeBusy(home: string): boolean {
  if (heldHomes.has(path.resolve(home))) return false;
  const file = path.join(home, ".pp-agent-lifecycle.lock");
  if (!fs.existsSync(file)) return false;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    execFileSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
    return false;
  } catch { return true; }
  finally { fs.closeSync(fd); }
}

function lockFile(home: string): string {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, ".pp-agent-lifecycle.lock");
  // The maintenance process must not create a root-owned file in a tenant Home.
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    if (process.getuid?.() === 0) {
      const owner = fs.statSync(home);
      fs.fchownSync(fd, owner.uid, owner.gid);
    }
  } finally { fs.closeSync(fd); }
  return file;
}

/** flock survives its helper: descriptor 3 shares the parent's open file
 * description. Closing the parent descriptor releases the exclusive lease. */
export function acquireCodexLifecycleLock(home: string): () => void {
  const fd = fs.openSync(lockFile(home), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try { execFileSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", fd] }); }
  catch { fs.closeSync(fd); throw new Error("codex_runtime_active"); }
  heldHomes.add(path.resolve(home));
  return () => { heldHomes.delete(path.resolve(home)); fs.closeSync(fd); };
}

/** The lock belongs to the runtime itself (including its children), not the
 * Web Job's terminal flag. A waiting launch cannot open an evicted rollout. */
export function spawnCodexRuntime(executable: string, args: string[], options: SpawnOptionsWithoutStdio) {
  const home = options.env?.CODEX_HOME;
  if (!home || process.platform !== "linux") return spawn(executable, args, options);
  return spawn("flock", ["--shared", "--no-fork", lockFile(home), executable, ...args], options);
}

/** Also protect pre-upgrade/unmanaged writers. Never use edge.status=open as
 * runtime evidence. /proc errors other than vanished processes fail closed. */
export function assertNoUnmanagedCodexRuntime(home: string, files: string[]): void {
  if (process.platform !== "linux") throw new Error("runtime_inspection_unsupported");
  const actualHome = fs.realpathSync(home);
  const inodes = new Set(files.filter((file) => fs.existsSync(file)).map((file) => {
    const st = fs.statSync(file); return `${st.dev}:${st.ino}`;
  }));
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)) {
    try {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (command.some((arg) => arg === "app-server" || arg === "exec") && /codex/.test(command[0] ?? "")) {
        const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        const runtimeHome = env.find((value) => value.startsWith("CODEX_HOME="))?.slice(11);
        if (runtimeHome && fs.existsSync(runtimeHome) && fs.realpathSync(runtimeHome) === actualHome) throw new Error("codex_runtime_active");
      }
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
          const st = fs.statSync(`/proc/${pid}/fd/${fd}`);
          if (inodes.has(`${st.dev}:${st.ino}`)) throw new Error("rollout_open_by_runtime");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
  }
}
