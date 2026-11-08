// PCM playback runs on the audio rendering thread, independent of React and layout.
class DotPlayback extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue=[]; this.offset=0; this.available=0; this.phase=0;
    this.buffering=true; this.target=0.5; this.waited=0; this.tail=0; this.reportClock=0;
    this.stats={received:0,played:0,underruns:0,longGaps:0,rebufferedMs:0,cleared:0,maxQueuedMs:0};
    this.port.onmessage=({data})=>{
      if(data.type==='clear') {this.stats.cleared+=this.available;this.queue=[];this.offset=0;this.available=0;this.phase=0;this.buffering=true;this.waited=0;this.tail=0;this.report();return;}
      if(data.type==='stats'){this.report();return;}
      if(data.type!=='audio'||!(data.samples instanceof Int16Array)||!data.samples.length)return;
      // A broken transport must fail visibly, never silently skip words to catch up.
      if(this.available+data.samples.length>24000*60){this.port.postMessage({type:'overflow'});return;}
      this.queue.push({samples:data.samples,seq:data.seq});this.available+=data.samples.length;
      this.stats.received+=data.samples.length;
      this.stats.maxQueuedMs=Math.max(this.stats.maxQueuedMs,this.available/24);
    };
  }
  report(){this.port.postMessage({type:'stats',...this.stats,queuedMs:this.available/24,targetMs:this.target*1000});}
  process(inputs,outputs) {
    const result=this.render(inputs,outputs),out=outputs[0]?.[0];
    if(out){this.levelClock=(this.levelClock??0)+out.length/sampleRate;if(this.levelClock>=0.08){this.levelClock=0;const rms=Math.sqrt(out.reduce((n,x)=>n+x*x,0)/out.length);this.port.postMessage({type:"level",rms,buffering:this.buffering,queuedMs:this.available/24});}}
    return result;
  }
  render(_inputs,outputs) {
    const out=outputs[0]?.[0];if(!out)return true;
    this.reportClock+=out.length/sampleRate;if(this.reportClock>=1){this.reportClock=0;this.report();}
    if(this.buffering){
      if(!this.available){this.waited=0;return true;}
      this.waited+=out.length/sampleRate;
      // Timeout releases short phrases even when they do not fill the target buffer.
      if(this.available<24000*this.target&&this.waited<this.target){this.stats.rebufferedMs+=out.length/sampleRate*1000;return true;}
      this.buffering=false;this.waited=0;
    }
    for(let i=0;i<out.length;i++) {
      if(!this.available){
        // Count starvation only if more audio arrives, not ordinary utterance endings.
        this.tail+=1/sampleRate;
        out[i]=0;continue;
      }
      if(this.tail>0.02){
        if(this.tail<1){this.stats.underruns++;this.target=Math.min(1.2,this.target+0.4);}else this.stats.longGaps++;
        this.tail=0;this.buffering=true;this.waited=0;this.report();break;
      }
      this.tail=0;
      const q=this.queue[0],a=q.samples[this.offset],b=q.samples[this.offset+1]??this.queue[1]?.samples[0]??a;out[i]=(a+(b-a)*this.phase)/32768;
      this.phase+=24000/sampleRate;
      while(this.phase>=1&&this.available){
        this.phase--;this.offset++;this.available--;this.stats.played++;
        if(this.offset===this.queue[0].samples.length){const done=this.queue.shift();this.offset=0;this.port.postMessage({type:'played',seq:done.seq});}
      }
    }
    return true;
  }
}
registerProcessor('pp-dot-playback',DotPlayback);
