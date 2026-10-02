import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { ParaStore } from "../server/para-store.js";
import { migratePara, migrateParaSidebar, migratePersonalKanban, paraJobPrompt } from "../server/para-schema.js";
const id = () => crypto.randomUUID();

test("personal kanban migration preserves legacy data, relationships and accepted snapshots transactionally", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY);
      CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT,last_active_at TEXT,status TEXT,external_status TEXT,deleted_at TEXT);
      CREATE TABLE files(id TEXT PRIMARY KEY); CREATE TABLE messages(id TEXT PRIMARY KEY);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,conversation_id TEXT); CREATE TABLE pending_prompts(id TEXT PRIMARY KEY,conversation_id TEXT,content TEXT,quote_excerpt TEXT);
      INSERT INTO users VALUES('u'); INSERT INTO conversations VALUES('c','u','2026-01-01','idle','idle',NULL);`);
    migratePara(sql); sql.exec("ALTER TABLE para_boards ADD COLUMN position REAL NOT NULL DEFAULT 0"); migrateParaSidebar(sql);
    sql.exec("INSERT INTO para_boards(id,user_id,name,created_at,updated_at) VALUES('b','u','board','2026-01-01','2026-01-01')");
    for (const stage of ["idea", "incubating", "active", "done"]) {
      sql.prepare("INSERT INTO para_projects(id,user_id,board_id,title,stage,created_at,updated_at) VALUES(?,'u','b',?,?,'2026-01-01','2026-01-01')").run(stage,stage,stage);
    }
    sql.exec(`INSERT INTO para_conversations VALUES('active','c','primary','2026-01-01'); INSERT INTO jobs VALUES('j','c');
      INSERT INTO para_resources(id,user_id,board_id,title,kind,created_at,updated_at) VALUES('r','u','b','retained','note','2026-01-01','2026-01-01');
      INSERT INTO para_resource_links VALUES('active','r',1,1);`);
    const original = sql.prepare("SELECT snapshot FROM para_job_context WHERE job_id='j'").get()!.snapshot;
    sql.exec("BEGIN"); migratePersonalKanban(sql); sql.exec("ROLLBACK");
    assert.equal(sql.prepare("SELECT name FROM pragma_table_info('para_projects') WHERE name='workflow_stage'").get(), undefined);
    sql.exec("BEGIN"); migratePersonalKanban(sql); sql.exec("COMMIT");
    assert.deepEqual(sql.prepare("SELECT id,workflow_stage FROM para_projects ORDER BY id").all().map(r => [r.id,r.workflow_stage]), [["active","active"],["done","done"],["idea","idea"],["incubating","incubating"]]);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM para_projects WHERE started_at IS NOT NULL OR ended_at IS NOT NULL").get()!.n,0);
    assert.equal(sql.prepare("SELECT snapshot FROM para_job_context WHERE job_id='j'").get()!.snapshot, original);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM para_resource_links").get()!.n,1);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM para_resource_versions").get()!.n,1);
    assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(),[]);
    sql.exec("UPDATE para_projects SET stage='active',workflow_stage='review' WHERE id='active'");
    assert.equal(sql.prepare("SELECT workflow_stage FROM para_projects WHERE id='active'").get()!.workflow_stage,"review");
    sql.exec("INSERT INTO jobs VALUES('j2','c')");
    assert.equal(JSON.parse(String(sql.prepare("SELECT snapshot FROM para_job_context WHERE job_id='j2'").get()!.snapshot)).stage,"review");
    sql.exec("UPDATE para_projects SET stage='incubating' WHERE id='active'");
    assert.equal(sql.prepare("SELECT workflow_stage FROM para_projects WHERE id='active'").get()!.workflow_stage,"incubating", "legacy rollback writes remain readable");
  } finally { sql.close(); }
});

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-test-"));
  const password = crypto.randomUUID();
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root,"data"), tenantRoot:path.join(root,"tenants"), queueAutoStart:false, username:"demo-owner", passwordHash:bcrypt.hashSync(password,4), sessionSecret:crypto.randomUUID(), minimumFreeDiskBytes:0 });
  t.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const agent=request.agent(instance.app), login=await agent.post("/api/auth/login").send({username:"demo-owner",password}).expect(200);
  const store = new ParaStore(instance.db), user=LEGACY_USER_ID, board=store.createBoard(user,"Lifecycle",null);
  const patch = (pid:string, data:object, status=200) => agent.patch(`/api/para/projects/${pid}`).set("X-CSRF-Token",login.body.csrfToken).send(data).expect(status);
  return {...instance,root,agent,store,user,board,patch,csrf:login.body.csrfToken};
}

test("lifecycle accounts for waiting, paused and archived commitments; requires distinct closure and permits rework", async t => {
  const f=await fixture(t);
  let p=f.store.createProject(f.user,f.board.id,"Deliver a result");
  const update=async (change:object) => { p=(await f.patch(p.id,{revision:p.revision,...change})).body.project; };
  await update({stage:"incubating",ready:true});
  assert.equal(f.store.summary(f.user).counts.wip,0);
  await update({stage:"active"}); assert.ok(p.started_at); const started=p.started_at;
  await update({waiting_for:"Owner review",review_on:"2000-01-01",paused:true,hold_reason:"Focus elsewhere"});
  await update({archived:true});
  let summary=f.store.summary(f.user);
  assert.deepEqual({...summary.counts},{wip:1,review:0,waiting:1,paused:1,preparing:0,overdue:1,archived_wip:1});
  await update({archived:false,stage:"review",waiting_for:"",paused:false,acceptance:"Desktop passed; mobile pending"});
  assert.equal(f.store.sidebarProjects(f.user,f.board.id,"",false,5,0).projects[0].stage,"review");
  assert.equal(f.store.projects(f.user,f.board.id)[0].stage,"review");
  await f.patch(p.id,{revision:p.revision,stage:"done"},400);
  await f.patch(p.id,{revision:p.revision-1,stage:"done",outcome:"stale"},409);
  await update({stage:"active",brief:{...p.brief,next:"Repair mobile layout"}});
  assert.equal(p.started_at,started);
  await update({stage:"review"}); await update({stage:"done",outcome:"Both viewports accepted"});
  assert.ok(p.ended_at); assert.equal(p.review_on,null); assert.equal(f.store.summary(f.user).counts.wip,0);
  await update({stage:"incubating"}); assert.equal(p.ended_at,null);
  await f.patch(p.id,{revision:p.revision,stage:"done"},400);
  await f.patch(p.id,{revision:p.revision,stage:"stopped"},400);
  await update({stage:"stopped",outcome:"Scope no longer valuable"});
  await f.patch(p.id,{revision:p.revision,paused:true},400);
  await f.patch(p.id,{revision:p.revision,review_on:"2026-02-31"},400);
  assert.match(f.store.detail(f.user,p.id).events[0].action,/终止/);
  const before=f.store.detail(f.user,p.id), reopened=new AppDatabase(path.join(f.root,"data"),undefined,false);
  try { assert.deepEqual(new ParaStore(reopened).detail(f.user,p.id),before); } finally {reopened.close();}
});

test("personal summary and WIP preferences are tenant scoped, revision checked, authenticated and CSRF protected", async t => {
  const f=await fixture(t), other=id(), time=new Date().toISOString();
  f.db.createUser({id:other,username:"kanban-other",password_hash:"",display_name:"Other",role:"member",status:"active",created_at:time,updated_at:time});
  const b=f.store.createBoard(other,"Private",null), foreign=f.store.createProject(other,b.id,"Private", "review");
  f.store.createProject(f.user,f.board.id,"One","active");
  const another=f.store.createBoard(f.user,"Two",null); f.store.createProject(f.user,another.id,"Two","review");
  const result=await f.agent.get("/api/para/summary").expect(200);
  assert.equal(result.body.counts.wip,2); assert.equal(result.body.counts.review,1);
  assert.ok(!result.body.attention.some((p:{id:string})=>p.id===foreign.id));
  await request(f.app).get("/api/para/summary").expect(401);
  await f.agent.patch("/api/para/preferences").send({revision:0,wip_limit:2}).expect(403);
  await f.agent.patch("/api/para/preferences").set("X-CSRF-Token",f.csrf).send({revision:0,wip_limit:2}).expect(200);
  await f.agent.patch("/api/para/preferences").set("X-CSRF-Token",f.csrf).send({revision:0,wip_limit:5}).expect(409);
  await f.agent.patch("/api/para/preferences").set("X-CSRF-Token",f.csrf).send({revision:1,wip_limit:0}).expect(400);
  assert.deepEqual({...f.store.preferences(f.user)},{revision:1,wip_limit:2}); assert.equal(f.store.preferences(other).wip_limit,3);
  await f.patch(foreign.id,{revision:1,stage:"done",outcome:"unauthorized"},404);
});

test("lifecycle context is fixed per queued input and project stage never follows a Job automatically", async t => {
  const f=await fixture(t), selection={model:"gpt-6-sol",reasoningEffort:"medium"};
  let p=f.store.createProject(f.user,f.board.id,"Context","active");
  const c=f.db.createConversation(id(),"Context",selection,f.user,f.db.getDefaultProject(f.user)!.id);
  f.store.linkConversation(f.user,p.id,c.id);
  p=f.store.updateProject(f.user,p.id,{revision:p.revision,stage:"review",acceptance:"Original evidence"});
  const pending=f.db.createPendingPrompt(id(),c.id,"Check",selection);
  p=f.store.updateProject(f.user,p.id,{revision:p.revision,stage:"active",acceptance:"Changed evidence"});
  const job=f.db.materializePendingPrompt(pending.id,id(),id())!;
  const prompt=paraJobPrompt(f.db.sqlite,job.id);
  assert.match(prompt,/"stage":"review"/); assert.match(prompt,/Original evidence/); assert.doesNotMatch(prompt,/Changed evidence/);
  assert.equal(f.store.project(f.user,p.id).stage,"active");
});
