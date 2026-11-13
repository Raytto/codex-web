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
// New lifecycle tests also inspect /proc for unknown writers. Keep these away
// from permission tests that intentionally create inaccessible UID processes.
const storage = files.filter(name => name.startsWith('storage-') || name === 'host-storage-jobs.test.ts');
const first = ['node-transfers.test.ts','app.test.ts','personal-memory-codex.test.ts','app-server-lifecycle.test.ts','sqlite-contention.test.ts'];
const remaining = files.filter(name => name !== exclusive && !storage.includes(name));
remaining.sort((a,b) => (first.indexOf(a)<0?first.length:first.indexOf(a)) - (first.indexOf(b)<0?first.length:first.indexOf(b)) || a.localeCompare(b));
for (const [label,group] of [['cold',[exclusive]],['storage',storage],['application',remaining]]) {
  const started=performance.now();
  const paths=group.map(name => fileURLToPath(new URL(name, directory)));
  // Preserve arbitrary caller Node test flags via the original CLI path.
  const args=process.argv.length>2
    ? ['--import','tsx','--test',...(group===storage?['--test-concurrency=1']:[]),...process.argv.slice(2),...paths]
    : [fileURLToPath(new URL('run-test-group.mjs',directory)),group===storage?'1':'auto',...paths];
  const result = spawnSync(process.execPath,args,{stdio:'inherit'});
  console.log(`# group ${label}: ${group.length} files, ${((performance.now()-started)/1000).toFixed(3)} seconds`);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
