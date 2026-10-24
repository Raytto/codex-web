import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";
import { HOST_EXECUTOR_ID } from "../server/remote-worker-protocol.js";
import type { AgentOptions } from "../server/model-options.js";
import type { GeminiAccountRequest } from "../remote-worker/src/gemini-account-types.js";

test("new-node defaults stay available without erasing Google preferences or existing Gemini requests", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-node-selection-"));
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "tenant", passwordHash: bcrypt.hashSync("Tenant-Test-2026!", 8), sessionSecret: "fixture-session-secret-longer-than-thirty-two-characters" });
  t.after(async () => { instance.beginShutdown(); instance.remoteWorkers.close(); await instance.waitForBackgroundTasks(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  instance.db.createUser({ id: HOST_ROOT_USER_ID, username: "host", display_name: "Host", password_hash: bcrypt.hashSync("Host-Test-2026!", 8), role: "owner", status: "active", created_at: now, updated_at: now });
  const workerId = crypto.randomUUID(), remoteExecutor = `remote:${workerId}`;
  instance.db.registerRemoteWorker({ id: workerId, machine_name: "Windows fixture", platform: "win32-x64", protocol_version: 5,
    worker_version: "1.21.1", worker_release: null, worker_commit: null, worker_update_capable: 1, codex_version: "fixture", capacity: 0 });
  const remoteProject = instance.db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "Windows", root, remoteExecutor);
  const googleSelection = { model: "antigravity:gemini-node-fixture", reasoningEffort: "high" };
  const googleCatalog: AgentOptions = {
    models: [{ id: googleSelection.model, label: "Gemini fixture", description: "Authenticated host fixture", engineId: "antigravity", reasoningEfforts: ["low", "high"] }],
    reasoningEfforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], defaults: googleSelection,
  };
  let hostAuthenticated = true;
  t.mock.method(instance.runner, "geminiAccounts", async (_userId: string, operation: GeminiAccountRequest, executorId: string) => {
    assert.equal(operation.action, "catalog");
    assert.ok([HOST_EXECUTOR_ID, remoteExecutor].includes(executorId));
    return { catalog: executorId === HOST_EXECUTOR_ID && hostAuthenticated ? googleCatalog : null };
  });
  const runCalls = t.mock.method(instance.runner, "run", async () => { throw new Error("Queue must remain paused"); });
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login").send({ username: "host", password: "Host-Test-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const hostProject = instance.db.getDefaultProject(HOST_ROOT_USER_ID)!;
  assert.equal(hostProject.executor_id, HOST_EXECUTOR_ID);
  const hostQuery = `/api/agent-options?projectId=${hostProject.id}`;
  const remoteQuery = `/api/agent-options?projectId=${remoteProject.id}`;
  await owner.get(hostQuery).expect(200);
  await owner.put("/api/agent-selection").set("X-CSRF-Token", csrf).send({ ...googleSelection, executorId: HOST_EXECUTOR_ID }).expect(200);
  const create = (projectId: string) => owner.post("/api/conversations").set("X-CSRF-Token", csrf).send({ projectId, reuseEmpty: false });

  for (const pinned of [false, true]) {
    if (pinned) await owner.put("/api/user-settings/new-conversation-agent-selection").set("X-CSRF-Token", csrf).send(googleSelection).expect(200);
    const preferences = {
      recent: instance.db.getAgentSelectionPreference(HOST_ROOT_USER_ID),
      pinned: instance.db.getNewConversationAgentSelection(HOST_ROOT_USER_ID),
    };
    const remoteOptions = (await owner.get(remoteQuery).expect(200)).body;
    assert.ok(remoteOptions.models.every((model: { id: string }) => !model.id.startsWith("antigravity:")));
    assert.deepEqual(remoteOptions.selection, remoteOptions.defaults, "a Google preference cannot select an unavailable model on Windows");
    const remote = (await create(remoteProject.id).expect(201)).body;
    assert.deepEqual(remote.agentSelection, remoteOptions.defaults);
    assert.equal(instance.db.getConversation(remote.conversation.id)?.agent_model, remoteOptions.defaults.model);
    assert.deepEqual((await owner.get(hostQuery).expect(200)).body.selection, googleSelection, "returning to the authenticated host retains the Google choice");
    assert.deepEqual((await create(hostProject.id).expect(201)).body.agentSelection, googleSelection);
    assert.deepEqual({ recent: instance.db.getAgentSelectionPreference(HOST_ROOT_USER_ID), pinned: instance.db.getNewConversationAgentSelection(HOST_ROOT_USER_ID) }, preferences,
      "reading a node and creating its conversation must not rewrite either saved preference");
  }

  const existing = (await create(hostProject.id).expect(201)).body.conversation;
  const queued = instance.db.createJob(crypto.randomUUID(), existing.id, undefined, googleSelection);
  const pending = instance.db.createPendingPrompt(crypto.randomUUID(), existing.id, "Existing Gemini request", googleSelection);
  const queuedBefore = instance.db.getJob(queued.id), pendingBefore = instance.db.getPendingPrompt(pending.id);
  hostAuthenticated = false;
  const unavailable = (await owner.get(`/api/agent-options?conversationId=${existing.id}`).expect(200)).body;
  assert.ok(unavailable.models.every((model: { id: string }) => !model.id.startsWith("antigravity:")));
  assert.deepEqual(unavailable.selection, googleSelection, "existing Gemini conversations must not silently become Codex");
  assert.deepEqual((await owner.get(`/api/conversations/${existing.id}`).expect(200)).body.agentSelection, googleSelection);
  assert.equal(instance.db.getConversation(existing.id)?.agent_model, googleSelection.model);
  await owner.post(`/api/conversations/${existing.id}/messages`).set("X-CSRF-Token", csrf)
    .send({ message: "Explicit unavailable engine", ...googleSelection }).expect(400);
  assert.deepEqual(instance.db.getJob(queued.id), queuedBefore);
  assert.deepEqual(instance.db.getPendingPrompt(pending.id), pendingBefore);
  assert.deepEqual((await create(hostProject.id).expect(201)).body.agentSelection, unavailable.defaults, "new requests use available models even while old requests retain their engine");
  assert.deepEqual(instance.db.getAgentSelectionPreference(HOST_ROOT_USER_ID), googleSelection);
  assert.deepEqual(instance.db.getNewConversationAgentSelection(HOST_ROOT_USER_ID), googleSelection);
  assert.equal(runCalls.mock.callCount(), 0);
});
