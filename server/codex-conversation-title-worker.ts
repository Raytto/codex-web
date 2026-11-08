import { runAntigravityConversationTitle, type AntigravityTitleRuntime } from "../remote-worker/src/antigravity-title.js";
import { runCodexPersonalMemory } from "./codex-personal-memory.js";
import readline from "node:readline";
import { runCodexConversationTitle, validateConversationTitleRequest, type ConversationTitleAgentRequest, type ConversationTitleWorkerEvent } from "./conversation-title.js";

const controller = new AbortController();
let started = false;
const send = (event: ConversationTitleWorkerEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (started) return;
  started = true;
  void (async () => {
    try {
      const request = JSON.parse(line) as ConversationTitleAgentRequest & { antigravity?: AntigravityTitleRuntime };
      validateConversationTitleRequest(request, process.env.CWW_TENANT_USER_ID || undefined);
      const expectedUid = Number(process.env.CWW_TENANT_UID ?? "NaN");
      const expectedGid = Number(process.env.CWW_TENANT_GID ?? "NaN");
      if (process.platform !== "win32" && (process.getuid?.() !== expectedUid || process.getgid?.() !== expectedGid)) throw new Error("Codex title worker Unix identity mismatch");
      const output = request.task === "personal_memory"
        ? await runCodexPersonalMemory(request, { signal: controller.signal, onAuthReady: () => send({ type: "auth_ready" }) })
        : request.engineId === "antigravity"
        ? await runAntigravityConversationTitle(request.prompt, request.timeoutMs, request.antigravity!, controller.signal)
        : await runCodexConversationTitle(request, { signal: controller.signal, onAuthReady: () => send({ type: "auth_ready" }) });
      send({ type: "completed", output });
    } catch (error) {
      send({ type: "failed", message: error instanceof Error ? error.message : "Codex title request failed" });
      process.exitCode = 1;
    } finally { input.close(); }
  })();
});
input.on("close", () => { if (!started) process.exitCode = 1; });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => controller.abort());
