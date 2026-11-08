import fs from 'node:fs';
import type {FileRow} from './db.js';
import {StorageCatalog,type StorageItem} from './storage-catalog.js';
import {enrollRegisteredFiles,itemForFile,type StorageRoots} from './storage-inventory.js';
import {StorageRestoreProgress} from './storage-progress.js';

/** Explicit content requests only. Directory, sidebar and thumbnail probes
 * must not call this class. Restores are shared across concurrent readers. */
export class StorageFileAccess {
  private readonly pending=new Map<string,Promise<void>>();
  private readonly errors=new Map<string,{at:number;message:string}>();
  constructor(readonly catalog:StorageCatalog,readonly roots:StorageRoots,
    readonly resolve:(file:FileRow,userId:string)=>string,
    readonly restore:(userId:string,fileId:string)=>Promise<void>){ }
  private touch(file:FileRow,userId:string):void {
    enrollRegisteredFiles(this.catalog,this.roots,file.id);
    const item=itemForFile(this.catalog,userId,file.id);
    if(!item)throw new Error('storage_file_mapping_failed');
    this.catalog.touch(userId,item.id,'user-read');
  }
  ensure(file:FileRow,userId:string):'local'|'restoring'|'error' {
    const absolute=this.resolve(file,userId),key=`${userId}:${file.id}`;
    const stat=fs.lstatSync(absolute,{throwIfNoEntry:false});
    if(stat?.isFile() && !stat.isSymbolicLink()) {this.touch(file,userId);return 'local';}
    if(this.pending.has(key))return 'restoring';
    if((this.errors.get(key)?.at??0)>Date.now()-30_000)return 'error';
    const queued=new StorageRestoreProgress(this.catalog.db,userId,'file',file.id,true);
    const promise=this.restore(userId,file.id).then(()=>{
      const restored=fs.lstatSync(absolute,{throwIfNoEntry:false});
      if(!restored?.isFile() || restored.isSymbolicLink())throw new Error('storage_restore_not_installed');
      this.touch(file,userId);this.errors.delete(key);
    }).catch(error=>{
      this.errors.set(key,{at:Date.now(),message:error instanceof Error?error.message.slice(0,200):'storage_restore_failed'});
      queued.finish(error);
      this.catalog.db.prepare("UPDATE storage_restores SET state='error',stage='error',error='恢复中断，请重试。',updated_at=? WHERE user_id=? AND kind='file' AND subject_id=? AND state!='complete'")
        .run(Date.now(),userId,file.id);
      throw error;
    }).finally(()=>this.pending.delete(key));
    // The synchronous reader API returns 202; it must not create an unhandled
    // rejection. Explicit reads below also await this same promise.
    promise.catch(()=>undefined);this.pending.set(key,promise);return 'restoring';
  }
  async read(file:FileRow,userId:string):Promise<void> {
    const state=this.ensure(file,userId),key=`${userId}:${file.id}`;
    if(state==='error')throw new Error(this.errors.get(key)?.message??'storage_restore_failed');
    if(state==='local')return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([this.pending.get(key),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('storage_restore_pending')),25_000);timer.unref();
    })]);}finally{if(timer)clearTimeout(timer);}
  }
}

/** Reader chapters/assets have their own clocks and restore exactly one
 * object. Metadata and the chapter directory never enter this read path. */
export class StorageObjectAccess{
 private readonly pending=new Map<string,Promise<void>>();
 constructor(readonly catalog:StorageCatalog,readonly restore:(user:string,id:string)=>Promise<void>){}
 async read(item:StorageItem,absolute:string):Promise<void>{
  const stat=fs.lstatSync(absolute,{throwIfNoEntry:false});
  if(stat?.isFile() && !stat.isSymbolicLink()){this.catalog.touch(item.user_id,item.id,'user-read');return;}
  let task=this.pending.get(item.id);
  if(!task){
   task=this.restore(item.user_id,item.id).then(()=>{
    const restored=fs.lstatSync(absolute,{throwIfNoEntry:false});if(!restored?.isFile() || restored.isSymbolicLink())throw new Error('storage_restore_not_installed');
    this.catalog.touch(item.user_id,item.id,'user-read');
   }).finally(()=>this.pending.delete(item.id));
   task.catch(()=>undefined);this.pending.set(item.id,task);
  }
  await task;
 }
}
