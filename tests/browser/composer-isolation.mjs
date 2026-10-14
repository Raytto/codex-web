import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installRecorder } from './fixtures/recorder.mjs';
const base = process.env.CWW_BROWSER_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'composer-isolation-report-'));
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(repo + '/package.json');
const bcrypt = require('bcryptjs');
const { createApp } = await import(repo + '/dist-server/server/app.js');
const { TranscriptionService } = await import(repo + '/dist-server/server/transcription.js');
const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache/ms-playwright');
const playwrightRoot = process.env.PLAYWRIGHT_MODULE_PATH || fs.readdirSync(path.join(browserCache, '.links')).map(n => fs.readFileSync(path.join(browserCache, '.links', n), 'utf8').trim()).find(p => fs.existsSync(p + '/index.mjs'));
process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
const { chromium } = await import(playwrightRoot + '/index.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-ui-'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const proof=deferred();
TranscriptionService.prototype.transcribe=async (_file,context)=>context.draftText==='proof A'?proof.promise:'recognized fixture';
const instance=createApp({projectRoot:repo,dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),codexHome:path.join(root,'codex-home'),pythonRuntimeRoot:path.join(root,'python'),hostRootSocketPath:'',hostTenantRoot:'',hostKnowledgeRoot:'',personalMemoryApiKey:'',personalMemoryBaseUrl:'',dashscopeApiKey:'',dashscopeBaseUrl:'',username:'owner',passwordHash:bcrypt.hashSync('local-test',4),sessionSecret:'isolation-test-secret-atleast32bytes',queueAutoStart:false,basePath:'/codex-web'});
const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port+'/codex-web';
const deadline=setTimeout(()=>{throw new Error('Composer regression timed out');},180000);
let browser,page;const report={checks:[],errors:[]};const gates=[];
try {
 browser=await chromium.launch({headless:true,args:['--disable-gpu'],env:{...process.env,HOME:root,TMPDIR:root}});
 const context=await browser.newContext({viewport:{width:1440,height:900}});await installRecorder(context,Buffer.from('isolated browser recorder fixture').toString('base64'));
 const login=await context.request.post(origin+'/api/auth/login',{data:{username:'owner',password:'local-test'}});assert.equal(login.status(),200);const session=await login.json();
 const api=async(method,url,data)=>{const r=await context.request.fetch(origin+'/api'+url,{method,headers:{Origin:origin,'X-CSRF-Token':session.csrfToken},...(data===undefined?{}:{data})});assert.ok(r.ok(),url+':'+r.status());return r.status()===204?null:r.json();};
 const project=(await api('GET','/projects')).projects.find(p=>p.is_default);const conv=[];
 for(const name of ['isolation A','isolation B']){const c=(await api('POST','/conversations',{projectId:project.id,reuseEmpty:false})).conversation;await api('PATCH','/conversations/'+c.id,{title:name});conv.push(c.id);}
 const [a,b]=conv;page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto(origin);const auth=await(await context.request.get(origin+'/api/auth/session')).json();await page.evaluate(({account,project,a})=>{localStorage.setItem(`cww:account:${encodeURIComponent(account)}:selected-project`,project);localStorage.setItem(`cww:account:${encodeURIComponent(account)}:selected-conversation`,a);},{account:auth.accountId,project:project.id,a});await page.reload();
 const composer=()=>page.locator('.composer:visible');const input=()=>composer().locator('textarea');
 const select=async(name)=>{if(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).transform!=='none').catch(()=>false)){const toggle=page.getByRole('button',{name:'打开侧栏',exact:true});if(await toggle.isVisible().catch(()=>false))await toggle.click();}await page.locator('.conversation-select').filter({hasText:name}).click();await input().waitFor();};
 const hold=async(pattern)=>{const gate=deferred(),started=deferred(),ended=deferred();gates.push(gate);await page.route(pattern,async route=>{started.resolve();await gate.promise;try{await route.continue();}finally{ended.resolve();}});return {gate,started,ended};};
 const waitEmpty=()=>page.waitForFunction(()=>{const e=[...document.querySelectorAll('.composer textarea')].find(e=>e.getClientRects().length);return e?.value===''&&!e.disabled;});
 // Both text requests remain in flight independently; A's completion cannot unlock B.
 const ta=await hold('**/conversations/'+a+'/messages'),tb=await hold('**/conversations/'+b+'/messages');
 await input().fill('text A');await composer().getByRole('button',{name:'发送',exact:true}).click();await ta.started.promise;
 await select('isolation B');assert.equal(await input().inputValue(),'');assert.equal(await input().isEnabled(),true);await input().fill('text B');await composer().getByRole('button',{name:'发送',exact:true}).click();await tb.started.promise;
 ta.gate.resolve();await page.waitForResponse(r=>r.url().endsWith('/'+a+'/messages'));assert.equal(await input().inputValue(),'text B');assert.equal(await input().isDisabled(),true);
 tb.gate.resolve();await waitEmpty();report.checks.push('parallel_text_send_locks_and_completions_isolated');await page.unroute('**/conversations/*/messages');
 // A held voice upload must not occupy B's microphone or B's draft.
 await select('isolation A');const va=await hold('**/conversations/'+a+'/voice-messages');await input().fill('voice A');await composer().getByRole('button',{name:'录音输入',exact:true}).click();await composer().getByRole('button',{name:'发送语音',exact:true}).click();await va.started.promise;
 await page.locator('.conversation-select').filter({hasText:'isolation A'}).getByRole('img',{name:'正在上传到服务器'}).waitFor();
 await select('isolation B');await waitEmpty();await input().fill('voice B');await composer().getByRole('button',{name:'录音输入',exact:true}).click();const bAck=page.waitForResponse(r=>r.url().endsWith('/'+b+'/voice-messages'));await composer().getByRole('button',{name:'发送语音',exact:true}).click();assert.equal((await bAck).status(),202);await waitEmpty();await input().fill('new B draft');
 const aAck=page.waitForResponse(r=>r.url().endsWith('/'+a+'/voice-messages'));va.gate.resolve();assert.equal((await aAck).status(),202);await instance.waitForBackgroundTasks();assert.equal(await input().inputValue(),'new B draft');
 await select('isolation A');await waitEmpty();report.checks.push('A_voice_upload_B_independent_recording','late_voice_ack_does_not_clear_B','upload_indicator_tracks_origin');await page.unroute('**/conversations/'+a+'/voice-messages');
 // Uploads remain visible on return, and complete into their own draft only.
 const fa=await hold('**/conversations/'+a+'/draft/files');await composer().locator('input[type=file]').setInputFiles({name:'A-file.txt',mimeType:'text/plain',buffer:Buffer.from('A')});await fa.started.promise;
 await select('isolation B');assert.equal(await composer().getByText('A-file.txt',{exact:true}).count(),0);await composer().locator('input[type=file]').setInputFiles({name:'B-file.txt',mimeType:'text/plain',buffer:Buffer.from('B')});await composer().getByText('B-file.txt',{exact:true}).waitFor();
 await select('isolation A');await composer().getByText('A-file.txt',{exact:true}).waitFor();fa.gate.resolve();await page.waitForResponse(r=>r.url().endsWith('/'+a+'/draft/files'));await select('isolation B');assert.equal(await input().inputValue(),'new B draft');assert.equal(await composer().getByText('A-file.txt',{exact:true}).count(),0);report.checks.push('parallel_file_uploads_and_return_progress_isolated');
 // The proofreading route still runs in A while B can type and record.
 await select('isolation A');await input().fill('proof A');await composer().getByRole('button',{name:'录音输入',exact:true}).click();await composer().getByRole('button',{name:'停止录音并识别',exact:true}).click();await composer().getByText('正在识别语音…',{exact:true}).waitFor();
 await select('isolation B');assert.equal(await input().isEnabled(),true);await input().fill('B while A recognizes');proof.resolve('proofread result');await instance.waitForBackgroundTasks();await select('isolation A');await page.waitForFunction(()=>[...document.querySelectorAll('.composer textarea')].some(e=>e.getClientRects().length&&e.value.includes('proofread result')));await select('isolation B');assert.equal(await input().inputValue(),'B while A recognizes');report.checks.push('proofreading_background_result_isolated');
 // A failed upload remains retryable only in A, without locking B.
 await select('isolation A');let failOnce=true;
 await page.route('**/conversations/'+a+'/voice-messages',async route=>{if(failOnce){failOnce=false;await route.abort('failed');}else await route.continue();});
 await input().fill('retry A');await composer().getByRole('button',{name:'录音输入',exact:true}).click();await composer().getByRole('button',{name:'发送语音',exact:true}).click();await composer().getByText('语音未发送，音频已保留',{exact:true}).waitFor();
 await select('isolation B');assert.equal(await composer().getByText('语音未发送，音频已保留',{exact:true}).count(),0);assert.equal(await input().isEnabled(),true);await input().fill('B retained after A failure');
 await select('isolation A');const retryAck=page.waitForResponse(r=>r.url().endsWith('/'+a+'/voice-messages'));await composer().getByRole('button',{name:'重试识别语音',exact:true}).click();assert.equal((await retryAck).status(),202);await waitEmpty();await select('isolation B');assert.equal(await input().inputValue(),'B retained after A failure');await page.unroute('**/conversations/'+a+'/voice-messages');report.checks.push('failed_background_voice_retry_scoped_to_origin');
 // A transfer icon wins even if server status is running.
 await page.route('**/api/conversations**',async route=>{if(route.request().method()!=='GET')return route.continue();const r=await route.fetch();let data;try{data=await r.json();}catch{return route.fulfill({response:r});}for(const c of data.conversations??[])if(c.id===a)c.status='running';await route.fulfill({response:r,json:data});});
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await select('isolation A');const again=await hold('**/conversations/'+a+'/voice-messages');await input().fill('priority A');await composer().getByRole('button',{name:'录音输入',exact:true}).click();await composer().getByRole('button',{name:'发送语音',exact:true}).click();await again.started.promise;const row=page.locator('.conversation-select').filter({hasText:'isolation A'});await row.getByRole('img',{name:'正在上传到服务器'}).waitFor();assert.equal(await row.getByRole('img',{name:'正在执行',exact:true}).count(),0);again.gate.resolve();await waitEmpty();report.checks.push('client_upload_indicator_precedes_server_running');
 assert.equal(report.errors.length,0,report.errors.join('\n'));await page.setViewportSize({width:390,height:844});await page.screenshot({path:base+'/mobile-isolation.png'});assert.ok(await input().isEnabled());report.checks.push('mobile_layout_remains_editable');report.ok=true;
} catch(e){report.error=String(e.stack);process.exitCode=1;if(page)await page.screenshot({path:base+'/failure.png'}).catch(()=>{});}finally{
 clearTimeout(deadline);for(const g of gates)g.resolve();proof.resolve('cleanup');await browser?.close();instance.beginShutdown();await instance.waitForBackgroundTasks();server.closeAllConnections();await new Promise(r=>server.close(r));instance.db.close();fs.rmSync(root,{recursive:true,force:true});fs.writeFileSync(base+'/local-isolation-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
