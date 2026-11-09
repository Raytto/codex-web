import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DotCall } from '../server/dot-live.js';
import { VoiceTranscripts } from '../server/voice-transcripts.js';
import { VoiceRecovery } from '../src/voice-recovery.js';

function fixture() {
  const browser=new EventEmitter(),sent:any[]=[],upstream:any[]=[],records:any[]=[],writes:any[]=[];
  const scope={fragment:()=>true,record:(...v:any[])=>records.push(v),event:()=>{},checkpoint:()=>({}),callTable:'calls'};
  const gateway={scope:()=>scope,store:{sql:{prepare:()=>({run:(...v:any[])=>writes.push(v)})}},allCalls:new Set()};
  const call=new DotCall(gateway as any,{} as any,browser as any),c=call as any;
  let closed=false,startCount=0;
  const ws=new EventEmitter() as any;ws.readyState=1;ws.send=(e:string)=>upstream.push(JSON.parse(e));
  ws.close=()=>{closed=true;ws.readyState=3;ws.emit('close');};ws.terminate=ws.close;
  Object.assign(c,{upstream:ws,callId:'old',started:true,upstreamGeneration:1});
  call.send=e=>sent.push(e);call.up=e=>upstream.push(e);
  call.start=async()=>{assert.ok(closed,'old transport must be closed before replacement');startCount++;Object.assign(c,{callId:'new',upstreamGeneration:2});c.event({type:'session.started'});};
  return {call,c,sent,records,writes,upstream,ws,startCount:()=>startCount,receive:(m:any)=>browser.emit('message',JSON.stringify(m)),event:(e:any)=>c.event(e),finish:()=>c.event({type:'session.closed',usage:{}})};
}

test('stop and late transcript/PCM cannot reopen playback; only replacement session may bind',async()=>{
  const f=fixture();f.receive({type:'stop_audio',recoveryId:1});
  f.event({type:'session.output_audio.delta',delta:'old'});
  f.event({type:'session.input_transcript.delta',event_id:'late',delta:'old words',start_ms:0,end_ms:200});
  f.event({type:'session.instructions.appended'});
  assert.equal(f.sent.filter(e=>e.type==='audio').length,0);assert.equal(f.startCount(),0);
  f.receive({type:'resume_audio',recoveryId:0});assert.equal(f.startCount(),0);
  f.receive({type:'resume_audio',recoveryId:1});assert.equal(f.startCount(),0);
  f.finish();await new Promise(r=>setImmediate(r));assert.equal(f.startCount(),1);
  f.event({type:'session.output_audio.delta',delta:'fresh'});
  assert.deepEqual(f.sent.filter(e=>e.type==='audio').map(e=>[e.delta,e.callId,e.recoveryId]),[['fresh','new',1]]);
  assert.equal(f.records[0][1],'old words');
});
test('duplicate invalidations close once; stale playback receipts cannot mark new audio played',async()=>{
  const f=fixture();f.receive({type:'resync',recoveryId:1});f.receive({type:'resync',recoveryId:1});
  assert.equal(f.upstream.filter(e=>e.type==='session.close').length,1);
  f.receive({type:'played',callId:'old',recoveryId:0,seq:999});assert.equal(f.c.played,0);
  f.finish();await new Promise(r=>setImmediate(r));f.receive({type:'resume_audio',recoveryId:1});
  f.event({type:'session.output_audio.delta',delta:'fresh'});
  f.receive({type:'played',callId:'old',recoveryId:1,seq:1});assert.equal(f.c.played,0);
  f.receive({type:'played',callId:'new',recoveryId:1,seq:1});assert.equal(f.c.played,1);
});
test('ordinary input fragments do not clear audio, rotate, or append resume commands',()=>{
  const f=fixture();for(const delta of ['Hello',' there'])f.event({type:'session.input_transcript.delta',delta});
  assert.deepEqual(f.upstream,[]);assert.equal(f.sent.filter(e=>e.type==='clear_audio').length,0);clearTimeout(f.c.textTimer);
});
test('queued delegation is invalidated before dispatch, but no task cancellation is sent',async()=>{
  const f=fixture();let delegates=0;f.c.scope.delegate=async()=>{delegates++;};
  f.event({type:'session.delegation.created',delegation:{id:'old-task'}});
  assert.equal(f.c.delegationTimers.size,1);f.receive({type:'resync',recoveryId:1});assert.equal(f.c.delegationTimers.size,0);
  f.finish();await new Promise(r=>setImmediate(r));assert.equal(delegates,0);
  assert.ok(f.upstream.every(e=>!String(e.type).includes('cancel')));
});
test('timestamped overlapping fragments are grouped in event order, not fixed role order',()=>{
  const saved:any[]=[],t=new VoiceTranscripts(s=>saved.push(s)),birth=Date.UTC(2026,0,1);
  t.add('assistant',{event_id:'a',delta:'Old answer',start_ms:100,end_ms:400},'one',birth);
  t.add('user',{event_id:'b',delta:'New ',start_ms:300,end_ms:500},'one',birth);
  t.add('user',{event_id:'c',delta:'request',start_ms:510,end_ms:700},'one',birth);
  t.add('assistant',{event_id:'d',delta:'Late but earlier',start_ms:0,end_ms:50},'one',birth,true);
  t.flush();assert.deepEqual(saved.map(s=>[s.role,s.text]),[['assistant','Late but earlier'],['assistant','Old answer'],['user','New request']]);
  assert.equal(saved[2].createdAt,'2026-01-01T00:00:00.300Z');assert.equal(saved[0].withheld,true);
  t.add('user',{event_id:'late',delta:'earlier user',start_ms:60,end_ms:80},'one',birth);t.flush();assert.equal(saved[3].createdAt,'2026-01-01T00:00:00.060Z');
  t.add('user',{event_id:'b',delta:'New ',start_ms:300,end_ms:500},'two',birth+10000);t.flush();assert.notEqual(saved[4].source,saved[2].source);
});
for(const stall of [2,5,10])test(`browser retains complete correction through ${stall}s recovery and rejects late binds`,()=>{
  const sent:any[]=[],issues:string[]=[],c=new VoiceRecovery(e=>sent.push(e),e=>issues.push(e));c.bind('old',0);
  c.activity(true,0,0);c.capture({seq:1,at:0,audio:'start'},.1);c.invalidate(1,'interruption',.1,0);
  for(let i=2;i<stall*10;i++)c.capture({seq:i,at:i/10,audio:`part${i}`},i/10);
  c.recoveryReady(1);assert.equal(sent.filter(e=>e.type==='resume_audio').length,0);
  c.activity(false,stall,0);assert.equal(sent.filter(e=>e.type==='resume_audio').length,1);
  assert.equal(c.bind('old',0),false);assert.equal(c.bind('old',1),false);assert.equal(c.bind('fresh',1),true);
  for(let i=0;i<stall*10+10;i++)c.drain(stall+3+i/10);
  const audio=sent.filter(e=>e.type==='audio');assert.equal(audio[0].audio,'start');assert.equal(new Set(audio.map(e=>e.captureSeq)).size,audio.length);
  assert.ok(audio.every(e=>e.callId==='fresh'&&e.recoveryId===1));assert.equal(issues.length,0);
});
test('stop waits for fresh actual activity; oversize recovery discards a whole utterance visibly',()=>{
  const sent:any[]=[],issues:string[]=[],c=new VoiceRecovery(e=>sent.push(e),e=>issues.push(e));c.bind('old',0);
  c.invalidate(1,'stop_audio',1,0);c.recoveryReady(1);c.activity(false,2,0);assert.equal(sent.filter(e=>e.type==='resume_audio').length,0);
  c.activity(true,3,3);for(let i=0;i<202;i++)c.capture({seq:i,at:3+i/10,audio:'x'},3+i/10);
  c.activity(false,25,3);assert.equal(sent.filter(e=>e.type==='resume_audio').length,0);assert.equal(c.bufferedFrames,0);assert.match(issues[0],/20秒/);
  c.activity(true,26,26);c.capture({seq:300,at:26,audio:'new complete input'},26);c.activity(false,28,26);
  assert.equal(sent.filter(e=>e.type==='resume_audio').length,1);
});
test('events from a physically replaced socket and old async callback are ignored',async()=>{
  const f=fixture();let resolve:any,executed=0;f.c.scope.delegate=()=>{executed++;return new Promise(r=>resolve=r);};
  f.event({type:'session.delegation.created',delegation:{id:'already-started'}});
  await new Promise(r=>setTimeout(r,1400));assert.equal(executed,1);
  f.receive({type:'resync',recoveryId:1});f.finish();await new Promise(r=>setImmediate(r));f.receive({type:'resume_audio',recoveryId:1});
  resolve({mode:'accepted',message:'old result'});await new Promise(r=>setImmediate(r));
  const n=f.sent.length;f.c.event({type:'session.output_audio.delta',delta:'old physical PCM'},1);f.c.event({type:'session.input_transcript.delta',delta:'old physical caption'},1);f.c.event({type:'session.closed'},1);
  assert.equal(f.sent.length,n);assert.equal(f.sent.filter(e=>e.type==='execution').length,0);assert.equal(f.c.callId,'new');
});
test('recovery input is paced in real time and long waiting silence does not overflow the saved utterance',()=>{
 const sent:any[]=[],c=new VoiceRecovery(e=>sent.push(e),()=>{});c.bind('old',0);c.activity(true,0,0);c.capture({seq:1,at:0,audio:'first'},0);c.invalidate(1,'interruption',.1,0);
 for(let i=2;i<=10;i++)c.capture({seq:i,at:i/10,audio:'part'},i/10);c.activity(false,2,0);
 for(let i=30;i<300;i++)c.capture({seq:i,at:i/10,audio:'silence'},i/10);assert.equal(c.bufferedFrames,10);
 c.recoveryReady(1);assert.equal(c.bind('new',1),true);c.drain(31);assert.equal(sent.filter(e=>e.type==='audio').length,1);for(let i=0;i<9;i++)c.drain(31+(i+1)/10);assert.equal(sent.filter(e=>e.type==='audio').length,10);
});
