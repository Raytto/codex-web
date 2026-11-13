import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import type {StorageHost} from './storage-host.js';
import {storageRoot} from './storage-inventory.js';
import {acquireCodexLifecycleLock,assertNoUnmanagedCodexRuntime} from './codex-lifecycle-lock.js';
import {assertFileNotOpen} from './storage-file-lifecycle.js';
import {fileFingerprint} from './storage-chunks.js';
import {STORAGE_DAY} from './storage-lifecycle-policy.js';

/** Only the engine's regenerable provider/catalog caches are selected. User
 * plans, generated images, rollout/history databases and installed plugins are
 * deliberately outside this deletion list and use their archive/recovery path. */
export function collectNativeRebuildable(host:StorageHost,maxFiles=500,reserve?:()=>boolean){
 let attempted=0;const attempt=()=>attempted<maxFiles&&(!reserve||reserve())&&++attempted>0;
 const result={releasedBytes:0,files:0,debugRows:0,blocked:[] as Array<{user:string;reason:string}>},now=host.catalog.now();
 for(const user of host.db.prepare('SELECT id FROM users ORDER BY id').all()){
  const uid=String(user.id),home=storageRoot(host.catalog,host.roots,uid,'native');if(!fs.existsSync(home))continue;
  let unlock:(()=>void)|undefined;
  try{
   if(fs.realpathSync(home)!==path.resolve(home))throw new Error('storage_cache_home_alias');
   unlock=acquireCodexLifecycleLock(home);
   const logs=path.join(home,'logs_2.sqlite');assertNoUnmanagedCodexRuntime(home,[logs]);
   const scanKey=`native-cache:${uid}`,prior=host.db.prepare('SELECT value_json FROM storage_scan_state WHERE name=?').get(scanKey);
   const after=prior?String(JSON.parse(String(prior.value_json)).after??''):'';
   let visited=0,last=after,stopped=false;const deadline=Date.now()+10_000;
   const walk=(directory:string,relative:string)=>{
    if(!fs.existsSync(directory) || stopped)return;
    if(fs.realpathSync(directory)!==path.resolve(directory))throw new Error('storage_cache_symlink');
    for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
     if(result.files>=maxFiles || visited>=5000 || Date.now()>deadline){stopped=true;break;}
     const key=`${relative}/${entry.name}`,file=path.join(directory,entry.name);
     if(entry.isSymbolicLink())continue;
     if(entry.isDirectory()){if(key>after || after.startsWith(key+'/'))walk(file,key);continue;}
     if(key<=after)continue;
     visited++;last=key;const st=fs.lstatSync(file);
     if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || st.mtimeMs+7*STORAGE_DAY>now)continue;
     assertFileNotOpen(file);if(fileFingerprint(fs.lstatSync(file))!==fileFingerprint(st))continue;
     if(!attempt()){stopped=true;break;}
     fs.unlinkSync(file);result.files++;result.releasedBytes+=st.blocks*512;
    }
   };
   for(const name of ['codex_apps_server_info','codex_apps_tools','remote_plugin_catalog'])walk(path.join(home,'cache',name),name);
   host.db.prepare('INSERT INTO storage_scan_state VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at')
    .run(scanKey,JSON.stringify({after:stopped?last:''}),now);
   if(fs.existsSync(logs)&&attempted<maxFiles){
    const stat=fs.lstatSync(logs);if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1)throw new Error('storage_debug_database_scope');
    const db=new DatabaseSync(logs);
    try{
     db.exec('PRAGMA busy_timeout=1000');
     const columns=new Set(db.prepare('PRAGMA table_info(logs)').all().map(row=>String(row.name)));
     if(!['id','ts','level'].every(name=>columns.has(name)))throw new Error('storage_debug_schema_unsupported');
     // Engine ts is epoch seconds. Unknown/invalid historical timestamps stay
     // visible for repair; they are never treated as epoch zero and deleted.
     const cutoff=[Math.floor((now-7*STORAGE_DAY)/1000),Math.floor((now-30*STORAGE_DAY)/1000)];
     if(!db.prepare("SELECT 1 FROM logs WHERE ts>=1577836800 AND ts<CASE WHEN upper(level) IN ('DEBUG','TRACE','INFO') THEN ? ELSE ? END LIMIT 1").get(...cutoff)||!attempt())continue;
     db.exec('BEGIN IMMEDIATE');
     const removed=db.prepare(`DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE ts>=1577836800
       AND ts<CASE WHEN upper(level) IN ('DEBUG','TRACE','INFO') THEN ? ELSE ? END ORDER BY id LIMIT 1000)`)
       .run(Math.floor((now-7*STORAGE_DAY)/1000),Math.floor((now-30*STORAGE_DAY)/1000));
     db.exec('COMMIT');result.debugRows+=Number(removed.changes);
    }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
   }
   host.catalog.resolveIssue('local-gc',uid);
  }catch(error){const reason=error instanceof Error?error.message:'storage_local_gc_failed';result.blocked.push({user:uid,reason});host.catalog.issue('local-gc',uid,uid,reason);}
  finally{unlock?.();}
 }
 const cleaner=process.env.STORAGE_BUILD_CLEANER;
 if(cleaner&&attempted<maxFiles){
  const prior=host.db.prepare("SELECT updated_at FROM storage_scan_state WHERE name='build-cache-gc'").get();
  if(!prior || Number(prior.updated_at)+STORAGE_DAY<=now){
   try{
    const st=fs.lstatSync(cleaner);if(!path.isAbsolute(cleaner)||!st.isFile()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022)!==0)throw new Error('storage_build_cleaner_scope');
    if(!attempt())throw new Error('storage_maintenance_yield');
    execFileSync(cleaner,['gc-idle'],{stdio:'ignore',timeout:120_000});
    host.db.prepare("INSERT INTO storage_scan_state VALUES('build-cache-gc','{}',?) ON CONFLICT(name) DO UPDATE SET updated_at=excluded.updated_at").run(now);
   }catch{result.blocked.push({user:'__shared__',reason:'scoped_builder_busy_or_gc_failed'});}
  }
 }
 host.catalog.audit('__shared__',null,null,'rebuildable_cache_and_debug_gc',result.releasedBytes,result);return result;
}
