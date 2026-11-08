import fs from 'node:fs';
import type {StorageCatalog} from './storage-catalog.js';
import type {StorageItem} from './storage-catalog.js';

export type EventReadRequest={jobId:string;afterSeq?:number;limit?:number;batchId?:string;offsetBytes?:number};
export type EventHistoryPage={state:'ready'|'cold'|'expired';events?:Array<{seq:number;event_type:string;payload:string;created_at:string}>;
 batchId?:string;itemId?:string;nextSeq?:number;hasMore?:boolean;requiresByteRead?:boolean;
 bodyBase64?:string;nextOffsetBytes?:number;done?:boolean;sha256?:string;bytes?:number;expiresAt?:number;blockedReason?:string;retryAfterSeconds?:number};

/** Reading metadata never warms a partition. Cloud reads return the exact item
 * to restore; large individual events remain fully accessible through bounded
 * byte ranges instead of being silently truncated or loading a whole file. */
export async function readEventHistory(catalog:StorageCatalog,user:string,input:EventReadRequest,
 resolve:(item:StorageItem)=>string,processIdentity:string):Promise<EventHistoryPage>{
 const db=catalog.db,after=input.afterSeq??0,limit=input.limit??100,offset=input.offsetBytes??0;
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>200
   ||!Number.isSafeInteger(offset)||offset<0)throw new Error('storage_event_cursor_invalid');
 if(!db.prepare('SELECT 1 FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=? AND c.user_id=?').get(input.jobId,user))throw new Error('storage_event_job_not_found');
 const batch=input.batchId?db.prepare('SELECT * FROM storage_event_batches WHERE id=? AND job_id=? AND user_id=?').get(input.batchId,input.jobId,user)
  :db.prepare('SELECT * FROM storage_event_batches WHERE job_id=? AND user_id=? AND last_seq>? AND deleted_at IS NOT NULL ORDER BY first_seq LIMIT 1').get(input.jobId,user,after);
 if(input.batchId&&!batch)throw new Error('storage_event_batch_not_found');
 if(!batch){
  // Bound the SQL projection too: exceptionally large hot events are left in
  // the normal live event endpoint, rather than duplicated into bridge memory.
  const events:NonNullable<EventHistoryPage['events']>=[];let bytes=0,more=false;
  for(const row of db.prepare(`SELECT seq,event_type,CASE WHEN length(CAST(payload AS BLOB))<=524288 THEN payload ELSE NULL END payload,created_at
    FROM job_events WHERE job_id=? AND seq>? ORDER BY seq LIMIT ?`).iterate(input.jobId,after,limit+1)){
   if(row.payload===null)throw new Error('storage_live_event_large_use_live_endpoint');
   const length=Buffer.byteLength(String(row.payload));if(events.length>=limit || events.length && bytes+length>512*1024){more=true;break;}
   events.push(row as NonNullable<EventHistoryPage['events']>[number]);bytes+=length;
  }
  return {state:'ready',events,nextSeq:events.at(-1)?.seq??after,hasMore:more};
 }
 const item=catalog.item(user,String(batch.item_id)),version=item.current_version?catalog.version(user,item.current_version):null;
 const info={batchId:String(batch.id),itemId:item.id,expiresAt:Number(batch.expires_at),sha256:String(batch.sha256)};
 if(!version || version.state==='error')return {state:'expired',...info,nextSeq:Number(batch.last_seq),hasMore:true};
 const file=resolve(item);let fd:number;
 try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {state:'cold',...info,blockedReason:item.blocked_reason??undefined,retryAfterSeconds:Math.max(5,Math.ceil((item.next_attempt_at-catalog.now())/1000))};throw e;}
 let lease:ReturnType<StorageCatalog['acquireLease']>|undefined;
 try{
  lease=catalog.acquireLease(user,item.id,{processIdentity,purpose:'event-history-read',ttlMs:60_000});
  const st=fs.fstatSync(fd);if(!st.isFile()||st.size!==version.logical_bytes)throw new Error('storage_event_file_changed');
  catalog.touch(user,item.id,'tool-read');
  if(input.batchId){
   if(offset>st.size)throw new Error('storage_event_cursor_invalid');
   const body=Buffer.alloc(Math.min(128*1024,st.size-offset));const n=fs.readSync(fd,body,0,body.length,offset);
   return {state:'ready',...info,bytes:st.size,bodyBase64:body.subarray(0,n).toString('base64'),nextOffsetBytes:offset+n,done:offset+n===st.size};
  }
  const events:NonNullable<EventHistoryPage['events']>=[];let total=0,pieces:Buffer[]=[],size=0,large=false,prefix='',previous=0;
  const buffer=Buffer.alloc(64*1024),deadline=Date.now()+25_000;let reads=0;
  for(;;){
   const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;
   const block=Buffer.from(buffer.subarray(0,n));let start=0;
   if(++reads%16===0){await new Promise<void>(resolve=>setImmediate(resolve));if(Date.now()>deadline)throw new Error('storage_event_read_budget');}
   while(start<block.length){
    const nl=block.indexOf(10,start),end=nl<0?block.length:nl,part=block.subarray(start,end);
    if(prefix.length<256)prefix+=part.subarray(0,256-prefix.length).toString();size+=part.length;
    if(size>1024*1024){large=true;pieces=[];}else if(!large)pieces.push(part);
    if(nl>=0){
     const seq=large?Number(/^\{"seq":(\d+),/.exec(prefix)?.[1]):Number(JSON.parse(Buffer.concat(pieces).toString()).seq);
     if(!Number.isSafeInteger(seq)||seq<=previous||seq<Number(batch.first_seq)||seq>Number(batch.last_seq))throw new Error('storage_event_partition_invalid');
     previous=seq;
     if(seq>after){
      if(large)return {state:'ready',...info,events,nextSeq:events.at(-1)?.seq??after,hasMore:true,requiresByteRead:true};
      if(events.length>=limit || events.length && total+size>512*1024)return {state:'ready',...info,events,nextSeq:events.at(-1)!.seq,hasMore:true};
      const row=JSON.parse(Buffer.concat(pieces).toString());
      if(typeof row.payload!=='string'||typeof row.event_type!=='string'||typeof row.created_at!=='string')throw new Error('storage_event_partition_invalid');
      events.push(row);total+=size;
     }
     pieces=[];size=0;large=false;prefix='';
    }
    start=nl<0?block.length:nl+1;
   }
  }
  if(size)throw new Error('storage_event_partition_incomplete');
  const next=events.at(-1)?.seq??Number(batch.last_seq);
  const more=Boolean(db.prepare('SELECT 1 FROM storage_event_batches WHERE job_id=? AND user_id=? AND last_seq>? UNION ALL SELECT 1 FROM job_events WHERE job_id=? AND seq>? LIMIT 1').get(input.jobId,user,next,input.jobId,next));
  return {state:'ready',...info,events,nextSeq:next,hasMore:more};
 }finally{fs.closeSync(fd);if(lease)catalog.releaseLease(user,lease.id);}
}
