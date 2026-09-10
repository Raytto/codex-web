import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { countRunningJobsForExecutorInDatabase } from "../server/executor-job-status.js";

test("Codex account switching counts only running Jobs on the selected executor", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-executor-gate-"));
  const databasePath = path.join(root, "state.sqlite");
  const database = new DatabaseSync(databasePath);
  context.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, executor_id TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL);
    INSERT INTO projects VALUES
      ('server-project', 'local-host'),
      ('remote-project', 'remote:worker-a'),
      ('tenant-project', 'tenant-local');
    INSERT INTO conversations VALUES
      ('server-conversation', 'server-project'),
      ('remote-conversation', 'remote-project'),
      ('tenant-conversation', 'tenant-project');
    INSERT INTO jobs VALUES
      ('server-job', 'server-conversation', 'completed'),
      ('remote-job', 'remote-conversation', 'running'),
      ('tenant-job', 'tenant-conversation', 'running');
  `);

  assert.equal(countRunningJobsForExecutorInDatabase(databasePath, "local-host"), 0);
  assert.equal(countRunningJobsForExecutorInDatabase(databasePath, "remote:worker-a"), 1);
  assert.equal(countRunningJobsForExecutorInDatabase(databasePath, "tenant-local"), 1);
  database.prepare("UPDATE jobs SET status='running' WHERE id='server-job'").run();
  assert.equal(countRunningJobsForExecutorInDatabase(databasePath, "local-host"), 1);
});
