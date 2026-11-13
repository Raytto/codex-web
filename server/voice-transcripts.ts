import crypto from 'node:crypto';
export type VoicePlayback = 'confirmed' | 'audible' | 'unconfirmed' | 'withheld' | 'legacy';
export type VoiceSegment = {role:'user'|'assistant';text:string;source:string;callId:string;startMs:number;endMs:number;createdAt:string;timed:boolean;withheld:boolean;mutable?:boolean;playback?:VoicePlayback};
type Fragment = {id:string;role:VoiceSegment['role'];text:string;callId:string;birth:number;startMs:number;endMs:number;order:number;dialogue:string;epoch?:number;timed:boolean;playback:VoicePlayback};

// Only source fragments determine text. Flush cadence, silence and character
// counts are never turn boundaries. Rebuilding by event time handles late input
// and late playback receipts without feeding display changes back to execution.
export class VoiceTranscripts {
  private fragments = new Map<string,Fragment>();
  private saved = new Map<string,string>();
  constructor(private readonly record:(segment:VoiceSegment)=>void) {}
  add(role:VoiceSegment['role'],e:Record<string,any>,callId:string,birth:number,withheld=false) {
    const text=String(e.delta??''); if(!text)return;
    const timed=Number.isFinite(e.start_ms)&&Number.isFinite(e.end_ms)&&e.start_ms>=0&&e.end_ms>=e.start_ms&&e.end_ms<86400000;
    const startMs=timed?e.start_ms:Number(e.received_ms??Math.max(0,Date.now()-birth));
    const id=String(e.event_id??`${role}:${startMs}:${e.end_ms}:${text}`),key=callId+':'+id;
    if(this.fragments.has(key))return;
    this.fragments.set(key,{id,role,text,callId,birth,startMs,endMs:timed?e.end_ms:startMs,order:this.fragments.size,dialogue:e.dialogue_id??callId,epoch:e.output_epoch,timed,playback:withheld?'withheld':e.playback??'legacy'});
  }
  segments():VoiceSegment[] {
    const ordered=[...this.fragments.values()].sort((a,b)=>a.birth+a.startMs-b.birth-b.startMs||a.order-b.order);
    const groups:Fragment[][]=[];
    // Unconfirmed/withheld output cannot close a caller's turn. Actual overlaps
    // keep the ongoing caller bubble; the next caller onset after a reply closes it.
    let user:Fragment[]|undefined,assistant:Fragment[]|undefined,withheldAssistant:Fragment[]|undefined;
    let replies:Fragment[]=[];
    for(const f of ordered){
      if(f.role==='user'){
        const previousEnd=user?.reduce((n,x)=>Math.max(n,x.birth+x.endMs),-Infinity)??-Infinity;
        // A reply may begin on the caller's final token. Later audible reply
        // fragments still prove a role change before the next caller onset.
        const previous=user?.at(-1);
        // Caption timestamps are approximate. A final caller token must not be
        // split merely because a quick reply's timestamp lands before it. New
        // recordings also require a new browser speech/recovery epoch.
        const hasEpoch=f.epoch!==undefined&&previous?.epoch!==undefined;
        const newOnset=!hasEpoch||f.callId!==previous?.callId||f.epoch!==previous?.epoch;
        const replyBetween=newOnset&&replies.some(r=>r.birth+r.endMs<=f.birth+f.startMs&&(hasEpoch||r.birth+r.startMs>=previousEnd));
        if(!user||user[0].dialogue!==f.dialogue||replyBetween){user=[];groups.push(user);replies=[];assistant=undefined;withheldAssistant=undefined;}
        user.push(f);
      }else{
        // Withheld audit fragments must not break the same visible reply.
        if(f.playback==='withheld'){
          if(!withheldAssistant||withheldAssistant[0].callId!==f.callId){withheldAssistant=[];groups.push(withheldAssistant);}
          withheldAssistant.push(f);continue;
        }
        if(!assistant||assistant[0].callId!==f.callId){assistant=[];groups.push(assistant);}
        assistant.push(f);
        if(f.playback==='confirmed'||f.playback==='audible'||f.playback==='legacy'){
          replies.push(f);
        }
      }
    }
    return groups.map<VoiceSegment>(g=>{
      const anchor=g.reduce((a,b)=>a.order<b.order?a:b),first=g[0],last=g.at(-1)!;
      return {role:first.role,text:g.map(f=>f.text).join(''),source:crypto.createHash('sha256').update(`voice-turn:${anchor.callId}:${anchor.role}:${anchor.id}`).digest('hex'),callId:first.callId,startMs:first.startMs,endMs:last.birth+last.endMs-first.birth,createdAt:new Date(first.birth+first.startMs).toISOString(),timed:g.every(f=>f.timed),withheld:first.playback==='withheld',mutable:true,playback:g.every(f=>f.playback==='confirmed')?'confirmed':first.playback==='withheld'?'withheld':first.playback==='legacy'?'legacy':'unconfirmed'};
    }).filter(g=>g.text.trim());
  }
  flush(){for(const s of this.segments()){const value=JSON.stringify(s);if(this.saved.get(s.source)===value)continue;this.saved.set(s.source,value);this.record(s);}}
}
