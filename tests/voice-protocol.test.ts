import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
import {VOICE_PROTOCOL_VERSION, verifyVoiceWorklet, isPhysicalRecoveryReason} from '../src/voice-protocol.js';

for(const file of ['audio','playback'])test(`${file} render code negotiates the page protocol without audio`,async()=>{
  let Processor:any;
  const channel=new MessageChannel();
  try {
    vm.runInNewContext(fs.readFileSync(new URL(`../public/pp-dot-${file}-worklet.js`,import.meta.url),'utf8'),{
      AudioWorkletProcessor:class {port=channel.port2;},registerProcessor:(_name:string,p:any)=>Processor=p,
    });
    new Processor();
    await verifyVoiceWorklet(channel.port1 as unknown as MessagePort,500);
  }finally{channel.port1.close();channel.port2.close();}
});
for(const version of [undefined,1,'2',3])test(`mismatched cached worklet ${version} is rejected`,async()=>{
  const {port1,port2}=new MessageChannel();
  try{
    port2.on('message',()=>port2.postMessage({type:'voice_protocol',version}));
    await assert.rejects(verifyVoiceWorklet(port1 as unknown as MessagePort,100),/刷新/);
  }finally{port1.close();port2.close();}
});
test('legacy worklet timeout does not consume subsequent audio listeners',async()=>{
  const {port1,port2}=new MessageChannel();
  try{
    await assert.rejects(verifyVoiceWorklet(port1 as unknown as MessagePort,20),/刷新/);
    port2.on('message',()=>port2.postMessage({type:'voice_protocol',version:VOICE_PROTOCOL_VERSION}));
    await verifyVoiceWorklet(port1 as unknown as MessagePort,100);
  }finally{port1.close();port2.close();}
});
test('only explicit physical failures may replace the live connection',()=>{
  for(const reason of ['transport_lost','context_rotation','upstream_disconnected','upstream_unresponsive'])assert.equal(isPhysicalRecoveryReason(reason),true);
  for(const reason of ['interruption','transport_delay','capture_delay','input_congestion','output_congestion','output_age','stop_audio',undefined,{},null])assert.equal(isPhysicalRecoveryReason(reason),false);
});
