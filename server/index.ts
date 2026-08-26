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
  logger.info({ host: config.host, port: config.port, basePath: config.basePath }, "ChatGPT Work started");
  void runner.cleanupTerminalJobRuntimes().then((result) => {
    if (result.removed > 0 || result.failed.length > 0) {
      logger[result.failed.length > 0 ? "warn" : "info"](
        { removed: result.removed, absent: result.absent, failed: result.failed },
        "Terminal job runtime startup cleanup finished",
      );
    }
  }).catch((error) => {
    logger.error({ error }, "Terminal job runtime startup cleanup failed");
  });
});
remoteWorkers.attach(server);

const SHUTDOWN_DRAIN_TIMEOUT_MS = 29 * 60_000;
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  beginShutdown();
  logger.info({ signal }, "ChatGPT Work stopping");
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
