type Frame = {audio:string;seq:number;at:number};
type Sender = (event:Record<string,unknown>)=>void;

// Only this controller can bind audio to a new physical upstream. It does not
// treat captions, silence or an instruction ack as permission to play old audio.
export class VoiceRecovery {
  callId=''; recoveryId=0; blocked=false; speaking=false; stopped=false;
  private pending:Frame[]=[];
  private history:Frame[]=[];
  private ready=false;
  private canResume=false;
  private resumeSent=false;
  private newSpeech=false;
  private overflow=false;
  private speechStart=0;
  private speechEnd=-1;
  private replaying=false;
  private boundCalls=new Set<string>();
  constructor(private readonly send:Sender, private readonly issue:(text:string)=>void) {}
  get bufferedFrames(){return this.pending.length;}
  get synchronizing(){return this.replaying;}
  freeze(){this.ready=false;this.blocked=true;}
  activity(active:boolean,at:number,start:number) {
    this.speaking=active;
    if(active){
      this.speechStart=start;
      if(this.overflow || (!this.newSpeech && (this.blocked||!this.ready))){this.pending=this.history.filter(f=>f.at>=start-.2);this.overflow=false;}
      this.newSpeech=true;
    }else this.speechEnd=at;
    this.send({type:'speech',callId:this.callId,active});
    if(!active)this.resume();
  }
  invalidate(id:number,reason:string,at:number,start:number) {
    if(id<=this.recoveryId)return;
    this.recoveryId=id;this.blocked=true;this.ready=false;this.canResume=false;this.resumeSent=false;
    this.stopped=reason==='stop_audio';this.newSpeech=!this.stopped&&this.speaking;this.overflow=false;
    this.pending=this.newSpeech?this.history.filter(f=>f.at>=start-.2):[];
    this.send({type:this.stopped?'stop_audio':'resync',recoveryId:id,cutoffSeq:this.pending[0]?.seq,reason});
    if(!this.stopped&&!this.newSpeech)this.issue('语音连接正在重新同步。旧播报已停止；请接着说，未听清的那句可以再说一次。');
  }
  recoveryReady(id:number) {if(id!==this.recoveryId)return;this.canResume=true;this.resume();}
  private resume() {
    if(this.blocked&&this.canResume&&this.newSpeech&&!this.speaking&&!this.overflow&&!this.resumeSent){
      this.resumeSent=true;this.send({type:'resume_audio',recoveryId:this.recoveryId});
    }
  }
  bind(callId:string,id:number) {
    if(id!==this.recoveryId||this.boundCalls.has(callId))return false;
    this.replaying=this.pending.length>3;
    this.callId=callId;this.boundCalls.add(callId);this.blocked=false;this.ready=true;this.stopped=false;
    this.canResume=false;this.resumeSent=false;return true;
  }
  accepts(callId:string,id:number){return this.ready&&!this.blocked&&callId===this.callId&&id===this.recoveryId;}
  capture(frame:Frame,now:number) {
    this.history.push(frame);while(this.history.length&&now-this.history[0]!.at>20)this.history.shift();
    if(this.overflow)return;
    // Retain the complete correction plus a short trailing silence. Recording
    // more silence while waiting would keep a real-time-rate replay behind forever.
    if((!this.ready||this.blocked||this.replaying)&&(!this.newSpeech||(!this.speaking&&frame.at>this.speechEnd+.3)))return;
    this.pending.push(frame);
    if(this.pending.length>200){
      this.pending=[];this.overflow=true;this.newSpeech=false;
      this.issue('连接恢复期间这段话超过20秒，未拼接或重发残句。请停顿后完整重复最新要求。');
    }
  }
  drain(now:number) {
    if(!this.ready||this.blocked||this.overflow)return;
    // Keep 200ms of unsent preroll so render-thread speech detection can veto the
    // first interruption samples before they enter the obsolete model session.
    // Live enforces real-time input pacing. Never drain a recovery backlog in a
    // burst: at most one captured 100ms frame per the caller's 100ms timer tick.
    if(this.pending.length&&now-this.pending[0]!.at>=.2){
      const f=this.pending.shift()!;
      this.send({type:'audio',callId:this.callId,recoveryId:this.recoveryId,captureSeq:f.seq,audio:f.audio});
    }
    if(this.pending.length<=3)this.replaying=false;
    this.send({type:'speech',callId:this.callId,active:this.speaking||this.pending.length>3});
  }
  // Transport reconnect never carries an arbitrary one-second tail into a new call.
  disconnected(){this.ready=false;this.pending=[];this.history=[];this.boundCalls.clear();}
}
