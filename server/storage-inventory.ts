import fs from 'node:fs';
import path from 'node:path';
import { StorageCatalog, type StorageItem } from './storage-catalog.js';
import { safeStorageMember, type FileLocator } from './storage-file-lifecycle.js';
import { isPersistedDeliverablePath } from './paths.js';
import type { StorageKind } from './storage-lifecycle-policy.js';
import {storageMetadataRows} from './storage-scan.js';

export type StorageRoots = { dataRoot:string; tenantRoot:string; hostRootCodexHome:string; hostUserId:string; lifecycleRoot?:string };
const uuid=/^[0-9a-f-]{36}$/i;
const timestamp=(value:unknown)=>typeof value==='string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

/** Logical roots travel with the install; no source instance absolute path is
 * persisted as the default destination of a restored file. Ownership is
 * checked against business records before granting access to a shared root. */
export function storageRoot(catalog:StorageCatalog,roots:StorageRoots,userId:string,key:string):string {
  if(!uuid.test(userId) || !catalog.db.prepare('SELECT 1 FROM users WHERE id=?').get(userId))throw new Error('storage_owner_unknown');
  if(key==='library')return path.join(roots.tenantRoot,userId,'library');
  if(key==='native')return userId===roots.hostUserId?roots.hostRootCodexHome:path.join(roots.tenantRoot,userId,'codex-home');
  if(key==='native-images')return path.join(storageRoot(catalog,roots,userId,'native'),'generated_images');
  if(key==='voice')return path.join(roots.dataRoot,'voice-recordings',userId);
  if(key==='events' || key==='native-snapshots'){
    if(!roots.lifecycleRoot)throw new Error('storage_lifecycle_root_missing');
    return path.join(roots.lifecycleRoot,'materialized',userId,key);
  }
  if(key.startsWith('conversation:')){
    const id=key.slice('conversation:'.length);
    if(!uuid.test(id) || !catalog.db.prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?').get(id,userId))throw new Error('storage_conversation_owner');
    return path.join(roots.tenantRoot,userId,'conversations',id);
  }
  if(key.startsWith('deliverable:')){
    const id=key.slice('deliverable:'.length);
    if(!uuid.test(id) || !catalog.db.prepare(`SELECT 1 FROM files f JOIN conversations c ON c.id=f.conversation_id
      WHERE f.id=? AND c.user_id=? AND f.relative_path LIKE ?`).get(id,userId,`deliverables/${id}/%`))throw new Error('storage_deliverable_owner');
    return path.join(roots.dataRoot,'deliverables',id);
  }
  if(key.startsWith('reader:')){
    const id=key.slice('reader:'.length);
    const version=catalog.db.prepare('SELECT normalized_root FROM reading_source_versions WHERE id=? AND user_id=?').get(id,userId);
    if(!version?.normalized_root || version.normalized_root!==`reader-resources/${userId}/${id}`)throw new Error('storage_reader_owner');
    return safeStorageMember(roots.dataRoot,String(version.normalized_root));
  }
  throw new Error('storage_root_unknown');
}

export function fileStorageLocator(file:{id:string;kind:string;relative_path:string;conversation_id:string}):FileLocator {
  if(file.kind==='output' && isPersistedDeliverablePath(file.relative_path)){
    const prefix=`deliverables/${file.id}/`;
    if(!file.relative_path.startsWith(prefix))throw new Error('storage_deliverable_path_mismatch');
    return {root:`deliverable:${file.id}`,path:file.relative_path.slice(prefix.length)};
  }
  return {root:`conversation:${file.conversation_id}`,path:file.relative_path};
}

/** Migration uses known business upper bounds once. Later sidebar activity,
 * scans, retries and the presence of references never advance object clocks. */
export function enrollRegisteredFiles(catalog:StorageCatalog,roots:StorageRoots,fileId?:string):{items:number;issues:number} {
  let items=0,issues=0;
  const files=storageMetadataRows(catalog.db,`SELECT f.rowid AS _storage_rowid,f.*,c.user_id,c.last_active_at,
    (SELECT MAX(r.last_accessed_at) FROM reading_source_versions r WHERE r.file_id=f.id) AS read_at,
    cd.updated_at AS draft_at,pp.updated_at AS pending_at
    FROM files f JOIN conversations c ON c.id=f.conversation_id
    LEFT JOIN composer_drafts cd ON cd.conversation_id=f.composer_draft_id
    LEFT JOIN pending_prompts pp ON pp.id=f.pending_prompt_id WHERE c.deleted_at IS NULL AND (? IS NULL OR f.id=?)`,[fileId??null,fileId??null]);
  for(const file of files){
    const id=String(file.id),owner=String(file.user_id);
    try{
      const loc=fileStorageLocator(file as unknown as Parameters<typeof fileStorageLocator>[0]);
      const root=storageRoot(catalog,roots,owner,loc.root);
      const prior=catalog.db.prepare("SELECT * FROM storage_items WHERE user_id=? AND scope='file' AND source_key=?").get(owner,id) as StorageItem|undefined;
      if(prior && prior.locator_json!==JSON.stringify(loc) && loc.root===`deliverable:${id}`){
        // Older path recognition misclassified persisted dotfiles as workspace
        // files. Repair only that exact, never-archived mapping with a present
        // owned original; never retarget immutable versions or live leases.
        catalog.transaction(()=>{
          const old=JSON.parse(prior.locator_json),source=safeStorageMember(root,loc.path);
          if(old.root!==`conversation:${file.conversation_id}` || old.path!==file.relative_path
            || prior.current_version || catalog.db.prepare('SELECT 1 FROM storage_versions WHERE item_id=?').get(prior.id)
            || catalog.db.prepare('SELECT 1 FROM storage_leases WHERE item_id=? AND released_at IS NULL').get(prior.id)
            || catalog.db.prepare('SELECT 1 FROM storage_items WHERE user_id=? AND locator_json=? AND id!=?').get(owner,JSON.stringify(loc),prior.id)
            || !fs.existsSync(source) || fs.lstatSync(source).size!==Number(file.size)
            || fs.existsSync(safeStorageMember(storageRoot(catalog,roots,owner,old.root),old.path)))
            throw new Error('storage_deliverable_locator_repair_required');
          catalog.db.prepare('UPDATE storage_items SET locator_json=?,revision=revision+1 WHERE id=? AND locator_json=?')
            .run(JSON.stringify(loc),prior.id,prior.locator_json);
          catalog.audit(owner,prior.id,null,'legacy_deliverable_locator_repaired',0,{from:old,to:loc});
        });
      }
      // Missing legacy cold originals still enter the index and resolve through
      // their existing verified archive; absence is never permission to erase.
      if(fs.existsSync(root))safeStorageMember(root,loc.path);
      const used=Math.max(...[file.created_at,file.last_active_at,file.read_at,file.draft_at,file.pending_at].map(timestamp));
      const item=catalog.enroll({userId:owner,scope:'file',sourceKey:id,kind:String(file.mime_type).startsWith('image/')?'image':'file',locator:loc,
        name:String(file.original_name),trustedUsedAt:used||undefined,timeBasis:'legacy-business-upper-bound',
        recoveryDependency:Boolean(file.composer_draft_id || file.pending_prompt_id)});
      catalog.link(owner,item.id,'file',id);catalog.link(owner,item.id,'conversation',String(file.conversation_id));items++;
    }catch(e){catalog.issue('file',id,owner,e instanceof Error?e.message:'storage_inventory_failed');issues++;}
  }
  return {items,issues};
}

export function enrollVoiceFiles(catalog:StorageCatalog):number {
  let count=0;
  for(const row of storageMetadataRows(catalog.db,`SELECT rowid AS _storage_rowid,id,user_id,conversation_id,audio_relative_path,created_at,submitted_at,audio_restored_at
    FROM voice_transcriptions WHERE audio_relative_path IS NOT NULL`)){
    const owner=String(row.user_id),prefix=`voice-recordings/${owner}/`,relative=String(row.audio_relative_path);
    if(!relative.startsWith(prefix)){catalog.issue('voice',String(row.id),owner,'storage_voice_path_owner');continue;}
    const item=catalog.enroll({userId:owner,scope:'voice',sourceKey:String(row.id),kind:'voice',
      locator:{root:'voice',path:relative.slice(prefix.length)},name:path.basename(relative),
      trustedUsedAt:Math.max(...[row.created_at,row.submitted_at,row.audio_restored_at].map(timestamp))||undefined,timeBasis:'voice-business-time'});
    catalog.link(owner,item.id,'voice',String(row.id));
    if(row.conversation_id)catalog.link(owner,item.id,'conversation',String(row.conversation_id));count++;
  }return count;
}

/** This bounded scan is scheduled separately from the fifteen-minute due-item
 * pass. Small navigation text stays local. Unknown access dates explicitly
 * start at migration T0; a later scan cannot renew that deadline. */
export function enrollTree(catalog:StorageCatalog,roots:StorageRoots,input:{userId:string;root:string;kind:StorageKind;
  conversationId?:string;knownUpperBound?:number;maxEntries?:number}):{visited:number;enrolled:number;blocked:number} {
  const base=storageRoot(catalog,roots,input.userId,input.root),result={visited:0,enrolled:0,blocked:0};
  if(!fs.existsSync(base))return result;
  let localNavigationBytes=0;
  const walk=(relative:string)=>{
    const dir=relative?safeStorageMember(base,relative):base;
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(['.git','node_modules','__pycache__','.venv','skills'].includes(entry.name))continue;
      if(++result.visited>(input.maxEntries??100_000))throw new Error('storage_inventory_scan_budget');
      const member=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink()){catalog.issue(input.root,member,input.userId,'unmapped_symlink');result.blocked++;continue;}
      if(entry.isDirectory()){walk(member);continue;}
      if(!entry.isFile())continue;
      if(/-(wal|shm)$/.test(entry.name)){
        if(!fs.existsSync(path.join(base,member.replace(/-(wal|shm)$/, ''))))catalog.issue(input.root,member,input.userId,'storage_orphan_sqlite_sidecar_requires_recovery');
        continue;
      }
      const st=fs.lstatSync(path.join(base,member));
      if(st.size<=64*1024 && /\.(md|txt|json|ya?ml|toml)$/i.test(entry.name) && localNavigationBytes+st.size<=256*1024){localNavigationBytes+=st.size;continue;}
      if(['AGENTS.md','INDEX.md','PROFILE.md'].includes(entry.name) || entry.name.startsWith('.pp-storage-'))continue;
      const recovery=/^\.(runtime|automation)\//.test(member),jobId=/^\.runtime\/jobs\/([a-f0-9-]{36})\//i.exec(member)?.[1];
      const job=jobId && input.conversationId?catalog.db.prepare('SELECT updated_at FROM jobs WHERE id=? AND conversation_id=?').get(jobId,input.conversationId):undefined;
      const known=job?timestamp(job.updated_at):input.knownUpperBound;
      const item=catalog.enroll({userId:input.userId,scope:input.root,sourceKey:member,kind:input.kind,recoveryDependency:recovery,
        locator:{root:input.root,path:member},name:entry.name,
        trustedUsedAt:known?Math.max(known,Math.floor(st.mtimeMs)):undefined,
        timeBasis:job?'job-business-and-write-upper-bound':known?'legacy-business-and-write-upper-bound':undefined});
      if(input.conversationId)catalog.link(input.userId,item.id,'conversation',input.conversationId);
      catalog.link(input.userId,item.id,'path',`${input.root}/${member}`);result.enrolled++;
    }
  };
  try{walk('');}catch(e){catalog.issue('tree',`${input.userId}:${input.root}`,input.userId,e instanceof Error?e.message:'storage_tree_failed');result.blocked++;}
  return result;
}

export function itemForFile(catalog:StorageCatalog,userId:string,fileId:string):StorageItem|undefined {
  return catalog.linked(userId,'file',fileId)[0];
}

/** Checkpoints protect exact immutable versions in the cloud. Their local
 * dependency window is finite, and merely finding the reference is not use. */
export function enrollRecoveryDependencies(catalog:StorageCatalog,roots:StorageRoots):number{
  let count=0;
  for(const row of storageMetadataRows(catalog.db,`SELECT cp.rowid AS _storage_rowid,cp.job_id,cp.checkpoint_json,c.user_id,c.id AS conversation_id,p.executor_id
    FROM job_recovery_checkpoints cp JOIN jobs j ON j.id=cp.job_id JOIN conversations c ON c.id=j.conversation_id
    LEFT JOIN projects p ON p.id=c.project_id`)){
    if(!['local-host','tenant-local'].includes(String(row.executor_id)))continue;
    try{
      const checkpoint=JSON.parse(String(row.checkpoint_json)),userId=String(row.user_id),cid=String(row.conversation_id);
      const rootKeys=[`conversation:${cid}`,'library','native'];
      for(const value of checkpoint.files??[]){
        if(typeof value!=='string' || !path.isAbsolute(value))continue;
        let mapped=false;
        for(const rootKey of rootKeys){
          const root=storageRoot(catalog,roots,userId,rootKey),relative=path.relative(root,value);
          if(!relative || relative.startsWith('../') || path.isAbsolute(relative))continue;
          const file=safeStorageMember(root,relative);
          if(fs.existsSync(file) && !fs.lstatSync(file).isFile())continue;
          // Native history requires its consistent unit, never a standalone
          // checkpoint file snapshot of a live history database or rollout.
          if(rootKey==='native'){mapped=true;break;}
          const item=catalog.enroll({userId,scope:'checkpoint-file',sourceKey:JSON.stringify({root:rootKey,path:relative}),kind:'recovery',locator:{root:rootKey,path:relative},
            name:path.basename(relative),trustedUsedAt:timestamp(checkpoint.capturedAt)||undefined,timeBasis:'checkpoint-captured-at',recoveryDependency:true});
          catalog.link(userId,item.id,'checkpoint',String(row.job_id));catalog.link(userId,item.id,'conversation',cid);
          if(item.current_version)catalog.reference(userId,item.current_version,'checkpoint',String(row.job_id));
          mapped=true;count++;break;
        }
        if(!mapped && value.startsWith(roots.dataRoot+'/'))catalog.issue('checkpoint',`${row.job_id}:${value}`,userId,'storage_checkpoint_path_requires_owner_mapping');
      }
    }catch(e){catalog.issue('checkpoint',String(row.job_id),String(row.user_id),e instanceof Error?e.message:'storage_checkpoint_parse');}
  }
  return count;
}
