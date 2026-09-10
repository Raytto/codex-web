// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
// Uses an isolated loopback Vite fixture; no production session or API calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const harness = `
import React, { useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from '/src/App.tsx';
import '/src/styles.css';
const filename = '示例视频 day 1 sample.mp4';
const content = '- 目标文件：[的文件](/tmp/missing/movie.mp4)\\n- 时长：60 分 06.964 秒'.replace('的文件', filename);
function Fixture() {
 const [revision, setRevision] = useState(0);
 const messagesRef = useRef(null);
 window.refreshFixture = () => setRevision(n => n + 1);
 const detail = { conversation: { id: 'test-chat' }, messages: [{id:'msg',role:'assistant',content,files:[],attachment_references:[],created_at:'2026-09-07T00:00:00Z',quote_excerpt:null}], messagePage:{hasMore:false},latestJob:null };
 return <div data-revision={revision}><Chat detail={detail} activities={[]} activitiesLoading={false} sending={false} loadingOlderMessages={false} messagesRef={messagesRef} onMessagesScroll={() => {}} onAskAgent={text => window.quotedText = text} onFetchRemoteFile={async () => {throw Error('unexpected fetch')}} remoteFileFetchEnabled={false} userInitials="T" chatFontSize={16} /></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({
 base: "/",
 server:{host:'127.0.0.1',port:0},
 plugins:[{
  name:'selection-regression-fixture',enforce:'pre',
  resolveId(id){if(id==='/__selection-harness.tsx')return id;},
  load(id){if(id==='/__selection-harness.tsx')return harness;},
  transform(code,id){if(id.endsWith('/src/App.tsx'))return (process.env.SELECTION_BASELINE ? execFileSync('git',['show','HEAD:src/App.tsx'],{encoding:'utf8'}) : code)+'\nexport { Chat };\n';},
  configureServer(s){s.middlewares.use((req,res,next)=>{
   if(req.url!=='/__selection')return next();
   res.setHeader('Content-Type','text/html; charset=utf-8');
   res.end('<html><head><meta charset="utf-8"><style>.chat{height:700px;width:950px}.messages{height:650px}</style></head><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/__selection-harness.tsx"></script></body></html>');
  });}
 }],
});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,ignoreDefaultArgs:['--disable-dev-shm-usage'],args:['--no-sandbox','--disable-gpu']});
 const page=await browser.newPage({viewport:{width:1200,height:850}});
 page.on('pageerror',e=>console.log('PAGEERROR',e.message));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__selection`);
 await page.waitForTimeout(1500);
 await page.locator('.unavailable-file-link').waitFor({timeout:5000,state:'attached'});
 const expected=await page.locator('.unavailable-file-link').textContent();
 await page.evaluate(()=>{
  const link=document.querySelector('.unavailable-file-link');window.originalLink=link;
  const range=document.createRange();range.selectNodeContents(link);
  window.getSelection().removeAllRanges();window.getSelection().addRange(range);
 });
 // selectionchange itself mounts the toolbar and re-renders Chat.
 await page.waitForTimeout(250);
 const after=await page.evaluate(()=>({sameNode:window.originalLink===document.querySelector('.unavailable-file-link'),text:window.getSelection().toString()}));
 console.log('after selectionchange',JSON.stringify(after));
 assert.equal(after.sameNode,true,'file text DOM replaced by selection toolbar render');
 assert.equal(after.text,expected,'native file selection lost after toolbar render');
 await page.evaluate(()=>window.refreshFixture());
 await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.originalLink===document.querySelector('.unavailable-file-link')),true,'file text remounted on fresh message/callback props');
 assert.equal(await page.evaluate(()=>window.getSelection().toString()),expected);
 // Include plain label and file text: both must share one selectable scope.
 const full=await page.evaluate(()=>{
  const range=document.createRange();range.selectNodeContents(document.querySelector('.markdown li'));
  window.getSelection().removeAllRanges();window.getSelection().addRange(range);return range.toString();
 });
 await page.waitForTimeout(150);
 await page.locator('.ask-agent-selection').click();
 assert.equal(await page.evaluate(()=>window.quotedText),full,'cross-boundary quote omitted or changed');
 // Real mouse drag through the file name while the toolbar updates.
 const points=await page.evaluate(()=>{
  window.getSelection().removeAllRanges();
  const node=document.querySelector('.unavailable-file-link').firstChild;
  const rect=(start,end)=>{const r=document.createRange();r.setStart(node,start);r.setEnd(node,end);return r.getBoundingClientRect();};
  const first=rect(0,1),last=rect(node.textContent.length-1,node.textContent.length);
  return {x1:first.left+1,y:first.top+first.height/2,x2:last.right-1};
 });
 await page.mouse.move(points.x1,points.y);await page.mouse.down();
 for(let i=1;i<=20;i++){await page.mouse.move(points.x1+(points.x2-points.x1)*i/20,points.y);await page.waitForTimeout(20);}
 await page.mouse.up();await page.waitForTimeout(150);
 const dragged=await page.evaluate(()=>window.getSelection().toString());
 assert.ok(dragged.includes('示例视频 day 1 sample.mp4'),`file name drag failed: ${dragged}`);
 console.log('PASS: native selection, DOM identity, refreshed props, cross-boundary quote, actual mouse drag');
} finally {await browser?.close();await server.close();}
