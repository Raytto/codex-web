import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type SharedCodexAuthPolicy = {
  sourceFile: string;
  lockFile: string;
  mode: "shared" | "own";
  userIds: ReadonlySet<string>;
};

export type SharedCodexAuthLease = {
  commitAndRelease(): Promise<void>;
  releaseWithoutCommit(): Promise<void>;
};

type AcquireOptions = {
  sourceFile: string;
  targetFile: string;
  lockFile: string;
  targetUid?: number;
  targetGid?: number;
  timeoutSeconds?: number;
};

export function sharedCodexAuthPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SharedCodexAuthPolicy | null {
  const sourceFile = env.CWW_SHARED_CODEX_AUTH_FILE?.trim();
  const lockFile = env.CWW_SHARED_CODEX_AUTH_LOCK?.trim();
  let configuredUsers = env.CWW_SHARED_CODEX_AUTH_USER_IDS ?? "";
  let mode: "shared" | "own" = env.CWW_SHARED_CODEX_AUTH_DEFAULT_MODE === "shared" ? "shared" : "own";
  const policyFile = env.CWW_SHARED_CODEX_AUTH_POLICY_FILE?.trim();
  if (policyFile && fs.existsSync(policyFile)) {
    const payload = JSON.parse(fs.readFileSync(policyFile, "utf8")) as { mode?: unknown; sharedUserIds?: unknown };
    if (payload.mode === "shared" || payload.mode === "own") {
      mode = payload.mode;
      configuredUsers = "";
    } else {
      if (!Array.isArray(payload.sharedUserIds) || payload.sharedUserIds.some((value) => typeof value !== "string")) {
        throw new Error("Shared Codex auth policy file is invalid");
      }
      configuredUsers = payload.sharedUserIds.join(",");
    }
  }
  const userIds = new Set(configuredUsers
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f-]{36}$/i.test(value)));
  if (!sourceFile && !lockFile && userIds.size === 0 && !policyFile) return null;
  if (!sourceFile || !lockFile) throw new Error("Shared Codex auth policy requires both source and lock paths");
  return { sourceFile: path.resolve(sourceFile), lockFile: path.resolve(lockFile), mode, userIds };
}

export function userUsesSharedCodexAuth(policy: SharedCodexAuthPolicy | null, userId: string): boolean {
  return Boolean(policy && (policy.mode === "shared" || policy.userIds.has(userId)));
}

export function validateCodexAuthPayload(raw: Buffer | string): void {
  let value: unknown;
  try { value = JSON.parse(raw.toString()); }
  catch { throw new Error("Codex auth file is not valid JSON"); }
  const root = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const tokens = root?.tokens && typeof root.tokens === "object" ? root.tokens as Record<string, unknown> : null;
  if ((root?.auth_mode !== undefined && root.auth_mode !== "chatgpt")
    || typeof tokens?.access_token !== "string" || !tokens.access_token
    || typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
    throw new Error("Codex auth file does not contain a reusable ChatGPT login");
  }
}

export async function acquireSharedCodexAuth(options: AcquireOptions): Promise<SharedCodexAuthLease> {
  const sourceFile = path.resolve(options.sourceFile);
  const targetFile = path.resolve(options.targetFile);
  const lockFile = path.resolve(options.lockFile);
  if (sourceFile === targetFile) throw new Error("Shared Codex auth source and target must be different files");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const holder = await acquireFlock(lockFile, options.timeoutSeconds ?? 60);
  let released = false;
  try {
    copyValidatedCodexAuth(sourceFile, targetFile, options.targetUid, options.targetGid);
  } catch (error) {
    await releaseFlock(holder);
    throw error;
  }
  const release = async (commit: boolean) => {
    if (released) return;
    released = true;
    try {
      if (commit) copyValidatedCodexAuth(targetFile, sourceFile);
    } finally {
      await releaseFlock(holder);
    }
  };
  return {
    commitAndRelease: () => release(true),
    releaseWithoutCommit: () => release(false),
  };
}

export function copyValidatedCodexAuth(sourceFile: string, targetFile: string, uid?: number, gid?: number): void {
  const payload = fs.readFileSync(sourceFile);
  validateCodexAuthPayload(payload);
  const targetDirectory = path.dirname(targetFile);
  if (uid !== undefined || gid !== undefined) {
    if (uid === undefined || gid === undefined) throw new Error("Target Codex auth identity requires both uid and gid");
    const result = spawnSync(process.execPath, ["-e", [
      "const fs=require('node:fs'),path=require('node:path');",
      "const target=process.argv[1],dir=path.dirname(target),tmp=path.join(dir,'.auth.json.shared-'+process.pid+'-'+Date.now());",
      "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{",
      "try{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(tmp,Buffer.concat(chunks),{mode:0o600,flag:'wx'});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,target);}",
      "catch(error){try{fs.rmSync(tmp,{force:true});}catch{};console.error(error.message);process.exitCode=1;}});",
    ].join(""), targetFile], { input: payload, encoding: "utf8", uid, gid });
    if (result.status !== 0) throw new Error((result.stderr || "Could not publish tenant Codex auth").trim());
    return;
  }
  fs.mkdirSync(targetDirectory, { recursive: true });
  const temporary = path.join(targetDirectory, `.auth.json.shared-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temporary, payload, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, targetFile);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export async function withSharedCodexAuthLock<T>(
  lockFile: string,
  operation: () => Promise<T> | T,
  timeoutSeconds = 60,
): Promise<T> {
  const resolvedLockFile = path.resolve(lockFile);
  fs.mkdirSync(path.dirname(resolvedLockFile), { recursive: true, mode: 0o700 });
  const holder = await acquireFlock(resolvedLockFile, timeoutSeconds);
  try {
    return await operation();
  } finally {
    await releaseFlock(holder);
  }
}

function acquireFlock(lockFile: string, timeoutSeconds: number): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const holder = spawn("flock", ["--exclusive", `--timeout=${timeoutSeconds}`, lockFile, "sh", "-c", "printf 'locked\\n'; cat >/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (!holder.killed) holder.kill("SIGTERM");
      reject(error);
    };
    holder.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000); });
    holder.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (settled || !stdout.includes("locked\n")) return;
      settled = true;
      resolve(holder);
    });
    holder.once("error", fail);
    holder.once("exit", (code, signal) => {
      if (!settled) fail(new Error(stderr.trim() || `Could not acquire shared Codex auth lock (${signal ?? code ?? "unknown"})`));
    });
  });
}

function releaseFlock(holder: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (holder.exitCode !== null || holder.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      if (!holder.killed) holder.kill("SIGTERM");
    }, 5_000);
    timer.unref();
    holder.once("exit", () => { clearTimeout(timer); resolve(); });
    holder.stdin.end();
  });
}
