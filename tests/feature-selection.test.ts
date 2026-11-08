import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { ParaStore } from "../server/para-store.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";

test("PARA defaults off for every account and upgrades saved choices only once without changing project data", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feature-default-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new AppDatabase(root, undefined, false);
  const offUser = crypto.randomUUID(), missingUser = crypto.randomUUID();
  const createUser = (db: AppDatabase, id: string) => {
    const time = new Date().toISOString();
    db.createUser({ id, username: id, display_name: "Fixture", password_hash: "", role: "member", status: "active", created_at: time, updated_at: time });
  };
  for (const id of [HOST_ROOT_USER_ID, offUser, missingUser]) createUser(first, id);
  const store = new ParaStore(first), board = store.createBoard(LEGACY_USER_ID, "Existing board", null);
  const project = store.createProject(LEGACY_USER_ID, board.id, "Existing project");
  const originalBoard = store.board(LEGACY_USER_ID, board.id), originalProject = store.project(LEGACY_USER_ID, project.id);
  const setting = first.sqlite.prepare("INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'feature_selection',?,'2026-09-29T00:00:00Z')");
  setting.run(LEGACY_USER_ID, JSON.stringify({ opportunityCards: false, paraBoard: true, revision: 8 }));
  setting.run(offUser, JSON.stringify({ opportunityCards: false, paraBoard: false, revision: 3 }));
  setting.run(HOST_ROOT_USER_ID, "malformed legacy setting");
  first.setChatFontSize(19, LEGACY_USER_ID);
  first.sqlite.exec("DELETE FROM schema_migrations WHERE version=2026093003");
  first.close();

  const upgraded = new AppDatabase(root, undefined, false);
  assert.deepEqual(upgraded.getFeatureSelection(LEGACY_USER_ID), { opportunityCards: false, paraBoard: false, revision: 9 });
  assert.deepEqual(upgraded.getFeatureSelection(offUser), { opportunityCards: false, paraBoard: false, revision: 4 });
  assert.deepEqual(upgraded.getFeatureSelection(HOST_ROOT_USER_ID), { opportunityCards: false, paraBoard: false, ppDot: true, revision: 1 });
  assert.deepEqual(upgraded.getFeatureSelection(missingUser), { opportunityCards: false, paraBoard: false, revision: 0 });
  assert.equal(upgraded.getChatFontSize(LEGACY_USER_ID), 19);
  assert.deepEqual(new ParaStore(upgraded).board(LEGACY_USER_ID, board.id), originalBoard);
  assert.deepEqual(new ParaStore(upgraded).project(LEGACY_USER_ID, project.id), originalProject);
  assert.equal(upgraded.setFeatureSelection(LEGACY_USER_ID, { opportunityCards: false, paraBoard: true, revision: 8 }), null, "old clients cannot undo the reset");
  const optIn = upgraded.setFeatureSelection(LEGACY_USER_ID, { opportunityCards: false, paraBoard: true, revision: 9 });
  assert.deepEqual(optIn, { opportunityCards: false, paraBoard: true, revision: 10 });
  upgraded.close();

  const reopened = new AppDatabase(root, undefined, false);
  try {
    assert.deepEqual(reopened.getFeatureSelection(LEGACY_USER_ID), optIn, "a later explicit opt-in survives restart");
    assert.deepEqual(reopened.getFeatureSelection(offUser), { opportunityCards: false, paraBoard: false, revision: 4 });
    const futureUser = crypto.randomUUID(); createUser(reopened, futureUser);
    assert.deepEqual(reopened.getFeatureSelection(futureUser), { opportunityCards: false, paraBoard: false, revision: 0 });
    assert.deepEqual(reopened.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { reopened.close(); }
});

test("feature selection is persistent, account isolated, revision guarded and broadcast to that account's clients", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feature-selection-"));
  const password = "Feature-selection-test-only-2026!";
  const instance = createApp({ basePath: "", projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync(password, 4), queueAutoStart: false, sessionSecret: "feature-selection-test-secret-longer-than-32-characters" });
  const friendId = crypto.randomUUID(), now = new Date().toISOString();
  instance.db.createUser({ id: friendId, username: "friend", display_name: "Fixture", password_hash: bcrypt.hashSync(password, 4), role: "member", status: "active", created_at: now, updated_at: now });
  const server = instance.app.listen(0, "127.0.0.1");
  const controllers: AbortController[] = [];
  t.after(async () => {
    controllers.forEach(c => c.abort()); await instance.beginShutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    instance.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const owner = request.agent(server), otherDevice = request.agent(server), friend = request.agent(server);
  const login = async (agent: ReturnType<typeof request.agent>, username: string) => agent.post("/api/auth/login").send({ username, password }).expect(200);
  const [a, b, f] = await Promise.all([login(owner, "demo-owner"), login(otherDevice, "demo-owner"), login(friend, "friend")]);
  const initial = { opportunityCards: false, paraBoard: false, revision: 0 };
  assert.deepEqual(a.body.features, initial);
  const connect = async (cookie: string) => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(origin + "/api/system/events", { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); let buffer = "";
    return async () => {
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        for (;;) {
          const at = buffer.indexOf("\n\n");
          if (at >= 0) {
            const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
            const data = block.split("\n").find(l => l.startsWith("data: "))?.slice(6);
            if (data) { const parsed = JSON.parse(data); if (parsed.type === "feature_selection") return parsed.features; }
          } else { const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += new TextDecoder().decode(chunk.value).replace(/\r\n/g, "\n"); }
        }
      } finally { clearTimeout(timeout); }
    };
  };
  const cookie = (r: typeof a) => (r.headers["set-cookie"] as unknown as string[]).map(c => c.split(";", 1)[0]).join("; ");
  const clients = await Promise.all([connect(cookie(a)), connect(cookie(b)), connect(cookie(f))]);
  assert.deepEqual(await Promise.all(clients.map(next => next())), [initial, initial, initial]);
  await request(server).get("/api/user-settings/features").expect(401);
  await owner.put("/api/user-settings/features").send({ opportunityCards: false, paraBoard: false, revision: 0 }).expect(403);
  for (const invalid of [{ opportunityCards: false, paraBoard: false, ppDot: "false", revision: 0 }, { opportunityCards: false, paraBoard: "false", revision: 0 }, { opportunityCards: false, paraBoard: false }, { opportunityCards: false, paraBoard: false, revision: -1 }, { opportunityCards: false, paraBoard: false, revision: 0, userId: friendId }]) {
    await owner.put("/api/user-settings/features").set("X-CSRF-Token", a.body.csrfToken).send(invalid).expect(400);
  }
  const hidden = { opportunityCards: false, paraBoard: false, ppDot: false, revision: 1 };
  await owner.put("/api/user-settings/features").set("X-CSRF-Token", a.body.csrfToken).send({ ...initial, paraBoard: false, ppDot: false }).expect(200, hidden);
  assert.deepEqual(await Promise.all(clients.slice(0, 2).map(next => next())), [hidden, hidden]);
  assert.deepEqual((await otherDevice.get("/api/auth/session").expect(200)).body.features, hidden);
  const read = await otherDevice.get("/api/user-settings/features").expect(200, hidden); assert.match(read.headers["cache-control"], /no-store/);
  await otherDevice.put("/api/user-settings/features").set("X-CSRF-Token", b.body.csrfToken).send(initial).expect(409);
  await friend.get("/api/user-settings/features").expect(200, initial);
  const friendNext = { opportunityCards: false, paraBoard: true, revision: 1 };
  await friend.put("/api/user-settings/features").set("X-CSRF-Token", f.body.csrfToken).send({ ...initial, paraBoard: true }).expect(200, friendNext);
  // If an owner's update leaked, the next friend event would be hidden instead.
  assert.deepEqual(await clients[2](), friendNext);
  const reconnect = await connect(cookie(b)); assert.deepEqual(await reconnect(), hidden);
  const reopened = new AppDatabase(path.join(root, "data"), undefined, false);
  try { assert.deepEqual(reopened.getFeatureSelection(LEGACY_USER_ID), hidden); assert.deepEqual(reopened.getFeatureSelection(friendId), friendNext); }
  finally { reopened.close(); }
  const shown = { opportunityCards: false, paraBoard: true, ppDot: false, revision: 2 };
  await otherDevice.put("/api/user-settings/features").set("X-CSRF-Token", b.body.csrfToken).send({ opportunityCards: false, paraBoard: true, revision: 1 }).expect(200, shown);
  assert.deepEqual(await clients[0](), shown);
});

test('Dot API protects the bound coordinator and parent project without restricting same-title ordinary tasks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-protection-'));
  const password = 'Dot-test-only-password!';
  const instance = createApp({ basePath: "",projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),username:'pp',passwordHash:bcrypt.hashSync(password,4),queueAutoStart:false,sessionSecret:'dot-protection-test-secret-longer-than-32-characters',hostKnowledgeRoot:path.join(root,'host-default'),hostRootSocketPath:path.join(root,'no-host.sock'),minimumFreeDiskBytes:0});
  t.after(async()=>{await instance.beginShutdown();await instance.waitForBackgroundTasks();instance.db.close();fs.rmSync(root,{recursive:true,force:true});});
  const db=instance.db, user=HOST_ROOT_USER_ID, now=new Date().toISOString();
  db.createUser({id:user,username:'test-host',display_name:'Fixture',password_hash:bcrypt.hashSync(password,4),role:'owner',status:'active',created_at:now,updated_at:now});
  const project=db.ensureDefaultProject(crypto.randomUUID(),user,'coordinator-project',instance.config.hostKnowledgeRoot,'local-host');
  const other=db.createProject(crypto.randomUUID(),user,'Other',path.join(root,'other'),'local-host');
  const dot=instance.dotStore.init(user), ordinary=db.createConversation(crypto.randomUUID(),'PP Dot',undefined,user,project.id);
  const owner=request.agent(instance.app),friend=request.agent(instance.app);
  const login=await owner.post('/api/auth/login').send({username:'test-host',password}).expect(200);
  const friendLogin=await friend.post('/api/auth/login').send({username:'pp',password}).expect(200);
  assert.equal(login.body.features.ppDot,true);
  const csrf=login.body.csrfToken, original=db.getConversation(dot.id), binding=instance.dotStore.session(user);
  const hidden=await owner.put('/api/user-settings/features').set('X-CSRF-Token',csrf).send({...login.body.features,ppDot:false}).expect(200);
  await owner.put('/api/user-settings/features').set('X-CSRF-Token',csrf).send({paraBoard:false,revision:hidden.body.revision}).expect(200);
  assert.equal((await owner.get('/api/auth/session').expect(200)).body.features.ppDot,false);
  await owner.post(`/api/conversations/${dot.id}/archive`).set('X-CSRF-Token',csrf).expect(409);
  await owner.delete(`/api/conversations/${dot.id}`).set('X-CSRF-Token',csrf).expect(409);
  await owner.put(`/api/conversations/${dot.id}/project`).set('X-CSRF-Token',csrf).send({projectId:other.id}).expect(409);
  await owner.post(`/api/projects/${project.id}/archive`).set('X-CSRF-Token',csrf).expect(409);
  await friend.post(`/api/conversations/${dot.id}/archive`).set('X-CSRF-Token',friendLogin.body.csrfToken).expect(404);
  await friend.post(`/api/projects/${project.id}/archive`).set('X-CSRF-Token',friendLogin.body.csrfToken).expect(404);
  assert.deepEqual(db.getConversation(dot.id),original);assert.deepEqual(instance.dotStore.session(user),binding);
  assert.equal(db.getProject(project.id)?.archived_at,null);
  const projects=await owner.get('/api/projects').expect(200);
  assert.equal(projects.body.projects.find((p:{id:string})=>p.id===project.id).has_dot_coordinator,true);
  assert.equal(projects.body.projects.find((p:{id:string})=>p.id===other.id).has_dot_coordinator,false);
  await owner.post(`/api/conversations/${ordinary.id}/archive`).set('X-CSRF-Token',csrf).expect(200);
  await owner.post(`/api/conversations/${ordinary.id}/restore`).set('X-CSRF-Token',csrf).expect(200);
  await owner.put(`/api/conversations/${ordinary.id}/project`).set('X-CSRF-Token',csrf).send({projectId:other.id}).expect(200);
  await owner.delete(`/api/conversations/${ordinary.id}`).set('X-CSRF-Token',csrf).expect(204);
  await owner.post(`/api/projects/${other.id}/archive`).set('X-CSRF-Token',csrf).expect(200);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM dot_calls').get()!.n,0);
});
