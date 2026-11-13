import {isPhysicalRecoveryReason} from './voice-protocol.js';
type Frame = {audio:string;seq:number;at:number};
type Sender = (event:Record<string,unknown>)=>void;

// Only this controller can bind audio to a new physical upstream. It does not
// treat captions, silence or an instruction ack as permission to play old audio.
export class VoiceRecovery {
  callId=''; recoveryId=0; blocked=false; speaking=false; stopped=false;
  private pending:Frame[]=[];
  private history:Frame[]=[];
  private ready=false;
  private physical=false;
  private canResume=false;
  private resumeSent=false;
  private newSpeech=false;
  private overflow=false;
  private speechStart=0;
  private speechEnd=-1;
  private lastQueuedSeq=-1;
  private speechEndSeq=-1;
  private replaying=false;
  private boundCalls=new Set<string>();
  constructor(private readonly send:Sender, private readonly issue:(text:string)=>void) {}
  get bufferedFrames(){return this.pending.length;}
  get synchronizing(){return this.replaying;}
  freeze(){this.blocked=true;}
  resumePlayback(callId:string,id:number){if(this.ready&&!this.physical&&callId===this.callId&&id===this.recoveryId){this.blocked=false;this.stopped=false;return true;}return false;}
  activity(active:boolean,at:number,start:number) {
    this.speaking=active;
    if(active){
      this.speechStart=start;
      if(this.overflow || (!this.newSpeech && (this.physical||!this.ready))){this.pending=this.history.filter(f=>f.at>=start-.2);this.overflow=false;}
      this.newSpeech=true;
    }else {this.speechEnd=at;this.speechEndSeq=this.lastQueuedSeq;}
    this.send({type:'speech',callId:this.callId,active,at,start,endCaptureSeq:this.speechEndSeq,recoveryId:this.recoveryId});
    if(!active)this.resume();
  }
  invalidate(id:number,reason:string,at:number,start:number) {
    if(id<=this.recoveryId)return;
    this.recoveryId=id;this.blocked=true;this.stopped=reason==='stop_audio';
    const physical=isPhysicalRecoveryReason(reason);
    if(!physical){
      this.send({type:'interrupt',recoveryId:id,reason,at,start});return;
    }
    this.physical=true;this.ready=false;this.canResume=false;this.resumeSent=false;
    this.newSpeech=this.speaking;this.overflow=false;
    this.pending=this.newSpeech?this.history.filter(f=>f.at>=start-.2):[];
    this.send({type:'resync',recoveryId:id,cutoffSeq:this.pending[0]?.seq,reason});
    this.issue('连接中断，正在恢复。后台任务保持原状态。');
  }
  recoveryReady(id:number) {if(id!==this.recoveryId)return;this.canResume=true;this.resume();}
  private resume() {
    if(this.physical&&this.canResume&&!this.overflow&&!this.resumeSent){
      this.resumeSent=true;this.send({type:'resume_audio',recoveryId:this.recoveryId});
    }
  }
  bind(callId:string,id:number) {
    if(id!==this.recoveryId||this.boundCalls.has(callId))return false;
    this.replaying=this.pending.length>3;
    this.callId=callId;this.boundCalls.add(callId);this.physical=false;this.blocked=false;this.ready=true;this.stopped=false;
    this.canResume=false;this.resumeSent=false;return true;
  }
  accepts(callId:string,id:number){return this.ready&&!this.blocked&&callId===this.callId&&id===this.recoveryId;}
  capture(frame:Frame,now:number) {
    this.history.push(frame);while(this.history.length&&now-this.history[0]!.at>20)this.history.shift();
    if(this.overflow)return;
    // Retain the complete correction plus a short trailing silence. Recording
    // more silence while waiting would keep a real-time-rate replay behind forever.
    if((!this.ready||this.physical||this.replaying)&&(!this.newSpeech||(!this.speaking&&frame.at>this.speechEnd+.3)))return;
    this.pending.push(frame);
    this.lastQueuedSeq=frame.seq;
    if(this.pending.length>200){
      this.pending=[];this.overflow=true;this.newSpeech=false;
      this.issue('连接恢复期间这段话超过20秒，未拼接或重发残句。请停顿后完整重复最新要求。');
    }
  }
  drain(now:number) {
    if(!this.ready||this.physical||this.overflow)return;
    // Keep 200ms of unsent preroll so render-thread speech detection can veto the
    // first interruption samples before they enter the obsolete model session.
    // Live enforces real-time input pacing. Never drain a recovery backlog in a
    // burst: at most one captured 100ms frame per the caller's 100ms timer tick.
    if(this.pending.length&&now-this.pending[0]!.at>=.2){
      const f=this.pending.shift()!;
      this.send({type:'audio',callId:this.callId,recoveryId:this.recoveryId,captureSeq:f.seq,audio:f.audio});
    }
    if(this.pending.length<=3)this.replaying=false;
    this.send({type:'speech',callId:this.callId,active:this.speaking,endCaptureSeq:this.speechEndSeq});
  }
  // Transport reconnect never carries an arbitrary one-second tail into a new call.
  disconnected(){this.ready=false;this.pending=[];this.history=[];this.boundCalls.clear();}
}
