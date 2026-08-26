import readline from "node:readline";
import { cleanupJobRuntime, jobRuntimeRoot, type JobRuntimeCleanupTarget } from "./python-runtime.js";

type TenantCleanupInput = {
  targets: JobRuntimeCleanupTarget[];
};

const expectedUserId = process.env.CWW_TENANT_USER_ID ?? "";
const sharedTenantRoot = process.env.TENANT_ROOT ?? "";
let handled = false;

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (handled) return;
  handled = true;
  let message: TenantCleanupInput;
  try {
    message = JSON.parse(line) as TenantCleanupInput;
    if (!Array.isArray(message.targets) || message.targets.length > 1_000) throw new Error("Invalid runtime cleanup batch");
  } catch (error) {
    process.stderr.write(`Tenant runtime cleanup input failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    input.close();
    return;
  }

  let removed = 0;
  let absent = 0;
  const failed: Array<{ jobId: string; message: string }> = [];
  for (const target of message.targets) {
    if (target.userId !== expectedUserId) {
      failed.push({ jobId: target.jobId, message: "Tenant cleanup user mismatch" });
      continue;
    }
    try {
      const result = cleanupJobRuntime(jobRuntimeRoot(sharedTenantRoot, target));
      if (result.status === "removed") removed += 1;
      else if (result.status === "absent") absent += 1;
      else failed.push({ jobId: target.jobId, message: result.error?.message ?? "Runtime cleanup failed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Tenant runtime cleanup validation failed for ${target.jobId}: ${message}\n`);
      failed.push({ jobId: target.jobId, message });
    }
  }
  process.stdout.write(`${JSON.stringify({ removed, absent, failed })}\n`);
  process.exitCode = failed.length > 0 ? 1 : 0;
  input.close();
});

input.on("close", () => {
  if (!handled) process.exitCode = 1;
});
