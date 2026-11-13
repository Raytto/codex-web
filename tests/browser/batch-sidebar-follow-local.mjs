// Isolated real app + Chromium; no production data or upstream Agent jobs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { createApp } from '../../server/app.ts';
const work = process.env.CWW_BROWSER_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(),'batch-ui-'));
fs.mkdirSync(work,{recursive:true});
const fixture=fs.mkdtempSync('/tmp/batch-ui-'),password='synthetic-ui-fixture',repo=process.cwd();
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const app=createApp({basePath:"",projectRoot:repo,dataRoot:fixture+'/data',tenantRoot:fixture+'/tenants',codexHome:fixture+'/codex',hostRootCodexHome:fixture+'/host',hostRootSocketPath:fixture+'/absent.sock',username:'batch-fixture',passwordHash:bcrypt.hashSync(password,4),sessionSecret:crypto.randomBytes(32).toString('hex'),queueAutoStart:false,minimumFreeDiskBytes:0,storageLifecycleEnabled:false});
const id=()=>crypto.randomUUID(),now=new Date().toISOString(),user=app.db.listUsers()[0].id;
const api=app.app.listen(0,'127.0.0.1');await new Promise(r=>api.once('listening',r));
const backend='http://127.0.0.1:'+api.address().port;
const baseline=process.env.UI_BASELINE_SHA;
const vite=await createServer({plugins:baseline?[{name:'baseline-regression',enforce:'pre',load(file){const relative=path.relative(repo,file);if(['src/App.tsx','src/scroll-follow.ts'].includes(relative))return execFileSync('git',['show',baseline+':'+relative],{encoding:'utf8'});}}]:[],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:backend,changeOrigin:false}}}});
let browser, page;const report={checks:[],errors:[],baseline:baseline||null};
try{
 await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,ignoreDefaultArgs:['--disable-dev-shm-usage'],env:{...process.env,TMPDIR:fixture},args:['--no-sandbox','--disable-gpu']});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const login=await context.request.post(origin+'/api/auth/login',{data:{username:'batch-fixture',password}});assert.equal(login.status(),200);
 const projects=(await (await context.request.get(origin+'/api/projects')).json()).projects;
 const project=projects.find(p=>p.executor_id==='tenant-local');assert.ok(project);
 const conversations=[];
 for(let i=0;i<13;i++){
  const c=app.db.createConversation(id(),'Batch UI '+i,{model:'gpt-6-astra',reasoningEffort:'max'},user,project.id);conversations.push(c);
  app.db.addMessage({id:id(),conversation_id:c.id,role:'user',content:'Isolated scrolling fixture '+i,created_at:now});
 }
 const selected=conversations.at(-1),message=id();
 app.db.addMessage({id:message,conversation_id:selected.id,role:'assistant',content:Array(30).fill('已有内容，供上翻查看。').join('\n\n'),created_at:now});
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));page.on('response',async r=>{if(r.status()>=400&&r.url().includes('/api/')){report.responses??=[];report.responses.push({path:new URL(r.url()).pathname,status:r.status(),body:(await r.text()).slice(0,300)});}});
 await page.goto(origin);await page.locator('.conversation-select').first().click();
 const group=page.locator('.project-group').filter({has:page.locator('.project-select').filter({hasText:project.name})});
 // Locate by the existing project row rather than relying on test-only UI hooks.
 const rows=page.locator('.project-conversations').filter({has:page.getByRole('button',{name:'展开显示',exact:true})});
 await page.locator('.messages').waitFor();
 const folder=page.locator('.project-conversations').first();
 const count=()=>folder.locator('.conversation-select').count();
 const waitCount=async n=>{await page.waitForFunction(n=>document.querySelector('.project-conversations')?.querySelectorAll('.conversation-select').length===n,n);};
 await waitCount(5);
 await folder.getByRole('button',{name:'展开显示',exact:true}).click();await waitCount(10);
 const changed=async()=>page.evaluate(p=>window.dispatchEvent(new CustomEvent('codex-web-conversation-changed',{detail:{projectId:p.project,conversationId:p.conversation}})),{project:project.id,conversation:selected.id});
 await changed();await page.waitForTimeout(800);assert.equal(await count(),10,'change notification preserves expanded page');report.checks.push('expanded after conversation change');
 await page.waitForTimeout(10500);assert.equal(await count(),10,'periodic refresh preserves expansion');report.checks.push('expanded after periodic refresh');
 // Ordinary conversation switches, then real collapse/reopen.
 await folder.locator('.conversation-select').nth(1).click();await page.waitForTimeout(400);assert.equal(await count(),10);
 await folder.locator('.conversation-select').first().click();
 const toggle=page.locator('.project-select').filter({hasText:project.name});await toggle.click();await toggle.click();await waitCount(5);
 await folder.getByRole('button',{name:'展开显示',exact:true}).click();await waitCount(10);report.checks.push('switch and explicit collapse/reopen');
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'打开侧栏',exact:true}).click();
 await folder.getByRole('button',{name:'展开显示',exact:true}).click();await waitCount(13);await changed();await page.waitForTimeout(600);assert.equal(await count(),13);report.checks.push('mobile show more');
 await page.setViewportSize({width:1440,height:900});await page.goto(origin+'/?conversation='+selected.id);await page.locator('.messages').waitFor();
 const messages=page.locator('.messages');const bottom=()=>messages.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight);
 await messages.hover();await page.mouse.wheel(0,100000);await page.waitForTimeout(200);assert.ok(await bottom()<2);
 // The same assistant message grows; message count does not change.
 app.db.sqlite.prepare('UPDATE messages SET content=content || ? WHERE id=?').run('\n\n'+Array(35).fill('流式正文增长').join('\n\n'),message);
 await changed();await page.waitForTimeout(800);assert.ok(await bottom()<2,'same-message content growth follows');report.checks.push('stream content growth');
 // A completed job marks its new result unread before the visible task refreshes.
 // That marker must not move an already-following reader to the answer's start.
 const completed=id();app.db.addMessage({id:completed,conversation_id:selected.id,role:'assistant',content:Array(60).fill('完成结果继续跟随到底部').join('\n\n'),created_at:new Date().toISOString()});
 app.db.sqlite.prepare('UPDATE conversations SET has_unread_result=1,unread_anchor_message_id=? WHERE id=?').run(completed,selected.id);
 await changed();await page.waitForTimeout(800);assert.ok(await bottom()<2,'completed unread result preserves active bottom follow');report.checks.push('completed unread result stays at bottom');
 // Native details and delayed image layout trigger ResizeObserver without React state changes.
 await messages.evaluate(e=>{const detail=document.createElement('details');detail.id='layout-record';detail.innerHTML='<summary>工作记录尺寸验收</summary><div style="height:800px">工具记录</div>';e.append(detail);});
 await page.getByText('工作记录尺寸验收',{exact:true}).click();await page.waitForTimeout(200);assert.ok(await bottom()<2,'expanded work record follows');
 await page.getByText('工作记录尺寸验收',{exact:true}).click();await page.waitForTimeout(200);assert.ok(await bottom()<2,'collapse keeps following');
 await messages.evaluate(e=>{const image=document.createElement('img');image.id='layout-image';e.append(image);setTimeout(()=>{image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="700"/>');},100);});
 await page.waitForTimeout(450);assert.ok(await bottom()<2,'late image follows');report.checks.push('details and delayed image');
 await messages.hover();await page.mouse.wheel(0,-600);await page.waitForTimeout(150);const top=await messages.evaluate(e=>e.scrollTop);assert.ok(await bottom()>300);
 app.db.sqlite.prepare('UPDATE messages SET content=content || ? WHERE id=?').run('\n\n'+Array(30).fill('查看历史时新结果继续增长').join('\n\n'),completed);
 app.db.sqlite.prepare('UPDATE conversations SET has_unread_result=1,unread_anchor_message_id=? WHERE id=?').run(completed,selected.id);
 await changed();await page.waitForTimeout(800);assert.ok(Math.abs(await messages.evaluate(e=>e.scrollTop)-top)<2,'unread refresh does not pull history reader');report.checks.push('unread refresh preserves history position');
 await messages.evaluate(e=>{document.querySelector('#layout-image').style.height='1200px';});await page.waitForTimeout(200);assert.ok(Math.abs(await messages.evaluate(e=>e.scrollTop)-top)<2,'history remains stationary');
 await page.mouse.wheel(0,100000);await page.waitForTimeout(150);await messages.evaluate(e=>{document.querySelector('#layout-image').style.height='1600px';});await page.waitForTimeout(200);assert.ok(await bottom()<2);report.checks.push('upward protection and return-to-bottom');
 const unopened=conversations[0],anchor=id();
 app.db.addMessage({id:anchor,conversation_id:unopened.id,role:'assistant',content:Array(60).fill('重新打开时定位首条未读').join('\n\n'),created_at:new Date().toISOString()});
 app.db.sqlite.prepare('UPDATE conversations SET has_unread_result=1,unread_anchor_message_id=? WHERE id=?').run(anchor,unopened.id);
 await page.goto(origin+'/?conversation='+unopened.id);await messages.waitFor();await page.waitForTimeout(700);
 assert.ok(await bottom()>300,'opening an unread task retains the first-unread anchor');
 const anchorTop=await page.locator(`[data-message-id="${anchor}"]`).evaluate(e=>e.getBoundingClientRect().top);
 assert.ok(anchorTop>=0&&anchorTop<400);report.checks.push('opening unread task still anchors first unread result');
 // A direct conversation URL must work when either the property or methods are blocked.
 for (const width of [1440,390]) for (const mode of ['getter','methods']) {
  const blocked=await browser.newContext({storageState:await context.storageState(),viewport:{width,height:844}});
  await blocked.addInitScript(mode=>{
   if(mode==='getter')Object.defineProperty(window,'localStorage',{get(){throw new DOMException('disabled','SecurityError')}});
   else for(const key of ['getItem','setItem','removeItem'])Storage.prototype[key]=function(){throw new DOMException('disabled','SecurityError')};
  },mode);
  const probe=await blocked.newPage(),errors=[];probe.on('pageerror',e=>errors.push(e.name));
  await probe.goto(origin+'/?conversation='+selected.id);await probe.locator('.composer textarea').waitFor();
  assert.equal(new URL(probe.url()).searchParams.get('conversation'),selected.id);assert.deepEqual(errors,[]);await blocked.close();
 }
 report.checks.push('direct conversation links with storage getter/methods blocked at desktop/mobile');
 assert.deepEqual(report.errors,[]);report.ok=true;
}catch(e){report.error=e.stack;report.page=await page?.locator('body').innerText().catch(()=>null);throw e;}
finally{fs.writeFileSync(path.join(work,'result.json'),JSON.stringify(report,null,2));await browser?.close();await vite.close();app.beginShutdown();await new Promise(r=>api.close(r));app.db.close();fs.rmSync(fixture,{recursive:true,force:true});console.log(JSON.stringify({ok:report.ok||false,checks:report.checks,error:report.error?.split('\n')[0]}));}
