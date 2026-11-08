import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { HostStorageJobs } from "../server/host-storage-jobs.js";
import { guardHostSocket } from "../server/host-socket.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) { assert.ok(Date.now() < deadline, "fixture did not reach expected state"); await delay(10); }
}

function fixture(t: import("node:test").TestContext, options: { timeoutMs?: number; concurrency?: number; maxPending?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-storage-test-"));
  const worker = path.join(root, "worker.cjs");
  fs.writeFileSync(worker, `
const fs = require('node:fs'); const { execFileSync } = require('node:child_process');
process.once('message', r => {
  fs.appendFileSync(r.roots.dataRoot + '/starts', r.id + '\\n');
  if (r.id === 'hang') {
    execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)", r.roots.dataRoot + '/descendant']);
  }
  if (r.id === 'crash') process.exit(7);
  if (r.id === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
  fs.appendFileSync(r.roots.dataRoot + '/finishes', r.id + '\\n');
  process.send(r.id === 'fail' ? {ok:false,error:'download failed'} : {ok:true,removed:3}, () => process.disconnect());
});
`);
  const jobs = new HostStorageJobs({ workerUrl: pathToFileURL(worker), timeoutMs: 5_000, ...options });
  t.after(() => { jobs.stop(); fs.rmSync(root, { force: true, recursive: true }); });
  const request = (id: string) => ({ operation: "restore_conversation" as const, roots: { dataRoot: root }, userId: "user-a", id });
  return { jobs, root, request };
}

test("synchronous storage download does not block another RPC; disconnect keeps one owned restore", async t => {
  const { jobs, root, request } = fixture(t);
  let restore: Promise<number | undefined> | undefined;
  const server = net.createServer(socket => {
    const input = readline.createInterface({ input: socket }); guardHostSocket(socket, input);
    socket.on("close", () => input.close());
    input.on("line", line => {
      if (line === "restore") {
        restore = jobs.run(request("slow"));
        void restore.then(() => { if (!socket.destroyed) socket.end("restored\n"); });
      } else socket.end("job-started\n");
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as net.AddressInfo).port;
  const first = net.createConnection(port, "127.0.0.1"); await once(first, "connect"); first.write("restore\n");
  await until(() => fs.existsSync(path.join(root, "starts")));
  first.destroy();
  const another = net.createConnection(port, "127.0.0.1"); await once(another, "connect"); another.write("run\n");
  assert.equal((await once(another, "data"))[0].toString(), "job-started\n");
  assert.equal(fs.existsSync(path.join(root, "finishes")), false, "download must still be blocked");
  assert.strictEqual(jobs.run(request("slow")), restore, "a reconnected caller joins the owned attempt");
  assert.equal(await restore, 3);
  assert.equal(fs.readFileSync(path.join(root, "starts"), "utf8"), "slow\n");
});

test("storage failures and worker crashes are isolated from concurrent and queued work", async t => {
  const { jobs, request } = fixture(t, { concurrency: 2 });
  const results = await Promise.allSettled([jobs.run(request("slow")), jobs.run(request("fail")), jobs.run(request("crash")), jobs.run(request("good"))]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected", "rejected", "fulfilled"]);
  assert.match(String((results[1] as PromiseRejectedResult).reason), /download failed/);
  assert.match(String((results[2] as PromiseRejectedResult).reason), /退出/);
});

test("storage concurrency and queue size stay bounded, duplicate requests share their result", async t => {
  const { jobs, root, request } = fixture(t, { concurrency: 1, maxPending: 2 });
  const slow = jobs.run(request("slow")); const queued = jobs.run(request("queued"));
  assert.strictEqual(jobs.run(request("slow")), slow);
  await assert.rejects(jobs.run(request("overflow")), /队列已满/);
  await until(() => fs.existsSync(path.join(root, "starts")));
  assert.equal(fs.readFileSync(path.join(root, "starts"), "utf8"), "slow\n");
  await Promise.all([slow, queued]);
  assert.equal(fs.readFileSync(path.join(root, "starts"), "utf8"), "slow\nqueued\n");
});

test("deadline kills the download process group, frees its slot, and permits a fresh attempt", async t => {
  const { jobs, root, request } = fixture(t, { timeoutMs: 600, concurrency: 1 });
  const failed = assert.rejects(jobs.run(request("hang")), /超时/);
  await until(() => fs.existsSync(path.join(root, "descendant")));
  const pid = Number(fs.readFileSync(path.join(root, "descendant"), "utf8"));
  await failed;
  await until(() => {
    try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z"); }
    catch { return true; }
  });
  assert.equal(await jobs.run(request("good")), 3);
});

test("bridge stop rejects running and queued operations without launching queued downloads", async t => {
  const { jobs, root, request } = fixture(t, { concurrency: 1 });
  const results = Promise.allSettled([jobs.run(request("hang")), jobs.run(request("queued"))]);
  await until(() => fs.existsSync(path.join(root, "descendant")));
  jobs.stop();
  assert.deepEqual((await results).map(r => r.status), ["rejected", "rejected"]);
  assert.equal(fs.readFileSync(path.join(root, "starts"), "utf8"), "hang\n");
  await assert.rejects(jobs.run(request("new")), /停止/);
});
