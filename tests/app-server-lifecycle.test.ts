import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAppServerTurn } from "../server/app-server-turn.js";
import { DEFAULT_OPTIONAL_AGENT_CAPABILITIES } from "../server/optional-capabilities.js";

function fixture(t: TestContext, mode = "ok") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-server-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, "codex");
  fs.writeFileSync(executablePath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.cwd(), mode = process.env.FAKE_MODE;
const log = m => fs.appendFileSync(path.join(root, 'requests'), m + '\\n');
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
let attempts = 0;
// Emulate the native writer retaining its lease after turn/completed.
const keepAlive = setInterval(() => {}, 1000);
process.on('SIGTERM', () => setTimeout(() => {
  fs.rmSync(path.join(root, 'writer'), {force:true});
  fs.writeFileSync(path.join(root, 'exited'), 'yes');
  process.exit(0);
}, 200));
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  log(m.method);
  if (m.method === 'thread/resume' || m.method === 'thread/start') {
    attempts++;
    const busy = fs.existsSync(path.join(root, 'writer')) || (mode === 'busy' && attempts <= 2) || mode === 'always-busy';
    if (busy || mode === 'other-error') send({id:m.id,error:{message:mode === 'other-error' ? 'permission denied' : 'thread root already has an active writer'}});
    else { fs.writeFileSync(path.join(root, 'writer'), 'held'); send({id:m.id,result:{thread:{id:'root'}}}); }
  } else if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    setTimeout(() => {
      send({method:'item/completed',params:{threadId:'root',item:{type:'agentMessage',text:'done'}}});
      send({method:'turn/completed',params:{threadId:'root',turn:{id:'turn',status:mode === 'turn-failed' ? 'failed' : 'completed',error:{message:'thread root already has an active writer'}}}});
    }, 10);
  } else if (typeof m.id === 'number') send({id:m.id,result:{}});
});
`, {mode:0o755});
  const controller = new AbortController();
  const progress: unknown[] = [];
  const run = (threadId: string | null = "root") => startAppServerTurn({
    executablePath, cwd:root, env:{...process.env, FAKE_MODE:mode}, threadId,
    prompt:"perform one action", imagePaths:[], model:"test", reasoningEffort:"low", library:root,
    shellEnvironment:{}, networkAccessEnabled:false, webSearchMode:"cached",
    optionalCapabilities:DEFAULT_OPTIONAL_AGENT_CAPABILITIES, codexEgressKind:"unchanged",
  }, {signal:controller.signal, onThreadStarted:()=>{}, onProgress:p=>progress.push(p)});
  const requests = () => fs.readFileSync(path.join(root, "requests"), "utf8").trim().split("\n");
  return {root,run,requests,controller,progress};
}

test("completed result waits for writer exit before the next immediate resume", async t => {
  const f = fixture(t);
  assert.equal(await f.run(null).result, "done");
  assert.equal(fs.existsSync(path.join(f.root,"writer")), false);
  assert.equal(fs.readFileSync(path.join(f.root,"exited"),"utf8"), "yes");
  assert.equal(await f.run().result, "done");
  assert.equal(f.requests().filter(x=>x === "turn/start").length, 2);
});

test("transient writer contention retries acquisition and submits user input once", async t => {
  const f = fixture(t,"busy");
  assert.equal(await f.run().result, "done");
  assert.equal(f.requests().filter(x=>x === "thread/resume").length, 3);
  assert.equal(f.requests().filter(x=>x === "turn/start").length, 1);
  assert.ok(f.progress.some(p => (p as {label?:string}).label?.includes("释放会话")));
});

test("cancelling writer wait stops acquisition without submitting a turn", async t => {
  const f = fixture(t,"always-busy");
  const execution = f.run();
  const rejection = assert.rejects(execution.result, {name:"AbortError"});
  const timer = setInterval(() => {
    if (f.progress.length) { clearInterval(timer); f.controller.abort(); }
  }, 10);
  t.after(()=>clearInterval(timer));
  await rejection;
  assert.equal(f.requests().filter(x=>x === "thread/resume").length, 1);
  assert.equal(f.requests().includes("turn/start"), false);
});

test("unrelated resume errors do not retry and still await process exit", async t => {
  const f = fixture(t,"other-error");
  await assert.rejects(f.run().result,/permission denied/);
  assert.equal(f.requests().filter(x=>x === "thread/resume").length, 1);
  assert.equal(fs.existsSync(path.join(f.root,"exited")),true);
});

test("writer text in a failed turn never replays user actions", async t => {
  const f = fixture(t,"turn-failed");
  await assert.rejects(f.run().result,/active writer/);
  assert.equal(f.requests().filter(x=>x === "thread/resume").length, 1);
  assert.equal(f.requests().filter(x=>x === "turn/start").length, 1);
  assert.equal(fs.existsSync(path.join(f.root,"writer")), false);
});

test("persistent contention has a bounded retry budget and never starts a turn", {timeout:20_000}, async t => {
  const f = fixture(t,"always-busy");
  await assert.rejects(f.run().result,/active writer/);
  assert.equal(f.requests().filter(x=>x === "thread/resume").length, 7);
  assert.equal(f.requests().includes("turn/start"), false);
});
