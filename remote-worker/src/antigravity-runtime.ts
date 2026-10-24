import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentOptions, AgentModelOption } from "./protocol.js";

export const ANTIGRAVITY_MODEL_PREFIX = "antigravity:";
export const ANTIGRAVITY_VERIFIED_VERSION = "1.4.6";
const OFFICIAL_RELEASE_ROOT = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.6-4884751325200384/";
// Pinned from the official updater manifests on 2026-10-23. Only these vendor
// files may be installed; an upstream auto-update cannot change this contract.
const RELEASES: Record<string, { file: string; sha512: string }> = {
  "linux-x64": { file: "linux-x64/cli_linux_x64.tar.gz", sha512: "4e1244b8b8c1280552f59c1b24b76a9245db9c80032aec6db28fb86033d6088abc30a90dad432d2b246c28fdd87d82abb48727d5ff88ba1d5d4ec76b33348e7d" },
  "linux-arm64": { file: "linux-arm/cli_linux_arm64.tar.gz", sha512: "0daa84244922bd648f940d44dfc33ace8c26217cd710ff116902eb8708829a0cfe70640f0d6b480243442881c9aeb4a905a9aa7887dd8a70159aa0f1a4f98a8f" },
  "darwin-x64": { file: "darwin-x64/cli_mac_x64.tar.gz", sha512: "4506e66b243ede25207f7add9b9661dd54b60f930d3c1a6a5cda4cb8849e9494b41a496d7e4c06d1f36af12c12a4588affe240f83ebeb1d233a7702e2ca02751" },
  "darwin-arm64": { file: "darwin-arm/cli_mac_arm64.tar.gz", sha512: "25af49004dd6d6013e6231278e2711b95641c8e54b661be871b3519c0a850053d4e707f46b47aa66e84ff9480041b13908194b48b1a97f84f2a22071d9c9fd3f" },
  "win32-x64": { file: "windows-x64/cli_windows_x64.exe", sha512: "56e6f15ce99d349ae8186d4e049a1ca8c7002e09447b5498da06581bd02843641bc95aa37046b0121dd3783c3a863135edbc0650b409a0e6b562c60e76240d22" },
  "win32-arm64": { file: "windows-arm/cli_windows_arm64.exe", sha512: "d65fa18e5851681a8b8b7ea04b2f25a6a6f140f9ee1ed81bfe6cb51dd7fa66d2b7845ace26ddf7627be5d1727097d4a64b454b3d997f24164745537c4eecf1bf" },
};
const installations = new Map<string, Promise<string>>();

function managedRuntimePath(root: string): string { return path.join(path.resolve(root), "runtime", ANTIGRAVITY_VERIFIED_VERSION, `${process.platform}-${process.arch}`, process.platform === "win32" ? "agy.exe" : "agy"); }
export function managedAntigravityExecutable(root: string): string | null {
  const candidate = managedRuntimePath(root);
  return isExecutable(candidate) ? candidate : null;
}

/** Called only from an explicit add-account action, never from a status poll. */
export async function ensureAntigravityInstalled(options: { root: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  const target = managedRuntimePath(options.root);
  const pending = installations.get(target);
  if (pending) return pending;
  const promise = installPinnedRuntime(options, target).finally(() => installations.delete(target));
  installations.set(target, promise);
  return promise;
}

async function installPinnedRuntime(options: { root: string; env?: NodeJS.ProcessEnv }, target: string): Promise<string> {
  const current = managedAntigravityExecutable(options.root);
  if (current) {
    const version = await runAntigravityCommand(["--version"], { executable: current, env: options.env, timeoutMs: 10_000 });
    if (version.code === 0 && version.stdout.trim() === ANTIGRAVITY_VERIFIED_VERSION) return current;
    throw new Error("已安装的 Gemini 引擎版本与受管版本不符，请管理员检查后重试。");
  }
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error("当前系统或处理器暂无经过核验的 Antigravity CLI 安装包。");
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(parent, ".install-"));
  try {
    const response = await fetch(`${OFFICIAL_RELEASE_ROOT}${release.file}`, { redirect: "error", signal: AbortSignal.timeout(5 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`下载官方 Gemini 引擎失败（${response.status}）。`);
    const archive = path.join(staging, process.platform === "win32" ? "release.exe" : "release");
    const file = await fs.promises.open(archive, "wx", 0o600);
    const digest = crypto.createHash("sha512");
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 512 * 1024 * 1024) throw new Error("Gemini 引擎安装包超过大小限制。");
        digest.update(chunk);
        await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    if (digest.digest("hex") !== release.sha512) throw new Error("Gemini 引擎安装包 SHA-512 校验失败，已停止安装。");
    let binary = archive;
    if (release.file.endsWith(".tar.gz")) {
      // Extract exactly one known member, never arbitrary paths from an archive.
      await promisify(execFile)("tar", ["-xzf", archive, "-C", staging, "antigravity"], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
      binary = path.join(staging, "antigravity");
    }
    fs.chmodSync(binary, 0o700);
    const verified = await runAntigravityCommand(["--version"], { executable: binary, env: options.env, timeoutMs: 10_000 });
    if (verified.code !== 0 || verified.stdout.trim() !== ANTIGRAVITY_VERIFIED_VERSION) throw new Error("Gemini 引擎安装包版本验证失败。");
    fs.renameSync(binary, target);
    return target;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

/** No per-job credentials are persisted: the child inherits its parent's env. */
export function ensureAntigravityMcpConfig(profileHome: string, entrypoint: string): void {
  const directory = path.join(profileHome, ".gemini", "config");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "mcp_config.json");
  let config: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    // The official login can create an empty placeholder before the first run.
    // Initialize that placeholder, but never overwrite nonempty broken config.
    const content = fs.readFileSync(file, "utf8").trim();
    if (content) {
      let parsed: unknown;
      try { parsed = JSON.parse(content); }
      catch { throw new Error("Gemini MCP 配置不是有效 JSON，未覆盖原配置。"); }
      const record = object(parsed);
      if (!record) throw new Error("Gemini MCP 配置不是有效对象，未覆盖原配置。");
      config = record;
    }
  }
  const servers = object(config.mcpServers) ?? {};
  const entry = { command: process.execPath, args: [path.resolve(entrypoint)], timeoutSeconds: 120 };
  if (JSON.stringify(servers.pp_agent) === JSON.stringify(entry)) return;
  config.mcpServers = { ...servers, pp_agent: entry };
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export type AntigravityModelOption = AgentModelOption & {
  engineId: "antigravity";
  providerLabel: "Antigravity";
  reasoningEffortOptions: Array<{ id: string; label: string }>;
  defaultReasoningEffort: string;
  rawModelByEffort: Record<string, string>;
};
export type AntigravityAgentOptions = Omit<AgentOptions, "models"> & { models: AntigravityModelOption[] };
export type AntigravityCommandOptions = { executable?: string; env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number };

/** Resolve the native CLI without starting it or silently installing/updating it. */
export function findAntigravityExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.AGY_RUNTIME_PATH || env.ANTIGRAVITY_RUNTIME_PATH;
  if (explicit) return isExecutable(explicit) ? path.resolve(explicit) : null;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const names = process.platform === "win32" ? ["agy.exe", "antigravity.exe"] : ["agy"];
  const dirs = [...(env.PATH || "").split(path.delimiter), path.join(home, ".local", "bin")].filter(Boolean);
  for (const directory of dirs) for (const name of names) {
    const candidate = path.resolve(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file: string): boolean {
  try { fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(file).isFile(); }
  catch { return false; }
}

export function antigravityLaunch(args: string[], env: NodeJS.ProcessEnv = process.env, executable?: string): { command: string; args: string[] } {
  const command = executable || findAntigravityExecutable(env);
  if (!command) throw new Error("当前节点未安装 Antigravity CLI（agy），请先安装后添加 Gemini 账号。");
  // JS launchers are useful for managed wrappers and deterministic integration tests.
  return /\.[cm]?js$/i.test(command) ? { command: process.execPath, args: [command, ...args] } : { command, args };
}

export async function runAntigravityCommand(args: string[], options: AntigravityCommandOptions = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = options.env ?? process.env;
  const launch = antigravityLaunch(args, env, options.executable);
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd: options.cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Antigravity CLI 查询超时，请检查节点连接或重新登录 Gemini 账号。")); }, options.timeoutMs ?? 45_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 4 * 1024 * 1024) { child.kill("SIGKILL"); finish(new Error("Antigravity CLI 返回的数据超过查询上限。")); }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_000); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, code));
  });
}

export async function readAntigravityModels(options: AntigravityCommandOptions = {}): Promise<AntigravityAgentOptions | null> {
  // Global flags precede the subcommand in the official CLI. This command does
  // no model inference, and refuses to list models without a signed-in account.
  const result = await runAntigravityCommand(["--output-format", "json", "models"], options);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "无法获取 Gemini 账号的模型列表。");
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { throw new Error("Antigravity CLI 未返回有效的模型目录 JSON。"); }
  return normalizeAntigravityModels(value);
}

const EFFORT_LABELS: Record<string, string> = { default: "模型默认", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高" };
const EFFORT_ORDER = ["default", "minimal", "low", "medium", "high", "xhigh", "max"];
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

/** Only catalog-advertised variants become choices; there is no fallback model list. */
export function normalizeAntigravityModels(value: unknown): AntigravityAgentOptions | null {
  const envelope = object(value);
  const result = object(envelope?.result) ?? envelope;
  if (result?.status !== undefined && result.status !== "SUCCESS") return null;
  // AGY 1.4.6 uses the normal print-result envelope for read-only commands:
  // {status:"SUCCESS", command:{name:"models",data:{models:[{id,label}]}}}.
  const command = object(result?.command);
  const payload = command?.name === "models" ? object(command.data) : result;
  const rows = Array.isArray(value) ? value : Array.isArray(payload?.models) ? payload.models : [];
  const names = object(payload?.display_names) ?? {};
  const models = new Map<string, AntigravityModelOption>();
  for (const row of rows) {
    const item = object(row);
    const raw = typeof row === "string" ? row.trim() : string(item?.slug ?? item?.id ?? item?.model);
    if (!raw || raw.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(raw) || item?.available === false || item?.enabled === false) continue;
    const label = string(item?.display_name ?? item?.displayName ?? item?.label ?? item?.name ?? names[raw]) || raw;
    const advertised = item?.reasoningEfforts ?? item?.supported_reasoning_efforts ?? item?.efforts;
    const explicitEfforts = Array.isArray(advertised) ? advertised.map((entry) => typeof entry === "string" ? entry : string(object(entry)?.id ?? object(entry)?.effort)).filter((effort) => /^[a-z][a-z0-9_-]{0,30}$/.test(effort)) : [];
    const suffix = raw.match(/-(minimal|low|medium|high|xhigh|max)$/);
    const fixedEffort = string(item?.effort ?? item?.reasoning_effort) || suffix?.[1];
    const efforts = explicitEfforts.length ? [...new Set(explicitEfforts)] : [fixedEffort || "default"];
    // Keep the exact advertised slug per effort. Never synthesize an executable
    // model id by trimming a suffix and assuming --model accepts that base.
    const base = suffix && !explicitEfforts.length ? raw.slice(0, -suffix[0].length) : raw;
    const id = `${ANTIGRAVITY_MODEL_PREFIX}${base}`;
    const current = models.get(id) ?? {
      id, label: suffix ? label.replace(/\s*\(?(?:minimal|low|medium|high|xhigh|max)\)?$/i, "").trim() : label,
      description: string(item?.description) || "通过此节点的 Google 账号运行 Antigravity CLI",
      engineId: "antigravity" as const, providerLabel: "Antigravity" as const,
      reasoningEfforts: [], reasoningEffortOptions: [], defaultReasoningEffort: "", rawModelByEffort: {},
    };
    for (const effort of efforts) {
      if (!current.reasoningEfforts.includes(effort)) current.reasoningEfforts.push(effort);
      current.rawModelByEffort[effort] = raw;
    }
    const declaredDefault = string(item?.defaultReasoningEffort ?? item?.default_effort);
    if (declaredDefault && efforts.includes(declaredDefault)) current.defaultReasoningEffort = declaredDefault;
    models.set(id, current);
  }
  if (!models.size) return null;
  for (const model of models.values()) {
    model.reasoningEfforts.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    model.reasoningEffortOptions = model.reasoningEfforts.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
    model.defaultReasoningEffort ||= model.reasoningEfforts.includes("medium") ? "medium" : model.reasoningEfforts[0]!;
  }
  const list = [...models.values()];
  const defaultRaw = string(payload?.default_model ?? payload?.selected_model);
  const defaultModel = list.find((item) => Object.values(item.rawModelByEffort).includes(defaultRaw)) ?? list[0]!;
  return {
    models: list,
    reasoningEfforts: [...new Set(list.flatMap((item) => item.reasoningEfforts))].map((id) => ({ id, label: EFFORT_LABELS[id] ?? id })),
    defaults: { model: defaultModel.id, reasoningEffort: defaultModel.defaultReasoningEffort },
  };
}

export function resolveAntigravityModel(options: AntigravityAgentOptions, model: string, effort: string): { model: string; reasoningEffort: string } {
  const selected = options.models.find((entry) => entry.id === model);
  if (!selected) throw new Error("当前 Gemini 账号不支持所选模型，请重新选择模型。");
  const raw = selected.rawModelByEffort[effort];
  if (!raw) throw new Error("所选 Gemini 模型不支持此思考深度，请重新选择。");
  return { model: raw, reasoningEffort: effort === "default" ? "" : effort };
}
