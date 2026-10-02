import fs from "node:fs";
import path from "node:path";

// Same UI scenario runs against isolated local data and short-lived production sessions.
export async function run({page,context,origin,work,assert}) {
  const report={phase:"setup",checks:[],errors:[],boardIds:[],projectIds:[],conversationIds:[],cleanup:false};
  const save=()=>fs.writeFileSync(path.join(work,"personal-kanban.json"),JSON.stringify(report,null,2));
  page.on("pageerror",e=>{report.errors.push(e.message);save();});
  page.on("response",async r=>{if(r.status()>=400 && new URL(r.url()).pathname.startsWith("/api/")) { (report.httpErrors??=[]).push({path:new URL(r.url()).pathname,status:r.status()});save(); }});
  const session=await (await context.request.get(origin+"/api/auth/session")).json();
  const api=async(method,route,data)=>{
    const r=await context.request.fetch(origin+"/api"+route,{method,data,headers:{"X-CSRF-Token":session.csrfToken}});
    assert.ok(r.ok(),`${method} ${route}: ${r.status()}`);return r.status()===204?null:r.json();
  };
  const until=async fn=>{const end=Date.now()+15000;do{if(await fn())return;await new Promise(r=>setTimeout(r,90));}while(Date.now()<end);assert.fail("Timed out: "+report.phase);};
  const board=page.locator(".para-workspace:not(.para-hidden)"), dialog=page.locator("dialog[open]");
  const stamp=Date.now().toString().slice(-9), name="项目看板验收-"+stamp, title="交付作品网站第一版-"+stamp;
  let p, bid, preferenceRevision=null;
  const originalFeatures=await api("GET","/user-settings/features"), originalPreferences=(await api("GET","/para/summary")).preferences;
  const project=async()=> (await api("GET","/para/projects/"+p)).project;
  const waitStage=async stage=>until(async()=> (await project()).stage===stage);
  const click=async name=>board.getByRole("button",{name,exact:true}).click();
  const setStage=async stage=>{await click("项目阶段");await page.getByRole("option",{name:stage,exact:true}).click();};
  try {
    report.phase="enable_and_create";save();
    await page.locator(".account-profile").click();await page.getByRole("button",{name:"功能选择",exact:true}).click();
    const checkbox=page.getByRole("checkbox",{name:"项目看板",exact:true});await checkbox.waitFor();
    if(!(await checkbox.isChecked()))await checkbox.click();
    await until(async()=> (await api("GET","/user-settings/features")).paraBoard);
    report.featureRevision=(await api("GET","/user-settings/features")).revision;
    await page.getByRole("button",{name:"关闭功能选择",exact:true}).click();
    await page.getByRole("button",{name:"看板操作",exact:true}).click();await page.getByRole("menuitem",{name:"新建看板",exact:true}).click();
    await dialog.getByLabel("看板名称",{exact:true}).fill(name);await dialog.getByRole("button",{name:"创建看板",exact:true}).click();
    await board.getByRole("heading",{name,exact:true}).waitFor();
    bid=(await api("GET","/para/boards")).boards.find(b=>b.name===name).id;report.boardIds.push(bid);save();
    assert.equal(await board.getByRole("button",{name:"领域",exact:true}).count(),0);
    assert.equal(await board.locator(".para-column").count(),5);
    await click("记个想法");await dialog.getByLabel("一句话记录",{exact:true}).fill(title);await dialog.getByRole("button",{name:"保存想法",exact:true}).click();
    await board.getByRole("heading",{name:title,exact:true}).waitFor();
    p=(await api("GET","/para/boards/"+bid)).projects.find(p=>p.title===title).id;report.projectIds.push(p);save();
    report.checks.push("renamed_feature_create_board_and_idea_five_stages");
    await click("开始准备");await waitStage("incubating");
    await click("编辑项目");await dialog.getByLabel("简报模板",{exact:true}).selectOption("build");await dialog.getByLabel("目标",{exact:true}).fill("发布可阅读的作品网站第一版");
    await dialog.getByLabel("完成标准",{exact:true}).fill("桌面与手机均可阅读，成果入口可以访问");
    await dialog.getByLabel("下一步",{exact:true}).fill("制作三页预览并检查阅读效果");await dialog.getByLabel("简报模板",{exact:true}).selectOption("explore");assert.equal(await dialog.getByLabel("目标",{exact:true}).inputValue(),"发布可阅读的作品网站第一版");await dialog.getByRole("button",{name:"保存简报",exact:true}).click();await dialog.waitFor({state:"hidden"});
    await click("标记准备就绪");await until(async()=> (await project()).ready===1);
    await click("开始推进");await dialog.getByLabel("投入边界",{exact:true}).fill("先完成三页，不做账号系统");await dialog.getByRole("button",{name:"开始推进",exact:true}).click();await waitStage("active");
    assert.ok((await project()).started_at);report.checks.push("prepare_brief_ready_and_explicit_start");save();

    report.phase="wait_pause_review";
    await click("记录等待");await dialog.getByLabel("在等谁 / 等什么",{exact:true}).fill("等我确认首页风格");await dialog.getByLabel("下次回顾").fill("2000-01-01");await dialog.getByRole("button",{name:"记录等待",exact:true}).click();await until(async()=> (await project()).waiting_for!=="");
    await click("暂停项目");await dialog.getByLabel("暂停原因",{exact:true}).fill("先完成另一个承诺");await dialog.getByRole("button",{name:"暂停项目",exact:true}).click();await until(async()=> (await project()).paused===1);
    let summary=await api("GET","/para/summary");assert.ok(summary.attention.some(item=>item.id===p));assert.ok(summary.counts.wip>=1);assert.ok(summary.counts.overdue>=1);
    await click(name);await click("待我处理");await board.locator(".kanban-attention-list").getByRole("button",{name:new RegExp(title)}).click();
    // Keep the real write, but hold its follow-up read to exercise a slow network.
    // The next mutation must visibly wait instead of being silently discarded by the action lock.
    report.phase="release_wait_and_resume";save();
    let releaseRefresh, refreshHeld=false;
    const delayedRefresh=new Promise(resolve=>{releaseRefresh=resolve;});
    const boardRoute=origin+"/api/para/boards/"+bid;
    const holdRefresh=async route=>{refreshHeld=true;await delayedRefresh;await route.continue();};
    await page.route(boardRoute,holdRefresh);
    try {
      await click("解除等待");await until(async()=> !(await project()).waiting_for && refreshHeld);
      assert.equal(await board.getByRole("button",{name:"恢复推进",exact:true}).isDisabled(),true,"next lifecycle action waits visibly for the previous refresh");
    } finally {releaseRefresh();await page.unrouteAll({behavior:"wait"});}
    await click("恢复推进");await until(async()=> !(await project()).paused);
    report.checks.push("slow_refresh_keeps_consecutive_lifecycle_actions_available_without_losing_clicks");
    await click("回顾 / 更新下一步");await dialog.getByLabel("下一步",{exact:true}).fill("按已确认风格完成预览");await dialog.getByLabel("下次回顾").fill("2099-12-31");await dialog.getByRole("button",{name:"完成本次回顾",exact:true}).click();await until(async()=> !!(await project()).reviewed_at);
    report.checks.push("wait_pause_counted_attention_and_dated_recap");save();

    report.phase="resources_and_conversation";
    await click("成果 0");await click("添加资料");await dialog.getByLabel("资料标题（可选）",{exact:true}).fill("候选成果与验证记录");await dialog.getByLabel("文字或摘录",{exact:true}).fill("桌面检查通过；手机布局待核查。");
    await dialog.getByRole("button",{name:"收进资料库",exact:true}).click();await board.getByText("候选成果与验证记录",{exact:true}).waitFor();
    const fileText="独立验收文件内容-"+crypto.randomUUID();
    await click("添加资料");await dialog.getByLabel("资料标题（可选）",{exact:true}).fill("独立验收文件");await dialog.getByLabel("文件或图片",{exact:true}).setInputFiles({name:"kanban-check.txt",mimeType:"text/plain",buffer:Buffer.from(fileText)});
    await dialog.getByRole("button",{name:"收进资料库",exact:true}).click();await board.getByRole("button",{name:/独立验收文件/}).click();await dialog.getByText(fileText,{exact:true}).waitFor();await dialog.getByRole("button",{name:"关闭对话框",exact:true}).click();
    await click("概览");await click("新建工作会话");await dialog.getByLabel("会话标题",{exact:true}).fill("看板验收草稿-"+stamp);
    await dialog.getByLabel("开场内容",{exact:true}).fill("根据项目下一步检查预览。这里只创建验收草稿，不发送任务。");
    await dialog.getByLabel(/候选成果与验证记录/).check();await dialog.getByLabel(/独立验收文件/).check();await dialog.getByRole("button",{name:"创建并打开",exact:true}).click();
    await page.locator("main.workspace:not(.para-workspace)").waitFor();
    const d=await api("GET","/para/projects/"+p);const cid=d.conversations[0].id;report.conversationIds.push(cid);save();
    const c=await api("GET","/conversations/"+cid);assert.match(c.composerDraft.content,/桌面检查通过/);assert.equal(c.composerDraft.files.length,1);
    const boardToggle=page.locator(`[data-board-id="${bid}"] .para-sidebar-toggle`);
    if(await boardToggle.getAttribute("aria-expanded")==="false") await boardToggle.click();
    await page.locator(`[data-para-project="${p}"] .para-sidebar-project-select`).click();await board.getByRole("heading",{name:title,exact:true}).waitFor();
    await click("提交验收");await dialog.getByLabel("验收说明",{exact:true}).fill("候选成果已收录；桌面通过，手机等待检查。");await dialog.getByRole("button",{name:"提交验收",exact:true}).click();await waitStage("review");
    await board.getByRole("button",{name:"查看成果 · 2",exact:true}).waitFor();report.checks.push("output_note_work_conversation_draft_and_review_evidence");save();

    report.phase="rework_close_reopen_stop";
    await click("退回修改");await dialog.getByLabel("返工下一步",{exact:true}).fill("修正手机段落间距");await dialog.getByRole("button",{name:"开始推进",exact:true}).click();await waitStage("active");
    await click("提交验收");await dialog.getByLabel("验收说明",{exact:true}).fill("桌面、手机、公开访问均通过");await dialog.getByRole("button",{name:"提交验收",exact:true}).click();await waitStage("review");
    await click("确认完成");await dialog.getByRole("button",{name:"确认完成",exact:true}).click();assert.equal(await dialog.getByLabel("验收结论").evaluate(el=>el.validity.valueMissing),true);
    await dialog.getByLabel("验收结论",{exact:true}).fill("已按约定验收第一版，保留成果记录");await dialog.getByRole("button",{name:"确认完成",exact:true}).click();await waitStage("done");
    assert.ok((await project()).ended_at);assert.equal((await project()).review_on,null);
    await click("重新打开");await waitStage("incubating");await click("终止项目");await dialog.getByLabel("终止原因",{exact:true}).fill("第二轮需求取消，第一版成果保留");await dialog.getByRole("button",{name:"终止项目",exact:true}).click();await waitStage("stopped");
    await click(name);await click("已终止");await board.locator(`[data-project-id="${p}"]`).waitFor();await board.locator(`[data-project-id="${p}"] .para-card-body`).click();
    await click("重新打开");await waitStage("incubating");report.checks.push("review_rejection_completion_required_conclusion_termination_and_reopen");save();

    report.phase="conflict_failure_archive";
    await click("开始推进");await dialog.getByLabel("下一步",{exact:true}).fill("保留我的未提交下一步");
    const before=await project();await api("PATCH","/para/projects/"+p,{revision:before.revision,effort:"另一个窗口的新边界"});
    await dialog.getByRole("button",{name:"开始推进",exact:true}).click();await dialog.getByRole("alert").waitFor();assert.equal(await dialog.getByLabel("下一步",{exact:true}).inputValue(),"保留我的未提交下一步");
    // Resolve the conflict through the actual UI. Cancelling and dispatching an
    // async refresh used to reopen with the old revision on slower connections.
    await dialog.getByRole("button",{name:"查看服务器最新版本",exact:true}).click();
    await dialog.getByText("投入边界：另一个窗口的新边界",{exact:true}).waitFor();
    assert.equal(await dialog.getByLabel("下一步",{exact:true}).inputValue(),"保留我的未提交下一步");
    await dialog.getByLabel("投入边界",{exact:true}).fill("另一个窗口的新边界");
    await dialog.getByRole("button",{name:"已核对，保留我的输入继续保存",exact:true}).click();
    let fail=true;const route=async route=>{if(fail&&route.request().method()==="PATCH"){fail=false;return route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"验收模拟暂时断网"})});}return route.continue();};
    await page.route(origin+"/api/para/projects/"+p,route);await dialog.getByLabel("下一步",{exact:true}).fill("失败后可重试的下一步");await dialog.getByRole("button",{name:"开始推进",exact:true}).click();await dialog.getByText("验收模拟暂时断网").waitFor();await dialog.getByRole("button",{name:"开始推进",exact:true}).click();await waitStage("active");await page.unroute(origin+"/api/para/projects/"+p,route);
    assert.equal((await project()).brief.next,"失败后可重试的下一步");assert.equal((await project()).effort,"另一个窗口的新边界");
    page.once("dialog",d=>d.accept());await click("归档");await until(async()=> !!(await project()).archived_at);assert.ok((await api("GET","/para/summary")).counts.archived_wip>=1);
    await click("恢复项目");await until(async()=> !(await project()).archived_at);report.checks.push("stale_revision_keeps_input_network_retry_and_archive_retains_commitment");save();

    report.phase="desktop_mobile_dark_and_wip";
    await click(name);await click("项目推进");await click("看板设置");await dialog.getByLabel("个人在制上限",{exact:true}).fill("1");await dialog.getByRole("button",{name:"保存上限",exact:true}).click();await until(async()=> (await api("GET","/para/summary")).preferences.wip_limit===1);preferenceRevision=(await api("GET","/para/summary")).preferences.revision;
    await dialog.getByText("已保存",{exact:true}).waitFor();await dialog.getByRole("button",{name:"关闭对话框",exact:true}).click();
    assert.equal(await board.locator(".kanban-overview").count(),0);
    await board.locator(`[data-project-id="${p}"]`).dragTo(board.locator(".para-column.stage-review"));await dialog.getByLabel("验收说明",{exact:true}).fill("拖动提交验收，保留证据");await dialog.getByRole("button",{name:"提交验收",exact:true}).click();await waitStage("review");
    await board.screenshot({path:path.join(work,"personal-kanban-desktop.png")});
    await page.reload();await board.getByRole("heading",{name,exact:true}).waitFor();assert.equal((await api("GET","/para/summary")).preferences.wip_limit,1);
    for(const width of [390,320]) {
      await page.setViewportSize({width,height:844});await board.locator(".para-column.stage-review").waitFor();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"no page horizontal overflow");
      assert.equal(await board.locator(".para-column").count(),5,"mobile sees all stages rather than hiding ongoing projects");
      await board.screenshot({path:path.join(work,`personal-kanban-${width}.png`)});
      await board.locator(`[data-project-id="${p}"] .para-card-body`).click();await click("记录等待");
      await dialog.getByLabel("在等谁 / 等什么",{exact:true}).fill("手机等待事项");assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await dialog.screenshot({path:path.join(work,`personal-kanban-dialog-${width}.png`)});await dialog.getByRole("button",{name:"取消",exact:true}).click();await click(name);
    }
    const touchContext=await context.browser().newContext({storageState:await context.storageState(),viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    try {const touch=await touchContext.newPage();touch.setDefaultTimeout(15000);await touch.goto(origin);const view=touch.locator(".para-workspace:not(.para-hidden)");await view.locator(`[data-project-id="${p}"] .para-card-body`).tap();await view.getByRole("heading",{name:title,exact:true}).waitFor();await touch.reload();await view.getByRole("heading",{name:title,exact:true}).waitFor();await view.getByRole("button",{name:"编辑验收说明",exact:true}).tap();await touch.locator("dialog[open]").getByLabel("验收说明",{exact:true}).waitFor();await touch.locator("dialog[open]").getByRole("button",{name:"取消",exact:true}).tap();report.checks.push("touch_open_edit_and_project_reload");}finally{await touchContext.close();}
    await page.setViewportSize({width:1440,height:1000});
    await page.locator(".account-profile").click();await page.getByRole("button",{name:"显示设置",exact:true}).click();await page.getByRole("button",{name:"使用深色模式",exact:true}).click();await page.getByRole("button",{name:"关闭显示设置",exact:true}).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"),"dark");await board.locator(".para-scroll").evaluate(el=>el.scrollTop=0);await board.screenshot({path:path.join(work,"personal-kanban-dark.png")});
    assert.deepEqual(report.errors,[]);report.checks.push("wip_persistence_desktop_mobile390_mobile320_dark_no_overflow");report.phase="passed";save();
  } catch(e) {report.failure=e.message;report.alerts=await page.getByRole("alert").allTextContents();save();await board.screenshot({path:path.join(work,"personal-kanban-failure.png"),timeout:3000}).catch(()=>{});throw e;}
  finally {
    await page.unrouteAll({behavior:"wait"});const errors=[];
    for(const bid of report.boardIds)try {
      const data=await api("GET","/para/boards/"+bid);
      for(const item of data.projects) {assert.ok(report.projectIds.includes(item.id));const archived=item.archived_at?item:(await api("PATCH","/para/projects/"+item.id,{revision:item.revision,archived:true,confirm_running:true})).project;await api("DELETE","/para/projects/"+item.id,{revision:archived.revision});}
      for(const r of data.resources) {const archived=r.archived_at?r:(await api("PATCH","/para/resources/"+r.id,{revision:r.revision,archived:true})).resource;await api("DELETE","/para/resources/"+r.id,{revision:archived.revision});}
      await api("DELETE","/para/boards/"+bid,{revision:data.board.revision});
    } catch(e){errors.push(e.message);}
    for(const cid of report.conversationIds)try {await api("DELETE","/conversations/"+cid);}catch(e){errors.push(e.message);}
    try {const current=(await api("GET","/para/summary")).preferences;if(preferenceRevision===current.revision)await api("PATCH","/para/preferences",{revision:current.revision,wip_limit:originalPreferences.wip_limit});}catch(e){errors.push(e.message);}
    try {const current=await api("GET","/user-settings/features");if(current.revision===report.featureRevision&&current.paraBoard!==originalFeatures.paraBoard)await api("PUT","/user-settings/features",{...current,paraBoard:originalFeatures.paraBoard});}catch(e){errors.push(e.message);}
    report.cleanup=errors.length===0;report.cleanupErrors=errors;save();assert.ok(report.cleanup,"dedicated fixtures cleaned up");
  }
}
