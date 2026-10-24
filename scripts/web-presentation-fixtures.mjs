import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareFinalizationFiles } from '../dist-server/server/job-finalization.js';
export const WEB_FIXTURE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="pp-agent-view" content="web"><title>交互验收作品</title><style>body{margin:0;padding:24px;font:16px/1.6 system-ui;background:#f5f7fb;color:#1d2535}button,input{font:inherit;padding:12px;margin:4px;max-width:90%}nav{display:flex;flex-wrap:wrap}#cards{display:grid;gap:12px}article{padding:16px;background:white;border-radius:12px}</style></head><body><h1>交互验收作品</h1><nav><button id="next">下一页</button><button id="reset">重置</button><button id="export">导出</button></nav><input id="filter" placeholder="筛选项目"><output id="count">0</output><button id="add">计数 +1</button><section id="cards"></section><details><summary>原生展开</summary>展开内容</details><script type="application/json" id="data">["苹果","香蕉","梨"]</script><script>let count=0;const items=JSON.parse(document.getElementById('data').textContent);const q=s=>document.getElementById(s);function render(){q('cards').innerHTML=items.filter(x=>x.includes(q('filter').value)).map(x=>'<article>'+x+'</article>').join('')}q('filter').oninput=render;q('add').onclick=()=>q('count').textContent=++count;q('next').onclick=()=>q('cards').textContent='第二页';q('reset').onclick=()=>{count=0;q('count').textContent=count;q('filter').value='';render()};q('export').onclick=()=>ppAgent.exportFile('结果.json',JSON.stringify({count}));render();window.fixtureReady=true;</script></body></html>`;
export function webFixtures(dataRoot, work) {
  const db = new DatabaseSync(path.join(dataRoot, 'codex-web.sqlite')); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  const ids = new Map(), directories = [];
  const owner = fs.statSync(dataRoot);
  return {
    async seed(conversationId, userId) {
      const c = db.prepare('SELECT user_id,title FROM conversations WHERE id=?').get(conversationId);
      assert.equal(c?.user_id, userId); assert.match(c.title, /^web-acceptance-/);
      assert.equal(db.prepare('SELECT count(*) AS n FROM jobs WHERE conversation_id=?').get(conversationId).n, 0);
      const messageId = crypto.randomUUID(), jobId = crypto.randomUUID(), now = new Date().toISOString();
      const name = '交互网页验收长文件名_筛选输入页面切换重置与导出.html';
      const documents = [
        [name, 'text/html', WEB_FIXTURE],
        [name + '.pp-agent.json', 'application/json', JSON.stringify({presentation_mode:'web',sha256:crypto.createHash('sha256').update(WEB_FIXTURE).digest('hex')})],
        ['报告阅读验收.html', 'text/html', '<!doctype html><meta charset="utf-8"><h1>报告标题</h1><h2>第一节</h2><p>报告正文仍然可选区与标注。</p><script type="application/json">{"safe":true}</script><details><summary>展开报告</summary>原生交互</details>'],
        ['Markdown阅读验收.md','text/markdown','\uFEFF# Markdown 标题\n\n## 第一节\n\n正文可读。'],
        ['未声明交互网页验收.html', 'application/octet-stream', WEB_FIXTURE],
        ['外部资源拒绝验收.html', 'text/html', '<!doctype html><meta charset="utf-8"><h1>需要外部资源</h1><script src="https://example.invalid/demo.js"></script>'],
      ];
      const sources = documents.map(([name,mime,body])=>{
        const id=crypto.randomUUID(), source=path.join(work,id);fs.writeFileSync(source,body);
        return {row:{id,conversation_id:conversationId,message_id:messageId,original_name:name,relative_path:`deliverables/${id}/${name}`,mime_type:mime,size:Buffer.byteLength(body),kind:'output',created_at:now},sourcePath:source,expectedSha256:crypto.createHash('sha256').update(body).digest('hex')};
      });
      const { files } = await prepareFinalizationFiles(dataRoot, jobId, sources);
      db.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'assistant',?,?)").run(messageId,conversationId,files.map(f=>`[${f.original_name}](outputs/${f.original_name})`).join('\n\n'),now);
      for (const file of files) {
        const absolute=path.join(dataRoot,file.relative_path); directories.push(path.dirname(absolute));
        if(process.getuid?.()===0){fs.chownSync(path.dirname(absolute),owner.uid,owner.gid);fs.chownSync(absolute,owner.uid,owner.gid);}
        db.prepare('INSERT INTO files(id,conversation_id,message_id,original_name,relative_path,mime_type,size,kind,created_at,sha256,presentation_mode,presentation_manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(file.id,conversationId,messageId,file.original_name,file.relative_path,file.mime_type,file.size,'output',now,file.sha256,file.presentation_mode,file.presentation_manifest);
        ids.set(file.id,{conversationId,userId});
      }
      fs.rmSync(path.join(dataRoot,'finalization',jobId),{recursive:true,force:true});
      return files;
    },
    trackVersion(id,originalId){assert.ok(ids.has(originalId));const f=db.prepare('SELECT * FROM files WHERE id=?').get(id);assert.equal(f.previous_file_id,originalId);assert.equal(f.conversation_id,ids.get(originalId).conversationId);ids.set(id,ids.get(originalId));directories.push(path.dirname(path.join(dataRoot,f.relative_path)));},
    setExpiry(id,expiry){assert.ok(ids.has(id));assert.ok(Number.isFinite(Date.parse(expiry)));db.prepare('UPDATE public_file_shares SET expires_at=? WHERE file_id=?').run(expiry,id);},
    activity(id){assert.ok([...ids.values()].some(f=>f.conversationId===id));return db.prepare('SELECT last_active_at FROM conversations WHERE id=?').get(id).last_active_at;},
    close(){for(const [id,f]of ids)db.prepare('DELETE FROM public_file_shares WHERE file_id=? AND user_id=?').run(id,f.userId);db.close();for(const dir of directories)fs.rmSync(dir,{recursive:true,force:true});}
  };
}
