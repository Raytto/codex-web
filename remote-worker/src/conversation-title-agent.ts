import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexLaunch } from "./codex-client.js";

export const TITLE_AGENT_MODEL = "gpt-5.6-luna";
export const TITLE_AGENT_REASONING_EFFORT = "low";
const schema = { type: "object", additionalProperties: false, properties: { title: { type: "string", minLength: 2, maxLength: 10 } }, required: ["title"] };

export function conversationTitleAgentArguments(schemaPath: string, outputPath: string): string[] {
  return [
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--sandbox", "read-only", "--model", TITLE_AGENT_MODEL,
    "--config", `model_reasoning_effort=${JSON.stringify(TITLE_AGENT_REASONING_EFFORT)}`,
    "--config", "web_search=\"disabled\"", "--config", "tools.web_search=false",
    "--config", "tools.view_image=false", "--config", "features.shell_tool=false",
    "--config", "features.unified_exec=false", "--config", "agents.enabled=false",
    "--config", "approval_policy=\"never\"", "--config", "history.persistence=\"none\"",
    "--output-schema", schemaPath, "--output-last-message", outputPath, "--json", "-",
  ];
}

export async function runConversationTitleAgent(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (!prompt || Buffer.byteLength(prompt, "utf8") > 100_000 || timeoutMs < 15_000 || timeoutMs > 120_000) throw new Error("Invalid title agent request");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-title-"));
  const schemaPath = path.join(root, "schema.json");
  const outputPath = path.join(root, "output.json");
  fs.writeFileSync(schemaPath, JSON.stringify(schema), { encoding: "utf8", mode: 0o600 });
  try {
    const launch = codexLaunch(conversationTitleAgentArguments(schemaPath, outputPath));
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { cwd: root, env: process.env, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
      let settled = false;
      let stderr = "";
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value ?? "");
      };
      const abort = () => {
        child.kill("SIGTERM");
        const error = new Error("Codex title request cancelled");
        error.name = "AbortError";
        finish(error);
      };
      const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("Codex title request timed out")); }, timeoutMs);
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8_000) stderr += chunk.toString("utf8").slice(0, 8_000 - stderr.length); });
      child.once("error", (error) => finish(error));
      child.once("exit", (code, signal) => {
        if (settled) return;
        if (code !== 0) return finish(new Error(`Codex title request failed (${signal ?? code ?? "unknown"})${stderr.trim() ? `: ${redact(stderr.trim()).slice(-1000)}` : ""}`));
        try {
          const output = fs.readFileSync(outputPath, "utf8").trim();
          const parsed = JSON.parse(output) as { title?: unknown };
          if (typeof parsed.title !== "string" || !parsed.title.trim() || Array.from(parsed.title.trim()).length > 10) throw new Error("Codex title request returned invalid output");
          finish(undefined, output);
        } catch (error) { finish(error instanceof Error ? error : new Error("Codex title output could not be read")); }
      });
      child.stdin.end(prompt, "utf8");
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function redact(value: string): string {
  return value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{16,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{48,})\b/g, "[REDACTED]")
    .replace(/((?:password|passwd|token|cookie|secret|api[ _-]?key|authorization|密码|口令|私钥|验证码)\s*[=:：]\s*)\S+/gi, "$1[REDACTED]");
}
