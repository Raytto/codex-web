import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { createApp } from "./app.js";
import { loadProductionConfig } from "./config.js";

// Configuration must fail closed before createApp creates directories, opens
// SQLite, performs migrations, or starts any background refresh.
const startupConfig = loadProductionConfig();
const { app, db, config, remoteWorkers, runner, resumableUploads, beginShutdown, waitForBackgroundTasks } = createApp(startupConfig);
fs.mkdirSync(path.join(config.dataRoot, "logs"), { recursive: true });
const logger = pino(pino.destination({ dest: path.join(config.dataRoot, "logs", "app.log"), sync: false }));

const finalizationRecovery = await runner.recoverJobFinalizations();
if (finalizationRecovery.resumed || finalizationRecovery.rolledBack || finalizationRecovery.published || finalizationRecovery.orphaned || finalizationRecovery.errors.length) {
  logger[finalizationRecovery.errors.length ? "warn" : "info"](finalizationRecovery, "Job finalization startup recovery finished");
}
const uploadRecovery = await resumableUploads.recover();
if (uploadRecovery.finalized || uploadRecovery.reconciled || uploadRecovery.cancelled) {
  logger.info(uploadRecovery, "Resumable upload startup recovery finished");
}
const remoteJobRecovery = runner.recoverRemoteJobs();
void remoteJobRecovery.catch((error) => logger.error({ error }, "Remote job startup recovery failed"));

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, basePath: config.basePath }, "Codex Web started");
  void cleanupTerminalRuntimes();
});
remoteWorkers.attach(server);

// Child attempts do not own runtime cleanup. Retryable Jobs remain protected
// by their queued state; terminal leftovers (including root-owned files) are retried.
let runtimeCleanupBusy = false;
async function cleanupTerminalRuntimes(): Promise<void> {
  if (runtimeCleanupBusy) return;
  runtimeCleanupBusy = true;
  try {
    const result = await runner.cleanupTerminalJobRuntimes();
    if (result.removed || result.failed.length) logger.info(result, "Terminal Job runtime cleanup");
  } catch (error) { logger.error({ error }, "Terminal Job runtime cleanup failed"); }
  finally { runtimeCleanupBusy = false; }
}
const runtimeCleanupTimer = setInterval(() => void cleanupTerminalRuntimes(), 5 * 60_000);
runtimeCleanupTimer.unref();

const SHUTDOWN_DRAIN_TIMEOUT_MS = 29 * 60_000;
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(runtimeCleanupTimer);
  beginShutdown();
  logger.info({ signal }, "Codex Web stopping");
  const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
  while ((db.listRunningJobSummaries().length > 0 || runner.activeJobCount > 0) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  const remainingJobs = db.listRunningJobSummaries().length;
  if (remainingJobs > 0 || runner.activeJobCount > 0) {
    logger.error({ remainingJobs, activeExecutions: runner.activeJobCount }, "Shutdown drain timed out");
    process.exit(1);
  }
  await waitForBackgroundTasks();
  logger.info("Running jobs drained; closing network services");
  remoteWorkers.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
