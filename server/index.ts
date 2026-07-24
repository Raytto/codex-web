import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { createApp } from "./app.js";
import { assertProductionConfig } from "./config.js";

const { app, db, config, runner, beginShutdown } = createApp();
assertProductionConfig(config);
fs.mkdirSync(path.join(config.dataRoot, "logs"), { recursive: true });
const logger = pino(pino.destination({ dest: path.join(config.dataRoot, "logs", "app.log"), sync: false }));

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, basePath: config.basePath }, "Codex Web started");
});

const SHUTDOWN_DRAIN_TIMEOUT_MS = 29 * 60_000;
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  beginShutdown();
  logger.info({ signal }, "Codex Web stopping");
  const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
  while ((db.runningJobCount() > 0 || runner.activeJobCount > 0) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  const remainingJobs = db.runningJobCount();
  if (remainingJobs > 0 || runner.activeJobCount > 0) {
    logger.error({ remainingJobs, activeExecutions: runner.activeJobCount }, "Shutdown drain timed out");
    process.exit(1);
  }
  logger.info("Running jobs drained; closing network services");
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
