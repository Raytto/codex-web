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
      const request = JSON.parse(line) as ConversationTitleAgentRequest;
      validateConversationTitleRequest(request, process.env.CWW_TENANT_USER_ID || undefined);
      const expectedUid = Number(process.env.CWW_TENANT_UID ?? "NaN");
      const expectedGid = Number(process.env.CWW_TENANT_GID ?? "NaN");
      if (process.platform !== "win32" && (process.getuid?.() !== expectedUid || process.getgid?.() !== expectedGid)) throw new Error("Codex title worker Unix identity mismatch");
      send({ type: "completed", output: await runCodexConversationTitle(request, { signal: controller.signal, onAuthReady: () => send({ type: "auth_ready" }) }) });
    } catch (error) {
      send({ type: "failed", message: error instanceof Error ? error.message : "Codex title request failed" });
      process.exitCode = 1;
    } finally { input.close(); }
  })();
});
input.on("close", () => { if (!started) process.exitCode = 1; });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => controller.abort());
