import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AppDatabase } from "../server/db.js";
import { conversationWaitingLabel } from "../src/conversation-waiting.js";

const selection = { model: "gpt-6.1-sol", reasoningEffort: "high" } as const;
const evidence = { kind: "artifact", summary: "fixture completed", functionalVerified: true,
  cleanupVerified: true, backgroundWorkFinished: true, checks: [{ name: "fixture", passed: true }] };

for (const capacity of [1, -1]) {
  test(`sidebar keeps incomplete workflows visible after a Job ends (capacity=${capacity})`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-waiting-"));
    const db = new AppDatabase(root);
    db.workflows.configure(capacity);
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const owner = db.createConversation(randomUUID(), "owner");
    const next = db.createConversation(randomUUID(), "queued");
    const job = db.createJob(randomUUID(), owner.id, undefined, selection);
    const queued = db.createJob(randomUUID(), next.id, undefined, selection);
    const row = (id: string) => db.listConversations().find(c => c.id === id)!;
    assert.equal(conversationWaitingLabel(row(owner.id)), "正在排队");
    db.updateJob(job.id, "running");
    db.updateConversation(owner.id, { status: "running" });
    assert.equal(conversationWaitingLabel(row(owner.id)), null, "running has its own spinner");
    db.finishJob(job.id, owner.id, "completed");
    db.workflows.settled(job.id);
    assert.equal(row(owner.id).has_pending_work, 0, "the old sidebar condition misses this wait");
    assert.equal(row(owner.id).workflow_state, capacity > 0 ? "blocked" : null);
    assert.equal(conversationWaitingLabel(row(owner.id)), capacity > 0 ? "等待处理" : null);
    assert.equal(conversationWaitingLabel(row(next.id)), "正在排队");
    if (capacity === 1) assert.throws(() => db.updateJob(queued.id, "running"), /WORKFLOW_LIMIT/);
    const reopened = new AppDatabase(root, undefined, false);
    try { assert.equal(conversationWaitingLabel(reopened.getConversation(owner.id)!), capacity > 0 ? "等待处理" : null); }
    finally { reopened.close(); }
    const resume = db.createJob(randomUUID(), owner.id, undefined, selection);
    db.updateJob(resume.id, "running");
    db.updateConversation(owner.id, { status: "running" });
    const workflow = db.workflows.assertJob(resume.id);
    db.workflows.requestClose(resume.id, workflow.revision, evidence);
    db.finishJob(resume.id, owner.id, "completed");
    assert.equal(conversationWaitingLabel(row(owner.id)), capacity > 0 ? "正在收尾" : null);
    db.workflows.settled(resume.id);
    assert.equal(conversationWaitingLabel(row(owner.id)), null, "only full completion clears waiting");
    db.updateJob(queued.id, "running");
    db.updateConversation(next.id, { status: "running" });
    assert.equal(conversationWaitingLabel(row(next.id)), null);
  });
}

test("waiting labels preserve active execution, scheduled details and legacy queue behavior", () => {
  const idle = { status: "idle", external_status: "idle", has_pending_work: 0, active_wake_count: 0 } as const;
  assert.equal(conversationWaitingLabel(idle), null);
  assert.equal(conversationWaitingLabel({ ...idle, has_pending_work: 1 }), "等待发送");
  assert.equal(conversationWaitingLabel({ ...idle, has_pending_work: 1 }, "preparing"), "等待维护结束后发送");
  assert.equal(conversationWaitingLabel({ ...idle, has_pending_work: 1, active_wake_count: 1 }), null);
  for (const workflow_state of ["queued", "active", "blocked", "closing"] as const) {
    assert.equal(conversationWaitingLabel({ ...idle, workflow_state, active_wake_count: 1 }), null);
    assert.equal(conversationWaitingLabel({ ...idle, workflow_state, external_status: "running" }), null);
  }
  for (const workflow_state of ["completed", "aborted"] as const) {
    assert.equal(conversationWaitingLabel({ ...idle, workflow_state }), null);
    assert.equal(conversationWaitingLabel({ ...idle, workflow_state, has_pending_work: 1 }), "等待发送");
  }
});
