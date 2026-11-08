import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MEMORY_BOOTSTRAP, TASK_MEMORY_BYTES, assertTaskMemoryAvailable, taskMemoryError, type TaskMemoryScopeResult, type TenantMemoryTarget } from "./task-memory.js";
import { tenantIdentityForUser } from "./tenant-identities.js";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scopePrefix = "codex-web-task-";
const scopeGroups = new Map<string, string>();
const commandOptions = { encoding: "utf8" as const, timeout: 5_000, maxBuffer: 64_000 };

export function memoryScopeName(token: string): string {
  if (!UUID.test(token)) throw new Error("Invalid memory scope identity");
  return `${scopePrefix}${token}.scope`;
}

export async function createTaskMemoryScope(pid: number, token: string, options: { limitBytes?: number; owner?: string; tenant?: boolean } = {}): Promise<string> {
  assertTaskMemoryAvailable();
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid memory scope process");
  const unit = memoryScopeName(token);
  const owner = options.owner ?? process.env.CODEX_WEB_TASK_SCOPE_OWNER ?? "";
  if (!/^[a-zA-Z0-9_.@-]+\.service$/.test(owner)) throw new Error("Task memory scope owner must be configured");
  const limit = options.limitBytes ?? TASK_MEMORY_BYTES;
  // No pool limit, reservation or additional concurrency cap. Every task is a
  // sibling scope with its own watermark and limit.
  const properties = [
    "PIDs", "au", "1", String(pid),
    "MemoryMax", "t", String(limit),
    "MemorySwapMax", "t", "0",
    "OOMPolicy", "s", "kill",
    "TimeoutStopUSec", "t", "5000000",
    "BindsTo", "as", "1", owner,
    "After", "as", "1", owner,
    "Slice", "s", options.tenant ? "system-codexwebtenants.slice" : "system.slice",
  ];
  try {
    await exec("/usr/bin/busctl", ["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "8", ...properties, "0"], commandOptions);
    const { stdout } = await exec("/usr/bin/systemctl", ["show", unit, "--property=ControlGroup", "--value"], commandOptions);
    const group = stdout.trim();
    const parent = options.tenant ? "/system.slice/system-codexwebtenants.slice/" : "/system.slice/";
    if (group !== `${parent}${unit}`) throw new Error("Unexpected memory scope");
    // The bridge/task mount namespace may hide /sys/fs/cgroup. Read the real
    // host hierarchy without changing the bridge's namespaces or permissions.
    const root = path.join("/proc/1/root/sys/fs/cgroup", group);
    if (fs.readFileSync(path.join(root, "memory.max"), "utf8").trim() !== String(limit)
      || fs.readFileSync(path.join(root, "memory.swap.max"), "utf8").trim() !== "0"
      || fs.readFileSync(path.join(root, "memory.oom.group"), "utf8").trim() !== "1"
      || !fs.readFileSync(path.join(root, "cgroup.procs"), "utf8").split(/\s+/).includes(String(pid))) {
      throw new Error("Memory scope verification failed");
    }
    scopeGroups.set(token, root);
    return unit;
  } catch {
    await finishTaskMemoryScope(token).catch(() => undefined);
    throw taskMemoryError("MEMORY_GUARD_UNAVAILABLE");
  }
}

export async function finishTaskMemoryScope(token: string): Promise<TaskMemoryScopeResult> {
  const unit = memoryScopeName(token);
  let result: TaskMemoryScopeResult = { oom: false, peakBytes: null };
  // Kernel counters are committed before the victim exits; systemd may still
  // be processing its exit notification when our child exit handler runs.
  const group = scopeGroups.get(token);
  if (group) {
    try {
      const events = fs.readFileSync(path.join(group, "memory.events"), "utf8");
      result.oom = Number(/^oom_kill\s+(\d+)$/m.exec(events)?.[1] ?? 0) > 0;
      const peak = Number(fs.readFileSync(path.join(group, "memory.peak"), "utf8").trim());
      if (Number.isSafeInteger(peak) && peak >= 0) result.peakBytes = peak;
    } catch { /* The failed unit's Result remains available after cgroup removal. */ }
  }
  try {
    const { stdout } = await exec("/usr/bin/systemctl", ["show", unit, "--property=Result", "--property=MemoryPeak"], commandOptions);
    const fields = Object.fromEntries(stdout.trim().split("\n").map(line => line.split("=")));
    const peak = Number(fields.MemoryPeak);
    result = { oom: result.oom || fields.Result === "oom-kill", peakBytes: Number.isSafeInteger(peak) && peak >= 0 ? peak : result.peakBytes };
  } catch { /* An empty successful scope is normally already collected. */ }
  // Stop ALL descendants, including a tool which detached its process group.
  // Do not release the Job until cleanup has completed. Failed scopes remain
  // queryable above; reset only after recording the OOM result.
  await exec("/usr/bin/systemctl", ["kill", "--signal=SIGKILL", "--kill-whom=all", unit], commandOptions).catch(() => undefined);
  await exec("/usr/bin/systemctl", ["stop", unit], commandOptions).catch(() => undefined);
  await exec("/usr/bin/systemctl", ["reset-failed", unit], commandOptions).catch(() => undefined);
  scopeGroups.delete(token);
  return result;
}

export function validateTenantMemoryTarget(target: TenantMemoryTarget): number {
  const identity = tenantIdentityForUser(target.userId);
  if (!identity || !UUID.test(target.token) || !Number.isSafeInteger(target.pid) || target.pid < 2) throw new Error("Invalid tenant memory target");
  return identity.uid;
}

export async function resolveTenantMemoryPid(target: TenantMemoryTarget): Promise<number> {
  const uid = validateTenantMemoryTarget(target);
  // Fixed deployment identity: callers never provide a container, host PID,
  // cgroup path, executable, limit, unit name or arbitrary systemd properties.
  const container = process.env.CODEX_WEB_TENANT_CONTAINER_NAME || "";
  if (!container || !/^[a-zA-Z0-9_.-]+$/.test(container)) throw new Error("Tenant container must be explicitly configured");
  const { stdout } = await exec("/usr/bin/docker", ["inspect", "--format", "{{.State.Pid}}", container], commandOptions);
  const initPid = Number(stdout.trim());
  if (!Number.isSafeInteger(initPid) || initPid < 2) throw new Error("Tenant container is unavailable");
  const initGroup = fs.readFileSync(`/proc/${initPid}/cgroup`, "utf8");
  const initRoot = fs.statSync(`/proc/${initPid}/root`);
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const directory = `/proc/${entry}`;
    try {
      const status = fs.readFileSync(`${directory}/status`, "utf8");
      const uids = /^Uid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);
      const pids = /^NSpid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);
      if (!uids?.every(value => value === uid) || !pids || pids.length < 2 || pids.at(-1) !== target.pid) continue;
      if (fs.readFileSync(`${directory}/cgroup`, "utf8") !== initGroup) continue;
      const root = fs.statSync(`${directory}/root`);
      if (root.dev !== initRoot.dev || root.ino !== initRoot.ino) continue;
      const argv = fs.readFileSync(`${directory}/cmdline`, "utf8").split("\0");
      const allowed = ["tenant-worker.js", "codex-voice-review-worker.js", "codex-conversation-title-worker.js"];
      if (argv[1] !== "-c" || argv[2] !== MEMORY_BOOTSTRAP || argv[3] !== "ppa-memory-bootstrap"
        || !allowed.includes(path.basename(argv[5] ?? "")) || path.dirname(argv[5] ?? "") !== "/app/dist-server/server") continue;
      const env = fs.readFileSync(`${directory}/environ`, "utf8");
      if (!env.split("\0").includes(`CWW_MEMORY_WORKER_TOKEN=${target.token}`)
        || !env.split("\0").includes(`CWW_TENANT_USER_ID=${target.userId}`)) continue;
      return Number(entry);
    } catch { /* Process exited or is outside the readable target boundary. */ }
  }
  throw new Error("Tenant worker identity could not be verified");
}
