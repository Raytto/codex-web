import fs from 'node:fs';
import type {StorageHost} from './storage-host.js';
import type {StorageItem} from './storage-catalog.js';
import {verifyVersionPresent} from './storage-maintenance.js';
import {storageRoot} from './storage-inventory.js';
import {safeStorageMember} from './storage-file-lifecycle.js';

export function nativeWarmCopies(host:StorageHost){
 const seen=new Set<string>(),entries:Array<{id:string;userId:string;conversationId:string;threadId:string;lastUsedAt:number;fileBytes:number;historyLogicalBytes:number;versions:string[]}>=[];
 for(const row of host.db.prepare("SELECT * FROM storage_native_units WHERE verified_at IS NOT NULL ORDER BY created_at DESC,id DESC").iterate()){
  const m=JSON.parse(String(row.manifest_json)),threadIds=m.lineage.threads.map((t:{id:string})=>t.id) as string[];
  const newer=threadIds.some(id=>seen.has(`${row.user_id}:${id}`));threadIds.forEach(id=>seen.add(`${row.user_id}:${id}`));
  if(newer || row.state!=='restored')continue;
  let bytes=0,lastUsedAt=Number(row.restored_at);const userId=String(row.user_id),home=storageRoot(host.catalog,host.roots,userId,'native');
  for(const member of m.rollouts){
   const item=host.catalog.item(userId,member.itemId),file=safeStorageMember(home,JSON.parse(item.locator_json).path);
   lastUsedAt=Math.max(lastUsedAt,item.last_used_at);
   if(fs.existsSync(file)){const st=fs.lstatSync(file);if(st.isFile()&&!st.isSymbolicLink())bytes+=st.blocks*512;}
  }
  entries.push({id:String(row.id),userId,conversationId:String(row.conversation_id),threadId:m.lineage.roots[0]??threadIds[0],
   lastUsedAt,fileBytes:bytes,historyLogicalBytes:m.parts.reduce((n:number,p:{bytes:number})=>n+p.bytes,0),versions:[...m.rollouts,...m.parts].map((p:{versionId:string})=>p.versionId)});
 }
 return entries.sort((a,b)=>a.lastUsedAt-b.lastUsedAt);
}

/** The byte cap applies to verified, unchanged rewarm copies. New/modified
 * originals retain their normal 15/30/60-day policy. Recent reads and actual
 * process leases remain protected; every pressure eviction still gets its
 * own real three-day quarantine. Physical high-water limits also account for
 * these quarantines rather than claiming upload/isolation released bytes. */
export async function enforceWarmCacheBudget(host:StorageHost,maxItems=32){
 const entries:Array<{item:StorageItem;bytes:number}>=[];let warmBytes=0;
 for(const item of host.db.prepare(`SELECT i.* FROM storage_items i JOIN storage_versions v ON v.id=i.current_version
   WHERE v.restored_at IS NOT NULL AND i.scope!='backup-material' AND i.kind!='native-history' ORDER BY i.last_used_at,i.id`).all() as StorageItem[]){
  const file=host.source(item);if(!fs.existsSync(file))continue;
  const stat=fs.lstatSync(file);if(!stat.isFile() || stat.isSymbolicLink())continue;
  const bytes=stat.blocks*512;entries.push({item,bytes});warmBytes+=bytes;
 }
 const natives=nativeWarmCopies(host),nativeHistoryLogicalBytes=natives.reduce((n,e)=>n+e.historyLogicalBytes,0);
 warmBytes+=natives.reduce((n,e)=>n+e.fileBytes+e.historyLogicalBytes,0);
 const before=warmBytes,blocked:Array<{itemId:string;reason:string}>=[];let isolated=0;
 for(const {item,bytes} of entries){
  if(warmBytes<=host.policy.hotBytes || isolated>=maxItems)break;
  if(item.last_used_at+15*60_000>host.catalog.now()){blocked.push({itemId:item.id,reason:'recently_used_cache'});continue;}
  try{
   await verifyVersionPresent(host,item.user_id,item.current_version!);
   await host.files.archive(item.user_id,item.id,{cachePressure:true});
   host.writeIndex(item.user_id,JSON.parse(item.locator_json).root);warmBytes-=bytes;isolated++;
  }catch(error){const reason=error instanceof Error?error.message:'storage_cache_evict_failed';blocked.push({itemId:item.id,reason});
   if(reason==='storage_cache_copy_changed')host.db.prepare('UPDATE storage_versions SET restored_at=NULL WHERE id=?').run(item.current_version!);
  }
 }
 for(const entry of natives){
  if(warmBytes<=host.policy.hotBytes || isolated>=maxItems)break;
  if(entry.lastUsedAt+15*60_000>host.catalog.now()){blocked.push({itemId:entry.id,reason:'recently_used_cache'});continue;}
  try{
   for(const version of entry.versions)await verifyVersionPresent(host,entry.userId,version);
   const orphan=entry.conversationId.startsWith('orphan:')?{userId:entry.userId,executor:entry.userId===host.roots.hostUserId?'local-host':'tenant-local'}:undefined;
   const id=await host.native.archive(entry.conversationId,process.env.STORAGE_ENGINE_VERSION||'unknown',entry.threadId,orphan,undefined,{cachePressure:true});
   if(!id){blocked.push({itemId:entry.id,reason:'native_cache_recent_or_active'});continue;}
   warmBytes-=entry.fileBytes+entry.historyLogicalBytes;isolated++;host.writeIndex(entry.userId,'native');
  }catch(error){blocked.push({itemId:entry.id,reason:error instanceof Error?error.message:'storage_native_cache_evict_failed'});}
 }
 const receipt={beforeWarmBytes:before,warmBytes,capBytes:host.policy.hotBytes,isolated,physicalReleasedBytes:0,blocked,overCap:warmBytes>host.policy.hotBytes,
  nativeHistoryLogicalBytes,budgetBasis:'allocated file copies plus serialized native history bytes; quarantine and SQLite free pages are not physical releases'};
 host.db.prepare("INSERT INTO storage_scan_state VALUES('warm-cache',?,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify(receipt),Date.now());
 return receipt;
}
