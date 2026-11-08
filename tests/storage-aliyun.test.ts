import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {AliyunStorageReader} from '../server/storage-aliyun-reader.js';

function fixture(t:test.TestContext,fetcher:typeof fetch,refresh=async()=>undefined){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-storage-cloud-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const configFile=path.join(root,'config');fs.writeFileSync(configFile,JSON.stringify({activeUID:'test',userList:[{userId:'test',openapiToken:{accessToken:'synthetic-test-token',expired:Math.floor(Date.now()/1000)+3600}}]}),{mode:0o600});
 let now=Date.now();const waits:number[]=[],clock={now:()=>now,wait:async(ms:number)=>{waits.push(ms);now+=ms;}};
 const reader=new AliyunStorageReader({configFile,driveId:'test',allowedRoots:['/test'],writeRoot:'/test',writeStateRoot:path.join(root,'intents'),fetch:fetcher,refresh,rangeBytes:16,apiClock:clock,requestIntervalMs:1000});return {root,reader,clock,waits};
}
test('cloud range retry resumes after delivered bytes; signed hosts never receive account authorization',async t=>{
 const starts:number[]=[];let urls=0;
 const {reader}=fixture(t,(async(url,init)=>{
  if(String(url).includes('openapi.alipan.com')){urls++;return Response.json({url:'https://test.aliyuncs.com/object',size:10,expiration:new Date(Date.now()+600_000).toISOString()});}
  const headers=new Headers(init?.headers);assert.equal(headers.has('authorization'),false);const start=Number(headers.get('range')!.match(/bytes=(\d+)/)![1]);starts.push(start);
  return new Response(start===0?'012':'3456789',{status:206,headers:{'content-range':`bytes ${start}-9/10`}});
 }) as typeof fetch);
 const buffers=[];for await(const chunk of await reader.stream('/test/file',10,'known-id'))buffers.push(chunk);
 assert.equal(Buffer.concat(buffers).toString(),'0123456789');assert.deepEqual(starts,[0,3]);assert.equal(urls,2);
});
test('authentication refresh is bounded and failed authorization or quota never becomes a successful verification',async t=>{
 let calls=0,refreshes=0;
 const {reader}=fixture(t,(async()=>{calls++;return new Response('',{status:401});}) as typeof fetch,async()=>{refreshes++;});
 await assert.rejects(reader.assertPresent('/test/file',12,'known-id'),/http_401/);assert.equal(calls,2);assert.equal(refreshes,1);
 const quota=fixture(t,(async()=>new Response('',{status:507})) as typeof fetch);
 await assert.rejects(quota.reader.assertPresent('/test/file',12,'known-id'),/http_507/);
});
test('signed URL validation and write boundaries fail before untrusted network or filesystem changes',async t=>{
 let calls=0;
 const {reader,root}=fixture(t,(async()=>{calls++;return Response.json({url:'https://untrusted.example/object',size:10,expiration:new Date(Date.now()+600_000).toISOString()});}) as typeof fetch);
 const stream=await reader.stream('/test/file',10,'known');await assert.rejects(async()=>{for await(const _ of stream){/* consume */}},/host_invalid/);assert.equal(calls,1);
 const file=path.join(root,'original');fs.writeFileSync(file,'unique');
 await assert.rejects(reader.putImmutable(file,'/another-account/file'),/write_scope/);assert.equal(fs.readFileSync(file,'utf8'),'unique');assert.equal(calls,1);
 await assert.rejects(reader.deleteExact('/test/../another-account/file','known',6),/write_scope/);
});
test('cloud throttling honors numeric and HTTP-date Retry-After before a successful read',async t=>{
 const starts:number[]=[];
 const f=fixture(t,(async()=>{
  starts.push(f.clock.now());
  if(starts.length===1)return new Response('',{status:429,headers:{'retry-after':'3'}});
  if(starts.length===2)return new Response('',{status:429,headers:{'retry-after':new Date(f.clock.now()+6000).toUTCString()}});
  return Response.json({url:'https://test.aliyuncs.com/object',size:12});
 }) as typeof fetch);
 await f.reader.assertPresent('/test/file',12,'known');assert.equal(starts.length,3);
 assert.ok(starts[1]-starts[0]>=3000);assert.ok(starts[2]-starts[1]>=5000);
});
test('persistent rate limiting is bounded and cannot become successful verification',async t=>{
 let calls=0;const f=fixture(t,(async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'invalid'}});}) as typeof fetch);
 await assert.rejects(f.reader.assertPresent('/test/file',12,'known'),/http_429/);
 assert.equal(calls,6);assert.ok(f.waits.reduce((a,b)=>a+b,0)<=120000);
 const cooldown=JSON.parse(fs.readFileSync(path.join(f.root,'intents/api-cooldown.json'),'utf8'));
 assert.ok(cooldown.notBefore>f.clock.now());assert.equal(JSON.stringify(cooldown).includes('synthetic-test-token'),false);
});
test('a long provider cooldown survives a fresh reader without new network calls or an unbounded wait',async t=>{
 let calls=0;const f=fixture(t,(async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'600'}});}) as typeof fetch);
 await assert.rejects(f.reader.assertPresent('/test/file',12,'known'),/http_429/);assert.equal(calls,1);assert.deepEqual(f.waits,[]);
 // Different config pathname avoids the in-process queue: this must read the durable cooldown.
 const configFile=path.join(f.root,'recovered-config');fs.copyFileSync(f.reader.config.configFile,configFile);fs.chmodSync(configFile,0o600);
 const next=new AliyunStorageReader({...f.reader.config,configFile,fetch:(async()=>{calls++;return Response.json({url:'https://test.aliyuncs.com/object',size:12});}) as typeof fetch});
 await assert.rejects(next.assertPresent('/test/file',12,'known'),/http_429/);assert.equal(calls,1);assert.deepEqual(f.waits,[]);
 await f.clock.wait(600000);await next.assertPresent('/test/file',12,'known');assert.equal(calls,2);
});
test('parallel readers sharing credentials serialize and pace requests',async t=>{
 const starts:number[]=[];let active=0,maxActive=0;
 const f=fixture(t,(async()=>{
  active++;maxActive=Math.max(maxActive,active);starts.push(f.clock.now());await Promise.resolve();active--;
  return Response.json({url:'https://test.aliyuncs.com/object',size:12});
 }) as typeof fetch);
 const other=new AliyunStorageReader({...f.reader.config});
 await Promise.all([f.reader,other,f.reader].map(r=>r.assertPresent('/test/file',12,'known')));
 assert.equal(maxActive,1);assert.equal(starts.length,3);
 assert.ok(starts[1]-starts[0]>=1000);assert.ok(starts[2]-starts[1]>=1000);
});
test('throttling does not consume or reset the bounded authentication retry',async t=>{
 let calls=0,refreshes=0;
 const f=fixture(t,(async()=>{calls++;return new Response('',{status:calls===2?429:401});}) as typeof fetch,async()=>{refreshes++;});
 await assert.rejects(f.reader.assertPresent('/test/file',12,'known'),/http_401/);assert.equal(calls,3);assert.equal(refreshes,1);
});
test('a throttled immutable create retries the same fixed identity and commits only once',async t=>{
 const creates:string[]= [];let commits=0,uploads=0;
 const f=fixture(t,(async(url,init)=>{
  const endpoint=String(url).split('/').pop(),body=typeof init?.body==='string'?JSON.parse(init.body):{};
  if(endpoint==='list')return Response.json({items:body.parent_file_id==='root'?[{file_id:'folder',name:'test',type:'folder',size:0}]:[]});
  if(endpoint==='create'){
   creates.push(String(init?.body));if(creates.length===1)return new Response('',{status:429,headers:{'retry-after':'2'}});
   return Response.json({file_id:'file',upload_id:'upload',part_info_list:[{part_number:1,upload_url:'https://test.aliyuncs.com/upload'}]});
  }
  if(endpoint==='upload'){uploads++;for await(const _ of init!.body as unknown as AsyncIterable<Buffer>){/* consume the upload as fetch does */}return new Response('',{status:200});}
  if(endpoint==='complete'){commits++;return Response.json({file_id:'file',size:6});}
  throw new Error('unexpected request');
 }) as typeof fetch);
 const source=path.join(f.root,'source');fs.writeFileSync(source,'unique');await f.reader.putImmutable(source,'/test/file');
 assert.equal(creates.length,2);assert.equal(creates[0],creates[1]);assert.equal(uploads,1);assert.equal(commits,1);
 assert.equal(f.reader.fileId('/test/file'),'file');assert.equal(fs.readFileSync(source,'utf8'),'unique');
});

test('interactive restores have no application pacing and do not wait behind a background request',{timeout:3000},async t=>{
 let backgroundStarted!:()=>void,releaseBackground!:()=>void;
 const started=new Promise<void>(resolve=>{backgroundStarted=resolve;}),hold=new Promise<void>(resolve=>{releaseBackground=resolve;});
 const f=fixture(t,(async()=>{backgroundStarted();await hold;return Response.json({url:'https://test.aliyuncs.com/object',size:12});}) as typeof fetch);
 const background=f.reader.assertPresent('/test/file',12,'known');await started;
 let foregroundCalls=0;const waits:number[]=[];
 const foreground=new AliyunStorageReader({...f.reader.config,requestIntervalMs:0,
  apiClock:{now:f.clock.now,wait:async ms=>{waits.push(ms);}},
  fetch:(async()=>{foregroundCalls++;return Response.json({url:'https://test.aliyuncs.com/object',size:12});}) as typeof fetch});
 try{
  await Promise.all([foreground.assertPresent('/test/file',12,'known'),foreground.assertPresent('/test/file',12,'known')]);
  assert.equal(foregroundCalls,2);assert.deepEqual(waits,[]);
 }finally{releaseBackground();await background;}
});
test('background range reads and immutable upload data share the same paced request budget',async t=>{
 const calls:Array<{at:number;method:string}>=[];
 const f=fixture(t,(async(url,init)=>{
  calls.push({at:f.clock.now(),method:init?.method??'GET'});
  const endpoint=String(url).split('/').pop(),body=typeof init?.body==='string'?JSON.parse(init.body):{};
  if(endpoint==='getDownloadUrl')return Response.json({url:'https://test.aliyuncs.com/download',size:3});
  if(endpoint==='download')return new Response('abc',{status:206,headers:{'content-range':'bytes 0-2/3'}});
  if(endpoint==='list')return Response.json({items:body.parent_file_id==='root'?[{file_id:'folder',name:'test',type:'folder',size:0}]:[]});
  if(endpoint==='create')return Response.json({file_id:'file',upload_id:'upload',part_info_list:[{part_number:1,upload_url:'https://test.aliyuncs.com/upload'}]});
  if(endpoint==='upload'){for await(const _ of init!.body as unknown as AsyncIterable<Buffer>){}return new Response('',{status:200});}
  if(endpoint==='complete')return Response.json({file_id:'file',size:3});
  throw Error('unexpected request');
 }) as typeof fetch);
 for await(const _ of await f.reader.stream('/test/input',3,'known')){}
 const source=path.join(f.root,'source');fs.writeFileSync(source,'abc');await f.reader.putImmutable(source,'/test/output');
 assert.ok(calls.some(c=>c.method==='GET'));assert.ok(calls.some(c=>c.method==='PUT'));
 for(let i=1;i<calls.length;i++)assert.ok(calls[i].at-calls[i-1].at>=1000);
});
