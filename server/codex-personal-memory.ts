import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnCodexRuntime } from "./codex-lifecycle-lock.js";
import { applyCodexProxyEnvironment, selectCodexEgress } from "./codex-egress.js";
import { constrainedCodexArguments } from "./constrained-codex.js";

export const PERSONAL_MEMORY_PROVIDER = "codex-cli";
export function personalMemoryModel() { return process.env.PERSONAL_MEMORY_MODEL?.trim() || ""; }
export const PERSONAL_MEMORY_EFFORT = process.env.PERSONAL_MEMORY_EFFORT?.trim() || "medium";
export type PersonalMemoryExecute = (userId: string, prompt: string, timeoutMs: number, signal: AbortSignal) => Promise<string>;
type Request = { userId: string; prompt: string; timeoutMs: number; engineId?: string };
export const PERSONAL_MEMORY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["candidates"],
  properties: { candidates: { type: "array", maxItems: 50, items: {
    type: "object", additionalProperties: false,
    required: ["kind", "canonical_key", "statement", "scope", "evidence_kind", "sensitivity", "message_ids", "ttl_days"],
    properties: {
      kind: { type: "string", enum: ["identity", "preference", "knowledge_level"] },
      canonical_key: { type: "string" }, statement: { type: "string" }, scope: { type: "string", enum: ["user_global"] },
      evidence_kind: { type: "string", enum: ["direct", "inferred", "correction", "forget"] },
      sensitivity: { type: "string", enum: ["normal", "sensitive"] },
      message_ids: { type: "array", items: { type: "string" } }, ttl_days: { type: "null" },
    },
  } } },
};

export function validatePersonalMemoryRequest(request: Request, expectedUserId?: string): void {
  if (!request || !/^[0-9a-f-]{36}$/i.test(request.userId) || (expectedUserId && expectedUserId !== request.userId)) throw new Error("personal_memory_user_mismatch");
  if (request.engineId !== undefined && request.engineId !== "codex") throw new Error("personal_memory_invalid_engine");
  if (typeof request.prompt !== "string" || !request.prompt || Buffer.byteLength(request.prompt) > 500_000) throw new Error("personal_memory_invalid_input");
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 30_000 || request.timeoutMs > 300_000) throw new Error("personal_memory_invalid_timeout");
}

export function personalMemoryArguments(schema: string, output: string): string[] {
  const args = constrainedCodexArguments(personalMemoryModel(), PERSONAL_MEMORY_EFFORT, schema, output);
  args.splice(args.length - 1, 0,
    "--config", 'model_provider="openai"', "--config", "project_doc_max_bytes=0",
    "--config", "features.apps=false", "--config", "features.multi_agent=false",
    "--config", "features.memories=false", "--config", "features.sleep_tool=false",
    "--config", "features.tool_suggest=false",
  );
  return args;
}

// Only these classifications can reach durable audit/logs; never relay model text or stderr.
export function personalMemoryError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const known = value.match(/\bpersonal_memory_[a-z_]+\b/);
  const codes = new Set(["personal_memory_cancelled", "personal_memory_timeout", "personal_memory_quota",
    "personal_memory_auth", "personal_memory_model_unavailable", "personal_memory_executor_offline",
    "personal_memory_resources_busy", "personal_memory_execution_failed", "personal_memory_invalid_result",
    "personal_memory_runtime_mismatch", "personal_memory_invalid_output", "personal_memory_user_mismatch",
    "personal_memory_invalid_engine", "personal_memory_invalid_input", "personal_memory_invalid_timeout"]);
  if (known && codes.has(known[0])) return known[0];
  if (/quota|rate.limit|usage.limit|额度|429/i.test(value)) return "personal_memory_quota";
  if (/auth|login|credential|401|403|token.*(?:expired|refresh)|refresh.*token/i.test(value)) return "personal_memory_auth";
  if (/model.*(?:unavailable|not found|unsupported|not supported|does not exist|not available)|model_not_found/i.test(value)) return "personal_memory_model_unavailable";
  if (/timed?.?out|timeout/i.test(value)) return "personal_memory_timeout";
  if (/offline|disconnect|ECONN|ENOTFOUND|unavailable|isolation/i.test(value)) return "personal_memory_executor_offline";
  if (/memory|resource/i.test(value)) return "personal_memory_resources_busy";
  return "personal_memory_execution_failed";
}

export function decodePersonalMemoryResult(raw: string): string {
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error("personal_memory_invalid_result"); }
  if (result.provider !== PERSONAL_MEMORY_PROVIDER || result.model !== personalMemoryModel() || result.reasoningEffort !== PERSONAL_MEMORY_EFFORT || typeof result.output !== "string") throw new Error("personal_memory_runtime_mismatch");
  return result.output;
}

export async function runCodexPersonalMemory(request: Request, callbacks: { signal: AbortSignal; onAuthReady?(): void }): Promise<string> {
  validatePersonalMemoryRequest(request, process.env.CWW_TENANT_USER_ID || undefined);
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = AbortSignal.any([callbacks.signal, timeout]);
  if (signal.aborted) throw new Error("personal_memory_cancelled");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppagent-memory-"));
  const schemaPath = path.join(temporaryRoot, "schema.json"), outputPath = path.join(temporaryRoot, "output.json");
  fs.writeFileSync(schemaPath, JSON.stringify(PERSONAL_MEMORY_SCHEMA), { mode: 0o600 });
  try {
    const egress = await selectCodexEgress({ signal });
    if (signal.aborted) throw new Error(timeout.aborted ? "personal_memory_timeout" : "personal_memory_cancelled");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawnCodexRuntime(process.env.CODEX_RUNTIME_PATH || "codex", personalMemoryArguments(schemaPath, outputPath), {
        cwd: temporaryRoot, env: applyCodexProxyEnvironment({ ...process.env }, egress.proxyUrl),
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
      let diagnostic = "", failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
      const kill = (kind: NodeJS.Signals) => {
        try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch {}
      };
      const abort = () => {
        failure = new Error(timeout.aborted ? "personal_memory_timeout" : "personal_memory_cancelled");
        kill("SIGTERM");
        killTimer ??= setTimeout(() => kill("SIGKILL"), 2_000);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      let authReady = false;
      child.stdout.on("data", () => { if (!authReady) { authReady = true; callbacks.onAuthReady?.(); } });
      child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8_000); });
      child.stdin.on("error", () => { /* close handles EPIPE and the exit status */ });
      child.once("error", error => { failure = new Error(personalMemoryError(error)); });
      child.once("close", code => {
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error(personalMemoryError(diagnostic)));
        try {
          if (fs.statSync(outputPath).size > 200_000) throw new Error();
          const value = fs.readFileSync(outputPath, "utf8").trim();
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed?.candidates)) throw new Error();
          resolve(value);
        } catch { reject(new Error("personal_memory_invalid_output")); }
      });
      child.stdin.end(request.prompt, "utf8");
    });
    return JSON.stringify({ provider: PERSONAL_MEMORY_PROVIDER, model: personalMemoryModel(), reasoningEffort: PERSONAL_MEMORY_EFFORT, output });
  } catch (error) {
    if (signal.aborted) throw new Error(timeout.aborted ? "personal_memory_timeout" : "personal_memory_cancelled");
    throw new Error(personalMemoryError(error));
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
}
