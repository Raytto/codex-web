import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installRecorder } from './fixtures/recorder.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=process.env.CWW_BROWSER_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'background-report-'));
fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-ui-')),require=createRequire(repo+'/package.json');
const {createApp}=await import(repo+'/dist-server/server/app.js');
const {OpportunityStore,contentInput}=await import(repo+'/dist-server/server/opportunity-store.js');
const {TranscriptionService}=await import(repo+'/dist-server/server/transcription.js');
// Transport, persistence and UI are real; microphone and ASR are controlled here.
let failRecognition=false;
TranscriptionService.prototype.transcribe=async(_name,options)=>{if(failRecognition){failRecognition=false;throw new Error('Controlled recognition failure');}return '语音-'+options.draftText;};
const cache=process.env.PLAYWRIGHT_BROWSERS_PATH||path.join(os.homedir(),'.cache/ms-playwright');
const playwrightRoot=process.env.PLAYWRIGHT_MODULE_PATH||fs.readdirSync(cache+'/.links').map(n=>fs.readFileSync(cache+'/.links/'+n,'utf8').trim()).find(p=>fs.existsSync(p+'/index.mjs'));
process.env.PLAYWRIGHT_BROWSERS_PATH=cache;
const {chromium}=await import(playwrightRoot+'/index.mjs');
const instance=createApp({projectRoot:repo,dataRoot:root+'/data',tenantRoot:root+'/tenants',username:'opportunity-fixture',passwordHash:require('bcryptjs').hashSync('background-test',4),sessionSecret:'background-test-secret-at-least32',basePath:'/codex-web',queueAutoStart:false,minimumFreeDiskBytes:0});
const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const origin='http://127.0.0.1:'+server.address().port+'/codex-web',report={checks:[],pageErrors:[]};
let browser,page;const held=[];let mode='hold';let received=0;
const deadline=setTimeout(()=>{throw new Error('Background uploads test deadline');},180000);
try{
 browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--disable-dev-shm-usage'],args:['--disable-gpu'],env:{...process.env,TMPDIR:root}});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await installRecorder(context,Buffer.from('synthetic local audio').toString('base64'));
 const login=await context.request.post(origin+'/api/auth/login',{data:{username:'opportunity-fixture',password:'background-test'}});assert.equal(login.status(),200);const session=await login.json();
 const api=async(method,url,data)=>{const r=await context.request.fetch(origin+'/api'+url,{method,headers:{Origin:new URL(origin).origin,'X-CSRF-Token':session.csrfToken},...(data===undefined?{}:{data})});assert.ok(r.ok(),url+': '+r.status());return r.status()===204?null:r.json();};
 const prefs=await api('GET','/user-settings/features');await api('PUT','/user-settings/features',{...prefs,opportunityCards:true});
 const project=(await api('GET','/projects')).projects.find(p=>p.executor_id==='tenant-local');
 const store=new OpportunityStore(instance.db),topic=store.createTopic(session.accountId,{name:'后台上传测试',project_id:project.id,goal:'验证并发录音归属'},crypto.randomUUID());
 const c=instance.db.createConversation(crypto.randomUUID(),'Upload test',{model:'fixture-model',reasoningEffort:'medium'},session.accountId,project.id),batch=store.begin(session.accountId,topic.id,c.id,null);
 const cards=[0,1].map(n=>{const content=contentInput.parse({title:'后台卡片 '+n,summary:'测试反馈 '+n,audience:'测试',problem:'并行上传 '+n,mechanism:'独立队列 '+n,value:'测试',fit:'小型',facts:'合成',assumptions:'测试',doubt:'测试',validation:'并行',difference:'独立 '+n,category:'测试',keywords:['测试'+n],sources:[]});const idea=store.ingest(session.accountId,batch.id,c.id,[{key:'card-'+n,content}])[0].idea;return idea;});
 for(const idea of cards)store.feedback(session.accountId,idea.id,{requestKey:crypto.randomUUID(),revision:idea.revision,action:'kept'});
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.pageErrors.push(String(e)));
 const workspace=()=>page.locator('.opportunity-workspace:visible'),dialog=()=>page.getByRole('dialog');
 const until=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await page.waitForTimeout(50);}throw new Error('Background condition timed out');};
 const goTopic=async()=>{if(page.viewportSize().width<=720&&!await page.locator('.sidebar').evaluate(e=>e.classList.contains('open')))await page.getByRole('button',{name:'打开侧栏',exact:true}).first().click();await page.getByRole('region',{name:'机会卡片',exact:true}).locator(`[data-opportunity-topic="${topic.id}"] .project-select`).click();await workspace().getByRole('navigation',{name:'已处理卡片总览'}).getByRole('button',{name:/^已保留/}).click();};
 const open=async n=>{await workspace().locator(`[data-opportunity-idea="${cards[n].id}"]`).getByRole('button',{name:'查看详情',exact:true}).click();await dialog().getByRole('textbox',{name:'反馈（可选）'}).waitFor();};
 const record=async text=>{if(text!==undefined)await dialog().getByRole('textbox',{name:'反馈（可选）'}).fill(text);await dialog().getByRole('button',{name:'语音输入',exact:true}).click();await dialog().getByRole('button',{name:'停止录音并识别',exact:true}).click();await until(async()=>dialog().getByRole('button',{name:'保留',exact:true}).isEnabled());};
 await page.route('**/api/opportunities/ideas/*/voice-feedback',async route=>{
   received++;
   if(mode==='hold'){await new Promise(resolve=>held.push(resolve));await route.continue();}
   else if(mode==='drop-response'){await route.fetch();await route.abort('failed');}
   else if(mode==='fail'){await route.abort('failed');}
   else await route.continue();
 });
 await page.goto(origin);await page.locator('[data-extension-group="opportunities"] .extension-toggle').click();await goTopic();await page.setViewportSize({width:390,height:844});
 await open(0);await record('A');await until(()=>received===1);
 assert.equal(store.voiceFeedback(session.accountId,cards[0].id).length,0);
 await dialog().getByRole('button',{name:'保留',exact:true}).click();await dialog().waitFor({state:'hidden'});
 await open(1);await record('B');await until(()=>received===2);
 await dialog().getByRole('button',{name:'淘汰',exact:true}).click();await dialog().waitFor({state:'hidden'});
 await open(0);await record();await until(()=>received===3);await dialog().getByRole('button',{name:'关闭弹窗',exact:true}).click();await dialog().waitFor({state:'hidden'});
 assert.equal(await workspace().getByRole('region',{name:'语音上传队列'}).getByRole('status').filter({hasText:'正在上传'}).count(),3);
 assert.equal(store.idea(session.accountId,cards[1].id).state,'dismissed');
 report.checks.push('keep_dismiss_and_close_before_server_acceptance_with_three_parallel_uploads_two_on_one_card');
 for(const resolve of held.splice(0))resolve();mode='pass';
 await until(()=>cards.every(card=>store.voiceFeedback(session.accountId,card.id).every(v=>v.state==='completed'))&&store.voiceFeedback(session.accountId,cards[0].id).length===2&&store.voiceFeedback(session.accountId,cards[1].id).length===1);
 assert.equal(store.idea(session.accountId,cards[0].id).note,'A\n语音-A\n语音-A');assert.equal(store.idea(session.accountId,cards[1].id).note,'B\n语音-B');assert.equal(store.idea(session.accountId,cards[1].id).state,'dismissed');
 report.checks.push('completion_appends_once_to_original_cards_without_reversing_decisions');
 await open(0);mode='drop-response';await record('lost response');await dialog().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试上传',exact:true}).waitFor();await dialog().getByRole('button',{name:'关闭弹窗',exact:true}).click();
 await until(()=>store.voiceFeedback(session.accountId,cards[0].id).length===3&&store.voiceFeedback(session.accountId,cards[0].id).every(v=>v.state==='completed'));
 mode='pass';await workspace().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试上传',exact:true}).click();await until(async()=>await workspace().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试上传',exact:true}).count()===0);
 assert.equal(store.voiceFeedback(session.accountId,cards[0].id).length,3);assert.equal(store.idea(session.accountId,cards[0].id).note.split('语音-lost response').length-1,1);
 report.checks.push('lost_acknowledgement_retries_same_recording_without_duplicate_feedback');
 mode='fail';await open(0);await record('recover one');await dialog().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试上传',exact:true}).waitFor();await record('recover two');await until(async()=>await dialog().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试上传',exact:true}).count()===2);
 await page.reload();await page.locator('[data-extension-group="opportunities"] .extension-toggle').waitFor({state:'attached'});await goTopic();
 await until(async()=>await workspace().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试上传',exact:true}).count()===2);
 mode='pass';await workspace().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试上传',exact:true}).first().click();await workspace().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试上传',exact:true}).first().click();
 await until(()=>store.voiceFeedback(session.accountId,cards[0].id).length===5&&store.voiceFeedback(session.accountId,cards[0].id).every(v=>v.state==='completed'));
 await until(async()=>await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('codex-web-voice-drafts');r.onsuccess=()=>{const db=r.result,q=db.transaction('drafts').objectStore('drafts').getAll();q.onsuccess=()=>{db.close();resolve(q.result.filter(v=>v.scope.startsWith('opportunity-upload:')).length===0);};q.onerror=reject;};r.onerror=reject;})));
 report.checks.push('all_failed_recordings_survive_reload_and_retry_individually_then_release_local_audio');
 await open(0);failRecognition=true;await record('retry status');await dialog().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试识别或保存',exact:true}).waitFor();await dialog().getByRole('button',{name:'关闭弹窗',exact:true}).click();
 let releaseStatus,staleCaptured=false;const staleStatus=new Promise(resolve=>releaseStatus=resolve);let intercept=true;
 await page.route('**/api/opportunities/ideas/'+cards[0].id,async route=>{const response=await route.fetch();if(intercept){intercept=false;staleCaptured=true;await staleStatus;}await route.fulfill({response});});
 await page.evaluate(()=>window.dispatchEvent(new Event('opportunities-updated')));await until(()=>staleCaptured);
 await workspace().getByRole('region',{name:'语音上传队列'}).getByRole('button',{name:'重试识别或保存',exact:true}).click();
 await until(()=>store.voiceFeedback(session.accountId,cards[0].id).length===6&&store.voiceFeedback(session.accountId,cards[0].id).every(v=>v.state==='completed'));
 releaseStatus();await until(async()=>await workspace().getByRole('region',{name:'语音上传队列'}).getByRole('status').filter({hasText:'反馈已保存'}).count()===3);
 await page.unroute('**/api/opportunities/ideas/'+cards[0].id);
 report.checks.push('stale_failed_status_response_cannot_override_a_new_recognition_retry');

 for(const width of [320,390,768,1440])for(const theme of ['light','dark']){await page.setViewportSize({width,height:900});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);assert.ok(await workspace().evaluate(e=>e.scrollWidth<=e.clientWidth));}
 await page.evaluate(()=>document.documentElement.style.fontSize='200%');assert.ok(await workspace().evaluate(e=>e.scrollWidth<=e.clientWidth));
 report.checks.push('queue_and_kept_entry_fit_mobile_desktop_both_themes_and_200_percent_text');assert.deepEqual(report.pageErrors,[]);report.ok=true;
}finally{
 clearTimeout(deadline);for(const resolve of held)resolve();fs.writeFileSync(output+'/result.json',JSON.stringify(report,null,2));await browser?.close();instance.beginShutdown();await new Promise(r=>server.close(r));instance.db.close();fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify(report));
}
