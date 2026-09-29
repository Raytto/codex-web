import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { ParaStore, emptyBrief, resourcePath } from "../server/para-store.js";
import { paraJobPrompt } from "../server/para-schema.js";
import { ensureTenantWorkspace } from "../server/paths.js";
import { LEGACY_USER_ID } from "../server/db.js";
const id = () => crypto.randomUUID();
const selection = { model: "gpt-6-sol", reasoningEffort: "medium" };
test("PARA board reordering is transactional, tenant scoped and keeps hidden archived boards", async (t) => {
  const f = await fixture(t);
  const b = f.store.createBoard(f.user, "second", null);
  const c = f.store.createBoard(f.user, "third", null);
  f.store.updateBoard(f.user, b.id, { revision: b.revision, archived: true });
  const move = { sourceId: c.id, targetId: f.board.id, placement: "before" };
  await f.agent.post("/api/para/boards/reorder").send(move).expect(403);
  const result = await f.agent.post("/api/para/boards/reorder").set("X-CSRF-Token", f.csrf).send(move).expect(200);
  assert.deepEqual(result.body.boards.map((board: { id: string }) => board.id), [c.id, f.board.id, b.id]);
  assert.ok(f.store.board(f.user, b.id).archived_at);
  const before = f.store.boards(f.user);
  await f.agent.post("/api/para/boards/reorder").set("X-CSRF-Token", f.csrf).send({ ...move, targetId: id() }).expect(404);
  assert.deepEqual(f.store.boards(f.user), before);
  const other = id(), time = new Date().toISOString();
  f.db.createUser({ id: other, username: "board-order-other", password_hash: "", display_name: "Other", role: "member", status: "active", created_at: time, updated_at: time });
  const privateBoard = f.store.createBoard(other, "private", null);
  for (const body of [{ ...move, sourceId: privateBoard.id }, { ...move, targetId: privateBoard.id }])
    await f.agent.post("/api/para/boards/reorder").set("X-CSRF-Token", f.csrf).send(body).expect(404);
  assert.deepEqual(f.store.boards(f.user), before);
  assert.equal(f.store.board(other, privateBoard.id).revision, 1);
  const repeated = await f.agent.post("/api/para/boards/reorder").set("X-CSRF-Token", f.csrf).send(move).expect(200);
  assert.deepEqual(repeated.body.boards, result.body.boards);
  const last = f.store.createBoard(f.user, "last", null);
  assert.equal(f.store.boards(f.user).at(-1)!.id, last.id);
});
test("PARA board deletion rejects retained content and stale revisions", async (t) => {
  const f = await fixture(t);
  await f.agent.delete(`/api/para/boards/${f.board.id}`).set("X-CSRF-Token", f.csrf).send({ revision: f.board.revision }).expect(409);
  assert.equal(f.store.project(f.user, f.project.id).board_id, f.board.id);
  const empty = f.store.createBoard(f.user, "empty", null);
  const archived = f.store.updateBoard(f.user, empty.id, { revision: empty.revision, archived: true });
  await f.agent.delete(`/api/para/boards/${empty.id}`).set("X-CSRF-Token", f.csrf).send({ revision: empty.revision }).expect(409);
  await f.agent.delete(`/api/para/boards/${empty.id}`).set("X-CSRF-Token", f.csrf).send({ revision: archived.revision }).expect(204);
  await f.agent.get(`/api/para/boards/${empty.id}`).expect(404);
});
test("PARA selected files inherit tenant access without exposing the private resource", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    t.skip("requires Linux root to test distinct execution identities");
    return;
  }
  const f = await fixture(t);
  const tenantRoot = path.join(f.root, "tenants");
  const tenant = path.join(tenantRoot, f.user);
  const conversations = path.join(tenant, "conversations");
  fs.chmodSync(f.root, 0o711);
  fs.chmodSync(tenantRoot, 0o711);
  for (const directory of [tenant, conversations]) {
    fs.chownSync(directory, 0, 65534);
    fs.chmodSync(directory, 0o2750);
  }
  // Exercise the production default-ACL path when the host provides ACL tools;
  // the setgid directory also verifies the permission contract in slim CI.
  if (spawnSync("setfacl", ["--version"]).status === 0) {
    assert.equal(spawnSync("setfacl", ["-d", "-m", "u::rwx,u:65534:rwx,g::---,m::rwx,o::---", conversations]).status, 0);
  }
  const marker = "unprivileged-attachment-" + id();
  const resource = (await f.agent
    .post(`/api/para/boards/${f.board.id}/resources`)
    .set("X-CSRF-Token", f.csrf)
    .field("key", id())
    .field("projectId", f.project.id)
    .attach("file", Buffer.from(marker), "selected.txt")
    .expect(201)).body.resource;
  const conversation = (await f.agent
    .post(`/api/para/projects/${f.project.id}/new-conversation`)
    .set("X-CSRF-Token", f.csrf)
    .send({ key: id(), title: "tenant attachment", resourceIds: [resource.id], prompt: "read selected file" })
    .expect(201)).body.conversation;
  const draft = f.db.getComposerDraft(conversation.id)!;
  const attachment = path.join(conversations, conversation.id, draft.files[0].relative_path);
  // Pass only the fixture root, since the test runner's TMPDIR can itself sit
  // behind private maintenance-account directories that must stay private.
  const rootFd = fs.openSync(f.root, "r");
  t.after(() => fs.closeSync(rootFd));
  const readAs = (uid: number, file: string) => spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", "/proc/self/fd/3/" + path.relative(f.root, file)], {
    uid, gid: uid, cwd: "/", encoding: "utf8", env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe", rootFd],
  });
  const own = readAs(65534, attachment);
  assert.equal(own.status, 0, "the normal tenant execution identity must read its selected attachment: " + own.stderr);
  assert.equal(own.stdout, marker);
  assert.notEqual(readAs(65533, attachment).status, 0, "another tenant must remain unable to traverse the account directory");
  assert.notEqual(readAs(65534, resourcePath(tenantRoot, f.user, resource.id)).status, 0, "only the selected copy is an Agent attachment");
});
async function fixture(t: test.TestContext, maximum = 50 * 1024 * 1024) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "para-test-"));
  const password = "Test-only-password-123!";
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    queueAutoStart: false,
    username: "demo",
    passwordHash: bcrypt.hashSync(password, 4),
    sessionSecret: "para-test-secret-at-least-thirty-two-characters",
    minimumFreeDiskBytes: 0,
    maxStoredBytesPerUser: maximum,
  });
  t.after(() => {
    instance.beginShutdown();
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const agent = request.agent(instance.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: "demo", password })
    .expect(200);
  const csrf = login.body.csrfToken;
  const db = instance.db,
    store = new ParaStore(db),
    user = LEGACY_USER_ID;
  const engine = db.getDefaultProject(user)!;
  const b = await agent
    .post("/api/para/boards")
    .set("X-CSRF-Token", csrf)
    .send({ key: id(), name: "测试看板", default_project_id: engine.id })
    .expect(201);
  const board = b.body.board;
  const p = await agent
    .post(`/api/para/boards/${board.id}/projects`)
    .set("X-CSRF-Token", csrf)
    .send({ key: id(), title: "测试目标" })
    .expect(201);
  return {
    ...instance,
    root,
    agent,
    csrf,
    store,
    user,
    engine,
    board,
    project: p.body.project,
  };
}
test("PARA creates no phantom execution objects, replays create keys, and detects stale edits", async (t) => {
  const f = await fixture(t);
  const count = () =>
    f.db.sqlite.prepare("SELECT count(*) AS n FROM conversations").get()!.n;
  assert.equal(count(), 0);
  const payload = { key: id(), title: "一句话想法" };
  const url = `/api/para/boards/${f.board.id}/projects`;
  const a = await f.agent
    .post(url)
    .set("X-CSRF-Token", f.csrf)
    .send(payload)
    .expect(201);
  const b = await f.agent
    .post(url)
    .set("X-CSRF-Token", f.csrf)
    .send(payload)
    .expect(201);
  assert.equal(a.body.project.id, b.body.project.id);
  assert.equal(count(), 0);
  await f.agent
    .post(url)
    .set("X-CSRF-Token", f.csrf)
    .send({ ...payload, title: "different" })
    .expect(409);
  const patch = `/api/para/projects/${a.body.project.id}`;
  await f.agent
    .patch(patch)
    .set("X-CSRF-Token", f.csrf)
    .send({
      revision: 1,
      stage: "active",
      brief: { ...emptyBrief(), goal: "已确认" },
    })
    .expect(200);
  await f.agent
    .patch(patch)
    .set("X-CSRF-Token", f.csrf)
    .send({ revision: 1, brief: { ...emptyBrief(), goal: "过时覆盖" } })
    .expect(409);
  assert.equal(f.store.project(f.user, a.body.project.id).brief.goal, "已确认");
  assert.equal(f.db.getProject(f.engine.id)!.root_path, f.engine.root_path);
});
test("PARA ownership, CSRF, foreign source and download boundaries use real routes", async (t) => {
  const f = await fixture(t);
  const other = id(),
    time = new Date().toISOString();
  f.db.createUser({
    id: other,
    username: "para-other",
    password_hash: bcrypt.hashSync("Other-test-123!", 4),
    display_name: "Other",
    role: "member",
    status: "active",
    created_at: time,
    updated_at: time,
  });
  const agent = request.agent(f.app),
    login = await agent
      .post("/api/auth/login")
      .send({ username: "para-other", password: "Other-test-123!" })
      .expect(200),
    csrf = login.body.csrfToken;
  await request(f.app).get("/api/para/boards").expect(401);
  await f.agent
    .post("/api/para/boards")
    .send({ key: id(), name: "no-csrf" })
    .expect(403);
  await f.agent
    .post("/api/para/boards")
    .set("X-CSRF-Token", f.csrf)
    .set("Origin", "https://wrong.example")
    .send({ key: id(), name: "wrong-origin" })
    .expect(403);
  await agent.get(`/api/para/boards/${f.board.id}`).expect(404);
  await agent.get(`/api/para/projects/${f.project.id}`).expect(404);
  await agent
    .patch(`/api/para/projects/${f.project.id}`)
    .set("X-CSRF-Token", csrf)
    .send({ revision: 1, title: "stolen" })
    .expect(404);
  const upload = await f.agent
    .post(`/api/para/boards/${f.board.id}/resources`)
    .set("X-CSRF-Token", f.csrf)
    .field("key", id())
    .field("projectId", f.project.id)
    .attach("file", Buffer.from("private data"), "example.txt")
    .expect(201);
  await agent
    .get(`/api/para/resources/${upload.body.resource.id}/content`)
    .expect(404);
  const own = f.store.createBoard(other, "own", null),
    p = f.store.createProject(other, own.id, "own");
  await agent
    .put(`/api/para/projects/${p.id}/resources/${upload.body.resource.id}`)
    .set("X-CSRF-Token", csrf)
    .send({})
    .expect(404);
  await agent
    .post(`/api/para/boards/${own.id}/resources`)
    .set("X-CSRF-Token", csrf)
    .field("key", id())
    .field("source_file_id", id())
    .expect(404);
  await f.agent
    .post(`/api/para/boards/${f.board.id}/resources`)
    .set("X-CSRF-Token", f.csrf)
    .field("key", id())
    .field("url", "javascript:alert(1)")
    .expect(400);
});
test("PARA primary and reference links preserve original engines and exclude empty reuse", async (t) => {
  const f = await fixture(t),
    p2 = f.store.createProject(f.user, f.board.id, "另一个项目");
  const engine2 = f.db.createProject(
    id(),
    f.user,
    "工程二",
    path.join(f.root, "engine2"),
    "tenant-local",
  );
  const c1 = f.db.createConversation(
      id(),
      "新任务",
      selection,
      f.user,
      f.engine.id,
    ),
    c2 = f.db.createConversation(
      id(),
      "不同工程",
      selection,
      f.user,
      engine2.id,
    );
  await f.agent
    .post(`/api/para/projects/${f.project.id}/conversations`)
    .set("X-CSRF-Token", f.csrf)
    .send({ ids: [c1.id, c2.id] })
    .expect(200);
  assert.equal(f.db.getConversation(c2.id)!.project_id, engine2.id);
  assert.equal(
    f.db.findReusableEmptyConversation(f.user, f.engine.id),
    undefined,
  );
  f.store.linkConversation(f.user, p2.id, c1.id);
  assert.equal(
    f.store.detail(f.user, p2.id).conversations[0].relation,
    "reference",
  );
  const job = f.db.createJob(id(), c1.id, undefined, selection);
  assert.match(paraJobPrompt(f.db.sqlite, job.id), /测试目标/);
  assert.doesNotMatch(paraJobPrompt(f.db.sqlite, job.id), /另一个项目/);
  f.store.transaction(() =>
    f.store.linkConversation(f.user, p2.id, c1.id, true),
  );
  assert.equal(
    f.store
      .detail(f.user, f.project.id)
      .conversations.find((c) => c.id === c1.id)!.relation,
    "reference",
  );
  await f.agent
    .delete(`/api/para/projects/${p2.id}/conversations/${c1.id}`)
    .set("X-CSRF-Token", f.csrf)
    .expect(204);
  assert.ok(f.db.getConversation(c1.id));
  assert.match(paraJobPrompt(f.db.sqlite, job.id), /测试目标/);
});
test("PARA accepted job and queued prompt snapshots survive edits, reference changes and database reopen", async (t) => {
  const f = await fixture(t),
    c = f.db.createConversation(
      id(),
      "背景测试",
      selection,
      f.user,
      f.engine.id,
    );
  f.store.linkConversation(f.user, f.project.id, c.id);
  f.store.updateProject(f.user, f.project.id, {
    revision: 1,
    brief: { ...emptyBrief(), goal: "最初目标" },
  });
  const pending = f.db.createPendingPrompt(id(), c.id, "执行", selection);
  f.store.updateProject(f.user, f.project.id, {
    revision: 2,
    brief: { ...emptyBrief(), goal: "后续目标" },
  });
  const job = f.db.materializePendingPrompt(pending.id, id(), id())!;
  assert.match(paraJobPrompt(f.db.sqlite, job.id), /最初目标/);
  assert.doesNotMatch(paraJobPrompt(f.db.sqlite, job.id), /后续目标/);
  const next = f.db.createJob(id(), c.id, undefined, selection);
  assert.match(paraJobPrompt(f.db.sqlite, next.id), /后续目标/);
  const { AppDatabase } = await import("../server/db.js");
  const reopened = new AppDatabase(path.join(f.root, "data"), undefined, false);
  try {
    assert.equal(
      paraJobPrompt(reopened.sqlite, job.id),
      paraJobPrompt(f.db.sqlite, job.id),
    );
  } finally {
    reopened.close();
  }
});
test("PARA file and message collection survives deleting the source, with replay and quota accounting", async (t) => {
  const f = await fixture(t),
    c = f.db.createConversation(
      id(),
      "来源会话",
      selection,
      f.user,
      f.engine.id,
    ),
    mid = id(),
    fid = id(),
    ws = ensureTenantWorkspace(path.join(f.root, "tenants"), f.user, c.id);
  f.db.addMessage({
    id: mid,
    conversation_id: c.id,
    role: "assistant",
    content: "可追溯的结论",
    created_at: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(ws, "uploads", "original.txt"), "original bytes");
  f.db.addFile({
    id: fid,
    conversation_id: c.id,
    message_id: mid,
    pending_prompt_id: null,
    original_name: "原文件.txt",
    relative_path: "uploads/original.txt",
    mime_type: "text/plain",
    size: 14,
    kind: "upload",
    created_at: new Date().toISOString(),
  });
  const k = id();
  const collect = () =>
    f.agent
      .post(`/api/para/boards/${f.board.id}/resources`)
      .set("X-CSRF-Token", f.csrf)
      .field("key", k)
      .field("projectId", f.project.id)
      .field("source_file_id", fid);
  const r = (await collect().expect(201)).body.resource;
  assert.equal((await collect().expect(201)).body.resource.id, r.id);
  const note = (
    await f.agent
      .post(`/api/para/boards/${f.board.id}/resources`)
      .set("X-CSRF-Token", f.csrf)
      .field("key", id())
      .field("source_message_id", mid)
      .expect(201)
  ).body.resource;
  assert.equal(note.body, "可追溯的结论");
  assert.equal(f.db.sumStoredFileBytesForUser(f.user), 28);
  f.db.sqlite.prepare("DELETE FROM conversations WHERE id=?").run(c.id);
  fs.rmSync(ws, { recursive: true, force: true });
  assert.equal(
    fs.readFileSync(
      resourcePath(path.join(f.root, "tenants"), f.user, r.id),
      "utf8",
    ),
    "original bytes",
  );
  const response = await f.agent
    .get(`/api/para/resources/${r.id}/preview`)
    .expect(200);
  assert.equal(response.body.content, "original bytes");
  assert.equal(response.body.resource.source_conversation_id, null);
  assert.equal(f.store.resource(f.user, note.id).body, "可追溯的结论");
  assert.equal(f.db.sumStoredFileBytesForUser(f.user), 14);
  assert.equal((await collect().expect(201)).body.resource.id, r.id);
  await f.agent
    .delete(`/api/para/projects/${f.project.id}/resources/${r.id}`)
    .set("X-CSRF-Token", f.csrf)
    .expect(204);
  assert.equal(
    f.store.resource(f.user, r.id).sha256,
    crypto.createHash("sha256").update("original bytes").digest("hex"),
  );
});
test("PARA new conversation is idempotent, snapshots chosen resources, and changes default only explicitly", async (t) => {
  const f = await fixture(t),
    engine2 = f.db.createProject(
      id(),
      f.user,
      "工程二",
      path.join(f.root, "e2"),
      "tenant-local",
    );
  f.store.updateProject(f.user, f.project.id, {
    revision: 1,
    brief: { ...emptyBrief(), goal: "测试输入目标" },
  });
  const note = (
    await f.agent
      .post(`/api/para/boards/${f.board.id}/resources`)
      .set("X-CSRF-Token", f.csrf)
      .field("key", id())
      .field("projectId", f.project.id)
      .field("title", "选定笔记")
      .field("body", "选定笔记的具体内容")
      .expect(201)
  ).body.resource;
  const file = (
    await f.agent
      .post(`/api/para/boards/${f.board.id}/resources`)
      .set("X-CSRF-Token", f.csrf)
      .field("key", id())
      .field("projectId", f.project.id)
      .attach("file", Buffer.from("input file"), "input.txt")
      .expect(201)
  ).body.resource;
  const data = {
    key: id(),
    title: "规划",
    projectId: engine2.id,
    resourceIds: [note.id, file.id],
    prompt: "整理计划",
  };
  const url = `/api/para/projects/${f.project.id}/new-conversation`;
  const a = await f.agent
    .post(url)
    .set("X-CSRF-Token", f.csrf)
    .send(data)
    .expect(201);
  const b = await f.agent
    .post(url)
    .set("X-CSRF-Token", f.csrf)
    .send(data)
    .expect(201);
  assert.equal(a.body.conversation.id, b.body.conversation.id);
  assert.equal(a.body.conversation.project_id, engine2.id);
  assert.equal(f.store.project(f.user, f.project.id).default_project_id, null);
  const draft = f.db.getComposerDraft(a.body.conversation.id)!;
  assert.match(draft.content, /选定笔记的具体内容/);
  assert.equal(draft.files.length, 1);
  assert.equal(
    fs.readFileSync(
      path.join(
        f.root,
        "tenants",
        f.user,
        "conversations",
        a.body.conversation.id,
        draft.files[0].relative_path,
      ),
      "utf8",
    ),
    "input file",
  );
  const job = f.db.materializeComposerDraftAsJob(
    id(),
    id(),
    a.body.conversation.id,
    draft.content,
    selection,
    null,
  );
  assert.match(paraJobPrompt(f.db.sqlite, job.id), /测试输入目标/);
  assert.equal(
    f.db.listFiles(a.body.conversation.id)[0].message_id,
    job.message_id,
  );
  await f.agent
    .post(url)
    .set("X-CSRF-Token", f.csrf)
    .send({ ...data, key: id(), resourceIds: [], setDefault: true })
    .expect(201);
  assert.equal(
    f.store.project(f.user, f.project.id).default_project_id,
    engine2.id,
  );
  f.db.sqlite
    .prepare("UPDATE projects SET archived_at=? WHERE id=?")
    .run(new Date().toISOString(), engine2.id);
  await f.agent
    .post(url)
    .set("X-CSRF-Token", f.csrf)
    .send({ key: id(), title: "不会回退", prompt: "开始" })
    .expect(409);
});
test("PARA archive keeps running work, restore keeps phase, and move keeps associations", async (t) => {
  const f = await fixture(t),
    c = f.db.createConversation(
      id(),
      "运行会话",
      selection,
      f.user,
      f.engine.id,
    );
  f.store.linkConversation(f.user, f.project.id, c.id);
  f.db.sqlite
    .prepare("UPDATE conversations SET status='running' WHERE id=?")
    .run(c.id);
  const url = `/api/para/projects/${f.project.id}`;
  await f.agent
    .patch(url)
    .set("X-CSRF-Token", f.csrf)
    .send({ revision: 1, stage: "active", paused: true })
    .expect(200);
  await f.agent
    .patch(url)
    .set("X-CSRF-Token", f.csrf)
    .send({ revision: 2, archived: true })
    .expect(409);
  await f.agent
    .patch(url)
    .set("X-CSRF-Token", f.csrf)
    .send({ revision: 2, archived: true, confirm_running: true })
    .expect(200);
  const b = f.store.createBoard(f.user, "另一看板", null);
  await f.agent
    .patch(url)
    .set("X-CSRF-Token", f.csrf)
    .send({ revision: 3, archived: false, board_id: b.id })
    .expect(200);
  const d = f.store.detail(f.user, f.project.id);
  assert.equal(d.project.stage, "active");
  assert.equal(d.project.paused, 1);
  assert.equal(d.project.board_id, b.id);
  assert.equal(d.conversations[0].status, "running");
  assert.equal(d.conversations[0].project_id, f.engine.id);
});
test("PARA failed registration removes staged files and quota includes independent resources", async (t) => {
  const f = await fixture(t, 5);
  await f.agent
    .post(`/api/para/boards/${f.board.id}/resources`)
    .set("X-CSRF-Token", f.csrf)
    .field("key", id())
    .attach("file", Buffer.from("too big"), "bad.txt")
    .expect(413);
  assert.equal(f.store.resources(f.user, f.board.id).length, 0);
  assert.deepEqual(
    fs.readdirSync(path.join(f.root, "data", "para-staging")),
    [],
  );
  const file = (
    await f.agent
      .post(`/api/para/boards/${f.board.id}/resources`)
      .set("X-CSRF-Token", f.csrf)
      .field("key", id())
      .attach("file", Buffer.from("12345"), "ok.txt")
      .expect(201)
  ).body.resource;
  assert.equal(f.db.sumStoredFileBytesForUser(f.user), 5);
  await f.agent
    .post(`/api/para/boards/${f.board.id}/resources`)
    .set("X-CSRF-Token", f.csrf)
    .field("key", id())
    .attach("file", Buffer.from("1"), "overflow.txt")
    .expect(413);
  await f.agent.get(`/api/para/resources/${file.id}/content`).expect(200);
});

test("PARA interrupted registration rolls back blob and retry key; edited resources keep their versions", async (t) => {
  const f = await fixture(t);
  f.db.sqlite.exec(
    "CREATE TRIGGER fail_para_resource BEFORE INSERT ON para_resources BEGIN SELECT RAISE(ABORT, 'injected registration failure'); END;",
  );
  const k = id();
  await f.agent
    .post(`/api/para/boards/${f.board.id}/resources`)
    .set("X-CSRF-Token", f.csrf)
    .field("key", k)
    .attach("file", Buffer.from("durable"), "fixture.txt")
    .expect(500);
  const root = path.join(f.root, "tenants", f.user, "para-resources");
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT count(*) AS n FROM para_requests WHERE key=?")
      .get(k)!.n,
    0,
  );
  f.db.sqlite.exec("DROP TRIGGER fail_para_resource");
  const r = (
    await f.agent
      .post(`/api/para/boards/${f.board.id}/resources`)
      .set("X-CSRF-Token", f.csrf)
      .field("key", k)
      .attach("file", Buffer.from("durable"), "fixture.txt")
      .expect(201)
  ).body.resource;
  const edited = await f.agent
    .patch("/api/para/resources/" + r.id)
    .set("X-CSRF-Token", f.csrf)
    .send({ revision: 1, title: "更名", body: "新备注" })
    .expect(200);
  assert.equal(edited.body.resource.revision, 2);
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) AS n FROM para_resource_versions WHERE resource_id=?",
      )
      .get(r.id)!.n,
    2,
  );
  await f.agent
    .patch("/api/para/resources/" + r.id)
    .set("X-CSRF-Token", f.csrf)
    .send({ revision: 1, body: "过时备注" })
    .expect(409);
  assert.equal(f.store.resource(f.user, r.id).body, "新备注");
});

test("PARA refuses offline execution and checksums before creating any conversation", async (t) => {
  const f = await fixture(t),
    remote = f.db.createProject(
      id(),
      f.user,
      "离线工程",
      "C:\\test",
      "remote:" + id(),
    );
  const endpoint = `/api/para/projects/${f.project.id}/new-conversation`;
  await f.agent
    .post(endpoint)
    .set("X-CSRF-Token", f.csrf)
    .send({
      key: id(),
      title: "offline",
      projectId: remote.id,
      prompt: "start",
    })
    .expect(409);
  const r = (
    await f.agent
      .post(`/api/para/boards/${f.board.id}/resources`)
      .set("X-CSRF-Token", f.csrf)
      .field("key", id())
      .field("projectId", f.project.id)
      .attach("file", Buffer.from("before"), "fixture.txt")
      .expect(201)
  ).body.resource;
  fs.writeFileSync(
    resourcePath(path.join(f.root, "tenants"), f.user, r.id),
    "tampered",
  );
  await f.agent
    .post(endpoint)
    .set("X-CSRF-Token", f.csrf)
    .send({ key: id(), title: "corrupt", prompt: "start", resourceIds: [r.id] })
    .expect(409);
  assert.equal(f.store.detail(f.user, f.project.id).conversations.length, 0);
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) AS n FROM conversations").get()!.n,
    0,
  );
});

test("PARA archived areas do not block their existing projects; resource paths reject cross-directory links", async (t) => {
  const f = await fixture(t),
    area = f.store.createArea(f.user, f.board.id, "长期领域", "");
  f.store.updateProject(f.user, f.project.id, {
    revision: 1,
    area_id: area.id,
  });
  f.store.updateArea(f.user, area.id, { revision: 1, archived: true });
  const updated = f.store.updateProject(f.user, f.project.id, {
    revision: 2,
    stage: "active",
    brief: { ...emptyBrief(), goal: "继续推进" },
  });
  assert.equal(updated.stage, "active");
  assert.equal(updated.area_id, area.id);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  const resourceRoot = path.join(f.root, "tenants", f.user, "para-resources");
  fs.symlinkSync(outside, resourceRoot, "dir");
  await f.agent
    .post(`/api/para/boards/${f.board.id}/resources`)
    .set("X-CSRF-Token", f.csrf)
    .field("key", id())
    .attach("file", Buffer.from("must not escape"), "fixture.txt")
    .expect(409);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(f.store.resources(f.user, f.board.id).length, 0);
});

test("PARA sidebar search keeps board hierarchy, literal queries, paging and tenant boundaries", async (t) => {
  const f = await fixture(t);
  const board = f.store.createBoard(f.user, "Garden board", null);
  const projects = Array.from({ length: 9 }, (_, i) => f.store.createProject(f.user, board.id, `seed ${i}`));
  const literal = f.store.createProject(f.user, board.id, "100%_\\ garden");
  const hidden = f.store.createProject(f.user, board.id, "archived flower");
  f.store.updateProject(f.user, hidden.id, { revision: hidden.revision, archived: true });
  const other = id(), time = new Date().toISOString();
  f.db.createUser({ id: other, username: "sidebar-other", password_hash: "", display_name: "Other", role: "member", status: "active", created_at: time, updated_at: time });
  const foreign = f.store.createBoard(other, "Garden board private", null);
  const foreignProject = f.store.createProject(other, foreign.id, "seed private");
  const search = await f.agent.get("/api/para/sidebar").query({ q: "seed" }).expect(200);
  assert.deepEqual(search.body.boards.map((b: { id: string }) => b.id), [board.id]);
  assert.equal(search.body.boards[0].project_count, 9);
  const first = await f.agent.get(`/api/para/boards/${board.id}/sidebar-projects`).query({ q: "seed", limit: 5 }).expect(200);
  assert.deepEqual(first.body.projects.map((p: { id: string }) => p.id), projects.slice(4).reverse().map((p) => p.id));
  assert.equal(first.body.nextOffset, 5);
  assert.equal(first.body.hasMore, true);
  const second = await f.agent.get(`/api/para/boards/${board.id}/sidebar-projects`).query({ q: "seed", offset: first.body.nextOffset }).expect(200);
  assert.equal(second.body.projects.length, 4); assert.equal(second.body.hasMore, false);
  assert.equal(f.store.sidebarProjects(f.user, board.id, "Garden board", false, 100, 0).total, 10, "board matches include its projects");
  assert.deepEqual(f.store.sidebarProjects(f.user, board.id, "%_\\", false, 5, 0).projects.map((p) => p.id), [literal.id]);
  assert.deepEqual(f.store.sidebar(f.user, "archived flower", false), []);
  assert.equal(f.store.sidebar(f.user, "archived flower", true)[0].id, board.id);
  await f.agent.get(`/api/para/boards/${foreign.id}/sidebar-projects`).expect(404);
  await f.agent.post("/api/para/projects/reorder-sidebar").set("X-CSRF-Token", f.csrf).send({ sourceId: projects[0].id, targetId: foreignProject.id, placement: "before" }).expect(404);
  await f.agent.get(`/api/para/boards/${board.id}/sidebar-projects`).query({ limit: 0 }).expect(400);
  f.store.updateBoard(f.user, board.id, { revision: board.revision, archived: true });
  assert.equal(f.store.sidebar(f.user, "seed", false).length, 0);
  assert.equal(f.store.sidebar(f.user, "seed", true).length, 1);
});

test("PARA sidebar drag persists without changing kanban or revisions; actual activity returns projects to top", async (t) => {
  const f = await fixture(t);
  const a = f.project, b = f.store.createProject(f.user, f.board.id, "b"), c = f.store.createProject(f.user, f.board.id, "c");
  const order = () => f.store.sidebarProjects(f.user, f.board.id, "", false, 10, 0).projects.map((p) => p.id);
  assert.deepEqual(order(), [c.id, b.id, a.id]);
  const move = { sourceId: a.id, targetId: c.id, placement: "before" };
  await f.agent.post("/api/para/projects/reorder-sidebar").send(move).expect(403);
  await f.agent.post("/api/para/projects/reorder-sidebar").set("X-CSRF-Token", f.csrf).send(move).expect(204);
  assert.deepEqual(order(), [a.id, c.id, b.id]);
  for (const original of [a, b, c]) {
    const next = f.store.project(f.user, original.id);
    assert.equal(next.position, original.position); assert.equal(next.revision, original.revision); assert.equal(next.updated_at, original.updated_at);
    await f.agent.get(`/api/para/projects/${original.id}`).expect(200);
  }
  assert.deepEqual(order(), [a.id, c.id, b.id], "viewing does not count as activity");
  f.store.updateProject(f.user, b.id, { revision: b.revision, title: "b changed" });
  assert.deepEqual(order(), [b.id, a.id, c.id]);
  const conversation = f.db.createConversation(id(), "linked", selection, f.user, f.engine.id);
  f.store.linkConversation(f.user, c.id, conversation.id, false);
  assert.equal(order()[0], c.id);
  f.store.reorderSidebarProjects(f.user, c.id, a.id, "after");
  const prior = order();
  f.db.markConversationResultSeenForUser(conversation.id, f.user);
  assert.deepEqual(order(), prior);
  f.db.sqlite.prepare("UPDATE conversations SET last_active_at=? WHERE id=?").run("2099-01-01T00:00:00.000Z", conversation.id);
  assert.equal(order()[0], c.id);
  const note = (await f.agent.post(`/api/para/boards/${f.board.id}/resources`).set("X-CSRF-Token", f.csrf)
    .field("key", id()).field("projectId", a.id).field("title", "linked note").field("body", "first").expect(201)).body.resource;
  assert.equal(order()[0], a.id);
  f.store.reorderSidebarProjects(f.user, a.id, c.id, "after");
  f.store.updateResource(f.user, note.id, { revision: note.revision, body: "changed" });
  assert.equal(order()[0], a.id, "editing a linked resource is activity");
  const otherBoard = f.store.createBoard(f.user, "other", null), otherProject = f.store.createProject(f.user, otherBoard.id, "other");
  await f.agent.post("/api/para/projects/reorder-sidebar").set("X-CSRF-Token", f.csrf).send({ ...move, targetId: otherProject.id }).expect(400);
  const archived = f.store.updateProject(f.user, c.id, { revision: c.revision, archived: true });
  await f.agent.post("/api/para/projects/reorder-sidebar").set("X-CSRF-Token", f.csrf).send({ ...move, targetId: archived.id }).expect(409);
});
