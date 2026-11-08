import fs from 'node:fs';
import {storageRestoreProgress} from './storage-progress.js';
import path from 'node:path';
import type {Request,Router} from 'express';
import type {AppDatabase,JobRow} from './db.js';
import {StorageCatalog,type StorageItem} from './storage-catalog.js';
import {storageRoot,type StorageRoots} from './storage-inventory.js';
import {safeStorageMember} from './storage-file-lifecycle.js';
import {nativeUnitSuccessor} from './storage-native-lifecycle.js';

export function mountStorageAutomation(api:Router,db:AppDatabase,authenticate:(req:Request)=>JobRow|null,
 options:{enabled:boolean;roots:StorageRoots;hostRoots:StorageRoots;restore:(user:string,id:string,kind:'file'|'item'|'native')=>Promise<void>;
 readEvents?:(user:string,input:import('./storage-event-reader.js').EventReadRequest)=>Promise<import('./storage-event-reader.js').EventHistoryPage>}){
 const catalog=new StorageCatalog(db.sqlite),pending=new Map<string,Promise<void>>();
 const absolute=(item:StorageItem,roots:StorageRoots)=>{const loc=JSON.parse(item.locator_json);return safeStorageMember(storageRoot(catalog,roots,item.user_id,loc.root),loc.path);};
 const publicItem=(item:StorageItem)=>{
   const version=item.current_version?catalog.version(item.user_id,item.current_version):null;
   let local=false,physical:string|null=null;try{local=fs.existsSync(absolute(item,options.roots));physical=absolute(item,item.user_id===options.roots.hostUserId?options.hostRoots:options.roots);}catch{/* internal snapshot/unknown root stays explicit */}
   return {id:item.id,name:item.display_name,path:physical,locator:JSON.parse(item.locator_json),bytes:version?.logical_bytes??null,sha256:version?.sha256??null,
     version:version?.id??null,state:pending.has(item.id)?'restoring':local?'local':version?.verified_at?'cold':'unavailable',blockedReason:item.blocked_reason};
 };
 api.post('/automation/jobs/:jobId/storage',async(req,res)=>{
  const job=authenticate(req);if(!job)return res.status(401).json({error:'任务凭据无效或已经结束。'});
  const conversation=db.getConversation(job.conversation_id)!;
  const project=conversation.project_id?db.getProjectForUser(conversation.project_id,conversation.user_id):undefined;
  if(!options.enabled || project && !['local-host','tenant-local'].includes(project.executor_id))return res.status(409).json({error:'当前执行节点未启用此文件恢复入口。'});
  const user=conversation.user_id,args=req.body as Record<string,unknown>;
  try{
   if(args.action==='context')return res.json({actions:{list:{query:'optional filename substring',after:'optional item ID',root:'optional logical root from a directory index'},lookup:{id:'item ID or registered file ID',path:'or exact original path'},restore:{id:'item ID from lookup/list'},
    native:{id:'optional immutable native unit ID: omit to list, supply to restore its exact parent/child family'},
    events:{jobId:'owned job ID',afterSeq:'exclusive sequence cursor (default 0)',limit:'1–200 (default 100)',batchId:'optional: read full original JSONL bytes of this batch',offsetBytes:'byte cursor for batchId; decode bodyBase64, continue nextOffsetBytes until done'}},
    rule:'索引仅包含目录信息。读原文件前 restore；state=restoring 时按 retryAfterSeconds 重试。只恢复指定文件，不创建替代文件。',conversationId:conversation.id});
   if(args.action==='native'){
    const rows=typeof args.id==='string'?db.sqlite.prepare('SELECT * FROM storage_native_units WHERE id=? AND user_id=?').all(args.id,user)
      :db.sqlite.prepare('SELECT * FROM storage_native_units WHERE user_id=? AND id>? ORDER BY id LIMIT 101').all(user,String(args.after??''));
    if(typeof args.id==='string' && !rows.length)return res.status(404).json({error:'当前账号没有这个原生历史单元。'});
    const successors=new Map(rows.map(row=>[String(row.id),nativeUnitSuccessor(catalog,user,String(row.id))]));
    if(typeof args.id==='string' && rows[0].state!=='restored' && !pending.has(args.id)){
      const id=args.id;const operation=options.restore(user,id,'native').catch(error=>{
        db.sqlite.prepare('UPDATE storage_native_units SET blocked_reason=? WHERE id=? AND user_id=?').run(error instanceof Error?error.message:'storage_native_restore_failed',id,user);
      }).finally(()=>pending.delete(id));pending.set(id,operation);
    }
    return res.status(typeof args.id==='string' && successors.get(args.id)?409:typeof args.id==='string' && pending.has(args.id)?202:200).json({units:rows.slice(0,100).map(row=>{
      const m=JSON.parse(String(row.manifest_json));return {id:row.id,conversationId:String(row.conversation_id).startsWith('orphan:')?null:row.conversation_id,
        threadIds:m.lineage.threads.map((t:{id:string})=>t.id),state:successors.get(String(row.id))?'superseded':pending.has(String(row.id))?'restoring':row.state,successorUnitId:successors.get(String(row.id))??null,blockedReason:row.blocked_reason,
        progress:storageRestoreProgress(db.sqlite,user,'item',String(row.id))};}),next:rows.length>100?rows[99].id:null,retryAfterSeconds:5});
   }
   if(args.action==='events'){
    if(!options.readEvents || typeof args.jobId!=='string')return res.status(400).json({error:'需要任务 ID。'});
    const result=await options.readEvents(user,{jobId:args.jobId,afterSeq:args.afterSeq as number|undefined,limit:args.limit as number|undefined,
      batchId:typeof args.batchId==='string'?args.batchId:undefined,offsetBytes:args.offsetBytes as number|undefined});
    return res.status(result.state==='cold'?202:result.state==='expired'?410:200).json(result);
   }
   if(args.action==='list'){
    const query=String(args.query??'').slice(0,256),after=String(args.after??'');
    const rows=db.sqlite.prepare(`SELECT * FROM storage_items WHERE user_id=? AND id>? AND instr(lower(display_name),lower(?))>0
      AND scope!='backup-material' AND (? IS NULL OR json_extract(locator_json,'$.root')=?) AND kind NOT IN ('events','native-history') ORDER BY id LIMIT 101`).all(user,after,query,typeof args.root==='string'?args.root:null,typeof args.root==='string'?args.root:null) as StorageItem[];
    return res.json({files:rows.slice(0,100).map(publicItem),next:rows.length>100?rows[99].id:null});
   }
   if(!['lookup','restore'].includes(String(args.action)))return res.status(400).json({error:'未知文件恢复操作。'});
   let item:StorageItem|undefined;
   if(typeof args.id==='string')item=db.sqlite.prepare(`SELECT i.* FROM storage_items i WHERE i.user_id=? AND (i.id=? OR EXISTS(
     SELECT 1 FROM storage_item_links l WHERE l.item_id=i.id AND l.user_id=i.user_id AND l.kind='file' AND l.subject_id=?))`).get(user,args.id,args.id) as StorageItem|undefined;
   if(!item && typeof args.path==='string'){
    for(const row of db.sqlite.prepare("SELECT * FROM storage_items WHERE user_id=? AND kind NOT IN ('events','native-history')").iterate(user) as IterableIterator<StorageItem>){
      try{if(path.isAbsolute(args.path) && path.resolve(args.path)===absolute(row,row.user_id===options.roots.hostUserId?options.hostRoots:options.roots)){item=row;break;}}catch{/* keep ownership boundaries */}
    }
   }
   if(!item)return res.status(404).json({error:'当前账号的目录中没有该文件，请先 list 查询。'});
   if(args.action==='restore'){
    if(item.kind==='native-history')return res.status(409).json({error:'原生历史须通过原线程续跑入口恢复完整依赖。'});
    const local=publicItem(item).state==='local';
    if(local)catalog.touch(user,item.id,'tool-read');
    else if(!pending.has(item.id)){
      const id=item.id,operation=options.restore(user,id,'item').catch(error=>{catalog.block(user,id,error instanceof Error?error.message:'storage_restore_failed');}).finally(()=>pending.delete(id));
      pending.set(id,operation);
    }
   }
   const result=publicItem(catalog.item(user,item.id));return res.status(result.state==='restoring'?202:200).json({...result,retryAfterSeconds:result.state==='restoring'?5:undefined});
  }catch(error){return res.status(409).json({error:error instanceof Error?error.message:'文件恢复失败。'});}
 });
}
