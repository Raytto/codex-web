// Isolated real API/SQLite + browser regression. Never starts a model job.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { createApp } from '../dist-server/server/app.js';
import { HOST_ROOT_USER_ID } from '../dist-server/server/host-root-user.js';
import { run as sidebarScenario } from '../tests/browser/sidebar-scroll.mjs';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fs.mkdtempSync(path.join(process.env.TEST_RUNTIME || os.tmpdir(), 'project-automation-'));
const shortTemp = `/tmp/automation-${crypto.randomUUID()}`;
fs.symlinkSync(root, shortTemp, 'dir');
const password = crypto.randomUUID();
const instance = createApp({ projectRoot: process.cwd(), basePath: '/codex-web',
  dataRoot: path.join(root,'data'), tenantRoot: path.join(root,'tenants'), codexHome: path.join(root,'codex'),
  hostRootSocketPath: '', hostRootCodexHome: path.join(root,'host-codex'),
  queueAutoStart: false, username: 'member', passwordHash: bcrypt.hashSync(password,4), sessionSecret: crypto.randomBytes(32).toString('hex') });
const server = instance.app.listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const origin = `http://127.0.0.1:${server.address().port}/codex-web`;
const results = [], errors=[];
let browser;
async function login(username) {
  const context = await browser.newContext();
  const response = await context.request.post(`${origin}/api/auth/login`,{data:{username,password}});
  assert.equal(response.status(),200);
  return context;
}
async function openSidebar(page) {
  const sidebar=page.locator('.sidebar');
  if (await sidebar.evaluate(el => matchMedia('(max-width: 720px)').matches && !el.classList.contains('open'))) await page.getByRole('button',{name:'打开侧栏',exact:true}).click();
}
async function projectMenu(page,name) {
  await openSidebar(page);
  await page.getByRole('button',{name:`项目 ${name} 操作`,exact:true}).click();
}
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,ignoreDefaultArgs:['--disable-dev-shm-usage'],args:['--disable-gpu'],env:{...process.env,TMPDIR:shortTemp}});
  const context=await login('member');
  const projects=await (await context.request.get(`${origin}/api/projects`)).json();
  const project=projects.projects.find(p=>p.id===projects.defaultProjectId)||projects.projects[0];
  assert.ok(project);
  const page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(`${origin}/`);await page.locator('.account-profile').waitFor();
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:width===390?844:900});
    await projectMenu(page,project.name);
    await page.getByRole('menuitem',{name:'管理定时任务',exact:true}).click();
    await page.getByRole('button',{name:'新建周期任务',exact:true}).click();
    await page.getByRole('textbox',{name:'任务名称',exact:true}).fill(`Browser recurrence ${width}`);
    await page.getByRole('textbox',{name:'任务指令',exact:true}).fill('Synthetic browser fixture; do not run a model.');
    await page.getByRole('button',{name:'创建周期任务',exact:true}).click();
    await page.getByRole('button',{name:'暂停任务',exact:true}).waitFor();
    let tasks=(await (await context.request.get(`${origin}/api/recurring-tasks`)).json()).tasks;
    assert.equal(tasks.length,1);assert.equal(tasks[0].state,'active');
    await page.getByRole('button',{name:'暂停任务',exact:true}).click();
    await page.getByRole('button',{name:'启用任务',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'任务指令',exact:true}).fill('Updated synthetic instruction.');
    await page.getByRole('button',{name:'保存更改',exact:true}).click();
    await page.getByRole('button',{name:'保存更改',exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.recurring-editor fieldset')?.disabled);
    tasks=(await (await context.request.get(`${origin}/api/recurring-tasks`)).json()).tasks;
    assert.equal(tasks[0].state,'paused');assert.equal(tasks[0].prompt,'Updated synthetic instruction.');
    assert.ok(await page.locator('.recurring-workspace').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await page.getByRole('button',{name:'删除',exact:true}).click();
    await page.getByRole('heading',{name:'周期任务',exact:true}).waitFor();
    assert.deepEqual((await (await context.request.get(`${origin}/api/recurring-tasks`)).json()).tasks,[]);
    results.push({width,recurringCreateEditPauseDelete:true});
  }
  await page.setViewportSize({width:1440,height:900});
  await projectMenu(page,project.name);await page.getByRole('menuitem',{name:'管理项目技能',exact:true}).click();
  const skill=page.getByRole('dialog',{name:`项目技能 · ${project.name}`,exact:true});
  await skill.getByRole('button',{name:'新建技能',exact:true}).click();
  await skill.getByRole('textbox',{name:'技能名称',exact:true}).fill('browser-fixture');
  await skill.getByRole('textbox',{name:'技能内容（SKILL.md）',exact:true}).fill('---\nname: browser-fixture\ndescription: Synthetic browser regression fixture\n---\n\nOnly a fixture.\n');
  await skill.getByRole('button',{name:'保存技能',exact:true}).click();
  await skill.getByRole('button',{name:'停用',exact:true}).click();
  await skill.getByRole('button',{name:'启用',exact:true}).waitFor();
  await skill.getByRole('button',{name:'删除',exact:true}).click();
  await skill.getByText('还没有项目技能',{exact:true}).waitFor();
  await skill.getByRole('button',{name:'关闭项目技能',exact:true}).click();
  results.push({projectSkillsCreateDisableDelete:true});
  await page.goto(`${origin}/`);
  await sidebarScenario({page,context,origin,work:root,assert});
  results.push({sidebar:JSON.parse(fs.readFileSync(path.join(root,'sidebar-scroll.json'),'utf8')).checks});
  await context.close();
  const now=new Date().toISOString();
  instance.db.createUser({id:HOST_ROOT_USER_ID,username:'owner',display_name:'Host administrator',password_hash:bcrypt.hashSync(password,4),role:'owner',status:'active',created_at:now,updated_at:now});
  const owner=await login('owner');const ownerPage=await owner.newPage();ownerPage.setDefaultTimeout(20000);ownerPage.on('pageerror',e=>errors.push(e.message));
  await ownerPage.goto(`${origin}/`);await ownerPage.locator('.account-profile').waitFor();
  for(const width of [1440,390,320]) {
    await ownerPage.setViewportSize({width,height:width===320?568:900});
    await openSidebar(ownerPage);await ownerPage.locator('.account-profile').click();
    await ownerPage.getByRole('button',{name:'节点文件传输',exact:true}).click();
    const dialog=ownerPage.getByRole('dialog',{name:'节点文件传输',exact:true});
    await dialog.getByText('还没有传输任务。',{exact:true}).waitFor();
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    assert.ok(await dialog.getByRole('button',{name:'开始传输',exact:true}).isDisabled());
    await ownerPage.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    results.push({width,transferDisabledWithoutEndpoints:true});
  }
  await owner.close();assert.deepEqual(errors,[]);
  assert.equal(instance.db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
  console.log(JSON.stringify({ok:true,results,modelJobsStarted:0}));
} finally {
  await browser?.close();instance.beginShutdown();await instance.waitForBackgroundTasks();instance.remoteWorkers.close();
  server.closeAllConnections();await new Promise(r=>server.close(r));instance.db.close();fs.unlinkSync(shortTemp);fs.rmSync(root,{recursive:true,force:true});
}
