import readline from "node:readline";
import { runCodexVoiceReview, validateCodexVoiceReviewRequest, type CodexVoiceReviewRequest, type CodexVoiceReviewWorkerEvent } from "./codex-voice-review.js";

const controller = new AbortController();
let started = false;

function send(event: CodexVoiceReviewWorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (started) return;
  started = true;
  void (async () => {
    try {
      const request = JSON.parse(line) as CodexVoiceReviewRequest;
      validateCodexVoiceReviewRequest(request, process.env.CWW_TENANT_USER_ID || undefined);
      const expectedUid = Number(process.env.CWW_TENANT_UID ?? "NaN");
      const expectedGid = Number(process.env.CWW_TENANT_GID ?? "NaN");
      if (process.platform !== "win32" && (process.getuid?.() !== expectedUid || process.getgid?.() !== expectedGid)) {
        throw new Error("Codex voice review worker Unix identity mismatch");
      }
      const output = await runCodexVoiceReview(request, {
        signal: controller.signal,
        onAuthReady: () => send({ type: "auth_ready" }),
      });
      send({ type: "completed", output });
      process.exitCode = 0;
    } catch (error) {
      send({ type: "failed", message: error instanceof Error ? error.message : "Codex voice review failed" });
      process.exitCode = 1;
    } finally {
      input.close();
    }
  })();
});

input.on("close", () => {
  if (!started) process.exitCode = 1;
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => controller.abort());
}
