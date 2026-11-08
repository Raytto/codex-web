#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StorageHost} from './storage-host.js';
import {storageEnvironment} from './storage-environment.js';
import {StorageAccessMonitor} from './storage-access-monitor.js';
import {runStorageMaintenance} from './storage-maintenance.js';
import {readBackupPlan,createStorageBackup,compactLocalRecoveryPoint} from './storage-backup-plan.js';
import {measureStorage} from './storage-metrics.js';
import {runStorageProcess} from './storage-process.js';

async function main(){
 process.env.PPAGENT_STORAGE_MAINTENANCE='1';
 const action=process.argv[2]??'help';
 if(action==='help'||action==='--help'){process.stdout.write('storage-maintenance-cli inventory | tick | backfill | backup | measure | local-recovery | monitor\nExplicit STORAGE_* instance configuration is required. No live database migrations run from this command.\n');return;}
 const host=new StorageHost(storageEnvironment(),{background:true});let monitor:StorageAccessMonitor|undefined;
 try{
  if(action==='monitor'){
   const helper=process.env.STORAGE_MONITOR_HELPER||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../deploy/storage-access-monitor.py');
   if(!fs.existsSync(helper))throw new Error('storage_monitor_helper_missing');
   await new Promise<void>((resolve,reject)=>{
    monitor=new StorageAccessMonitor(host.catalog,host.roots,path.join(host.roots.lifecycleRoot!,'access'),helper,()=>reject(new Error('storage_access_monitor_failed')));monitor.start();
    const stop=()=>void monitor!.stop().then(resolve);process.once('SIGTERM',stop);process.once('SIGINT',stop);
   });
   return;
  }
  let result:unknown;
  if(action==='inventory')result={inventory:host.inventory(true)};
  else if(action==='tick'||action==='backfill'){
   const maxItems=Number(process.env.STORAGE_BACKGROUND_MAX_ITEMS??1),budgetMs=Number(process.env.STORAGE_BACKGROUND_BUDGET_MS??120_000);
   if(!Number.isSafeInteger(maxItems)||maxItems<1||maxItems>32||!Number.isSafeInteger(budgetMs)||budgetMs<1000||budgetMs>600_000)throw new Error('storage_background_batch_invalid');
   result=await runStorageMaintenance(host,{inventory:action==='backfill',maxItems,budgetMs,conservative:process.env.STORAGE_MAINTENANCE_MODE==='conservative'});
  }
  else if(action==='backup'||action==='local-recovery'){
   if(!process.env.STORAGE_BACKUP_PLAN)throw new Error('storage_backup_plan_missing');
   const plan=readBackupPlan(process.env.STORAGE_BACKUP_PLAN);
   // The immutable installed host release supplies the SHA. A later deploy
   // must never keep reporting the first install's backup-plan SHA.
   plan.codeSha=fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../release-commit'),'utf8').trim();
   if(!/^[a-f0-9]{40}$/.test(plan.codeSha))throw new Error('storage_release_commit_missing');
   result=action==='backup'?await createStorageBackup(host,plan):compactLocalRecoveryPoint(host,plan);
  }else if(action==='measure'){
   if(!process.env.STORAGE_STATE_ROOT)throw new Error('storage_state_root_missing');
   result=measureStorage(host,{stateRoot:process.env.STORAGE_STATE_ROOT,sharedRoots:(process.env.STORAGE_SHARED_MEASURE_ROOTS??'').split(',').filter(Boolean)});
  }else throw new Error('storage_maintenance_action_unknown');
  // Reports contain identities, counts and hashes, never credentials or signed URLs.
  process.stdout.write(JSON.stringify(result)+'\n');
 }finally{if(monitor)await monitor.stop();host.close();}
}
void runStorageProcess(main).catch(error=>{process.stderr.write(JSON.stringify({ok:false,error:error instanceof Error?error.message:'storage_maintenance_failed'})+'\n');process.exitCode=1;});
