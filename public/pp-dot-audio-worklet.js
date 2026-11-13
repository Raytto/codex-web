class Capture extends AudioWorkletProcessor {
  constructor(){super();this.samples=[];this.phase=0;this.total=0;this.n=0;this.clock=0;this.seq=0;
    this.port.onmessage=({data})=>{if(data.type==='voice_protocol')this.port.postMessage({type:'voice_protocol',version:2});};
  }
  process(inputs){
    const channel=inputs[0]?.[0];if(channel){this.clock=typeof currentTime==='number'?currentTime+channel.length/sampleRate:this.clock+channel.length/sampleRate;
      for(const x of channel){this.total+=x;this.n++;this.phase+=24000;
        if(this.phase>=sampleRate){this.phase-=sampleRate;this.samples.push(Math.max(-32768,Math.min(32767,Math.round(this.total/this.n*32767))));this.total=0;this.n=0;
          if(this.samples.length===2400){const pcm=new Int16Array(this.samples);this.port.postMessage({pcm:pcm.buffer,seq:++this.seq,at:this.clock-.1},[pcm.buffer]);this.samples=[];}
        }
      }
    }return true;
  }
}
registerProcessor('pp-dot-capture',Capture);
