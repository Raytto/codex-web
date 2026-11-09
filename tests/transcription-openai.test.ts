import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../server/config.js";
import { loadTranscriptionConfig } from "../server/transcription-config.js";
import { buildOpenAITranscriptionPrompt, selectTranscriptionKeywords, TranscriptionService, transcriptionIdentity } from "../server/transcription.js";
import { OPENAI_TRANSCRIPTION_MAX_BYTES, transcribeOpenAI, openaiTranscriptionFetch } from "../server/transcription-openai.js";

function wav(seconds = 1) {
  const b = Buffer.alloc(44 + seconds * 32000);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24); b.writeUInt32LE(32000,28);
  b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write("data",36); b.writeUInt32LE(b.length-44,40);
  for(let i=44;i<b.length;i+=2) b.writeInt16LE(Math.round(Math.sin(i/2 * Math.PI/40) * 3000),i);
  return b;
}
function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcribe-provider-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const config = loadConfig({ dataRoot: root, transcriptionProvider: "openai", openaiTranscriptionApiKey: "fixture-key", openaiTranscriptionModel: "gpt-transcribe",
    dashscopeApiKey: "", openaiTranscriptionLanguages: ["zh","en"], transcriptionTimeoutMs: 2000 });
  const filePath = path.join(root,"input.wav"); fs.writeFileSync(filePath,wav());
  return {root,config,filePath};
}
test("provider compatibility and explicit language/proxy configuration", () => {
  const ali = loadTranscriptionConfig({transcriptionProvider:"dashscope"});
  assert.equal(ali.transcriptionProvider,"dashscope");
  assert.equal(loadTranscriptionConfig({openaiTranscriptionLanguages:[]}).openaiTranscriptionLanguages.length,0);
  assert.deepEqual(loadTranscriptionConfig({openaiTranscriptionLanguages:["zh","en","zh"]}).openaiTranscriptionLanguages,["zh","en"]);
  assert.throws(()=>loadTranscriptionConfig({transcriptionProvider:"unknown" as "openai"}));
  assert.throws(()=>loadTranscriptionConfig({openaiTranscriptionLanguages:["zh-CN"]}));
  assert.throws(()=>loadTranscriptionConfig({openaiTranscriptionProxy:""}));
  const c=loadConfig({transcriptionProvider:"dashscope",openaiTranscriptionApiKey:"",openaiTranscriptionModel:"gpt-transcribe",dashscopeApiKey:"ali-only"});
  assert.equal(transcriptionIdentity(c).provider,"dashscope");
  assert.equal(transcriptionIdentity({...c,transcriptionProvider:"openai"}).model,"gpt-transcribe");
});
test("keyword validation keeps whole canonical terms and prompt excludes the keyword list", () => {
  const picked=selectTranscriptionKeywords([" PP Agent ","PP  Agent","", "  ", "<bad>","line\rbreak","line\nbreak","x".repeat(161),"AtlasWidget","AtlasWidget"]);
  assert.deepEqual(picked.values,["PP Agent","AtlasWidget"]); assert.equal(picked.skipped,8);
  assert.deepEqual(selectTranscriptionKeywords(["12345678","AB"],2).values,["AB"]);
  const prompt=buildOpenAITranscriptionPrompt({draftText:"Project background",personalizedTerms:["AtlasWidget"],recentMessages:[{role:"system",content:"not context"}]},100);
  assert.match(prompt,/Project background/); assert.doesNotMatch(prompt,/AtlasWidget|not context|常用技术词/);
});
test("actual serialized multipart separates context, keyword and language arrays; text-only OpenAI skips image preparation", async t => {
  const f=setup(t);let count=0,seconds=0,images=0;
  const fake=(async (url,init)=>{
    count++; assert.match(String(url),/\/v1\/audio\/transcriptions$/);
    const wire=new Request(String(url),init); const bytes=await wire.arrayBuffer();
    const form=await new Response(bytes,{headers:{"content-type":wire.headers.get("content-type")!}}).formData();
    assert.deepEqual(form.getAll("keywords[]"),["PP Agent","AtlasWidget"]);
    assert.deepEqual(form.getAll("languages[]"),["zh","en"]); assert.equal(form.has("language"),false);
    assert.equal(form.get("model"),"gpt-transcribe");assert.equal(form.get("response_format"),"json");
    assert.match(String(form.get("prompt")),/Project background/);assert.doesNotMatch(String(form.get("prompt")),/AtlasWidget/);
    assert.equal((form.get("file") as File).type,"audio/wav");
    assert.deepEqual([...form.keys()].sort(),["file","keywords[]","keywords[]","languages[]","languages[]","model","prompt","response_format"].sort());
    return Response.json({text:"不改成 12，keep 20 ms.",usage:{type:"duration",seconds:1}});
  }) as typeof fetch;
  const service=new TranscriptionService(f.config,fake,async (_i,o)=>fs.writeFileSync(o,wav()),async()=>{images++;return [];});
  const name=crypto.randomUUID()+".wav";const original=wav();fs.writeFileSync(path.join(service.audioRoot,name),original);
  assert.equal(await service.transcribe(name,{draftText:"Project background",personalizedTerms:["PP Agent","AtlasWidget"],attachments:[{name:"photo.png",mimeType:"image/png"}]},{onUsage:s=>{seconds=s;}}),"不改成 12，keep 20 ms.");
  assert.equal(seconds,1);assert.equal(count,1);assert.equal(images,0);assert.deepEqual(fs.readFileSync(path.join(service.audioRoot,name)),original);
  assert.deepEqual(fs.readdirSync(service.audioRoot),[name]);
});
test("permanent errors, empty 200, transient retry, duration usage and cancellation", async t => {
  const f=setup(t);
  const base={...f,prompt:"background",keywords:["PP Agent"],timing:()=>{},retryDelays:[0,0],options:{}};
  for(const [status,body,match] of [
    [401,{},/认证/],[403,{},/权限/],[400,{},/参数/],[413,{},/大小/],
    [429,{error:{code:"credit_balance_exhausted"}},/额度不足/],[200,{text:" "},/清晰语音/],
  ] as const){let calls=0;await assert.rejects(()=>transcribeOpenAI({...base,fetch:(async()=>{calls++;return Response.json(body,{status});}) as typeof fetch}),match);assert.equal(calls,1);}
  let calls=0;
  assert.equal(await transcribeOpenAI({...base,fetch:(async()=>{calls++;return calls<3?Response.json({},{status:calls===1?429:503}):Response.json({text:"ok"});}) as typeof fetch}),"ok");assert.equal(calls,3);
  const controller=new AbortController();calls=0;
  await assert.rejects(()=>transcribeOpenAI({...base,options:{signal:controller.signal},fetch:(async()=>{calls++;controller.abort();throw new Error("abort");}) as typeof fetch}),{name:"AbortError"});assert.equal(calls,1);
  await assert.rejects(()=>transcribeOpenAI({...base,config:{...f.config,transcriptionTimeoutMs:1},fetch:(async(_u,i)=>{await new Promise((_,reject)=>{i!.signal!.addEventListener("abort",()=>reject(new Error("timeout")));setTimeout(()=>{},5);});return Response.json({});}) as typeof fetch}),/超时/);
});
test("oversized converted file is rejected before network and missing proxy never falls back direct", async t => {
  const f=setup(t); fs.truncateSync(f.filePath,OPENAI_TRANSCRIPTION_MAX_BYTES+1);
  await assert.rejects(()=>transcribeOpenAI({...f,prompt:"",keywords:[],options:{},timing:()=>{},retryDelays:[],fetch:(async()=>{assert.fail("no network");}) as typeof fetch}),/25 MB/);
  const old=process.env.CODEX_PRIMARY_HTTP_PROXY;delete process.env.CODEX_PRIMARY_HTTP_PROXY;
  try{await assert.rejects(()=>openaiTranscriptionFetch("https://api.openai.com/v1/audio/transcriptions",{method:"POST"},"codex"),/代理未配置/);}finally{if(old!==undefined)process.env.CODEX_PRIMARY_HTTP_PROXY=old;}
});
test("ten minutes survives real PCM conversion below provider size cap without truncating the tail", async t => {
  const f=setup(t);let bytes=0;
  const service=new TranscriptionService(f.config,(async(_u,init)=>{const form=init!.body as FormData;const b=Buffer.from(await (form.get("file") as File).arrayBuffer());bytes=b.length;assert.equal(b.readUInt32LE(24),16000);assert.ok(b.subarray(-32000).some(n=>n!==0));return Response.json({text:"tail present"});}) as typeof fetch);
  const name=crypto.randomUUID()+".wav", original=wav(600);fs.writeFileSync(path.join(service.audioRoot,name),original);
  assert.equal(await service.transcribe(name),"tail present");assert.ok(bytes>=19_200_000&&bytes<OPENAI_TRANSCRIPTION_MAX_BYTES);
  assert.deepEqual(fs.readFileSync(path.join(service.audioRoot,name)),original);
});
