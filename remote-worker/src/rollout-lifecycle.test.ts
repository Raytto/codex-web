import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rolloutLifecycle, localThreadLifecycles } from "./rollout-lifecycle.js";
import { normalizeThreadSnapshot } from "./codex-client.js";

const boot = Date.parse("2026-09-01T00:00:00Z");
const event = (type: string, timestamp = "2026-09-10T00:00:00Z") => JSON.stringify({ timestamp, type: "event_msg", payload: { type } }) + "\n";

test("authoritative rollout endings clear phantom external running without publishing commentary as a final reply", (context) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"rollout-lifecycle-"));context.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,"rollout.jsonl");
  for(const terminal of ["task_complete","turn_aborted"]) {
    fs.writeFileSync(file,event("task_started")+event(terminal));
    assert.equal(rolloutLifecycle(file,boot),"idle");
    const snapshot=normalizeThreadSnapshot({id:"thread",path:file,createdAt:1,updatedAt:2,turns:[{id:"turn",status:"completed",items:[{id:"commentary",type:"agentMessage",phase:"commentary",text:"Work in progress"}]}]});
    assert.equal(snapshot?.status,"idle");
    assert.equal(snapshot?.messages.some(row=>row.role === "assistant"),false);
  }
  fs.writeFileSync(file,event("task_complete")+event("task_started"));
  assert.equal(rolloutLifecycle(file,boot),"running");
});

test("only records predating OS boot can age out without an explicit terminal event", (context) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"rollout-boot-"));context.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,"rollout.jsonl");
  fs.writeFileSync(file,event("task_started","2026-08-10T12:39:07Z")+event("token_count","2026-08-10T12:39:46Z"));
  const old=new Date("2026-08-10T12:39:46Z");fs.utimesSync(file,old,old);
  assert.equal(rolloutLifecycle(file,boot),"idle");
  assert.equal(rolloutLifecycle(file,Date.parse("2026-08-01T00:00:00Z")),"running");
  fs.utimesSync(file,new Date(),new Date());
  assert.equal(rolloutLifecycle(file,boot),"running");
});

test("rollout tail reader is bounded and fails closed for absent, malformed or incomplete records", (context) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"rollout-tail-"));context.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,"rollout.jsonl");
  assert.equal(rolloutLifecycle(file,boot),null);
  for(const contents of ["",event("task_complete")+'{"partial":',event("task_complete")+'invalid\n']) {
    fs.writeFileSync(file,contents);assert.equal(rolloutLifecycle(file,boot),null);
  }
  fs.writeFileSync(file,JSON.stringify({padding:"x".repeat(300_000)})+"\n"+event("task_complete"));
  assert.equal(rolloutLifecycle(file,boot),"idle");
  fs.writeFileSync(file,event("token_count"));assert.equal(rolloutLifecycle(file,boot),null);
});


test("targeted lifecycle lookup is independent of observer RPC and rejects missing, duplicate and invalid IDs", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "thread-lookup-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "019fb964-b1fa-7c90-bbe7-fc16d4d165a3";
  const missing = "019fe3be-a030-7070-ac93-ab314090f202";
  const sessions = path.join(root, "sessions", "2026", "08", "01");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-${id}.jsonl`);
  fs.writeFileSync(file, event("task_complete"));
  assert.deepEqual(localThreadLifecycles(root, [id, missing]), [{ threadId: id, status: "idle" }]);
  assert.deepEqual(localThreadLifecycles(root, ["../../auth.json"]), []);
  fs.appendFileSync(file, event("task_started"));
  assert.deepEqual(localThreadLifecycles(root, [id]), [{ threadId: id, status: "running" }]);
  fs.mkdirSync(path.join(root, "archived_sessions"));
  fs.copyFileSync(file, path.join(root, "archived_sessions", `rollout-${id}.jsonl`));
  assert.deepEqual(localThreadLifecycles(root, [id]), [], "ambiguous files must not clear a lock");
});
