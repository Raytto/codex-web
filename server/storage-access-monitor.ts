import fs from 'node:fs';
import path from 'node:path';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import readline from 'node:readline';
import {StorageCatalog,type StorageItem} from './storage-catalog.js';
import {storageRoot,type StorageRoots} from './storage-inventory.js';
import {safeStorageMember} from './storage-file-lifecycle.js';
import {STORAGE_DAY} from './storage-lifecycle-policy.js';
import {storageMetadataRows} from './storage-scan.js';

/** Observation loss is a separate, explicit safety deadline, never fake use.
 * A recovered monitor closes each gap once. Scans/retries cannot extend it. */
export function openStorageUsageGap(catalog:StorageCatalog,ids:string[]):void{
 const prior=catalog.db.prepare("SELECT value_json FROM storage_scan_state WHERE name='access-gap'").get();
 const existing=prior?JSON.parse(String(prior.value_json)):{items:[],startedAt:catalog.now()};
 const gap={...existing,items:[...new Set([...existing.items,...ids])]};
 catalog.db.prepare("INSERT INTO storage_scan_state VALUES('access-gap',?,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify(gap),catalog.now());
 catalog.issue('access-monitor','queue',null,'storage_usage_observation_gap');
}
export function closeStorageUsageGap(catalog:StorageCatalog):void{
 const raw=catalog.db.prepare("SELECT value_json FROM storage_scan_state WHERE name='access-gap'").get();if(!raw)return;
 const gap=JSON.parse(String(raw.value_json));
 catalog.transaction(()=>{
  for(const id of gap.items as string[]){
   const item=catalog.db.prepare('SELECT * FROM storage_items WHERE id=?').get(id) as StorageItem|undefined;if(!item)continue;
   const until=catalog.now()+item.retention_days*STORAGE_DAY;
   catalog.db.prepare('UPDATE storage_items SET usage_not_before=MAX(usage_not_before,?) WHERE id=?').run(until,id);
   catalog.audit(item.user_id,item.id,item.current_version,'usage_observation_gap',0,{from:gap.startedAt,to:catalog.now(),safeAfter:until,originalLastUsedAt:item.last_used_at});
  }
  catalog.db.prepare("DELETE FROM storage_scan_state WHERE name='access-gap'").run();
  catalog.db.prepare("UPDATE storage_issues SET resolved_at=? WHERE scope='access-monitor' AND source_key='queue'").run(catalog.now());
 });
}

type Usage={itemId:string;userId:string;at:number;evidence:'tool-read'|'write';processIdentity:string;jobId:string|null};
export function recordStorageUsage(catalog:StorageCatalog,value:Usage):void{
  const item=catalog.item(value.userId,value.itemId);
  if(!Number.isSafeInteger(value.at) || value.at>catalog.now()+5000 || !/^[a-f0-9-]{36}:\d+:\d+$/.test(value.processIdentity))throw new Error('storage_usage_identity');
  if(value.at>item.last_used_at)catalog.touch(item.user_id,item.id,value.evidence,Math.min(value.at,catalog.now()));
  const existing=catalog.db.prepare('SELECT id,released_at FROM storage_leases WHERE user_id=? AND item_id=? AND process_identity=? ORDER BY acquired_at DESC LIMIT 1').get(item.user_id,item.id,value.processIdentity);
  if(existing?.released_at!==null && existing?.released_at!==undefined && value.at<=Number(existing.released_at))return;
  if(existing && existing.released_at===null)catalog.db.prepare('UPDATE storage_leases SET expires_at=MAX(expires_at,?) WHERE id=?').run(value.at+5*60_000,existing.id!);
  else catalog.acquireLease(item.user_id,item.id,{processIdentity:value.processIdentity,purpose:value.evidence,jobId:value.jobId??undefined,ttlMs:5*60_000});
}
export function reconcileStorageUsageMarker(catalog:StorageCatalog,root:string,item:StorageItem):void{
  const file=path.join(root,`${item.id}.json`);let value:Usage;
  try{const st=fs.lstatSync(file);if(!st.isFile() || st.isSymbolicLink() || st.size>4096)throw new Error('storage_usage_marker_invalid');value=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  if(value.itemId!==item.id || value.userId!==item.user_id)throw new Error('storage_usage_marker_owner');
  recordStorageUsage(catalog,value);
}
export class StorageAccessMonitor{
  private child?:ChildProcessWithoutNullStreams;private timer?:ReturnType<typeof setInterval>;
  private stopping=false;
  constructor(readonly catalog:StorageCatalog,readonly roots:StorageRoots,readonly markerRoot:string,readonly helper:string,readonly onFailure?:()=>void){}
  start():void{
    if(this.child)throw new Error('storage_access_monitor_running');
    fs.mkdirSync(this.markerRoot,{recursive:true,mode:0o700});
    const prior=this.catalog.db.prepare("SELECT value_json FROM storage_scan_state WHERE name='access-monitor'").get();
    if(prior)openStorageUsageGap(this.catalog,JSON.parse(String(prior.value_json)).items??[]);
    const child=spawn('python3',['-u',this.helper,this.markerRoot],{env:{...process.env,PPAGENT_STORAGE_MAINTENANCE:'1'},stdio:['pipe','pipe','pipe']});this.child=child;
    const lines=readline.createInterface({input:child.stdout});
    lines.on('line',line=>{try{
      const event=JSON.parse(line);
      if(event.event==='used')recordStorageUsage(this.catalog,event);
      else if(event.event==='ready'){
        closeStorageUsageGap(this.catalog);this.status({ready:true,watched:event.watched,items:event.items});
        this.catalog.resolveIssue('access-monitor','process');
      }
      else if(event.event==='overflow'){
       const previous=this.catalog.db.prepare("SELECT value_json FROM storage_scan_state WHERE name='access-monitor'").get();
       openStorageUsageGap(this.catalog,previous?JSON.parse(String(previous.value_json)).items??[]:[]);this.status({ready:false});
      }else this.catalog.issue('access-monitor',event.itemId??'queue',null,'storage_access_watch_failed');
    }catch{this.catalog.issue('access-monitor','event',null,'storage_access_event_retry_marker_retained');}});
    child.stderr.resume(); // Child diagnostics must never dump process environment.
    child.on('exit',()=>{this.status({ready:false});this.catalog.issue('access-monitor','process',null,'storage_access_monitor_stopped');if(this.timer)clearInterval(this.timer);if(!this.stopping)this.onFailure?.();});
    child.on('error',()=>this.onFailure?.());
    this.refresh();this.timer=setInterval(()=>this.refresh(),60_000);
  }
  private status(value:Record<string,unknown>):void{
    const old=this.catalog.db.prepare("SELECT value_json FROM storage_scan_state WHERE name='access-monitor'").get();
    if(old)value={...JSON.parse(String(old.value_json)),...value};
    this.catalog.db.prepare(`INSERT INTO storage_scan_state(name,value_json,updated_at) VALUES('access-monitor',?,?)
      ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify(value),this.catalog.now());
  }
  refresh():void{
    const files:Array<{id:string;userId:string;path:string}>=[];
    for(const item of storageMetadataRows(this.catalog.db,"SELECT rowid AS _storage_rowid,* FROM storage_items WHERE kind NOT IN ('events') AND scope!='backup-material'") as unknown as IterableIterator<StorageItem>){
      try{const locator=JSON.parse(item.locator_json);if(locator.root==='native-snapshots')continue;
        const file=safeStorageMember(storageRoot(this.catalog,this.roots,item.user_id,locator.root),locator.path);
        if(fs.existsSync(file) && fs.lstatSync(file).isFile())files.push({id:item.id,userId:item.user_id,path:file});
        reconcileStorageUsageMarker(this.catalog,this.markerRoot,item);
      }catch(e){this.catalog.issue('access-monitor',item.id,item.user_id,e instanceof Error?e.message:'storage_watch_failed');}
    }
    const jobs=Object.fromEntries(this.catalog.db.prepare('SELECT j.id,c.user_id FROM jobs j JOIN conversations c ON c.id=j.conversation_id').all().map(r=>[r.id,r.user_id]));
    this.child?.stdin.write(JSON.stringify({files,jobs})+'\n');
  }
  async stop():Promise<void>{this.stopping=true;if(this.timer)clearInterval(this.timer);const child=this.child;
    if(!child || child.exitCode!==null)return;await new Promise<void>(resolve=>{child.once('close',()=>resolve());child.stdin.end();});}
}
