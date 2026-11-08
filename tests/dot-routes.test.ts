import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import bcrypt from 'bcryptjs';import request from 'supertest';import WebSocket from 'ws';
import {createApp} from '../server/app.js';import {HOST_ROOT_USER_ID as user} from '../server/host-root-user.js';import {createJobAutomationToken} from '../server/wake-automation.js';
const id=()=>crypto.randomUUID(),selection={model:'gpt-6-astra',reasoningEffort:'xhigh'};
test('Dot real HTTP/WS routes enforce owner, CSRF, Origin, live coordinator token and expired login',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dot-api-')),secret=crypto.randomBytes(32).toString('hex'),password='fixture-password',now=new Date().toISOString();
 const app=createApp({ basePath: "",projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),hostKnowledgeRoot:path.join(root,'host-project'),hostRootSocketPath:path.join(root,'bridge.sock'),queueAutoStart:false,username:'fixture',passwordHash:bcrypt.hashSync(password,4),sessionSecret:secret,minimumFreeDiskBytes:0,publicBaseUrl:'http://127.0.0.1:37962'});
 const server=app.app.listen(0,'127.0.0.1');app.dotLive.attach(server);app.remoteWorkers.attach(server);app.nodeTransfers.attach(server);await new Promise<void>(r=>server.once('listening',r));
 t.after(async()=>{await app.dotLive.close();app.remoteWorkers.close();app.nodeTransfers.close();app.beginShutdown();await app.waitForBackgroundTasks();await new Promise<void>(r=>server.close(()=>r()));app.db.close();fs.rmSync(root,{recursive:true,force:true})});
 app.db.createUser({id:user,username:'test-host',display_name:'Dot fixture',password_hash:bcrypt.hashSync(password,4),role:'owner',status:'active',created_at:now,updated_at:now});
 const a=request.agent(app.app),login=await a.post('/api/auth/login').send({username:'test-host',password}).expect(200),csrf=login.body.csrfToken;
 const p=app.db.listProjects(user).find(p=>p.root_path===app.config.hostKnowledgeRoot)!;assert.ok(p);
 await request(app.app).get('/api/dot').expect(401);await a.post('/api/dot/open').send({}).expect(403);
 await a.post('/api/dot/open').set('X-CSRF-Token',csrf).set('Origin','https://evil.invalid').send({}).expect(403);
 const opened=await a.post('/api/dot/open').set('X-CSRF-Token',csrf).send({}).expect(200),cid=opened.body.conversation.id;
 const friend=request.agent(app.app),friendLogin=await friend.post('/api/auth/login').send({username:'fixture',password}).expect(200);
 await friend.get('/api/dot').expect(403);await friend.post('/api/dot/open').set('X-CSRF-Token',friendLogin.body.csrfToken).send({}).expect(403);await friend.delete('/api/conversations/'+cid).set('X-CSRF-Token',friendLogin.body.csrfToken).expect(404);
 const worker=app.db.createConversation(id(),'executor',selection,user,p.id),job=app.db.createJob(id(),worker.id,undefined,selection);app.db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
 await request(app.app).post(`/api/automation/jobs/${job.id}/dot`).set('Authorization','Bearer '+createJobAutomationToken(secret,job.id,worker.id,Date.now(),86400000,app.db.workflows.assertJob(job.id).epoch)).send({action:'memory_put'}).expect(403);
 const coord=app.db.createJob(id(),cid,undefined,selection);app.db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(coord.id);
 const endpoint=`/api/automation/jobs/${coord.id}/dot`,token=createJobAutomationToken(secret,coord.id,cid,Date.now(),86400000,app.db.workflows.assertJob(coord.id).epoch);
 await request(app.app).post(endpoint).set('Authorization','Bearer '+token).send({action:'context'}).expect(200);app.db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(coord.id);await request(app.app).post(endpoint).set('Authorization','Bearer '+token).send({action:'context'}).expect(401);
 const port=(server.address() as {port:number}).port;
 await new Promise<void>((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/api/dot/live`,['pp-dot','invalid'],{origin:'https://evil.invalid'});ws.on('unexpected-response',(_r,res)=>{assert.equal(res.statusCode,401);res.resume();ws.terminate();resolve()});ws.on('error',()=>{});ws.on('open',()=>reject(Error('unauthorized websocket opened')))});
 // Missing configuration is a supported default: no file/key/proxy discovery.
 await a.post('/api/dot/call').set('X-CSRF-Token',csrf).send({}).expect(503);
 const keys=['CODEX_WEB_LIVE_ENABLED','CODEX_WEB_LIVE_API_KEY_FILE','CODEX_WEB_LIVE_ENDPOINT','CODEX_WEB_LIVE_MODEL'] as const,prior=keys.map(k=>process.env[k]);
 try {
  process.env.CODEX_WEB_LIVE_ENABLED='true'; process.env.CODEX_WEB_LIVE_API_KEY_FILE=path.join(root,'fixture-key');
  process.env.CODEX_WEB_LIVE_ENDPOINT='wss://voice.example.invalid/live'; process.env.CODEX_WEB_LIVE_MODEL='fixture-live';
  fs.writeFileSync(process.env.CODEX_WEB_LIVE_API_KEY_FILE,'synthetic-no-network-credential');
  const ticket=(await a.post('/api/dot/call').set('X-CSRF-Token',csrf).send({}).expect(200)).body.ticket;
  assert.equal(typeof ticket,'string');
  await new Promise<void>((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/api/dot/live`,['pp-dot',ticket],{origin:'https://evil.invalid'});ws.on('unexpected-response',(_r,res)=>{assert.equal(res.statusCode,401);res.resume();ws.terminate();resolve()});ws.on('error',()=>{});ws.on('open',()=>reject(Error('cross-origin call opened')))});
  assert.equal(app.db.sqlite.prepare('SELECT COUNT(*) n FROM dot_calls').get()?.n,0);
 } finally {keys.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i]})}
 app.db.sqlite.prepare('DELETE FROM sessions WHERE user_id=?').run(user);await a.get('/api/dot').expect(401);
});
