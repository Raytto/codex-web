import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { AppDatabase } from '../server/db.js';
import { WorkflowStore, workflowCapacity } from '../server/workflow-store.js';
import { verifyWorkflowEvidence } from '../server/workflow-evidence.js';
import { createApp } from '../server/app.js';
import { createJobAutomationToken } from '../server/wake-automation.js';
const id=()=>crypto.randomUUID();
const selection={model:'gpt-6.1-sol',reasoningEffort:'high'} as const;
const evidence={kind:'artifact',summary:'verified result',functionalVerified:true,cleanupVerified:true,backgroundWorkFinished:true,checks:[{name:'real behavior',passed:true}]};
function fixture(t:test.TestContext, capacity=1){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-'));
 const db=new AppDatabase(root);db.workflows.configure(capacity);
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 function job(conversationId?:string){const c=conversationId?db.getConversation(conversationId)!:db.createConversation(id(),'modify');const j=db.createJob(id(),c.id,undefined,selection);return {c,j};}
 return {db,root,job};
}
function finish(db:AppDatabase,jobId:string){
 const w=db.workflows.assertJob(jobId);db.workflows.requestClose(jobId,w.revision,evidence);
 const j=db.getJob(jobId)!;db.finishJob(jobId,j.conversation_id,'completed');db.workflows.settled(jobId);
}
test('capacity accepts only explicit unlimited or positive integers',()=>{assert.equal(workflowCapacity(undefined),-1);assert.equal(workflowCapacity(''),-1);assert.equal(workflowCapacity(-1),-1);assert.equal(workflowCapacity('1'),1);for(const x of [0,-2,1.5,'bad',10001])assert.throws(()=>workflowCapacity(x));});
test('legacy stop controls release only empty never-started requests, external queue owners remain',t=>{
 const {db,job}=fixture(t);const a=job(),b=job();const external=db.workflows.external('external-wait',a.c.user_id,'external');
 db.cancelQueuedJob(a.j.id);db.workflows.reconcileUnstarted();
 assert.equal(db.workflows.forConversation(a.c.id)?.state,'aborted');assert.equal(db.workflows.get(external.id)?.state,'queued');
 db.updateJob(b.j.id,'running');db.finishJob(b.j.id,b.c.id,'cancelled');db.workflows.settled(b.j.id);db.workflows.reconcileUnstarted();
 assert.equal(db.workflows.forConversation(b.c.id)?.state,'blocked');
});
test('explicit resumption priority orders queued work without preempting the occupied slot',t=>{
 const {db,job}=fixture(t);const a=job(),b=job(),c=job();db.updateJob(a.j.id,'running');
 db.workflows.prioritize(db.workflows.forConversation(c.c.id)!.id,10,'用户要求先恢复已进入验收的任务');
 assert.throws(()=>db.workflows.prioritize(db.workflows.forConversation(a.c.id)!.id,20,'wrong'),/仅可/);
 assert.throws(()=>db.updateJob(c.j.id,'running'),/WORKFLOW_LIMIT/);finish(db,a.j.id);
 assert.throws(()=>db.updateJob(b.j.id,'running'),/WORKFLOW_LIMIT/);db.updateJob(c.j.id,'running');finish(db,c.j.id);db.updateJob(b.j.id,'running');
});
test('a completed Job does not release whole-workflow capacity; same owner can resume',t=>{
 const {db,job}=fixture(t);const a=job(),b=job();db.updateJob(a.j.id,'running');db.finishJob(a.j.id,a.c.id,'completed');db.workflows.settled(a.j.id);
 assert.equal(db.workflows.forConversation(a.c.id)?.state,'blocked');assert.throws(()=>db.updateJob(b.j.id,'running'),/WORKFLOW_LIMIT/);
 const next=job(a.c.id);db.updateJob(next.j.id,'running');finish(db,next.j.id);db.updateJob(b.j.id,'running');assert.equal(db.getJob(b.j.id)?.status,'running');
});
test('closing is retained until execution settles, duplicate settlement does not reopen',t=>{
 const {db,job}=fixture(t);const a=job(),b=job();db.updateJob(a.j.id,'running');const w=db.workflows.assertJob(a.j.id);db.workflows.requestClose(a.j.id,w.revision,evidence);
 db.finishJob(a.j.id,a.c.id,'completed');assert.throws(()=>db.updateJob(b.j.id,'running'),/WORKFLOW_LIMIT/);
 db.workflows.settled(a.j.id);db.workflows.settled(a.j.id);assert.equal(db.workflows.get(w.id)?.state,'completed');db.updateJob(b.j.id,'running');
});
test('durable new-conversation wake belongs to original owner, not a second FIFO task',t=>{
 const {db,job}=fixture(t);const a=job(),b=job();db.updateJob(a.j.id,'running');
 const plan=db.createWakePlan({id:id(),conversationId:a.c.id,createdByJobId:a.j.id,mode:'time',label:'verify',deadlineAt:new Date(Date.now()+10000).toISOString(),successPrompt:'verify',failurePrompt:'verify',timeoutPrompt:'verify',selection,newConversation:true});
 assert.equal(db.workflows.forConversation(plan.conversation_id)?.id,db.workflows.forConversation(a.c.id)?.id);
 db.finishJob(a.j.id,a.c.id,'completed');db.workflows.settled(a.j.id);assert.throws(()=>db.updateJob(b.j.id,'running'),/WORKFLOW_LIMIT/);
 const triggered=db.recordWakeEvent(plan.id,'event1','deadline',null,id());assert.equal(triggered.status,'triggered');
 const next=db.materializePendingPrompt(triggered.pendingPrompt!.id,id(),id())!;db.updateJob(next.id,'running');finish(db,next.id);db.updateJob(b.j.id,'running');
 assert.equal(db.recordWakeEvent(plan.id,'event1','deadline',null,id()).status,'duplicate');
});
test('pending or armed work and stale revisions prevent completion; late input cancels closing',t=>{
 const {db,job}=fixture(t);const a=job();db.updateJob(a.j.id,'running');const old=db.workflows.assertJob(a.j.id);
 const p=db.createPendingPrompt(id(),a.c.id,'extra',selection);
 assert.throws(()=>db.workflows.requestClose(a.j.id,old.revision,evidence),/状态已变化/);
 assert.throws(()=>db.workflows.requestClose(a.j.id,db.workflows.assertJob(a.j.id).revision,evidence),/仍有排队/);
 db.sqlite.prepare('DELETE FROM pending_prompts WHERE id=?').run(p.id);
 db.workflows.requestClose(a.j.id,db.workflows.assertJob(a.j.id).revision,evidence);
 db.createPendingPrompt(id(),a.c.id,'another extra',selection);db.finishJob(a.j.id,a.c.id,'completed');db.workflows.settled(a.j.id);
 assert.equal(db.workflows.forConversation(a.c.id)?.state,'active');
});
test('second database connection cannot take a slot; restart preserves owner and requires exit reconciliation',t=>{
 const {db,root,job}=fixture(t);const a=job(),b=job();db.updateJob(a.j.id,'running');
 const other=new AppDatabase(root,undefined,false);try{assert.throws(()=>other.updateJob(b.j.id,'running'),/WORKFLOW_LIMIT/);assert.ok(other.workflows.block(a.c.id));}finally{other.close();}
 db.finishJob(a.j.id,a.c.id,'interrupted');assert.throws(()=>db.workflows.requestClose(a.j.id,db.workflows.forConversation(a.c.id)!.revision,evidence),/./);
});
test('unlimited capacity runs independent workflows; finite capacity two and FIFO work without root exemption',t=>{
 const {db,job}=fixture(t,-1);const a=job(),b=job();db.updateJob(a.j.id,'running');db.updateJob(b.j.id,'running');assert.equal(db.workflows.list().filter(w=>w.state==='active').length,2);
 db.workflows.configure(2);const c=job();assert.throws(()=>db.updateJob(c.j.id,'running'),/WORKFLOW_LIMIT/);finish(db,a.j.id);db.updateJob(c.j.id,'running');
});
test('failed or cancelled attempts retain slot and cannot be archived; only unstarted task can directly cancel',t=>{
 const {db,job}=fixture(t);const a=job(),b=job();db.updateJob(a.j.id,'running');db.finishJob(a.j.id,a.c.id,'cancelled');db.workflows.settled(a.j.id);
 assert.throws(()=>db.workflows.cancelQueued(db.workflows.forConversation(a.c.id)!.id,a.c.user_id),/只有/);
 assert.throws(()=>db.sqlite.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(new Date().toISOString(),a.c.id),/先完成/);
 db.workflows.cancelQueued(db.workflows.forConversation(b.c.id)!.id,b.c.user_id);assert.equal(db.getJob(b.j.id)?.status,'cancelled');
});
test('completion requires all evidence, recorded deployments cannot masquerade as artifacts',t=>{
 const {db,job}=fixture(t);const a=job();db.updateJob(a.j.id,'running');let w=db.workflows.assertJob(a.j.id);
 assert.throws(()=>db.workflows.requestClose(a.j.id,w.revision,{...evidence,functionalVerified:false}),/必须全部/);
 db.workflows.trackRelease(a.j.id,'sample',123,'a'.repeat(40));w=db.workflows.assertJob(a.j.id);assert.throws(()=>db.workflows.requestClose(a.j.id,w.revision,evidence),/缺少/);
});
test('deployment evidence must match accepted and cleaned authoritative receipt',t=>{
 const {root}=fixture(t);const receipt={request:1,target_sha:'a'.repeat(40),phase:'cleaned',outcome:'accepted',evidence:{baseline_ok:true,functional_ok:true,session_revoked:true,cookie_rejected:true}};
 const proof={...evidence,kind:'deployment',releases:[{instance:'test',requestId:1,sha:'a'.repeat(40)}]};
 fs.writeFileSync(path.join(root,'1.json'),JSON.stringify(receipt));verifyWorkflowEvidence(proof,{test:root});
 fs.writeFileSync(path.join(root,'1.json'),JSON.stringify({...receipt,phase:'accepted'}));assert.throws(()=>verifyWorkflowEvidence(proof,{test:root}),/cleaned/);
 assert.throws(()=>verifyWorkflowEvidence(proof,{}),/未配置/);
});
test('external maintenance shares same slot and idempotency, no shadow queue',t=>{
 const {db,job}=fixture(t);const a=job();db.updateJob(a.j.id,'running');const e=db.workflows.external('external-key',a.c.user_id,'upgrade');assert.equal(e.state,'queued');assert.equal(db.workflows.external('external-key',a.c.user_id,'upgrade').id,e.id);
 finish(db,a.j.id);const claimed=db.workflows.external('external-key',a.c.user_id,'upgrade');assert.equal(claimed.state,'active');const b=job();assert.throws(()=>db.updateJob(b.j.id,'running'),/WORKFLOW_LIMIT/);db.workflows.closeExternal(e.id,claimed.revision,evidence);db.updateJob(b.j.id,'running');
});
test('HTTP workflow status/close scoped to live Job; list requires authentication',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-api-'));const secret='workflow-test-secret-with-more-than-32-characters';
 const app=createApp({projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),queueAutoStart:false,sessionSecret:secret,maxActiveWorkflows:1,minimumFreeDiskBytes:1});
 t.after(()=>{app.beginShutdown();app.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const c=app.db.createConversation(id(),'task');const j=app.db.createJob(id(),c.id,undefined,selection);app.db.updateJob(j.id,'running');
 const token=createJobAutomationToken(secret,j.id,c.id,Date.now(),86400000,app.db.workflows.assertJob(j.id).epoch);const url=`/api/automation/jobs/${j.id}/workflow`;
 await request(app.app).get('/api/workflows').expect(401);
 const status=await request(app.app).post(url).set('Authorization','Bearer '+token).send({action:'status'}).expect(200);
 await request(app.app).post(url).set('Authorization','Bearer '+token).send({action:'complete',revision:status.body.workflow.revision,evidence}).expect(200);
 assert.equal(app.db.workflows.forConversation(c.id)?.state,'closing');app.db.finishJob(j.id,c.id,'completed');app.db.workflows.settled(j.id);
 await request(app.app).post(url).set('Authorization','Bearer '+token).send({action:'status'}).expect(401);
});

test('same Job retry rejects an earlier run token before any automation side effects',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-epoch-'));const secret='workflow-test-secret-with-more-than-32-characters';
 const app=createApp({projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),queueAutoStart:false,sessionSecret:secret,maxActiveWorkflows:1,minimumFreeDiskBytes:1});
 t.after(()=>{app.beginShutdown();app.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const c=app.db.createConversation(id(),'task');const j=app.db.createJob(id(),c.id,undefined,selection);app.db.updateJob(j.id,'running');
 const old=createJobAutomationToken(secret,j.id,c.id,Date.now(),86400000,app.db.workflows.assertJob(j.id).epoch);
 app.db.updateJob(j.id,'queued');app.db.workflows.settled(j.id);app.db.updateJob(j.id,'running');
 const fresh=createJobAutomationToken(secret,j.id,c.id,Date.now(),86400000,app.db.workflows.assertJob(j.id).epoch);const url=`/api/automation/jobs/${j.id}/workflow`;
 await request(app.app).post(url).set('Authorization','Bearer '+old).send({action:'phase',phase:'stale'}).expect(401);
 await request(app.app).post(url).set('Authorization','Bearer '+fresh).send({action:'status'}).expect(200);
});

test('active workflow permits draft editing but protects conversation deletion and archiving',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-controls-'));
 const app=createApp({projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),queueAutoStart:false,maxActiveWorkflows:1,username:'fixture',passwordHash:bcrypt.hashSync('Workflow-Test-Password-2026!',8),sessionSecret:'workflow-test-secret-with-more-than-32-characters',minimumFreeDiskBytes:1});
 t.after(()=>{app.beginShutdown();app.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const agent=request.agent(app.app);const login=await agent.post('/api/auth/login').send({username:'fixture',password:'Workflow-Test-Password-2026!'}).expect(200);const csrf=login.body.csrfToken;
 const created=await agent.post('/api/conversations').set('X-CSRF-Token',csrf).expect(201);const c=created.body.conversation;
 const j=app.db.createJob(id(),c.id,undefined,selection);app.db.updateJob(j.id,'running');
 await agent.put(`/api/conversations/${c.id}/draft`).set('X-CSRF-Token',csrf).send({content:'补充要求'}).expect(200);
 await agent.delete(`/api/conversations/${c.id}`).set('X-CSRF-Token',csrf).expect(409);
 await agent.post(`/api/conversations/${c.id}/archive`).set('X-CSRF-Token',csrf).expect(409);
});

test('real queue pump retains closing owner until runner returns, then launches exactly one follower',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-pump-'));
 const app=createApp({projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),queueAutoStart:false,maxActiveWorkflows:1,minimumFreeDiskBytes:1});
 t.after(()=>{app.beginShutdown();app.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const jobs=[0,1,2].map(()=>{const c=app.db.createConversation(id(),'modify');const m=id();app.db.addMessage({id:m,conversation_id:c.id,role:'user',content:'verify',created_at:new Date().toISOString()});return app.db.createJob(id(),c.id,m,selection);});
 const started:string[]=[];const exits=new Map<string,()=>void>();
 app.runner.run=async(jobId,conversationId)=>{started.push(jobId);const w=app.db.workflows.assertJob(jobId);app.db.workflows.requestClose(jobId,w.revision,evidence);app.db.finishJob(jobId,conversationId,'completed');await new Promise<void>(r=>exits.set(jobId,r));};
 await app.pumpQueue();assert.deepEqual(started,[jobs[0].id]);await app.pumpQueue();assert.equal(started.length,1);
 exits.get(jobs[0].id)!();for(let i=0;i<30&&started.length<2;i++)await new Promise(r=>setImmediate(r));assert.deepEqual(started,jobs.slice(0,2).map(j=>j.id));
 exits.get(jobs[1].id)!();for(let i=0;i<30&&started.length<3;i++)await new Promise(r=>setImmediate(r));assert.deepEqual(started,jobs.map(j=>j.id));
 exits.get(jobs[2].id)!();await app.waitForBackgroundTasks();assert.ok(jobs.every(j=>app.db.workflows.forEntity('job',j.id)?.state==='completed'));
});

test('thirty-minute durable wait retains capacity across restart and resumes its original workflow',t=>{
 const {db,root,job}=fixture(t);const a=job(),b=job();db.updateJob(a.j.id,'running');
 const owner=db.workflows.assertJob(a.j.id).id;
 const now=Date.now();
 const plan=db.createWakePlan({id:id(),conversationId:a.c.id,createdByJobId:a.j.id,mode:'time',label:'30-minute acceptance wait',deadlineAt:new Date(now+30*60_000).toISOString(),successPrompt:'verify',failurePrompt:'verify',timeoutPrompt:'verify',selection});
 db.finishJob(a.j.id,a.c.id,'completed');db.workflows.settled(a.j.id);
 const reopened=new AppDatabase(root,undefined,false);
 try {assert.equal(reopened.workflows.forConversation(a.c.id)!.id,owner);assert.throws(()=>reopened.updateJob(b.j.id,'running'),/WORKFLOW_LIMIT/);}finally{reopened.close();}
 t.mock.timers.enable({apis:['Date'],now:now+31*60_000});
 assert.throws(()=>db.updateJob(b.j.id,'running'),/WORKFLOW_LIMIT/);
 const triggered=db.recordWakeEvent(plan.id,'after-thirty-minutes','deadline',null,id());
 const resumed=db.materializePendingPrompt(triggered.pendingPrompt!.id,id(),id())!;db.updateJob(resumed.id,'running');
 assert.equal(db.workflows.assertJob(resumed.id).id,owner);finish(db,resumed.id);db.updateJob(b.j.id,'running');
});

test('transport loss never settles ownership or admits a replacement, including unlimited mode',t=>{
 const {db,job}=fixture(t,-1);const a=job(),b=job();db.updateJob(a.j.id,'running');
 const owner=db.workflows.assertJob(a.j.id).id;
 db.workflows.executionUncertain(a.j.id,'worker connection lost; exit unverified');
 db.finishJob(a.j.id,a.c.id,'interrupted');db.workflows.settled(a.j.id);
 const replacement=job(a.c.id);
 assert.ok(db.workflows.block(a.c.id));assert.throws(()=>db.updateJob(replacement.j.id,'running'),/WORKFLOW_EXECUTOR_UNSETTLED/);
 db.updateJob(b.j.id,'running'); // Independent work remains parallel.
 const reopenedRun=db.sqlite.prepare('SELECT settled FROM workflow_runs WHERE job_id=?').get(a.j.id);
 assert.equal(reopenedRun!.settled,0);
 db.workflows.recover(owner,'operator verified actual worker process and descendants exited');
 db.updateJob(replacement.j.id,'running');assert.ok(db.workflows.assertJob(replacement.j.id));
});

test('B migration number normalization preserves workflow rows and is idempotent',t=>{
 const {db,job}=fixture(t);const a=job();db.updateJob(a.j.id,'running');const w=db.workflows.assertJob(a.j.id);
 db.sqlite.prepare('DELETE FROM schema_migrations WHERE version=2026110701').run();
 db.sqlite.prepare('UPDATE schema_migrations SET version=2026110701 WHERE version=2026110802').run();
 WorkflowStore.normalizeLegacyMigration(db.sqlite);WorkflowStore.normalizeLegacyMigration(db.sqlite);
 assert.equal(db.workflows.assertJob(a.j.id).id,w.id);
 assert.equal(db.sqlite.prepare('SELECT name FROM schema_migrations WHERE version=2026110802').get()!.name,'durable-complete-workflows');
 assert.equal(db.sqlite.prepare('SELECT name FROM schema_migrations WHERE version=2026110701').get(),undefined);
});

test('unlimited mode rejects epochless credentials for new attempts but preserves adopted epoch-zero tokens',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-legacy-token-'));const secret='workflow-test-secret-with-more-than-32-characters';
 const app=createApp({projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),queueAutoStart:false,sessionSecret:secret,maxActiveWorkflows:-1,minimumFreeDiskBytes:1});
 t.after(()=>{app.beginShutdown();app.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const c=app.db.createConversation(id(),'task'),j=app.db.createJob(id(),c.id,undefined,selection);app.db.updateJob(j.id,'running');
 const token=createJobAutomationToken(secret,j.id,c.id),url=`/api/automation/jobs/${j.id}/workflow`;
 await request(app.app).post(url).set('Authorization','Bearer '+token).send({action:'status'}).expect(401);
 // Model the persisted run adopted from a pre-upgrade Worker.
 app.db.sqlite.prepare('UPDATE workflows SET epoch=0 WHERE id=?').run(app.db.workflows.forEntity('job',j.id)!.id);
 app.db.sqlite.prepare('UPDATE workflow_runs SET epoch=0 WHERE job_id=?').run(j.id);
 await request(app.app).post(url).set('Authorization','Bearer '+token).send({action:'status'}).expect(200);
});
