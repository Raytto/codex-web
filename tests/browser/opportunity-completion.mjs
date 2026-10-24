import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=process.env.CWW_BROWSER_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'completion-report-'));
fs.mkdirSync(output,{recursive:true,mode:0o700});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'completion-ui-'));
const require=createRequire(repo+'/package.json');
const {createApp}=await import(repo+'/dist-server/server/app.js');
const {OpportunityStore,contentInput}=await import(repo+'/dist-server/server/opportunity-store.js');
const cache=process.env.PLAYWRIGHT_BROWSERS_PATH||'/root/.cache/ms-playwright';
process.env.PLAYWRIGHT_BROWSERS_PATH=cache;
const entry=fs.readdirSync(cache+'/.links').map(n=>fs.readFileSync(cache+'/.links/'+n,'utf8').trim()).find(p=>fs.existsSync(p+'/index.mjs'));
const {chromium}=await import(entry+'/index.mjs');
const app=createApp({projectRoot:repo,dataRoot:root+'/data',tenantRoot:root+'/tenants',username:'pp',passwordHash:require('bcryptjs').hashSync('completion-test',4),sessionSecret:'completion-test-secret-at-least32chars',queueAutoStart:false,basePath:"/codex-web",minimumFreeDiskBytes:0});
const server=app.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const origin='http://127.0.0.1:'+server.address().port+'/codex-web';
const report={checks:[],pageErrors:[]};let browser;
const deadline=setTimeout(()=>{throw new Error('Completion browser test timed out');},180000);
try{
 browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--disable-dev-shm-usage'],args:['--disable-gpu'],env:{...process.env,HOME:root,TMPDIR:root}});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const login=await context.request.post(origin+'/api/auth/login',{data:{username:'pp',password:'completion-test'}});assert.equal(login.status(),200);
 const session=await login.json(),uid=session.accountId;
 const api=async(method,url,data)=>{const r=await context.request.fetch(origin+'/api'+url,{method,headers:{Origin:origin,'X-CSRF-Token':session.csrfToken},...(data===undefined?{}:{data})});assert.ok(r.ok(),url+': '+r.status());return r.status()===204?null:r.json();};
 const prefs=await api('GET','/user-settings/features');await api('PUT','/user-settings/features',{...prefs,opportunityCards:true});
 const project=(await api('GET','/projects')).projects.find(p=>p.executor_id==='tenant-local');
 const source=(await api('POST','/conversations',{projectId:project.id,reuseEmpty:false})).conversation;
 const store=new OpportunityStore(app.db),topics=[],ideas=[];
 for(let n=0;n<2;n++){
  const topic=store.createTopic(uid,{name:'完成归档验收 '+n,project_id:project.id,goal:'测试保留与完成'},crypto.randomUUID());topics.push(topic);
  const batch=store.begin(uid,topic.id,source.id,null);
  const content=contentInput.parse({title:'待制作卡片 '+n,summary:'保留后继续设计和制作，做完归档。',audience:'验收',problem:'测试问题 '+n,mechanism:'独立测试机制 '+n,value:'测试价值',fit:'测试',facts:'合成数据',assumptions:'假设',doubt:'疑点',validation:'点击完成及恢复',difference:'独立机制 '+n,category:'验收',keywords:['测试',String(n)],sources:[]});
  const idea=store.ingest(uid,batch.id,source.id,[{key:'fixture',content}])[0].idea;ideas.push(idea);
  store.feedback(uid,idea.id,{requestKey:crypto.randomUUID(),revision:idea.revision,action:'kept',rating:4,note:'原始备注 '+n});
 }
 const research=store.start(uid,topics[0].id,{model:'gpt-6-sol',reasoningEffort:'medium'},crypto.randomUUID(),ideas[0].id);
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.pageErrors.push(String(e)));
 await page.goto(origin);await page.locator('[data-extension-group="opportunities"] .extension-toggle').click();
 const workspace=()=>page.locator('.opportunity-workspace:visible');
 const tabs=()=>workspace().getByRole('navigation',{name:'候选分类'});
 const card=()=>workspace().locator(`[data-opportunity-idea="${ideas[0].id}"]`);
 const open=async()=>{await page.getByRole('region',{name:'机会卡片',exact:true}).locator(`[data-opportunity-topic="${topics[0].id}"] .project-select`).click();await tabs().getByRole('button',{name:/^已保留/}).click();await card().waitFor();};
 await open();assert.equal(await card().locator('.opportunity-status').innerText(),'已保留');
 await card().getByRole('button',{name:'查看详情',exact:true}).click();
 const dialog=()=>page.getByRole('dialog');await dialog().getByRole('textbox',{name:'反馈（可选）'}).fill('已做好原型，资料需继续保留');
 await dialog().getByRole('button',{name:'标记完成',exact:true}).click();await dialog().waitFor({state:'hidden'});
 await workspace().getByRole('heading',{name:'还没有保留的卡片'}).waitFor();
 await tabs().getByRole('button',{name:/^已完成/}).click();await card().waitFor();assert.equal(await card().locator('.opportunity-status').innerText(),'已完成');
 assert.equal(store.idea(uid,ideas[0].id).note,'已做好原型，资料需继续保留');assert.equal(store.idea(uid,ideas[0].id).rating,4);
 await card().getByRole('button',{name:'查看研究',exact:true}).waitFor();assert.equal(store.detail(uid,ideas[0].id).research[0].conversation_id,research.conversationId);
 report.checks.push('detail_completion_saves_feedback_moves_card_and_keeps_research');
 await page.reload();await page.getByRole('region',{name:'机会卡片',exact:true}).locator(`[data-opportunity-topic="${topics[0].id}"] .project-select`).click();await tabs().getByRole('button',{name:/^已完成/}).click();await card().waitFor();
 await card().getByRole('button',{name:'查看详情',exact:true}).click();assert.equal(await dialog().getByRole('button',{name:'深入研究',exact:true}).isDisabled(),true);assert.equal(await dialog().getByRole('textbox',{name:'反馈（可选）'}).inputValue(),'已做好原型，资料需继续保留');
 await dialog().getByRole('button',{name:'恢复为保留',exact:true}).click();await dialog().waitFor({state:'hidden'});await tabs().getByRole('button',{name:/^已保留/}).click();await card().waitFor();
 report.checks.push('reload_persists_completed_and_detail_reopens_to_kept');
 // A failed write must leave the card in place and offer a usable retry.
 await page.route('**/api/opportunities/ideas/*/feedback',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试保存失败，请重试'})}),{times:1});
 await card().getByRole('button',{name:'标记完成',exact:true}).click();await workspace().getByRole('alert').filter({hasText:'测试保存失败'}).waitFor();assert.equal(store.idea(uid,ideas[0].id).state,'kept');
 await card().getByRole('button',{name:'标记完成',exact:true}).click();await card().waitFor({state:'hidden'});await tabs().getByRole('button',{name:/^已完成/}).click();await card().waitFor();
 await card().getByRole('button',{name:'恢复为保留',exact:true}).click();await tabs().getByRole('button',{name:/^已保留/}).click();await card().waitFor();
 report.checks.push('quick_complete_restore_and_failed_save_retry');
 // A stale list cannot overwrite feedback written on another page.
 const old=store.idea(uid,ideas[0].id);store.feedback(uid,old.id,{requestKey:crypto.randomUUID(),revision:old.revision,action:'rate',rating:5,note:'另一个页面的新备注'});
 const stale=page.waitForResponse(r=>r.url().endsWith('/feedback')&&r.request().method()==='POST');await card().getByRole('button',{name:'标记完成',exact:true}).click();assert.equal((await stale).status(),409);
 assert.equal(store.idea(uid,old.id).note,'另一个页面的新备注');await workspace().getByRole('button',{name:'重试读取',exact:true}).click();await card().getByRole('button',{name:'标记完成',exact:true}).click();await tabs().getByRole('button',{name:/^已完成/}).click();await card().waitFor();assert.equal(store.idea(uid,old.id).note,'另一个页面的新备注');
 report.checks.push('concurrent_feedback_conflict_preserves_newer_data');
 await workspace().getByRole('combobox',{name:'发现主题'}).selectOption('');await tabs().getByRole('button',{name:/^已保留/}).click();await workspace().locator(`[data-opportunity-idea="${ideas[1].id}"]`).waitFor();assert.equal(await card().count(),0);
 await tabs().getByRole('button',{name:/^已完成/}).click();await card().waitFor();
 report.checks.push('all_topics_kept_and_completed_filters');
 for(const width of [1440,768,390,320])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await tabs().getByRole('button',{name:/^已完成/}).scrollIntoViewIfNeeded();assert.ok(await workspace().evaluate(e=>e.scrollWidth<=e.clientWidth));
  for(const name of [/^已保留/,/^已完成/]){const bounds=await tabs().getByRole('button',{name}).boundingBox();assert.ok(bounds.height>=44);}
  await card().getByRole('button',{name:'恢复为保留',exact:true}).scrollIntoViewIfNeeded();assert.ok((await card().getByRole('button',{name:'恢复为保留',exact:true}).boundingBox()).height>=44);
  if(width===390)await workspace().screenshot({path:output+'/completed-'+theme+'.png'});
 }
 await page.evaluate(()=>document.documentElement.style.fontSize='200%');assert.ok(await workspace().evaluate(e=>e.scrollWidth<=e.clientWidth));
 await card().getByRole('button',{name:'查看详情',exact:true}).click();await dialog().getByRole('button',{name:'恢复为保留',exact:true}).scrollIntoViewIfNeeded();assert.ok(await dialog().evaluate(e=>e.scrollWidth<=e.clientWidth));
 report.checks.push('desktop_mobile_light_dark_large_text_actions_fit');assert.deepEqual(report.pageErrors,[]);report.ok=true;
}catch(error){report.ok=false;report.error=String(error.stack||error);throw error;}
finally{clearTimeout(deadline);fs.writeFileSync(output+'/result.json',JSON.stringify(report,null,2));await browser?.close();app.beginShutdown();await new Promise(r=>server.close(r));app.db.close();fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({ok:report.ok,checks:report.checks,report:output+'/result.json'}));}
