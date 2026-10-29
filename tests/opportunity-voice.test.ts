import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppDatabase, LEGACY_USER_ID as user } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { OpportunityStore, contentInput } from '../server/opportunity-store.js';
import { OpportunityVoiceService } from '../server/opportunity-voice.js';
import { TranscriptionService } from '../server/transcription.js';
import { resolveVoiceRecordingPath } from '../server/voice-recording.js';
const id=()=>crypto.randomUUID();
function seed(db:AppDatabase,root:string){
 const store=new OpportunityStore(db),project=db.createProject(id(),user,'Test',root,'tenant-local');
 const conversation=db.createConversation(id(),'Test',{model:'gpt-test',reasoningEffort:'low'},user,project.id);
 const topic=store.createTopic(user,{name:'Voice test',project_id:project.id,goal:'Regression'},id()),batch=store.begin(user,topic.id,conversation.id,null);
 const content=contentInput.parse({title:'Test',summary:'Test',audience:'Test',problem:'Test',mechanism:'Test',value:'Test',fit:'Test',facts:'Test',assumptions:'Test',doubt:'Test',validation:'Test',difference:'Test',category:'Test',keywords:['Test'],sources:[]});
 const idea=store.ingest(user,batch.id,conversation.id,[{key:'test',content}])[0]!.idea;
 return {store,idea};
}
function fixture(t:test.TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'opportunity-voice-')),config=loadConfig({dataRoot:root+'/data',tenantRoot:root+'/tenants',queueAutoStart:false});fs.mkdirSync(config.dataRoot,{recursive:true});
 const db=new AppDatabase(config.dataRoot,undefined,false),{store,idea}=seed(db,root),audioRoot=root+'/audio';fs.mkdirSync(audioRoot);
 const filePath=root+'/input.webm';fs.writeFileSync(filePath,'test audio');
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const input={user,ideaId:idea.id,recordingId:id(),filePath,mimeType:'audio/webm',draftText:'typed input',maximumBytes:1e7};
 return {root,config,db,store,idea,audioRoot,input};
}
for(const action of ['kept','later','dismissed'])test(`uploaded voice survives ${action}, appends once and preserves latest rating and note`,async t=>{
 const f=fixture(t);let resolve!:(s:string)=>void;
 const service=new OpportunityVoiceService(f.config,f.db,{audioRoot:f.audioRoot,transcribe:()=>new Promise(r=>{resolve=r;})});
 const accepted=service.accept(f.input),running=service.pump();
 assert.equal(service.accept(f.input).id,accepted.id);assert.throws(()=>service.accept({...f.input,ideaId:id()}));
 assert.throws(()=>service.accept({...f.input,draftText:'different'}),/不同内容/);
 f.store.feedback(user,f.idea.id,{requestKey:id(),revision:f.idea.revision,action,rating:4,note:'edited while recognizing'});
 resolve('recognized speech');await running;
 const final=f.store.detail(user,f.idea.id);
 assert.equal(final.idea.state,action);assert.equal(final.idea.rating,4);assert.equal(final.idea.note,'edited while recognizing\nrecognized speech');assert.equal(final.voiceFeedback[0].state,'completed');
 await service.pump();assert.equal(f.store.detail(user,f.idea.id).feedback.filter(v=>v.actor==='user-voice').length,1);
 assert.equal(f.store.feedbackInbox(user,f.idea.topic_id).pending,2);
});
test('recognition winning the click race rebases speech, but not concurrent manual edits; undo retains speech',async t=>{
 const f=fixture(t),service=new OpportunityVoiceService(f.config,f.db,{audioRoot:f.audioRoot,transcribe:async()=> 'speech'});
 service.accept(f.input);await service.pump();
 const kept=f.store.feedback(user,f.idea.id,{requestKey:id(),revision:f.idea.revision,action:'kept',rating:5,note:'new typing'});
 assert.equal(kept.note,'new typing\nspeech');assert.equal(kept.state,'kept');
 assert.throws(()=>f.store.feedback(user,f.idea.id,{requestKey:id(),revision:f.idea.revision,action:'dismissed'}),/卡片已更新/);
 const next=service.accept({...f.input,recordingId:id(),draftText:kept.note});await service.pump();
 const undone=f.store.feedback(user,f.idea.id,{requestKey:id(),revision:kept.revision,action:'undo'});
 assert.equal(undone.state,f.idea.state);assert.equal(undone.note,'typed input\nspeech\nspeech');assert.equal(f.store.voiceFeedback(user,f.idea.id).find(v=>v.id===next.id)?.state,'completed');
});
test('restart resumes durable uploads; failed audio is retained, ownership enforced, retry can reuse recognized text after length repair',async t=>{
 const f=fixture(t);let calls=0,fail=true;
 const transcription={audioRoot:f.audioRoot,transcribe:async()=>{calls++;if(fail)throw new Error('provider failed');return 'speech';}};
 const first=new OpportunityVoiceService(f.config,f.db,transcription),accepted=first.accept({...f.input,draftText:'x'.repeat(6000)});
 f.db.sqlite.prepare("UPDATE opportunity_voice_feedback SET state='processing'").run();first.stop();
 const reopened=new AppDatabase(f.config.dataRoot,undefined,false);
 try{
  const recovered=new OpportunityVoiceService(f.config,reopened,transcription);await recovered.pump();
  const row=reopened.sqlite.prepare('SELECT audio_json FROM opportunity_voice_feedback WHERE id=?').get(accepted.id) as {audio_json:string};
  assert.ok(fs.existsSync(resolveVoiceRecordingPath(f.config.dataRoot,JSON.parse(row.audio_json).relativePath)));
  assert.throws(()=>recovered.retry(id(),f.idea.id,accepted.id));fail=false;recovered.retry(user,f.idea.id,accepted.id);await recovered.pump();
  assert.equal(f.store.voiceFeedback(user,f.idea.id)[0].state,'failed');assert.equal(f.store.voiceFeedback(user,f.idea.id)[0].transcript,'speech');
  const current=f.store.idea(user,f.idea.id);f.store.feedback(user,f.idea.id,{requestKey:id(),revision:current.revision,action:'rate',note:'shortened'});
  recovered.retry(user,f.idea.id,accepted.id);await recovered.pump();assert.equal(calls,2);assert.equal(f.store.idea(user,f.idea.id).note,'shortened\nspeech');
  assert.equal(fs.existsSync(resolveVoiceRecordingPath(f.config.dataRoot,JSON.parse(row.audio_json).relativePath)),false);
 }finally{reopened.close();}
});
test('real multipart route acknowledges before recognition, checks CSRF/owner, persists decisions and background result',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'opportunity-voice-api-'));let resolve!:(s:string)=>void;const deferred=new Promise<string>(r=>resolve=r);
 t.mock.method(TranscriptionService.prototype,'transcribe',()=>deferred);
 const app=createApp({projectRoot:process.cwd(),dataRoot:root+'/data',tenantRoot:root+'/tenants',username:'pp',passwordHash:bcrypt.hashSync('test',4),sessionSecret:'opportunity-voice-secret-atleast32characters',queueAutoStart:false,minimumFreeDiskBytes:0});
 t.after(async()=>{resolve('speech');app.beginShutdown();await app.waitForBackgroundTasks();app.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const {idea}=seed(app.db,root),agent=request.agent(app.app),login=await agent.post('/api/auth/login').send({username:'pp',password:'test'}).expect(200),csrf=login.body.csrfToken;
 const url='/api/opportunities/ideas/'+idea.id+'/voice-feedback';
 await agent.post(url).expect(403);
 const send=(target:string)=>agent.post(target).set('X-CSRF-Token',csrf).field('clientRecordingId',id()).field('draftText','typed').attach('audio',Buffer.from('fake audio'),{filename:'voice.webm',contentType:'audio/webm'});
 await send('/api/opportunities/ideas/'+id()+'/voice-feedback').expect(404);
 const accepted=await send(url).expect(202);assert.equal(accepted.body.accepted,true);
 await agent.post('/api/opportunities/ideas/'+idea.id+'/feedback').set('X-CSRF-Token',csrf).send({requestKey:id(),revision:idea.revision,action:'dismissed',rating:3,note:'typed'}).expect(200);
 resolve('speech');await app.opportunityVoice.wait();
 const result=await agent.get('/api/opportunities/ideas/'+idea.id).expect(200);assert.equal(result.body.idea.state,'dismissed');assert.equal(result.body.idea.note,'typed\nspeech');
 assert.equal(result.body.voiceFeedback[0].state,'completed');assert.equal(result.body.voiceFeedback[0].audio_json,undefined);
});

for(const arrival of ['before-first-completes','after-first-completes'])test(`parallel recordings keep prior speech and the latest draft when second arrives ${arrival}`,async t=>{
 const f=fixture(t);let n=0;
 const service=new OpportunityVoiceService(f.config,f.db,{audioRoot:f.audioRoot,transcribe:async()=>++n===1?'first speech':'second speech'});
 const first={...f.input,baseRevision:f.idea.revision,draftText:'first draft'},second={...f.input,recordingId:id(),baseRevision:f.idea.revision,draftText:'updated draft'};
 service.accept(first);
 if(arrival==='after-first-completes')await service.pump();
 const accepted=service.accept(second);await service.pump();
 const result=f.store.detail(user,f.idea.id);
 assert.equal(result.idea.note,'updated draft\nfirst speech\nsecond speech');assert.equal(result.voiceFeedback.length,2);assert.equal(result.feedback.filter(v=>v.actor==='user-voice').length,2);
 assert.equal(service.accept(second).id,accepted.id);assert.throws(()=>service.accept({...second,baseRevision:second.baseRevision+1}),/不同内容/);
 assert.throws(()=>service.accept({...second,recordingId:id(),baseRevision:999}),/版本无效/);
});

test('late uploads with a recording baseline preserve manual edits, decisions and earlier speech',async t=>{
 const f=fixture(t),service=new OpportunityVoiceService(f.config,f.db,{audioRoot:f.audioRoot,transcribe:async()=> 'speech'});
 const recording={...f.input,baseRevision:f.idea.revision};
 f.store.feedback(user,f.idea.id,{requestKey:id(),revision:f.idea.revision,action:'dismissed',note:'manual replacement'});
 service.accept(recording);await service.pump();
 service.accept({...recording,recordingId:id()});await service.pump();
 assert.equal(f.store.idea(user,f.idea.id).note,'manual replacement\nspeech\nspeech');assert.equal(f.store.idea(user,f.idea.id).state,'dismissed');
});

test('voice baseline migration preserves legacy queued audio and is repeatable',async t=>{
 const f=fixture(t),old=new OpportunityVoiceService(f.config,f.db,{audioRoot:f.audioRoot,transcribe:async()=> 'unused'});
 const accepted=old.accept(f.input);old.stop();
 f.db.sqlite.exec('ALTER TABLE opportunity_voice_feedback DROP COLUMN base_revision');
 f.db.sqlite.prepare('DELETE FROM schema_migrations WHERE version=?').run(2026102901);
 const reopened=new AppDatabase(f.config.dataRoot,undefined,false);
 try{
  assert.equal((reopened.sqlite.prepare('SELECT base_revision FROM opportunity_voice_feedback WHERE id=?').get(accepted.id) as {base_revision:null}).base_revision,null);
  const migrated=new OpportunityVoiceService(f.config,reopened,{audioRoot:f.audioRoot,transcribe:async()=> 'legacy speech'});await migrated.pump();
  assert.equal(f.store.idea(user,f.idea.id).note,'typed input\nlegacy speech');assert.equal(f.store.voiceFeedback(user,f.idea.id)[0].state,'completed');
  const again=new AppDatabase(f.config.dataRoot,undefined,false);try{assert.equal(again.sqlite.prepare('SELECT count(*) n FROM schema_migrations WHERE version=2026102901').get()?.n,1);assert.deepEqual(again.sqlite.prepare('pragma foreign_key_check').all(),[]);}finally{again.close();}
 }finally{reopened.close();}
});

test('research/state-only revisions do not discard unsaved typing when parallel voices complete',async t=>{
 const f=fixture(t),service=new OpportunityVoiceService(f.config,f.db,{audioRoot:f.audioRoot,transcribe:async()=> 'speech'});
 const recording={...f.input,baseRevision:f.idea.revision};
 f.db.sqlite.prepare('UPDATE opportunity_ideas SET revision=revision+1,manual_processed=1 WHERE id=?').run(f.idea.id);
 service.accept(recording);await service.pump();
 service.accept({...recording,recordingId:id(),draftText:'latest unsaved typing'});await service.pump();
 assert.equal(f.store.idea(user,f.idea.id).note,'latest unsaved typing\nspeech\nspeech');
});
