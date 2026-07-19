import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { createApp } from "./app.js";
import { assertProductionConfig } from "./config.js";

const { app, db, config } = createApp();
assertProductionConfig(config);
fs.mkdirSync(path.join(config.dataRoot, "logs"), { recursive: true });
const logger = pino(pino.destination({ dest: path.join(config.dataRoot, "logs", "app.log"), sync: false }));

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, basePath: config.basePath }, "ChatGPT Work started");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "ChatGPT Work stopping");
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
