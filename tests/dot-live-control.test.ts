import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DotCall } from '../server/dot-live.js';
import { VoiceTranscripts } from '../server/voice-transcripts.js';
import { VoiceRecovery } from '../src/voice-recovery.js';
import { getEncoding } from 'js-tiktoken';

const calls:any[]=[];test.afterEach(()=>{for(const c of calls.splice(0)){c.ended=true;clearInterval(c.outputTimer);clearInterval(c.inputTimer);clearTimeout(c.textTimer);for(const t of c.delegationTimers)clearTimeout(t);}});
function fixture() {
  const browser=new EventEmitter(),sent:any[]=[],upstream:any[]=[],records:any[]=[],writes:any[]=[];
  const scope={playback:()=>{},fragment:()=>true,record:(...v:any[])=>records.push(v),event:()=>{},checkpoint:()=>({}),callTable:'calls'};
  const gateway={scope:()=>scope,store:{sql:{prepare:()=>({run:(...v:any[])=>writes.push(v)})}},allCalls:new Set(),limits:{maxDurationMs:1200000}};
  const call=new DotCall(gateway as any,{} as any,browser as any),c=call as any;calls.push(c);
  let closed=false,startCount=0;
  const ws=new EventEmitter() as any;ws.readyState=1;ws.send=(e:string)=>upstream.push(JSON.parse(e));
  ws.close=()=>{closed=true;ws.readyState=3;ws.emit('close');};ws.terminate=ws.close;
  Object.assign(c,{upstream:ws,callId:'old',started:true,upstreamGeneration:1});
  call.send=e=>sent.push(e);call.up=e=>upstream.push(e);
  call.start=async()=>{assert.ok(closed,'old transport must be closed before replacement');startCount++;Object.assign(c,{callId:'new',upstreamGeneration:2});c.event({type:'session.started'});};
  return {call,c,sent,records,writes,upstream,ws,startCount:()=>startCount,receive:(m:any)=>browser.emit('message',JSON.stringify(m)),event:(e:any)=>c.event(e),finish:()=>c.event({type:'session.closed',usage:{}})};
}

test('stop fences the stream immediately, but only new credible speech opens the verified boundary',()=>{
  const f=fixture();f.receive({type:'interrupt',recoveryId:1,reason:'stop_audio'});
  const fence=f.c.fence;assert.ok(fence);assert.ok(f.upstream.some(e=>e.type==='session.output_audio.fixture.play'));
  f.event({type:'session.output_audio.delta',delta:Buffer.from('old').toString('base64')});
  f.event({type:'session.input_transcript.delta',event_id:'late',delta:'old words',start_ms:0,end_ms:200});
  f.event({type:'session.instructions.appended',client_event_id:fence.instructionId});
  assert.equal(f.sent.filter(e=>e.type==='playback_ready'||e.type==='audio').length,0);
  f.event({type:'session.output_audio.fixture.played',client_event_id:fence.fixtureId});
  f.event({type:'session.output_audio.delta',delta:Buffer.concat([Buffer.from('old late'),fence.marker.subarray(0,400)]).toString('base64')});
  f.event({type:'session.output_audio.delta',delta:Buffer.concat([fence.marker.subarray(400),Buffer.from('unrequested')]).toString('base64')});
  assert.equal(f.sent.filter(e=>e.type==='playback_ready'||e.type==='audio').length,0);
  f.receive({type:'speech',callId:'old',active:true});
  assert.equal(f.sent.filter(e=>e.type==='playback_ready').length,1);
  assert.equal(f.upstream.filter(e=>e.type==='session.output_audio.fixture.play').length,1,'do not erase the new answer at utterance-end');
  f.event({type:'session.output_audio.delta',delta:Buffer.from('fresh').toString('base64')});
  assert.deepEqual(f.sent.filter(e=>e.type==='audio').map(e=>[Buffer.from(e.delta,'base64').toString(),e.callId,e.recoveryId]),[['fresh','old',1]]);
  assert.equal(f.startCount(),0);assert.ok(f.upstream.every(e=>e.type!=='session.close'));
});
test('duplicate invalidations close once; stale playback receipts cannot mark new audio played',async()=>{
  const f=fixture();f.receive({type:'resync',recoveryId:1,reason:'transport_lost'});f.receive({type:'resync',recoveryId:1,reason:'transport_lost'});
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
for (const reason of ['interruption', 'output_congestion', 'transport_delay', 'capture_delay', undefined, 'unknown']) {
  test(`old resync ${reason} stops with a refresh instruction instead of rebuilding the upstream`, async () => {
    const f=fixture(); let closed=''; f.call.close=async reason=>{closed=reason;};
    f.receive({type:'resync',recoveryId:1,reason});
    assert.equal(closed,'client_protocol_mismatch');
    assert.ok(f.sent.some(e=>e.code==='client_protocol_mismatch'&&/刷新/.test(e.message)));
    assert.equal(f.upstream.filter(e=>e.type==='session.close').length,0);
    assert.equal(f.c.recoveryTimes.length,0);
  });
}
test('pending delegation survives physical recovery without early acceptance or cancellation',async()=>{
  const f=fixture();let delegates=0;f.c.scope.delegate=async()=>{delegates++;return {mode:'queued_next_turn'};};
  f.event({type:'session.delegation.created',delegation:{id:'old-task'}});
  assert.equal(f.c.delegationTimers.size,1);assert.ok(!f.upstream.some(e=>String(e.content).includes('交由')));
  f.receive({type:'resync',recoveryId:1,reason:'transport_lost'});assert.equal(f.c.delegationTimers.size,1);
  f.finish();await new Promise(r=>setImmediate(r));f.receive({type:'resume_audio',recoveryId:1});
  await new Promise(r=>setTimeout(r,1450));assert.equal(delegates,0,'a stalled microphone must not be mistaken for a finished request');
  f.receive({type:'audio',callId:'new',recoveryId:1,captureSeq:0,audio:'AAAAAA=='});
  await new Promise(r=>setTimeout(r,600));assert.equal(delegates,1);
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
  t.add('user',{event_id:'late',delta:'earlier user',start_ms:60,end_ms:80},'one',birth);t.flush();assert.equal(saved[3].createdAt,'2026-01-01T00:00:00.060Z');assert.equal(saved[3].source,saved[2].source);
  t.add('user',{event_id:'b',delta:'New ',start_ms:300,end_ms:500},'two',birth+10000);t.flush();assert.notEqual(saved[4].source,saved[2].source);
});
for(const stall of [2,5,10])test(`browser retains complete correction through ${stall}s recovery and rejects late binds`,()=>{
  const sent:any[]=[],issues:string[]=[],c=new VoiceRecovery(e=>sent.push(e),e=>issues.push(e));c.bind('old',0);
  c.activity(true,0,0);c.capture({seq:1,at:0,audio:'start'},.1);c.invalidate(1,'transport_lost',.1,0);
  for(let i=2;i<stall*10;i++)c.capture({seq:i,at:i/10,audio:`part${i}`},i/10);
  c.recoveryReady(1);assert.equal(sent.filter(e=>e.type==='resume_audio').length,1);
  c.activity(false,stall,0);assert.equal(sent.filter(e=>e.type==='resume_audio').length,1);
  assert.equal(c.bind('old',0),false);assert.equal(c.bind('old',1),false);assert.equal(c.bind('fresh',1),true);
  for(let i=0;i<stall*10+10;i++)c.drain(stall+3+i/10);
  const audio=sent.filter(e=>e.type==='audio');assert.equal(audio[0].audio,'start');assert.equal(new Set(audio.map(e=>e.captureSeq)).size,audio.length);
  assert.ok(audio.every(e=>e.callId==='fresh'&&e.recoveryId===1));assert.equal(issues.length,1);
});
test('ordinary stopped output still sends a 60 second utterance once without 20 second overflow',()=>{
  const sent:any[]=[],issues:string[]=[],c=new VoiceRecovery(e=>sent.push(e),e=>issues.push(e));c.bind('old',0);
  c.invalidate(1,'stop_audio',1,0);c.activity(true,2,2);
  for(let i=0;i<600;i++){c.capture({seq:i,at:2+i/10,audio:'x'},2+i/10);c.drain(2+i/10);}
  c.activity(false,62,2);for(let i=0;i<5;i++)c.drain(62+i/10);
  const audio=sent.filter(e=>e.type==='audio');assert.equal(audio.length,600);assert.equal(new Set(audio.map(e=>e.captureSeq)).size,600);assert.equal(issues.length,0);
  assert.equal(sent.filter(e=>e.type==='resync'||e.type==='resume_audio').length,0);
  assert.equal(sent.at(-1).active,false);
});
test('events from a physically replaced socket and old async callback are ignored',async()=>{
  const f=fixture();let resolve:any,executed=0;f.c.scope.delegate=()=>{executed++;return new Promise(r=>resolve=r);};
  f.event({type:'session.delegation.created',delegation:{id:'already-started'}});
  await new Promise(r=>setTimeout(r,1400));assert.equal(executed,1);
  f.receive({type:'resync',recoveryId:1,reason:'transport_lost'});f.finish();await new Promise(r=>setImmediate(r));f.receive({type:'resume_audio',recoveryId:1});
  resolve({mode:'accepted',message:'old result'});await new Promise(r=>setImmediate(r));
  const n=f.sent.length;f.c.event({type:'session.output_audio.delta',delta:'old physical PCM'},1);f.c.event({type:'session.input_transcript.delta',delta:'old physical caption'},1);f.c.event({type:'session.closed'},1);
  assert.equal(f.sent.length,n);assert.equal(f.sent.filter(e=>e.type==='execution').length,0);assert.equal(f.c.callId,'new');
});
test('recovery input is paced in real time and long waiting silence does not overflow the saved utterance',()=>{
 const sent:any[]=[],c=new VoiceRecovery(e=>sent.push(e),()=>{});c.bind('old',0);c.activity(true,0,0);c.capture({seq:1,at:0,audio:'first'},0);c.invalidate(1,'transport_lost',.1,0);
 for(let i=2;i<=10;i++)c.capture({seq:i,at:i/10,audio:'part'},i/10);c.activity(false,2,0);
 for(let i=30;i<300;i++)c.capture({seq:i,at:i/10,audio:'silence'},i/10);assert.equal(c.bufferedFrames,10);
 c.recoveryReady(1);assert.equal(c.bind('new',1),true);c.drain(31);assert.equal(sent.filter(e=>e.type==='audio').length,1);for(let i=0;i<9;i++)c.drain(31+(i+1)/10);assert.equal(sent.filter(e=>e.type==='audio').length,10);
});

test('marker without played and stale marker after a second stop never releases stale audio',()=>{
 const f=fixture();f.receive({type:'interrupt',recoveryId:1,reason:'interruption'});f.c.continueOutput();const first=f.c.fence;
 f.event({type:'session.instructions.appended',client_event_id:first.instructionId});
 f.event({type:'session.output_audio.delta',delta:Buffer.concat([first.marker,Buffer.from('fresh-but-not-yet-approved')]).toString('base64')});
 assert.equal(f.sent.filter(e=>e.type==='audio').length,0);
 f.receive({type:'interrupt',recoveryId:2,reason:'stop_audio'});
 f.event({type:'session.output_audio.fixture.played',client_event_id:first.fixtureId});
 assert.equal(f.sent.filter(e=>e.type==='playback_ready'||e.type==='audio').length,0);assert.equal(f.c.inputHeld,false);
 assert.equal(f.c.waitForSpeech,true);assert.equal(f.startCount(),0);
});
test('microphone frames are retained only during the short fixture window, not a whole utterance',()=>{
 const f=fixture();f.receive({type:'audio',callId:'old',recoveryId:0,captureSeq:1,audio:'AAAAAA=='});
 assert.ok(f.upstream.some(e=>e.type==='session.input_audio.append'));
 f.receive({type:'speech',callId:'old',active:true});f.receive({type:'interrupt',recoveryId:1,reason:'interruption'});const gate=f.c.fence;
 const before=f.upstream.filter(e=>e.type==='session.input_audio.append').length;
 for(let i=2;i<5;i++)f.receive({type:'audio',callId:'old',recoveryId:1,captureSeq:i,audio:'AAAAAA=='});
 assert.equal(f.upstream.filter(e=>e.type==='session.input_audio.append').length,before);assert.equal(f.c.inputFrames.length,3);
 f.event({type:'session.output_audio.fixture.played',client_event_id:gate.fixtureId});assert.equal(f.c.inputHeld,false);
 f.event({type:'session.output_audio.delta',delta:Buffer.concat([gate.marker,Buffer.from('new answer')]).toString('base64')});
 assert.equal(f.sent.filter(e=>e.type==='playback_ready').length,1,'marker works while the caller is still speaking');
 for(let i=0;i<3;i++)f.c.drainInput();assert.equal(f.upstream.filter(e=>e.type==='session.input_audio.append').length,before+3);
 f.receive({type:'speech',callId:'old',active:false,endCaptureSeq:4});f.c.continueOutput();
 assert.equal(f.upstream.filter(e=>e.type==='session.output_audio.fixture.play').length,1);
});
test('delegation waits for the captured utterance end, not an empty never-ending silence stream',async()=>{
 const f=fixture();let n=0;f.c.scope.delegate=async()=>{n++;return {mode:'queued_next_turn'};};
 f.c.inputHeld=true;for(let i=1;i<=8;i++)f.receive({type:'audio',callId:'old',recoveryId:0,captureSeq:i,audio:'AAAAAA=='});
 f.receive({type:'speech',callId:'old',active:false,endCaptureSeq:4});f.c.speechChangedAt=0;f.event({type:'session.delegation.created',delegation:{id:'watermark'}});
 await new Promise(r=>setTimeout(r,1400));assert.equal(n,0);
 f.c.inputHeld=false;for(let i=0;i<4;i++)f.c.drainInput();f.c.lastAudioAt=Date.now();
 await new Promise(r=>setTimeout(r,550));assert.equal(n,1);assert.equal(f.c.inputFrames.length,4);
});

test('repeated marker holds recover pacing during verified trailing silence without dropping speech or bursting',()=>{
 const f=fixture(),silence=Buffer.alloc(4800).toString('base64'),speech=Buffer.alloc(4800);for(let i=0;i<speech.length;i+=2)speech.writeInt16LE(2000,i);
 let seq=0;
 for(let round=0;round<15;round++){
  f.receive({type:'speech',callId:'old',active:true});f.c.inputHeld=true;
  for(let i=0;i<10;i++){f.receive({type:'audio',callId:'old',recoveryId:0,captureSeq:++seq,audio:speech.toString('base64')});if(i===3)f.c.inputHeld=false;f.c.drainInput();}
  f.receive({type:'speech',callId:'old',active:false,endCaptureSeq:seq});
  for(let i=0;i<20;i++){
   const n=f.upstream.filter(e=>e.type==='session.input_audio.append').length;
   f.receive({type:'audio',callId:'old',recoveryId:0,captureSeq:++seq,audio:silence});f.c.drainInput();
   assert.ok(f.upstream.filter(e=>e.type==='session.input_audio.append').length-n<=1,'no input-rate burst');
  }
  assert.ok(f.c.inputFrames.length<=2,'silence cannot lock in accumulated fixture delay');
 }
 assert.equal(f.upstream.filter(e=>e.audio===speech.toString('base64')).length,150,'every spoken frame exactly once');
 assert.ok(f.c.trimmedSilenceFrames>0);
});
test('quiet or nonquiet frames within the captured utterance and its tail are preserved',()=>{
 const f=fixture();f.c.inputHeld=true;
 const send=(seq:number,audio=Buffer.alloc(4800).toString('base64'))=>f.receive({type:'audio',callId:'old',recoveryId:0,captureSeq:seq,audio});
 f.receive({type:'speech',callId:'old',active:true});for(let i=0;i<20;i++)send(i);
 f.receive({type:'speech',callId:'old',active:false,endCaptureSeq:19});for(let i=20;i<23;i++)send(i);
 assert.equal(f.c.inputFrames.length,23);
 send(23,Buffer.alloc(4800,99).toString('base64'));assert.equal(f.c.inputFrames.length,24,'never discard nonquiet tail based only on VAD');
 send(24);assert.equal(f.c.inputFrames.length,24,'only surplus quiet tail can be omitted');
});

test('background context waits for captured speech, transcript and reply without consuming its watermark',()=>{
 const f=fixture(),now=Date.now();
 f.c.gateway.store.db={getSession:()=>({})};
 f.c.scope.reconcile=()=>{};
 f.c.scope.events=(after:number)=>after<1?[{seq:1,kind:'message_assistant',content:JSON.stringify({content:'Original Agent image result: red',historical:false})}]:[];
 Object.assign(f.c,{speechActive:false,speechChangedAt:now-10000,lastInput:now,speechEndSeq:20,lastForwardedSeq:10});
 f.c.tick();assert.equal(f.c.lastSeq,0,'queued speech must reach upstream before background updates');
 f.c.lastForwardedSeq=20;f.c.speechChangedAt=now-1800;f.c.tick();assert.equal(f.c.lastSeq,0,'brief pause is not the end of a long request');
 f.c.speechChangedAt=now-10000;f.c.latestInputAt=now;f.c.tick();assert.equal(f.c.lastSeq,0,'late input transcript still belongs to current turn');
 f.c.latestInputAt=now-10000;f.c.latestOutputAt=now;f.c.tick();assert.equal(f.c.lastSeq,0,'do not inject another result into a spoken reply');
 f.c.latestOutputAt=now-10000;f.c.inputHeld=true;f.c.tick();assert.equal(f.c.lastSeq,0,'append events are invalid during a media fixture');
 f.c.inputHeld=false;f.c.tick();assert.equal(f.c.lastSeq,1);
 f.c.tick();assert.equal(f.upstream.filter(e=>e.type==='session.thinking.append').length,1,'quiet updates still arrive once');
});

test('long multilingual background context fits the Live append budget and retains its source kind',()=>{
 const f=fixture();f.c.gateway.store.db={getSession:()=>({})};f.c.scope.reconcile=()=>{};
 f.c.scope.events=()=>[{seq:1,kind:'message_assistant',content:JSON.stringify({sourceId:'owned-result',content:'后台图片说明与中文结果。'.repeat(400)})}];
 f.c.tick();const sent=f.upstream.filter(e=>e.type==='session.thinking.append');assert.equal(sent.length,1);
 assert.ok(getEncoding('o200k_base').encode(sent[0].content).length<=480);
 assert.match(sent[0].content,/message_assistant/);assert.match(sent[0].content,/owned-result/);
});
