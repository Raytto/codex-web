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
  setting.run(LEGACY_USER_ID, JSON.stringify({ paraBoard: true, revision: 8 }));
  setting.run(offUser, JSON.stringify({ paraBoard: false, revision: 3 }));
  setting.run(HOST_ROOT_USER_ID, "malformed legacy setting");
  first.setChatFontSize(19, LEGACY_USER_ID);
  first.sqlite.exec("DELETE FROM schema_migrations WHERE version=2026093003");
  first.close();

  const upgraded = new AppDatabase(root, undefined, false);
  assert.deepEqual(upgraded.getFeatureSelection(LEGACY_USER_ID), { paraBoard: false, revision: 9 });
  assert.deepEqual(upgraded.getFeatureSelection(offUser), { paraBoard: false, revision: 4 });
  assert.deepEqual(upgraded.getFeatureSelection(HOST_ROOT_USER_ID), { paraBoard: false, revision: 1 });
  assert.deepEqual(upgraded.getFeatureSelection(missingUser), { paraBoard: false, revision: 0 });
  assert.equal(upgraded.getChatFontSize(LEGACY_USER_ID), 19);
  assert.deepEqual(new ParaStore(upgraded).board(LEGACY_USER_ID, board.id), originalBoard);
  assert.deepEqual(new ParaStore(upgraded).project(LEGACY_USER_ID, project.id), originalProject);
  assert.equal(upgraded.setFeatureSelection(LEGACY_USER_ID, { paraBoard: true, revision: 8 }), null, "old clients cannot undo the reset");
  const optIn = upgraded.setFeatureSelection(LEGACY_USER_ID, { paraBoard: true, revision: 9 });
  assert.deepEqual(optIn, { paraBoard: true, revision: 10 });
  upgraded.close();

  const reopened = new AppDatabase(root, undefined, false);
  try {
    assert.deepEqual(reopened.getFeatureSelection(LEGACY_USER_ID), optIn, "a later explicit opt-in survives restart");
    assert.deepEqual(reopened.getFeatureSelection(offUser), { paraBoard: false, revision: 4 });
    const futureUser = crypto.randomUUID(); createUser(reopened, futureUser);
    assert.deepEqual(reopened.getFeatureSelection(futureUser), { paraBoard: false, revision: 0 });
    assert.deepEqual(reopened.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { reopened.close(); }
});

test("feature selection is persistent, account isolated, revision guarded and broadcast to that account's clients", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feature-selection-"));
  const password = "Feature-selection-test-only-2026!";
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
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
  const initial = { paraBoard: false, revision: 0 };
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
  await owner.put("/api/user-settings/features").send({ paraBoard: false, revision: 0 }).expect(403);
  for (const invalid of [{ paraBoard: "false", revision: 0 }, { paraBoard: false }, { paraBoard: false, revision: -1 }, { paraBoard: false, revision: 0, userId: friendId }]) {
    await owner.put("/api/user-settings/features").set("X-CSRF-Token", a.body.csrfToken).send(invalid).expect(400);
  }
  const hidden = { paraBoard: false, revision: 1 };
  await owner.put("/api/user-settings/features").set("X-CSRF-Token", a.body.csrfToken).send({ ...initial, paraBoard: false }).expect(200, hidden);
  assert.deepEqual(await Promise.all(clients.slice(0, 2).map(next => next())), [hidden, hidden]);
  assert.deepEqual((await otherDevice.get("/api/auth/session").expect(200)).body.features, hidden);
  const read = await otherDevice.get("/api/user-settings/features").expect(200, hidden); assert.match(read.headers["cache-control"], /no-store/);
  await otherDevice.put("/api/user-settings/features").set("X-CSRF-Token", b.body.csrfToken).send(initial).expect(409);
  await friend.get("/api/user-settings/features").expect(200, initial);
  const friendNext = { paraBoard: true, revision: 1 };
  await friend.put("/api/user-settings/features").set("X-CSRF-Token", f.body.csrfToken).send({ ...initial, paraBoard: true }).expect(200, friendNext);
  // If an owner's update leaked, the next friend event would be hidden instead.
  assert.deepEqual(await clients[2](), friendNext);
  const reconnect = await connect(cookie(b)); assert.deepEqual(await reconnect(), hidden);
  const reopened = new AppDatabase(path.join(root, "data"), undefined, false);
  try { assert.deepEqual(reopened.getFeatureSelection(LEGACY_USER_ID), hidden); assert.deepEqual(reopened.getFeatureSelection(friendId), friendNext); }
  finally { reopened.close(); }
  const shown = { paraBoard: true, revision: 2 };
  await otherDevice.put("/api/user-settings/features").set("X-CSRF-Token", b.body.csrfToken).send({ paraBoard: true, revision: 1 }).expect(200, shown);
  assert.deepEqual(await clients[0](), shown);
});
