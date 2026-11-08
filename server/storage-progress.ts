import crypto from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
export type StorageProgressTick={stage:'preparing'|'converting'|'downloading'|'verifying'|'installing';completed:number;total:number|null;estimated?:boolean};
export type RestoreProgress={state:'idle'|'queued'|'restoring'|'complete'|'error';stage:string;percent:number|null;estimated:boolean;updatedAt:number;error:string|null};
export class StorageRestoreProgress{
 readonly attempt=crypto.randomUUID();private written=0;private stage='';
 constructor(readonly db:DatabaseSync,readonly userId:string,readonly kind:'file'|'item'|'conversation',readonly subjectId:string,queued=false){
  const now=Date.now();db.prepare(`INSERT INTO storage_restores(user_id,kind,subject_id,attempt_id,state,stage,started_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,kind,subject_id) DO UPDATE SET attempt_id=excluded.attempt_id,state=excluded.state,
    stage=excluded.stage,completed_bytes=0,total_bytes=NULL,estimated=0,started_at=excluded.started_at,updated_at=excluded.updated_at,error=NULL`)
    .run(userId,kind,subjectId,this.attempt,queued?'queued':'restoring',queued?'queued':'preparing',now,now);
 }
 update(value:StorageProgressTick):void{
  const now=Date.now();if(value.stage===this.stage && now-this.written<500)return;
  this.stage=value.stage;this.written=now;
  this.db.prepare(`UPDATE storage_restores SET state='restoring',stage=?,completed_bytes=?,total_bytes=?,estimated=?,updated_at=?
    WHERE user_id=? AND kind=? AND subject_id=? AND attempt_id=?`).run(value.stage,Math.max(0,Math.floor(value.completed)),value.total===null?null:Math.max(0,Math.floor(value.total)),value.estimated?1:0,now,this.userId,this.kind,this.subjectId,this.attempt);
 }
 finish(error?:unknown):void{
  this.db.prepare(`UPDATE storage_restores SET state=?,stage=?,updated_at=?,error=? WHERE user_id=? AND kind=? AND subject_id=? AND attempt_id=?`)
   .run(error?'error':'complete',error?'error':'ready',Date.now(),error?'恢复暂未完成，请重试。':null,this.userId,this.kind,this.subjectId,this.attempt);
 }
}
export function storageRestoreProgress(db:DatabaseSync,userId:string,kind:string,id:string):RestoreProgress{
 const row=db.prepare('SELECT * FROM storage_restores WHERE user_id=? AND kind=? AND subject_id=?').get(userId,kind,id);
 if(!row)return {state:'idle',stage:'idle',percent:null,estimated:false,updatedAt:0,error:null};
 return {state:row.state as RestoreProgress['state'],stage:String(row.stage),percent:row.state==='complete'?100:
   Number(row.total_bytes)>0?Math.min(99,Math.max(0,Math.floor(Number(row.completed_bytes)*100/Number(row.total_bytes)))):null,
   estimated:row.estimated===1,updatedAt:Number(row.updated_at),error:row.error===null?null:String(row.error)};
}
