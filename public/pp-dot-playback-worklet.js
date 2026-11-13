// The render thread owns the output veto. A blocked UI cannot keep old speech alive.
class DotPlayback extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue=[];this.offset=0;this.available=0;this.phase=0;
    this.buffering=true;this.target=0.5;this.waited=0;this.tail=0;this.reportClock=0;
    this.clock=0;this.callId=null;this.recoveryId=0;this.blocked=true;this.physicalBlocked=false;this.muted=false;
    this.voice=false;this.voiceFenced=false;this.voiceOn=0;this.voiceOff=0;this.noise=0.002;this.input=[];this.reference=[];
    this.lastAudio=-100;this.speechStart=0;
    this.stats={received:0,played:0,underruns:0,longGaps:0,rebufferedMs:0,cleared:0,maxQueuedMs:0,rejected:0,interruptions:0};
    this.port.onmessage=({data})=>{
      if(data.type==='voice_protocol'){this.port.postMessage({type:'voice_protocol',version:2});return;}
      if(data.type==='resume'){
        // Only the authenticated server's observed in-stream media fence may
        // reopen this epoch on the SAME physical call. Never an ack/caption.
        if(!data.mediaFence||data.recoveryId!==this.recoveryId||data.callId!==this.callId)return;
        this.clear();this.blocked=false;this.physicalBlocked=false;this.voiceFenced=this.voice;this.lastAudio=-100;return;
      }
      if(data.type==='bind'){
        // Only a newly established physical session can unblock the current veto.
        if(data.recoveryId!==this.recoveryId||!data.callId||data.callId===this.callId)return;
        this.clear();this.callId=data.callId;this.blocked=false;this.physicalBlocked=false;this.lastAudio=-100;return;
      }
      if(data.type==='invalidate'){this.invalidate(data.reason??'stop_audio');return;}
      if(data.type==='mute'){this.muted=!!data.muted;if(this.muted&&this.voice){this.voice=false;this.voiceOn=0;this.voiceOff=0;this.activity();}return;}
      if(data.type==='clear'){this.clear();return;}
      if(data.type==='stats'){this.report();return;}
      if(data.type!=='audio'||!(data.samples instanceof Int16Array)||!data.samples.length)return;
      if(this.blocked||data.callId!==this.callId||data.recoveryId!==this.recoveryId){this.stats.rejected+=data.samples.length;return;}
      const rms=Math.sqrt(data.samples.reduce((n,x)=>n+(x/32768)**2,0)/data.samples.length);
      const audible=rms>.006;
      if(this.voice&&audible&&!this.voiceFenced){this.invalidate('interruption');return;}
      // A verified same-stream marker has removed obsolete audio. Fresh model
      // speech can play in full duplex; a VAD tail must not expire a new reply.
      // Continuous upstream silence is not a reply and must not fill this queue.
      if(this.voice&&!audible&&!this.queue.some(q=>q.audible))return;
      // Losing a whole obsolete reply is explicit; skipping words to catch up is not.
      if(this.available+data.samples.length>24000*2.4){this.invalidate('output_congestion');return;}
      this.queue.push({samples:data.samples,seq:data.seq,at:this.clock,audible});this.available+=data.samples.length;
      this.stats.received+=data.samples.length;if(audible)this.lastAudio=this.clock;
      this.stats.maxQueuedMs=Math.max(this.stats.maxQueuedMs,this.available/24);
    };
  }
  clear(){this.stats.cleared+=this.available;this.queue=[];this.offset=0;this.available=0;this.phase=0;this.buffering=true;this.waited=0;this.tail=0;this.report();}
  invalidate(reason){
    const physical=['transport_lost','context_rotation','upstream_disconnected','upstream_unresponsive'].includes(reason);
    if(this.physicalBlocked||(this.blocked&&reason!=='stop_audio'&&!physical))return;
    this.physicalBlocked=physical;
    this.blocked=true;this.recoveryId++;this.stats.interruptions++;this.clear();
    this.port.postMessage({type:'invalidate',reason,recoveryId:this.recoveryId,at:this.clock,speechStart:this.speechStart});
  }
  activity(){this.port.postMessage({type:'speech',active:this.voice,at:this.clock,speechStart:this.speechStart,recoveryId:this.recoveryId});}
  detect(input,out){
    if(!input||this.muted)return;
    // 20ms windows, at least 80ms credible activity, 1000ms end hysteresis for pauses.
    for(const x of input)this.input.push(x);
    const n=Math.round(sampleRate*.02);
    if(this.input.length<n)return;
    const a=this.input.splice(0,n);let energy=0,crossings=0;
    for(let i=0;i<a.length;i++){energy+=a[i]*a[i];if(i&&a[i]*a[i-1]<0)crossings++;}
    const rms=Math.sqrt(energy/n),zcr=crossings/n;
    const playing=this.queue.some(q=>q.audible)||this.clock-this.lastAudio<0.3;
    let echo=false;
    // AEC remains enabled at getUserMedia. This independent reference check rejects
    // strongly correlated residual speaker audio, never using output RMS as speech.
    if(playing&&rms>0.004)for(let delay=0;delay<=.12;delay+=.02){
      const start=this.reference.length-n-Math.round(delay*sampleRate);if(start<0)continue;
      let dot=0,power=0;for(let i=0;i<n;i+=4){const b=this.reference[start+i];dot+=a[i]*b;power+=b*b;}
      if(power>1e-6&&Math.abs(dot)/Math.sqrt(power*energy/4)>0.82){echo=true;break;}
    }
    const credible=!echo&&rms>Math.max(.011,this.noise*3)&&zcr>.008&&zcr<.4;
    if(!this.voice&&!playing&&!credible)this.noise=Math.min(.015,this.noise*.98+rms*.02);
    // Establish the boundary at EVERY credible speech onset, including when
    // output is idle. Waiting for audible PCM in that case would fence at the
    // end of the request and erase its fresh short answer during the VAD tail.
    if(credible){this.voiceOff=0;this.voiceOn+=.02;if(!this.voice&&this.voiceOn>=.08){this.voice=true;this.voiceFenced=false;this.speechStart=this.clock-this.voiceOn;this.activity();if(!this.blocked)this.invalidate('interruption');}}
    else {this.voiceOn=0;if(this.voice){this.voiceOff+=.02;if(this.voiceOff>=1){this.voice=false;this.voiceOff=0;this.activity();}}}
  }
  report(){this.port.postMessage({type:'stats',...this.stats,callId:this.callId,recoveryId:this.recoveryId,blocked:this.blocked,queuedMs:this.available/24,targetMs:this.target*1000});}
  process(inputs,outputs) {
    const out=outputs[0]?.[0];if(!out)return true;
    this.clock=typeof currentTime==='number'?currentTime+out.length/sampleRate:this.clock+out.length/sampleRate;this.detect(inputs[0]?.[0],out);
    if(this.queue.length&&this.clock-this.queue[0].at>2.4)this.invalidate('output_age');
    if(!this.blocked&&(!this.voice||this.voiceFenced)){
      this.render(out);
      // Keep a fresh response audible but quieter while the caller is speaking.
      if(this.voice)for(let i=0;i<out.length;i++)out[i]*=.35;
    }
    for(const x of out)this.reference.push(x);
    if(this.reference.length>sampleRate*.2)this.reference.splice(0,this.reference.length-Math.round(sampleRate*.2));
    this.levelClock=(this.levelClock??0)+out.length/sampleRate;
    if(this.levelClock>=.08){this.levelClock=0;this.port.postMessage({type:'level',callId:this.callId,recoveryId:this.recoveryId,rms:Math.sqrt(out.reduce((n,x)=>n+x*x,0)/out.length),buffering:this.buffering,queuedMs:this.available/24,blocked:this.blocked});}
    this.reportClock+=out.length/sampleRate;if(this.reportClock>=1){this.reportClock=0;this.report();}
    return true;
  }
  render(out) {
    if(this.buffering){
      if(!this.available){this.waited=0;return;}
      this.waited+=out.length/sampleRate;
      if(this.available<24000*this.target&&this.waited<this.target){this.stats.rebufferedMs+=out.length/sampleRate*1000;return;}
      this.buffering=false;this.waited=0;
    }
    for(let i=0;i<out.length;i++){
      if(!this.available){this.tail+=1/sampleRate;continue;}
      if(this.tail>.02){if(this.tail<1){this.stats.underruns++;this.target=Math.min(1.2,this.target+.4);}else this.stats.longGaps++;this.tail=0;this.buffering=true;this.waited=0;this.report();break;}
      this.tail=0;
      const q=this.queue[0],a=q.samples[this.offset],b=q.samples[this.offset+1]??this.queue[1]?.samples[0]??a;out[i]=(a+(b-a)*this.phase)/32768;
      this.phase+=24000/sampleRate;
      while(this.phase>=1&&this.available){this.phase--;this.offset++;this.available--;this.stats.played++;
        if(this.offset===this.queue[0].samples.length){const done=this.queue.shift();this.offset=0;this.port.postMessage({type:'played',seq:done.seq,callId:this.callId,recoveryId:this.recoveryId});}
      }
    }
  }
}
registerProcessor('pp-dot-playback',DotPlayback);
