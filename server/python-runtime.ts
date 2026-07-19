import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";

export type PythonRuntime = {
  uvPath: string;
  pythonPath: string;
  runnerPath: string;
  ready: boolean;
};

export function resolvePythonRuntime(config: Pick<AppConfig, "projectRoot" | "pythonRuntimeRoot">): PythonRuntime {
  const windows = process.platform === "win32";
  const uvPath = path.join(config.pythonRuntimeRoot, "bin", windows ? "uv.exe" : "uv");
  const pythonPath = path.join(config.pythonRuntimeRoot, "shared", windows ? path.join("Scripts", "python.exe") : path.join("bin", "python"));
  return {
    uvPath,
    pythonPath,
    runnerPath: path.join(config.projectRoot, "scripts", windows ? "run-python-task.ps1" : "run-python-task.sh"),
    ready: fs.existsSync(uvPath) && fs.existsSync(pythonPath),
  };
}

export function prepareJobRuntime(workspace: string, jobId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Invalid job id");
  const runtimeRoot = path.join(workspace, ".runtime", "jobs", jobId);
  for (const directory of ["uv-cache", "pip-cache", "tmp", "home", "xdg-cache", "xdg-config", "xdg-state", "xdg-runtime"]) {
    fs.mkdirSync(path.join(runtimeRoot, directory), { recursive: true });
  }
  return runtimeRoot;
}

export function cleanupJobRuntime(runtimeRoot: string): void {
  try {
    fs.rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Sandbox-created children can have a restrictive Windows ACL. Each job uses
    // an independent directory, so an undeletable stale directory cannot block
    // later turns in the same conversation.
  }
}

export function buildCodexEnvironment(runtime: PythonRuntime, runtimeRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const pathEntries = runtime.ready ? [path.dirname(runtime.pythonPath), path.dirname(runtime.uvPath)] : [];
  env[pathKey] = [...pathEntries, env[pathKey] ?? ""].filter(Boolean).join(path.delimiter);
  env.CWW_SHARED_PYTHON = runtime.pythonPath;
  env.CWW_UV = runtime.uvPath;
  env.CWW_PYTHON_RUNNER = runtime.runnerPath;
  env.CWW_JOB_RUNTIME = runtimeRoot;
  env.UV_CACHE_DIR = path.join(runtimeRoot, "uv-cache");
  env.PIP_CACHE_DIR = path.join(runtimeRoot, "pip-cache");
  env.TMPDIR = path.join(runtimeRoot, "tmp");
  env.TMP = env.TMPDIR;
  env.TEMP = env.TMPDIR;
  env.XDG_CACHE_HOME = path.join(runtimeRoot, "xdg-cache");
  env.XDG_CONFIG_HOME = path.join(runtimeRoot, "xdg-config");
  env.XDG_STATE_HOME = path.join(runtimeRoot, "xdg-state");
  env.XDG_RUNTIME_DIR = path.join(runtimeRoot, "xdg-runtime");
  env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}

export function buildShellEnvironment(runtime: PythonRuntime, runtimeRoot: string): Record<string, string> {
  return {
    CWW_SHARED_PYTHON: runtime.pythonPath,
    CWW_UV: runtime.uvPath,
    CWW_PYTHON_RUNNER: runtime.runnerPath,
    CWW_JOB_RUNTIME: runtimeRoot,
    UV_CACHE_DIR: path.join(runtimeRoot, "uv-cache"),
    PIP_CACHE_DIR: path.join(runtimeRoot, "pip-cache"),
    HOME: path.join(runtimeRoot, "home"),
    TMPDIR: path.join(runtimeRoot, "tmp"),
    TMP: path.join(runtimeRoot, "tmp"),
    TEMP: path.join(runtimeRoot, "tmp"),
    XDG_CACHE_HOME: path.join(runtimeRoot, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(runtimeRoot, "xdg-config"),
    XDG_STATE_HOME: path.join(runtimeRoot, "xdg-state"),
    XDG_RUNTIME_DIR: path.join(runtimeRoot, "xdg-runtime"),
    PYTHONDONTWRITEBYTECODE: "1",
  };
}
