import crypto from 'node:crypto';
// Primary Live audio has no timestamps. Match exact PCM bytes from the timed
// sideband to frames actually consumed by the browser. Never infer heard text
// from captions, packet counts, wall time or a server fixture acknowledgement.
export class VoicePlaybackEvidence {
  private frames=new Map<number,{bytes:Buffer;played:boolean;epoch:number}>();
  private timed:Array<{bytes:Buffer;start:number;end:number}>=[];
  ranges:number[][]=[];
  heardEpochs=new Set<number>();
  sent(seq:number,bytes:Buffer,epoch=0){this.frames.set(seq,{bytes,played:false,epoch});if(this.frames.size>600)this.frames.delete(this.frames.keys().next().value!);}
  reflected(bytes:Buffer,start:number,end:number){
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||Math.abs(bytes.length/48-(end-start))>1)return;
    this.timed.push({bytes,start,end});if(this.timed.length>600)this.timed.shift();this.match();
  }
  played(seq:number){const f=this.frames.get(seq);if(f){f.played=true;let energy=0;for(let i=0;i+1<f.bytes.length;i+=2)energy+=(f.bytes.readInt16LE(i)/32768)**2;if(Math.sqrt(energy/(f.bytes.length/2))>=.006)this.heardEpochs.add(f.epoch);this.match();}}
  private match(){
    for(const [seq,f] of this.frames){if(!f.played||f.bytes.length<960)continue;
      // Exclude all-silent repeated packets: these have no unique media identity.
      let energy=0;for(let i=0;i<f.bytes.length;i+=2)energy+=(f.bytes.readInt16LE(i)/32768)**2;
      if(Math.sqrt(energy/(f.bytes.length/2))<.006){this.frames.delete(seq);continue;}
      for(const t of this.timed){
        let at=t.bytes.indexOf(f.bytes),start:number,end:number;
        if(at>=0&&at%2===0){start=t.start+at/48;end=start+f.bytes.length/48;}
        else {at=f.bytes.indexOf(t.bytes);if(at<0||at%2)continue;start=t.start;end=t.end;}
        this.ranges.push([start,end]);this.frames.delete(seq);break;
      }
    }
    const merged:number[][]=[];for(const r of this.ranges.sort((a,b)=>a[0]-b[0])){const last=merged.at(-1);if(last&&r[0]<=last[1]+.1)last[1]=Math.max(last[1],r[1]);else merged.push([...r]);}this.ranges=merged;
  }
  get digest(){return crypto.createHash('sha256').update(JSON.stringify([this.ranges,[...this.heardEpochs]])).digest('hex');}
}
