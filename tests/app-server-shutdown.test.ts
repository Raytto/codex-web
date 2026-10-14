import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { liveAppServerGroup, shutdownAppServer } from "../server/app-server-shutdown.js";

async function fixture(t: TestContext, mode: "normal" | "stubborn" | "orphan") {
  const child = spawn(process.execPath, ["-e", `
    const {spawn} = require('node:child_process');
    const mode = ${JSON.stringify(mode)};
    const hold = setInterval(() => {}, 1000);
    if (mode === 'normal') {
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
      process.stdout.write('ready');
    } else {
      const native = spawn(process.execPath, ['-e',
        "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready');"
      ], {stdio:['ignore','pipe','ignore']});
      native.stdout.once('data', () => process.stdout.write('ready'));
      process.on('SIGTERM', () => { if (mode === 'orphan') process.exit(0); });
    }
  `], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit").then(() => undefined);
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } });
  await once(child.stdout, "data");
  return { child, exited };
}

test("graceful app-server shutdown waits for exit without escalation", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t, "normal");
  let escalated = false;
  await shutdownAppServer(f.child, f.exited, {
    processGroup: true, graceMs: 1000,
    onEscalation: () => { escalated = true; },
  });
  assert.equal(f.child.exitCode, 0);
  assert.equal(escalated, false);
  assert.deepEqual(liveAppServerGroup(f.child.pid!), []);
});

for (const mode of ["stubborn", "orphan"] as const) {
  test(`shutdown releases ${mode} native writer before returning and leaves unrelated groups intact`, { skip: process.platform !== "linux" }, async t => {
    const f = await fixture(t, mode);
    const other = await fixture(t, "normal");
    let escalations = 0;
    await shutdownAppServer(f.child, f.exited, {
      processGroup: true, graceMs: 150, killMs: 2000,
      onEscalation: members => { escalations++; assert.ok(members.length >= 1); },
    });
    assert.equal(escalations, 1);
    assert.deepEqual(liveAppServerGroup(f.child.pid!), []);
    assert.equal(other.child.exitCode, null);
    assert.ok(liveAppServerGroup(other.child.pid!).length > 0);
    await shutdownAppServer(other.child, other.exited, { processGroup: true, graceMs: 1000 });
  });
}

test("unconfirmed exit still fails closed after escalation", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t, "stubborn");
  await assert.rejects(shutdownAppServer(f.child, new Promise(() => {}), {
    processGroup: true, graceMs: 100, killMs: 150,
  }), /session ownership is not released/);
  await f.exited;
  assert.deepEqual(liveAppServerGroup(f.child.pid!), []);
});
