// Exercise real file links and reader chrome through trusted browser clicks.
// API fixtures isolate navigation from storage; production acceptance is separate.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {FileCard, AssistantFileLink, AssistantFileLinkContext, RemoteFileCard} from '/src/App.tsx';
import {PublicSharesDialog} from '/src/public-shares-dialog.tsx';
import '/src/styles.css';
const files = ['html', 'markdown', 'pdf', 'epub'].map(kind => ({id:kind, original_name:'fixture.'+(kind==='markdown'?'md':kind), relative_path:'outputs/fixture.'+kind, mime_type: {html:'text/html', markdown:'text/markdown', pdf:'application/pdf', epub:'application/epub+zip'}[kind],size:100,kind:'output'}));
async function fetchRemote() { await new Promise(resolve=>setTimeout(resolve,100)); if(window.failRemote) throw Error('fixture transfer failed'); return files[0]; }
createRoot(document.getElementById('root')).render(<div id="fixture-home">
<h1>导航验收来源页</h1>{files.map(file=><FileCard key={file.id} file={file}/>)}
<AssistantFileLinkContext.Provider value={{files, messageId:'fixture',remoteFileFetchEnabled:true,onFetchRemoteFile:fetchRemote}}><AssistantFileLink href="outputs/fixture.html">正文阅读链接</AssistantFileLink><AssistantFileLink href="outputs/remote.html">远端正文链接</AssistantFileLink></AssistantFileLinkContext.Provider>
<RemoteFileCard sourcePath="outputs/remote.html" onFetch={fetchRemote}/>
{location.search.includes('shares')&&<PublicSharesDialog onClose={()=>{}}/>}
</div>);
`;
const server = await createServer({configFile:false,base:'/codex-web/',server:{host:'127.0.0.1',port:0}, plugins:[react(),{
  name:'reader-navigation-fixture',enforce:'pre',
  resolveId(id){if(id==='/__navigation.tsx')return id;},
  load(id){if(id==='/__navigation.tsx')return harness;},
  transform(code,id){if(id.endsWith('/src/App.tsx'))return code+'\nexport {FileCard, AssistantFileLink, AssistantFileLinkContext, RemoteFileCard};';},
  configureServer(instance){instance.middlewares.use((req,res,next)=>{
    const pathname = req.url?.split('?')[0].replace(/^\/codex-web(?=\/|$)/, '') || '/';
    if(!['/','/__reader-navigation'].includes(pathname))return next();
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/codex-web/@vite/client"></script><script type="module">import RefreshRuntime from "/codex-web/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/codex-web/__navigation.tsx"></script></body></html>');
  });}
}]});
let browser;
let checks=0;
try {
  await server.listen();
  const origin=`http://127.0.0.1:${server.httpServer.address().port}/codex-web`;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,ignoreDefaultArgs:['--disable-dev-shm-usage'],args:['--no-sandbox','--disable-gpu']});
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:844}});
    const page=await context.newPage();
    const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/api/**',route=>{
      const url=new URL(route.request().url()), p=url.pathname.replace(/^\/codex-web(?=\/)/, '');
      const json=body=>route.fulfill({json:body});
      if(p==='/api/auth/session')return json({authenticated:true,accountId:'fixture',username:'demo-owner',csrfToken:'fixture',features:{paraBoard:false,revision:1}});
      if(p==='/api/user-settings/features')return json({paraBoard:false,revision:1});
      if(p.endsWith('/activity'))return json({});
      if(p==='/api/public-shares')return json({shares:[{id:'share',fileId:'html',fileName:'fixture.html',documentKind:'html',size:100,expiresAt:'2099-01-01T00:00:00Z',publicUrl:origin+'/files/html/preview/public'}]});
      if(p.includes('/preview/content')||p.includes('/preview/public/content'))return json({content:'<h1>导航阅读正文</h1><h2>第一节</h2><p>用于导航验收。</p><h2>第二节</h2><p>正文。</p>'});
      if(/\/preview(?:\/public)?$/.test(p)){
        const id=p.split('/')[3];
        if(id==='missing')return route.fulfill({status:404,json:{error:'文件不存在'}});
        return json({file:{id,original_name:'fixture.'+id,mime_type:'text/html',size:100},content:'<h1>导航阅读正文</h1><p>公开正文。</p>',conversation:{id:'conversation',title:'导航测试',status:'idle'},share:{enabled:false}});
      }
      if(p.endsWith('/manifest'))return json({source:{format:'html'},version:{id:'version'}});
      if(p.endsWith('/annotations'))return json({annotations:[]});
      return route.fulfill({status:404,json:{error:'Unknown fixture API'}});
    });
    const home=async()=>{await page.goto(origin+'/__reader-navigation');await page.locator('#fixture-home').waitFor();};
    const returned=async()=>{await page.getByRole('link',{name:'返回工作站',exact:true}).click();await page.locator('#fixture-home').waitFor();assert.equal(context.pages().length,1);checks++;};
    await home();
    const initialHistory=await page.evaluate(()=>history.length);
    const entries=['.file-card > a[href="/codex-web/files/html/preview"]:not(.preview-button)',...['html','markdown','pdf','epub'].map(id=>`.preview-button[href="/codex-web/files/${id}/preview"]`),'text=正文阅读链接'];
    for(const selector of entries){
      await page.locator(selector).click();await page.getByRole('link',{name:'返回工作站',exact:true}).waitFor();
      assert.match(page.url(),/\/files\/[^/]+\/preview$/);assert.equal(context.pages().length,1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);checks+=3;
      await returned();
    }
    assert.ok(await page.evaluate(()=>history.length)<=initialHistory+1);checks++;
    // Modifier keys and middle click continue to keep the source page open.
    for(const clickOptions of [{modifiers:['Alt']},{modifiers:['Control']},{button:'middle'}]){
      const [tab]=await Promise.all([context.waitForEvent('page'),page.locator('.preview-button[href="/codex-web/files/html/preview"]').click(clickOptions)]);
      await tab.getByRole('link',{name:'返回工作站',exact:true}).waitFor();
      assert.ok(page.url().endsWith('/__reader-navigation'));assert.equal(context.pages().length,2);
      assert.equal(await tab.evaluate(()=>window.opener===null),true);
      await tab.getByRole('link',{name:'返回工作站',exact:true}).click();await tab.locator('#fixture-home').waitFor();await tab.close();checks+=4;
    }
    for(const selector of ['.remote-file-card-main','text=远端正文链接']){
      await page.locator(selector).click();await page.waitForURL('**/files/html/preview');await returned();
      const [tab]=await Promise.all([context.waitForEvent('page'),page.locator(selector).click({modifiers:['Alt']})]);
      await tab.waitForURL('**/files/html/preview');assert.equal(await tab.evaluate(()=>opener===null),true);await tab.close();checks+=2;
    }
    await page.evaluate(()=>window.failRemote=true);
    const [failedTab]=await Promise.all([context.waitForEvent('page'),page.locator('.remote-file-card-main').click({modifiers:['Alt']})]);
    await page.locator('.remote-file-card.failed').waitFor();assert.equal(failedTab.isClosed(),true);assert.equal(context.pages().length,1);checks+=2;
    await page.goto(origin+'/files/missing/preview');await page.getByText('暂时无法在线阅读',{exact:true}).waitFor();await returned();
    // A directly opened reader has no in-app predecessor; return still works.
    const direct=await context.newPage();await direct.goto(origin+'/files/html/preview');await direct.getByRole('link',{name:'返回工作站',exact:true}).click();await direct.locator('#fixture-home').waitFor();await direct.close();checks++;
    // A same-origin page outside this application is not an in-app return target.
    for (const outsidePath of ['/outside-app', '/codex-web-other']) {
      const outside=await context.newPage();
      await outside.route('**'+outsidePath, route=>route.fulfill({contentType:'text/html',body:`<a href="${origin}/files/html/preview">Open reader</a>`}));
      await outside.goto(new URL(origin).origin+outsidePath);
      await outside.getByRole('link',{name:'Open reader',exact:true}).click();
      await outside.getByRole('link',{name:'返回工作站',exact:true}).waitFor();
      assert.equal(new URL(await outside.evaluate(()=>document.referrer)).pathname,outsidePath);
      await outside.getByRole('link',{name:'返回工作站',exact:true}).click();
      await outside.locator('#fixture-home').waitFor();
      assert.equal(new URL(outside.url()).pathname,'/codex-web');
      assert.equal(await outside.locator('#fixture-home').count(),1);checks+=3;
      await outside.close();
    }
    await page.goto(origin+'/?shares');
    for (const selector of ['.public-share-title', '.public-share-actions a']) {
      await page.locator(selector).click();await page.getByRole('link',{name:'返回工作站',exact:true}).waitFor();
      assert.equal(context.pages().length,1);await returned();checks++;
    }
    const [sharedTab]=await Promise.all([context.waitForEvent('page'),page.locator('.public-share-title').click({modifiers:['Alt']})]);
    await sharedTab.getByRole('link',{name:'返回工作站',exact:true}).waitFor();await sharedTab.close();checks++;
    assert.deepEqual(errors,[]);checks++;
    await context.close();
    console.log(`${width}px navigation passed`);
  }
  console.log(JSON.stringify({passed:true,checks}));
} finally {await browser?.close();await server.close();}
