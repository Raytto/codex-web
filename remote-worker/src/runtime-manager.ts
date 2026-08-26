import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readCodexAgentOptions } from "./codex-client.js";
import type { RuntimeStatus } from "./protocol.js";

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export class RuntimeManager {
  private readonly runtimeRoot: string;
  private readonly pointerPath: string;
  private fallbackPath: string;
  private status: RuntimeStatus = {
    installedVersion: "unknown", latestVersion: null, versionCheckedAt: null,
    catalogUpdatedAt: null, agentOptions: null,
  };

  constructor(private readonly stateRoot: string, configuredPath?: string) {
    this.runtimeRoot = path.join(stateRoot, "codex-runtime");
    this.pointerPath = path.join(this.runtimeRoot, "current.json");
    this.fallbackPath = configuredPath || "codex";
    fs.mkdirSync(path.join(this.runtimeRoot, "releases"), { recursive: true });
    process.env.CODEX_RUNTIME_PATH = this.activePath();
  }

  snapshot(): RuntimeStatus { return structuredClone(this.status); }

  activePath(): string {
    try {
      const pointer = JSON.parse(fs.readFileSync(this.pointerPath, "utf8")) as { path?: unknown };
      if (typeof pointer.path === "string" && fs.existsSync(pointer.path)) return pointer.path;
    } catch { /* A missing or incomplete managed runtime falls back to the installer-selected CLI. */ }
    return this.fallbackPath;
  }

  async refresh(checkLatest: boolean, forceLatest = false): Promise<RuntimeStatus> {
    const executable = this.activePath();
    process.env.CODEX_RUNTIME_PATH = executable;
    const now = new Date().toISOString();
    const latestDue = checkLatest && (forceLatest || !this.status.versionCheckedAt || Date.now() - Date.parse(this.status.versionCheckedAt) >= 12 * 60 * 60 * 1000);
    const [installed, options, latest] = await Promise.all([
      Promise.resolve(detectVersion(executable)),
      readCodexAgentOptions(executable),
      latestDue ? queryLatestVersion() : Promise.resolve(this.status.latestVersion),
    ]);
    this.status = {
      installedVersion: installed,
      latestVersion: latest,
      versionCheckedAt: latestDue ? now : this.status.versionCheckedAt,
      catalogUpdatedAt: now,
      agentOptions: options,
    };
    return this.snapshot();
  }

  async upgrade(version: string, activeJobs: number): Promise<RuntimeStatus> {
    if (activeJobs > 0) throw new Error("目标机器仍有任务执行，暂不能升级 Codex");
    if (!VERSION_PATTERN.test(version)) throw new Error("服务器返回的 Codex 版本号无效");
    const releasesRoot = path.join(this.runtimeRoot, "releases");
    const finalRoot = path.join(releasesRoot, version);
    const finalExecutable = packageExecutable(finalRoot);
    const previousPath = this.activePath();
    let stagingRoot = "";
    if (!fs.existsSync(finalExecutable)) {
      stagingRoot = path.join(releasesRoot, `.staging-${version}-${process.pid}-${Date.now()}`);
      fs.mkdirSync(stagingRoot, { recursive: true });
      try {
        const npm = npmLaunch(["install", "--prefix", stagingRoot, `@openai/codex@${version}`, "--omit=dev", "--no-audit", "--no-fund"]);
        await run(npm.command, npm.args, 10 * 60_000);
        const stagedExecutable = packageExecutable(stagingRoot);
        if (detectVersion(stagedExecutable) !== version) throw new Error("新 Codex 版本自检不一致");
        await readCodexAgentOptions(stagedExecutable);
        fs.renameSync(stagingRoot, finalRoot);
        stagingRoot = "";
      } finally {
        if (stagingRoot && fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
      }
    }
    const pointer = { version, path: finalExecutable, previousPath, updatedAt: new Date().toISOString() };
    const temporary = `${this.pointerPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, this.pointerPath);
    process.env.CODEX_RUNTIME_PATH = finalExecutable;
    try {
      return await this.refresh(true, true);
    } catch (error) {
      const rollback = { version: detectVersion(previousPath), path: previousPath, previousPath: finalExecutable, updatedAt: new Date().toISOString() };
      fs.writeFileSync(temporary, `${JSON.stringify(rollback, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporary, this.pointerPath);
      process.env.CODEX_RUNTIME_PATH = previousPath;
      await this.refresh(false).catch(() => undefined);
      throw error;
    }
  }

}

function packageExecutable(releaseRoot: string): string {
  return path.join(releaseRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
}

function detectVersion(executable: string): string {
  try {
    const command = executable.toLowerCase().endsWith(".js") ? process.execPath : executable;
    const args = executable.toLowerCase().endsWith(".js") ? [executable, "--version"] : ["--version"];
    const output = execFileSync(command, args, { encoding: "utf8", timeout: 15_000 }).trim();
    const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
    return match?.[1] ?? (output.slice(0, 80) || "unknown");
  } catch { return "unknown"; }
}

async function queryLatestVersion(): Promise<string> {
  const npm = npmLaunch(["view", "@openai/codex", "dist-tags.latest", "--json", "--silent"]);
  const { stdout } = await execFileAsync(npm.command, npm.args, {
    encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as unknown;
  if (typeof parsed !== "string" || !VERSION_PATTERN.test(parsed)) throw new Error("无法确认最新 Codex 版本");
  return parsed;
}

function npmLaunch(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npm", args };
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((value): value is string => Boolean(value));
  const cli = candidates.find((value) => fs.existsSync(value));
  if (!cli) throw new Error("找不到 Node.js 附带的 npm，无法检查或安装 Codex");
  return { command: process.execPath, args: [cli, ...args] };
}

function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Codex 安装超时")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-12000); });
    child.stderr.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-12000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(output.trim() || `Codex 安装失败 (${code ?? "unknown"})`));
    });
  });
}
