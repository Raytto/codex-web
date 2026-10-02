import fs from "node:fs";
import path from "node:path";

// Optional model probe on dedicated fixtures. Enable only for an explicitly authorized test instance.
export async function run({page,context,origin,work,assert}) {
  assert.equal(process.env.CODEX_WEB_BROWSER_MODEL_PROBE,"true","Model probes require explicit opt-in");
  const report={phase:"setup",checks:[],cleanup:false};
  const save=()=>fs.writeFileSync(path.join(work,"personal-kanban-agent.json"),JSON.stringify(report,null,2));
  const session=await(await context.request.get(origin+"/api/auth/session")).json();
  const api=async(method,route,data)=>{const r=await context.request.fetch(origin+"/api"+route,{method,data,headers:{"X-CSRF-Token":session.csrfToken}});assert.ok(r.ok(),`${method} ${route}: ${r.status()}`);return r.status()===204?null:r.json();};
  const original=await api("GET","/user-settings/features");let featureRevision=original.revision;
  const token=crypto.randomUUID(),name="看板背景验收-"+Date.now().toString().slice(-8),goal="核验项目背景-"+token,evidence="验收证据-"+token,fileText="file-evidence-"+crypto.randomUUID();
  let bid,pid,cid;
  try {
    if(!original.paraBoard)featureRevision=(await api("PUT","/user-settings/features",{...original,paraBoard:true})).revision;
    bid=(await api("POST","/para/boards",{key:crypto.randomUUID(),name})).board.id;report.boardId=bid;save();
    let p=(await api("POST",`/para/boards/${bid}/projects`,{key:crypto.randomUUID(),title:name})).project;pid=p.id;report.projectId=pid;save();
    p=(await api("PATCH",`/para/projects/${pid}`,{revision:p.revision,stage:"review",brief:{...p.brief,goal,success:"模型准确读取阶段、证据与附件",next:"核对上下文"},acceptance:evidence})).project;
    const upload=await context.request.post(origin+`/api/para/boards/${bid}/resources`,{headers:{"X-CSRF-Token":session.csrfToken},multipart:{key:crypto.randomUUID(),projectId:pid,title:"模型验收附件",file:{name:"kanban-evidence.txt",mimeType:"text/plain",buffer:Buffer.from(fileText)}}});assert.equal(upload.status(),201);
    await page.reload();await page.locator(`[data-board-id="${bid}"] .para-sidebar-item`).click();
    const board=page.locator(".para-workspace:not(.para-hidden)");await board.locator(`[data-project-id="${pid}"] .para-card-body`).click();
    await board.getByRole("button",{name:"新建工作会话",exact:true}).click();const dialog=page.locator("dialog[open]");
    await dialog.getByLabel("会话标题",{exact:true}).fill(name);
    await dialog.getByLabel("开场内容",{exact:true}).fill("这是项目看板的独立验收任务。只读取本次已提供的主项目背景和附件 kanban-evidence.txt，不联网、不修改文件、不读取工程其他文件、不创建其他任务。仅回复 JSON：goal 为主项目目标原文；stage 为项目阶段的英文代码；acceptance 为项目验收说明原文；file 为附件完整文本。不需要额外解释。");
    await dialog.getByLabel(/模型验收附件/).check();await dialog.getByRole("button",{name:"创建并打开",exact:true}).click();
    const detail=await api("GET",`/para/projects/${pid}`);cid=detail.conversations[0].id;report.conversationId=cid;save();
    const chat=page.locator("main.workspace:not(.para-workspace)");await chat.getByRole("button",{name:"发送",exact:true}).click();report.phase="model_running";save();
    const deadline=Date.now()+240000;let delivered;
    do {delivered=await api("GET",`/conversations/${cid}`);if(delivered.latestJob && !["queued","running"].includes(delivered.latestJob.status))break;await new Promise(r=>setTimeout(r,1200));}while(Date.now()<deadline);
    report.jobId=delivered.latestJob?.id;report.jobStatus=delivered.latestJob?.status;save();
    assert.equal(report.jobStatus,"completed");const answer=delivered.messages.filter(m=>m.role==="assistant").at(-1)?.content||"";
    assert.ok(answer.includes(goal));assert.ok(answer.includes("review"));assert.ok(answer.includes(evidence));assert.ok(answer.includes(fileText));
    assert.equal((await api("GET",`/para/projects/${pid}`)).project.stage,"review","a completed Job never completes the project");
    report.checks.push("real_model_reads_goal_review_stage_acceptance_and_unique_file","job_completion_preserves_review_stage");report.phase="passed";save();
  } catch(e){report.failure=e.message;save();throw e;}
  finally {
    const errors=[];
    // Normal API deletion performs the app's own safe lifecycle and storage cleanup.
    if(cid)try{await api("DELETE",`/conversations/${cid}`);}catch(e){errors.push(e.message);}
    if(bid)try{const data=await api("GET",`/para/boards/${bid}`);for(const p of data.projects){assert.equal(p.id,pid);const a=(await api("PATCH",`/para/projects/${p.id}`,{revision:p.revision,archived:true,confirm_running:true})).project;await api("DELETE",`/para/projects/${p.id}`,{revision:a.revision});}for(const r of data.resources){const a=(await api("PATCH",`/para/resources/${r.id}`,{revision:r.revision,archived:true})).resource;await api("DELETE",`/para/resources/${r.id}`,{revision:a.revision});}await api("DELETE",`/para/boards/${bid}`,{revision:data.board.revision});}catch(e){errors.push(e.message);}
    try{const current=await api("GET","/user-settings/features");if(current.revision===featureRevision && current.paraBoard!==original.paraBoard)await api("PUT","/user-settings/features",{...current,paraBoard:original.paraBoard});}catch(e){errors.push(e.message);}
    report.cleanup=errors.length===0;report.cleanupErrors=errors;save();assert.ok(report.cleanup,"probe fixtures cleaned up");
  }
}
