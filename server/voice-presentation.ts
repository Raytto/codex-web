import type {AppDatabase,MessageRow,PendingPromptWithFiles} from './db.js';
import {VoiceTranscripts} from './voice-transcripts.js';

function metadata(text:string):Record<string,any>{try{const value=JSON.parse(text);return value&&typeof value==='object'?value:{};}catch{return {};}}

export function isVoicePending(db:AppDatabase,id:string){return Boolean(db.sqlite.prepare("SELECT 1 FROM conversation_voice_operations WHERE pending_id=? AND source_seq>0").get(id));}
export function publicVoicePending(db:AppDatabase,p:PendingPromptWithFiles){return isVoicePending(db,p.id)?{...p,content:'语音要求已接收，等待原会话 Agent 处理。',quote_excerpt:null,voiceDelegation:true}:p;}

// Identity-based compatibility view, including the pre-fix delegation. No
// mutation of history, source events, job inputs, or task watermarks on reads.
export function voicePresentation(db:AppDatabase,cid:string) {
  const sql=db.sqlite;
  const hidden=new Set<string>();
  const internal=sql.prepare(`SELECT m.id FROM messages m WHERE m.conversation_id=? AND m.role='user' AND EXISTS (
    SELECT 1 FROM conversation_voice_operations o WHERE o.conversation_id=m.conversation_id AND o.source_seq>0 AND m.content LIKE '[本会话语音要求，第 '||o.revision||' 版；来源 %' AND (
      EXISTS(SELECT 1 FROM jobs j WHERE j.id=o.job_id AND j.message_id=m.id)
      OR EXISTS(SELECT 1 FROM remote_steered_inputs s WHERE s.job_id=o.job_id AND s.message_id=m.id)
      OR (o.created_at<=m.created_at AND EXISTS(SELECT 1 FROM dot_steers s WHERE s.pending_id=o.pending_id)
          AND m.content LIKE '[本会话语音要求，第 '||o.revision||' 版；来源 %')
    ))`).all(cid) as {id:string}[];
  internal.forEach(m=>hidden.add(m.id));
  const dot=sql.prepare('SELECT user_id FROM dot_sessions WHERE conversation_id=?').get(cid) as {user_id:string}|undefined;
  const events=sql.prepare(dot?"SELECT kind,source_id,content FROM dot_events WHERE user_id=? AND kind IN ('voice_fragment','voice_segment','voice_playback') ORDER BY seq":"SELECT kind,source_id,content FROM conversation_voice_events WHERE conversation_id=? AND kind IN ('voice_fragment','voice_segment','voice_playback') ORDER BY seq").all(dot?dot.user_id:cid) as {kind:string;source_id:string;content:string}[];
  const fragments:Array<Record<string,any>&{source:string}>=events.filter(e=>e.kind==='voice_fragment').map(e=>({source:e.source_id,...metadata(e.content)}));
  const calls=new Set(fragments.filter(f=>typeof f.callId==='string').map(f=>f.callId));
  const playback=new Map(events.filter(e=>e.kind==='voice_playback').map(e=>[e.source_id,metadata(e.content)]));
  const oldSegments:Array<Record<string,any>&{id:string}>=events.filter(e=>e.kind==='voice_segment').map(e=>({id:e.source_id,...metadata(e.content)}));
  for(const s of oldSegments)if(calls.has(s.callId))hidden.add(s.id);
  const turns=new VoiceTranscripts(()=>{});
  for(const f of fragments){
    if(!calls.has(f.callId)||!['user','assistant'].includes(f.role)||!Number.isFinite(f.birth)||typeof f.delta!=='string')continue;
    let status=f.withheld?'withheld':f.presentationVersion?'unconfirmed':'legacy';
    if(f.role==='assistant'&&f.presentationVersion){
      const evidence=playback.get(f.callId),ranges=evidence?.ranges??[];
      if(!f.withheld&&evidence?.heardEpochs?.includes(f.outputEpoch))status='audible';
      if(ranges.some((r:number[])=>r[0]<=f.startMs&&r[1]>=f.endMs))status='confirmed';
    }else if(f.role==='assistant'&&oldSegments.some(s=>s.callId===f.callId&&s.role==='assistant'&&s.withheld&&s.startMs<=f.startMs&&s.endMs>=f.endMs))status='withheld';
    if(f.role==='assistant'&&f.presentationVersion&&status==='unconfirmed')continue;
    turns.add(f.role,{delta:f.delta,event_id:f.eventId??f.source,start_ms:f.startMs,end_ms:f.endMs,received_ms:f.receivedMs,dialogue_id:f.dialogueId,output_epoch:f.outputEpoch,playback:status},f.callId,f.birth,status==='withheld');
  }
  const messages:Array<MessageRow & {voice_playback?:string}>=turns.segments().filter(s=>!s.withheld).map(s=>({id:s.source,conversation_id:cid,role:s.role,content:s.text,created_at:s.createdAt,voice_playback:s.role==='assistant'?(s.playback==='confirmed'?'confirmed':'unconfirmed'):undefined}));
  return {hidden,messages,active:events.length>0||internal.length>0};
}
