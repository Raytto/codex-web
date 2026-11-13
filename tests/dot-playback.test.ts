import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
const code=fs.readFileSync(new URL('../public/pp-dot-playback-worklet.js',import.meta.url),'utf8');
function fixture(rate=48000){let Processor;const events=[];vm.runInNewContext(code,{Int16Array,sampleRate:rate,AudioWorkletProcessor:class{constructor(){this.port={postMessage:e=>events.push(e)}}},registerProcessor:(_n,p)=>Processor=p});const p=new Processor(),message=data=>p.port.onmessage({data});message({type:'bind',callId:'old',recoveryId:0});return {p,events,message,add:(seq,n=2400,callId='old',recoveryId=0)=>message({type:'audio',seq,callId,recoveryId,samples:Int16Array.from({length:n},(_,i)=>Math.sin(i*.07)*16000)}),step:(mic=new Float32Array(128))=>{const out=new Float32Array(128);p.process([[mic]],[[out]]);return out}};}
test('long normal streaming preserves every sample and ordered playback receipts',()=>{const f=fixture();let seq=0;for(let i=0;i<3750;i++){if(i%38===0)f.add(++seq);f.step();}for(let i=0;i<800;i++)f.step();assert.equal(f.p.stats.played,f.p.stats.received);assert.equal(f.p.stats.cleared,0);assert.deepEqual(f.events.filter(e=>e.type==='played').map(e=>e.seq),Array.from({length:seq},(_,i)=>i+1));});
test('short phrase drains below the adaptive target at 44.1k and 48k',()=>{for(const rate of [44100,48000]){const f=fixture(rate);f.add(1);for(let i=0;i<300;i++)f.step();assert.equal(f.p.stats.played,2400);assert.equal(f.p.available,0);}});
test('late old PCM and bind cannot reopen invalidated player; fresh physical binding restores full output',()=>{const f=fixture();f.add(1);f.message({type:'invalidate',reason:'stop_audio'});f.add(2);f.message({type:'bind',callId:'old',recoveryId:1});for(let i=0;i<250;i++)assert.ok(f.step().every(x=>x===0));assert.equal(f.events.filter(e=>e.type==='played').length,0);f.message({type:'bind',callId:'new',recoveryId:1});f.add(3,2400,'old',0);f.add(4,2400,'new',1);for(let i=0;i<300;i++)f.step();assert.deepEqual(f.events.filter(e=>e.type==='played').map(e=>e.seq),[4]);assert.ok(f.p.stats.rejected>=4800);});
test('render thread vetoes speech within 250ms without any UI callback or network acknowledgement',()=>{const f=fixture();f.add(1,24000);for(let i=0;i<210;i++)f.step();assert.ok(f.p.stats.played>0);let stopAt=-1;for(let i=0;i<94;i++){const mic=Float32Array.from({length:128},(_,k)=>.08*Math.sin((i*128+k)*.13));const out=f.step(mic);if(f.p.blocked&&stopAt<0){stopAt=i*128/48000;assert.ok(out.every(x=>x===0));}}assert.ok(stopAt>=0&&stopAt<.25);assert.equal(f.events.filter(e=>e.type==='invalidate').length,1);f.add(2);for(let i=0;i<100;i++)assert.ok(f.step().every(x=>x===0));});
test('noise, 20ms click and muted microphone do not interrupt; English pauses keep one activity',()=>{const f=fixture();f.add(1,24000);for(let i=0;i<250;i++)f.step(Float32Array.from({length:128},(_,k)=>.002*Math.sin(k*.8)));assert.equal(f.p.blocked,false);for(let i=0;i<7;i++)f.step(Float32Array.from({length:128},(_,k)=>.1*Math.sin(k*.2)));for(let i=0;i<50;i++)f.step();assert.equal(f.p.blocked,false);f.message({type:'mute',muted:true});for(let i=0;i<100;i++)f.step(Float32Array.from({length:128},(_,k)=>.1*Math.sin(k*.2)));assert.equal(f.p.blocked,false);
 const g=fixture();for(let i=0;i<60;i++)g.step(Float32Array.from({length:128},(_,k)=>.06*Math.sin((i*128+k)*.12)));for(let i=0;i<180;i++)g.step();assert.equal(g.p.voice,true);for(let i=0;i<60;i++)g.step(Float32Array.from({length:128},(_,k)=>.06*Math.sin((i*128+k)*.12)));for(let i=0;i<400;i++)g.step();assert.deepEqual(g.events.filter(e=>e.type==='speech').map(e=>e.active),[true,false]);});
test('correlated speaker echo does not trigger an interruption',()=>{const f=fixture();let last=new Float32Array(128);for(let i=0;i<700;i++){if(i%38===0)f.add(i);last=f.step(Float32Array.from(last,x=>x*.4));}assert.equal(f.p.blocked,false);});
test('backlogged output invalidates once instead of silently skipping words or replaying seconds of old audio',()=>{const f=fixture();for(let i=0;i<50;i++)f.add(i);assert.equal(f.p.blocked,true);assert.equal(f.events.filter(e=>e.type==='invalidate').length,1);assert.equal(f.p.available,0);for(let i=0;i<1000;i++)assert.ok(f.step().every(x=>x===0));});
test('continuous Live silence PCM after speech-onset boundary does not force repeated fences or reconnect',()=>{const f=fixture();let resumed=false;for(let i=0;i<600;i++){if(f.p.blocked&&!resumed){f.message({type:'resume',callId:'old',recoveryId:1,mediaFence:'observed'});resumed=true;}if(i%38===0)f.message({type:'audio',seq:i,callId:'old',recoveryId:resumed?1:0,samples:new Int16Array(2400)});f.step(Float32Array.from({length:128},(_,k)=>.08*Math.sin((i*128+k)*.13)));}assert.equal(f.p.blocked,false);assert.equal(f.p.physicalBlocked,false);assert.equal(f.events.filter(e=>e.type==='invalidate').length,1);});
test('same-call resume needs a current marker and renders the fresh answer through the VAD tail',()=>{
 const f=fixture();f.add(1);f.message({type:'invalidate',reason:'stop_audio'});
 f.message({type:'resume',callId:'old',recoveryId:1});assert.equal(f.p.blocked,true);
 f.message({type:'resume',callId:'old',recoveryId:0,mediaFence:'stale'});assert.equal(f.p.blocked,true);
 f.p.voice=true;f.message({type:'resume',callId:'old',recoveryId:1,mediaFence:'observed'});
 f.add(2,2400,'old',1);for(let i=0;i<250;i++)f.step();
 assert.equal(f.p.stats.played,2400);assert.equal(f.p.recoveryId,1);
 for(let i=0;i<500;i++)f.step();assert.equal(f.p.stats.played,2400,'entire short new answer is heard without an extra fence');
 f.message({type:'invalidate',reason:'stop_audio'});f.message({type:'resume',callId:'old',recoveryId:1,mediaFence:'late'});assert.equal(f.p.blocked,true);
});
test('a true transport fault during local silence advances recovery once and cannot be unlocked by an old marker',()=>{const f=fixture();f.message({type:'invalidate',reason:'interruption'});f.message({type:'invalidate',reason:'upstream_disconnected'});f.message({type:'invalidate',reason:'upstream_disconnected'});f.message({type:'invalidate',reason:'stop_audio'});assert.equal(f.p.recoveryId,2);f.message({type:'resume',callId:'old',recoveryId:1,mediaFence:'late'});assert.equal(f.p.blocked,true);f.message({type:'bind',callId:'new',recoveryId:2});assert.equal(f.p.blocked,false);});
test('speech beginning during idle output fences before a new short answer arrives in the VAD tail',()=>{
 const f=fixture();
 for(let i=0;i<150;i++)f.step(Float32Array.from({length:128},(_,k)=>.08*Math.sin((i*128+k)*.13)));
 assert.equal(f.events.filter(e=>e.type==='invalidate').length,1,'boundary must precede the reply, even when nothing was playing at speech onset');
 f.add(1);assert.equal(f.p.available,0,'late pre-boundary PCM remains rejected');
 f.message({type:'resume',callId:'old',recoveryId:1,mediaFence:'observed-at-speech-start'});
 for(let i=0;i<150;i++)f.step(Float32Array.from({length:128},(_,k)=>.08*Math.sin((i*128+k)*.13)));
 for(let i=0;i<150;i++)f.step(); // short answer arrives inside the one-second VAD tail
 f.add(2,2400,'old',1);
 for(let i=0;i<800;i++)f.step();
 assert.equal(f.events.filter(e=>e.type==='invalidate').length,1,'do not cancel the fresh reply at the end of the same utterance');
 assert.equal(f.p.stats.played,2400);assert.deepEqual(f.events.filter(e=>e.type==='played').map(e=>e.seq),[2]);
});

test('a verified fresh reply drains during continuous speech without expiring or forcing a second fence',()=>{
 const f=fixture();for(let i=0;i<80;i++)f.step(Float32Array.from({length:128},(_,k)=>.08*Math.sin((i*128+k)*.13)));
 assert.equal(f.p.blocked,true);f.message({type:'resume',callId:'old',recoveryId:1,mediaFence:'observed'});
 for(let i=0;i<1500;i++){
  if(i%38===0)f.add(i,2400,'old',1);
  f.step(Float32Array.from({length:128},(_,k)=>.08*Math.sin((i*128+k)*.13)));
 }
 assert.equal(f.events.filter(e=>e.type==='invalidate').length,1,'fresh duplex speech must not expire behind the local VAD');
 assert.ok(f.p.stats.played>24000*3);assert.ok(f.p.stats.maxQueuedMs<1500);
});
