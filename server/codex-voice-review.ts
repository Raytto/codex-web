import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyCodexProxyEnvironment, selectCodexEgress } from "./codex-egress.js";

export const VOICE_LEXICON_CODEX_MODEL = "gpt-5.6-luna";
export const VOICE_LEXICON_REASONING_EFFORT = "medium";

export type CodexVoiceReviewRequest = {
  userId: string;
  prompt: string;
  timeoutMs: number;
};

export type CodexVoiceReviewWorkerEvent =
  | { type: "auth_ready" }
  | { type: "completed"; output: string }
  | { type: "failed"; message: string };

export const VOICE_LEXICON_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          transcription_id: { type: "string" },
          observed: { type: "string" },
          intended: { type: "string" },
          is_term: { type: "boolean" },
          is_error: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          term_kind: { type: "string" },
        },
        required: ["transcription_id", "observed", "intended", "is_term", "is_error", "confidence", "term_kind"],
      },
    },
  },
  required: ["reviews"],
};

export function codexVoiceReviewArguments(schemaPath: string, outputPath: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--model", VOICE_LEXICON_CODEX_MODEL,
    "--config", `model_reasoning_effort=${JSON.stringify(VOICE_LEXICON_REASONING_EFFORT)}`,
    "--config", "web_search=\"disabled\"",
    "--config", "tools.web_search=false",
    "--config", "tools.view_image=false",
    "--config", "features.shell_tool=false",
    "--config", "features.unified_exec=false",
    "--config", "agents.enabled=false",
    "--config", "approval_policy=\"never\"",
    "--config", "history.persistence=\"none\"",
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "--json",
    "-",
  ];
}

export function validateCodexVoiceReviewRequest(request: CodexVoiceReviewRequest, expectedUserId?: string): void {
  if (!request || typeof request !== "object") throw new Error("Invalid Codex voice review request");
  if (!/^[0-9a-f-]{36}$/i.test(request.userId) || (expectedUserId && request.userId !== expectedUserId)) {
    throw new Error("Codex voice review user mismatch");
  }
  if (typeof request.prompt !== "string" || request.prompt.length < 1 || Buffer.byteLength(request.prompt, "utf8") > 500_000) {
    throw new Error("Codex voice review prompt is invalid");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 30_000 || request.timeoutMs > 10 * 60_000) {
    throw new Error("Codex voice review timeout is invalid");
  }
}

export async function runCodexVoiceReview(
  request: CodexVoiceReviewRequest,
  callbacks: { signal: AbortSignal; onAuthReady?(): void },
): Promise<string> {
  validateCodexVoiceReviewRequest(request, process.env.CWW_TENANT_USER_ID || undefined);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-voice-review-"));
  const schemaPath = path.join(temporaryRoot, "schema.json");
  const outputPath = path.join(temporaryRoot, "output.json");
  fs.writeFileSync(schemaPath, JSON.stringify(VOICE_LEXICON_OUTPUT_SCHEMA), { encoding: "utf8", mode: 0o600 });
  try {
    const egress = await selectCodexEgress({ signal: callbacks.signal });
    const environment = applyCodexProxyEnvironment({ ...process.env }, egress.proxyUrl);
    return await new Promise<string>((resolve, reject) => {
      const executable = process.env.CODEX_RUNTIME_PATH || "codex";
      const child = spawn(executable, codexVoiceReviewArguments(schemaPath, outputPath), {
        cwd: temporaryRoot,
        env: environment,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let settled = false;
      let authReady = false;
      let stderr = "";
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callbacks.signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value ?? "");
      };
      const stop = () => {
        if (child.exitCode !== null || child.signalCode) return;
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        } else child.kill("SIGTERM");
      };
      const abort = () => { stop(); finish(abortError()); };
      const timer = setTimeout(() => {
        stop();
        finish(new Error(`Codex voice review timed out after ${Math.ceil(request.timeoutMs / 1000)} seconds`));
      }, request.timeoutMs);
      callbacks.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", () => {
        if (!authReady) {
          authReady = true;
          callbacks.onAuthReady?.();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 16_000) stderr += chunk.toString("utf8").slice(0, 16_000 - stderr.length);
      });
      child.once("error", (error) => finish(error));
      child.once("exit", (code, signal) => {
        if (settled) return;
        if (code !== 0) {
          const detail = redactDiagnostic(stderr.trim().split("\n").slice(-8).join("\n")).slice(0, 2_000);
          return finish(new Error(`Codex voice review failed (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
        }
        try {
          const output = fs.readFileSync(outputPath, "utf8").trim();
          if (!output || Buffer.byteLength(output, "utf8") > 1_000_000) throw new Error("Codex voice review returned invalid output");
          JSON.parse(output);
          finish(undefined, output);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Codex voice review output could not be read"));
        }
      });
      child.stdin.end(request.prompt, "utf8");
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function abortError(): Error {
  const error = new Error("Codex voice review was cancelled");
  error.name = "AbortError";
  return error;
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{16,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{48,})\b/g, "[REDACTED]")
    .replace(/((?:password|passwd|token|cookie|secret|api[ _-]?key|authorization|密码|口令|私钥|验证码)\s*[=:：]\s*)\S+/gi, "$1[REDACTED]");
}
