// Isolated real-component layout regression, never accesses personal sessions.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs PLAYWRIGHT_BROWSERS_PATH=...
// CHAT_TEXT_SIZE_OUTPUT=/private/runtime node tests/browser/chat-text-size.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { pathToFileURL } from 'node:url';
const engines = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = process.env.CHAT_TEXT_SIZE_OUTPUT;
assert.ok(output, 'Set a private output directory');
fs.mkdirSync(output, { recursive: true });
const matrix = [[382,580],[382,618],[594,368],[594,406],[669,867],[669,902],[951,585],[951,620],[385,571],[385,609],[390,844],[402,874],[1440,900],[1280,800]];
const samples = ['中文测试', '中文测试：这是一段用于比较普通正文大小的中性长文本。'.repeat(8), '中文测试 Mixed English 123, consistent readable text. '.repeat(5)];
const activitySamples = [{"kind": "reasoning", "detail": "**中文测试：核对当前页面和历史字号**", "seq": 1, "created_at": "2026-11-04T14:00:00Z"}, {"kind": "update", "detail": "中文测试：阶段反馈比最终回复轻一些，保留清晰的阅读层级。Mixed English 123。中文测试：阶段反馈比最终回复轻一些，保留清晰的阅读层级。Mixed English 123。中文测试：阶段反馈比最终回复轻一些，保留清晰的阅读层级。Mixed English 123。", "seq": 2, "created_at": "2026-11-04T14:00:00Z"}, {"kind": "update", "detail": "## 中文测试：排版检查\n\n- 中文测试：正文较小\n\n1. 中文测试：状态与细节分层\n\n### 中文测试：补充说明", "seq": 3, "created_at": "2026-11-04T14:00:00Z"}, {"kind": "command", "label": "中文测试：检查页面布局", "detail": "echo fixture", "seq": 4, "created_at": "2026-11-04T14:00:00Z"}, {"kind": "error", "label": "中文测试：临时网络错误", "detail": "恢复后继续检查", "seq": 5, "created_at": "2026-11-04T14:00:00Z"}, {"kind": "todo", "items": [{"text": "中文测试：完成字号设计", "completed": true}, {"text": "中文测试：验证手机和电脑布局", "completed": false}], "seq": 6, "created_at": "2026-11-04T14:00:00Z"}, {"kind": "agent", "agents": [{"id": "fixture-agent", "path": "/root/layout-review", "status": "running", "summary": "中文测试：检查排版细节"}], "seq": 7, "created_at": "2026-11-04T14:00:00Z"}];
activitySamples[1].detail += '\n\n中文测试：中间段落检查正常段间距。\n\n中文测试：结尾段落保持紧凑。';
const harness = `
import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Chat} from '/src/App.tsx';
import {ConversationMessageList} from '/src/conversation/ConversationMessageList.tsx';
import '/src/styles.css';
const samples = ${JSON.stringify(samples)};
const activitySamples = ${JSON.stringify(activitySamples)};
function Fixture() {
 const [state,setState]=useState({size:14,stream:'',loading:false,richProgress:''}); const ref=useRef(null);
 window.setFixture=patch=>setState(s=>({...s,...patch}));
 const base={files:[],attachment_references:[],created_at:'2026-11-02T00:00:00Z',quote_excerpt:null};
 const messages=samples.flatMap((content,i)=>[{...base,id:'u'+i,role:'user',content},{...base,id:'a'+i,role:'assistant',content}]);
 messages.push({...base,id:'rich',role:'assistant',content:'## 标题层级\\n\\n中文测试\\n\\n**中文测试**\\n\\n[中文测试](https://example.com/)\\n\\n- 中文测试\\n\\n1. 中文测试'});
 const detail={conversation:{id:'fixture'},messages,messagePage:{hasMore:false},latestJob:null};
 const activities=state.richProgress?activitySamples.map((a,i)=>i===2?{...a,detail:state.richProgress}:a):activitySamples;
 return <main><Chat detail={detail} activities={activities} activitiesLoading={state.loading} sending={true} loadingOlderMessages={false} messagesRef={ref} onMessagesScroll={()=>{}} onAskAgent={()=>{}} onFetchRemoteFile={()=>{throw Error('unexpected')}} remoteFileFetchEnabled={false} userInitials="验" chatFontSize={state.size}/><section id="stream"><ConversationMessageList messages={[]} pendingQuestion="中文测试" streamingContent={state.stream} style={{'--chat-font-size':state.size+'px'}} /></section></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server=await createServer({base:"/",server:{host:'127.0.0.1',port:0},plugins:[{
 name:'chat-text-size-fixture',enforce:'pre',
 resolveId(id){if(id==='/__text-size.tsx')return id;},load(id){if(id==='/__text-size.tsx')return harness;},
 transform(code,id){if(id.endsWith('/src/App.tsx'))return code+'\nexport {Chat};';
  if(process.env.CHAT_TEXT_SIZE_BASELINE && id.endsWith('/src/styles.css'))return execFileSync('git',['show','5e7a8f54547d5bcc4ebc0ea9dbc1d23f7136a110:src/styles.css'],{encoding:'utf8'});
 },
 configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/__text-size')return next();res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/__text-size.tsx"></script></body></html>');});}
}]});
const report={baseline:!!process.env.CHAT_TEXT_SIZE_BASELINE,platform:'Linux; neither engine is iOS Safari; WebKit port may not implement text-size-adjust',rows:[],controls:[]};
let browser;
async function measure(page){return page.evaluate(()=>{
 const metric=el=>{
  const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;
  while(node=walker.nextNode())if(node.textContent.includes('中文测试'))break;
  if(!node)return null;
  const start=node.textContent.indexOf('中文测试'),range=document.createRange();range.setStart(node,start);range.setEnd(node,start+4);
  const r=range.getBoundingClientRect(),style=getComputedStyle(node.parentElement);
  return {width:r.width,height:r.height,font:style.fontSize,adjust:style.getPropertyValue('-webkit-text-size-adjust')||style.getPropertyValue('text-size-adjust'),weight:style.fontWeight,tag:node.parentElement.tagName};
 };
 return {pairs:[0,1,2].map(i=>({u:metric(document.querySelector('[data-message-id="u'+i+'"] .message-body > p')),a:metric(document.querySelector('[data-message-id="a'+i+'"] .markdown > p'))})),rich:[...document.querySelectorAll('[data-message-id="rich"] .markdown p, [data-message-id="rich"] .markdown li')].map(metric),heading:getComputedStyle(document.querySelector('[data-message-id="rich"] h2')).fontSize,stream:document.querySelector('#stream .streaming p')?{u:metric(document.querySelector('#stream .user p')),a:metric(document.querySelector('#stream .streaming p'))}:null,progress:[...document.querySelectorAll('.process-note-content p, .process-note-content li, .process-note-content h2, .process-note-content h3')].map(metric),captionContrast:(()=>{const fg=getComputedStyle(document.querySelector('.process-journal-note time')).color,bg=getComputedStyle(document.querySelector('.activity-card')).backgroundColor;const luminance=c=>c.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);const a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)})(),hierarchy:Object.fromEntries(Object.entries({title:'.activity-title strong',body:'.process-note-content',heading:'.process-note-content h2',status:'.process-journal-note header',time:'.process-journal-note time',plan:'.process-plan li',tool:'.activity-line',detail:'.technical-detail code',collaborator:'.subagent-row-title strong',collaboratorTime:'.subagent-row-title time'}).map(([key,selector])=>[key,(()=>{const el=document.querySelector(selector);if(!el)throw Error('Missing fixture: '+selector);return parseFloat(getComputedStyle(el).fontSize)})()])),progressSpacing:(()=>{const body=getComputedStyle(document.querySelector('.process-note-content'));const paragraph=getComputedStyle(document.querySelector('.process-note-content p:not(:first-child):not(:last-child)'));const note=getComputedStyle(document.querySelector('.process-journal-note'));return {lineHeight:parseFloat(body.lineHeight),paragraph:parseFloat(paragraph.marginTop),noteTop:parseFloat(note.marginTop),noteBottom:parseFloat(note.marginBottom)}})(),cardOverflow:document.querySelector('.activity-card').scrollWidth>document.querySelector('.activity-card').clientWidth,overflow:document.documentElement.scrollWidth>innerWidth};
 });}
// WebKit encloses fractional glyph positions in integer bounds (up to 1 px).
function equalPair(pair){assert.ok(Math.abs(pair.u.width-pair.a.width)<=1,JSON.stringify(pair));assert.ok(Math.abs(pair.u.height-pair.a.height)<=1,JSON.stringify(pair));}
try{
 await server.listen();const url='http://127.0.0.1:'+server.httpServer.address().port+'/__text-size';
 for(const engine of ['chromium','webkit']){
  browser=await engines[engine].launch({headless:true,...(engine==='chromium'?{ignoreDefaultArgs:['--disable-dev-shm-usage'],args:['--disable-gpu']}:{})});
  const context=await browser.newContext({viewport:{width:382,height:580},isMobile:true,hasTouch:true,deviceScaleFactor:2});const page=await context.newPage();
  await page.goto(url);await page.locator('[data-message-id="rich"] h2').waitFor();await page.evaluate(()=>document.fonts.ready);
  for(const theme of ['light','dark']) for(const size of [14,15,16,22]){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   await page.evaluate(size=>window.setFixture({size}),size);await page.waitForTimeout(40);
   for(const [width,height] of matrix){
    await page.setViewportSize({width,height});await page.waitForTimeout(25);const result=await measure(page);
    for(const pair of result.pairs)equalPair(pair);
    for(const m of result.rich){assert.equal(m.font,size+'px');assert.ok(Math.abs(m.height-result.pairs[0].u.height)<=1);}
    const h=result.hierarchy;
    assert.ok(h.title<size && h.title>h.heading && h.heading>h.body && h.body>h.status && h.status>h.time,JSON.stringify(h));
    assert.equal(h.plan,h.status);assert.equal(h.tool,h.status);assert.equal(h.detail,h.time);assert.equal(h.collaborator,h.status);assert.equal(h.collaboratorTime,h.time);
    for(const m of result.progress){assert.ok(parseFloat(m.font)<size);assert.ok(m.width<result.pairs[0].u.width-1);if(engine==='chromium')assert.equal(m.adjust,'100%');}
    for(const [key,ratio] of Object.entries({lineHeight:1.62,paragraph:5/12,noteTop:11/12,noteBottom:13/12}))assert.ok(Math.abs(result.progressSpacing[key]-h.body*ratio)<.02,JSON.stringify(result.progressSpacing));
    assert.ok(result.progress.length>=5);assert.equal(result.cardOverflow,false);assert.ok(result.captionContrast>=4.5);
    assert.ok(parseFloat(result.heading)>size);assert.equal(result.overflow,false);
    if(!report.baseline && engine==='chromium')for(const pair of result.pairs)assert.equal(pair.a.adjust,'100%');
    report.rows.push({theme,engine,version:browser.version(),size,width,height,...result});
   }
   for(const stream of ['中文测试','中文测试，这是逐步增长的回复。'.repeat(15),'中文测试\n\n**中文测试**\n\n- 中文测试']){
    await page.evaluate(stream=>window.setFixture({stream}),stream);await page.waitForTimeout(30);equalPair((await measure(page)).stream);
   }
  }
  // Explicit percentage is a sensitivity control, not an iOS autosizing reproduction.
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.setFixture({size:14,stream:''}));await page.waitForTimeout(30);
  const before=await measure(page);
  const control=await page.addStyleTag({content:'.message.assistant .markdown { -webkit-text-size-adjust:125%; text-size-adjust:125% }'});
  const inflated=await measure(page);await control.evaluate(el=>el.remove());const after=await measure(page);
  if(engine==='chromium')assert.ok(inflated.pairs[0].a.width>before.pairs[0].a.width*1.2,'Range must detect actual inflation');
  equalPair(after.pairs[0]);report.controls.push({engine,before:before.pairs[0],inflated:inflated.pairs[0],after:after.pairs[0]});
  await page.locator('.technical-detail summary').click();assert.equal(await page.locator('.technical-detail').getAttribute('open'),'');
  await page.evaluate(()=>window.setFixture({loading:true}));await page.locator('.activity-loading').waitFor();
  if(engine==='chromium')assert.equal(await page.locator('.activity-loading').evaluate(el=>getComputedStyle(el).getPropertyValue('text-size-adjust')),'100%');
  await page.evaluate(()=>window.setFixture({loading:false}));await page.locator('.process-note-content').first().waitFor();
  await page.locator('.subagent-panel > summary').click();assert.equal(await page.locator('.subagent-panel').getAttribute('open'),'');
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;window.setFixture({size:15,stream:''});},theme);
   await page.setViewportSize({width:951,height:1200});await page.waitForTimeout(40);
   await page.locator('.activity-card').screenshot({path:path.join(output,engine+'-'+theme+'-progress.png')});
  }
  await page.evaluate(()=>window.setFixture({richProgress:'## 中文测试\n\n内联 `code_example`\n\n```txt\n'+ 'long_code_'.repeat(40)+'\n```\n\n| 字段 | 值 |\n| --- | --- |\n| 内容 | '+ 'long_value_'.repeat(30)+' |'}));
  await page.setViewportSize({width:382,height:580});await page.locator('.process-note-content pre').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.activity-card').scrollWidth<=document.querySelector('.activity-card').clientWidth),true);
  for(const selector of ['.process-note-content pre','.process-note-content table'])assert.equal(await page.locator(selector).evaluate(el=>getComputedStyle(el).overflowX),'auto');
  await page.reload();await page.locator('[data-message-id="rich"] h2').waitFor();equalPair((await measure(page)).pairs[0]);
  await browser.close();browser=null;
 }
 report.ok=true;
}finally{fs.writeFileSync(path.join(output,'measurements.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await server.close();}
console.log(JSON.stringify({ok:report.ok,baseline:report.baseline,rows:report.rows.length,engines:['Chromium','Linux WebKit'],output}));
