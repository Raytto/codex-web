import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = new URL("./", import.meta.url);
const files = fs.readdirSync(directory).filter(name => name.endsWith(".test.ts")).sort();
const exclusive = "conversation-cold-storage.test.ts";
assert.ok(files.includes(exclusive));

// Keep storage migration/restore checks in a separate batch, before other
// suites spawn different-UID permission-test helpers.
// The remaining suites keep their normal parallelism; no tests are omitted.
for (const group of [[exclusive], files.filter(name => name !== exclusive)]) {
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--test", ...process.argv.slice(2),
    ...group.map(name => fileURLToPath(new URL(name, directory))),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
