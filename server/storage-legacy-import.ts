import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StorageCatalog } from './storage-catalog.js';
import { StorageChunkStore,sha256Path } from './storage-chunks.js';
import {safeStorageMember,type FileManifest,type FileLocator} from './storage-file-lifecycle.js';
import {storageRoot,type StorageRoots} from './storage-inventory.js';
import {verifyTarStream,type TarMember} from './storage-tar.js';
import {acquireColdStorageLock,removeColdStorageLock,type ColdStorageRoots,type ColdManifest,type ColdManifestEntry} from './conversation-cold-storage.js';

type Converted={member:string;user_id:string;item_id:string;version_id:string;prior_current_version:string|null};
function locator(entry:ColdManifestEntry,cid:string):FileLocator {
  if(entry.root==='codexHome')return {root:'native',path:entry.relativePath};
  if(entry.root==='conversation')return {root:`conversation:${cid}`,path:entry.relativePath};
  const match=/^deliverables\/([a-f0-9-]{36})\/(.+)$/i.exec(entry.relativePath);
  if(entry.root==='dataRoot' && match)return {root:`deliverable:${match[1]}`,path:match[2]};
  throw new Error('legacy_member_root_unmapped');
}

/** One compatibility pass splits an old conversation tar into independently
 * addressed, verified file objects. Afterwards reading one small file fetches
 * only its object; neither its siblings nor the original tar are downloaded.
 * Partially completed passes reuse verified chunks and never evict originals. */
export async function importLegacyConversation(input:{catalog:StorageCatalog;chunks:StorageChunkStore;roots:StorageRoots;
  legacyRoots:ColdStorageRoots;conversationId:string;read:(remote:string,bytes:number)=>Promise<Readable>;progress?:(completed:number,total:number)=>void}) {
  const {catalog,chunks,roots,conversationId:cid}=input;
  const lock=acquireColdStorageLock(input.legacyRoots,cid);let generation=0;
  try{
    const row=catalog.db.prepare(`SELECT c.user_id,c.last_active_at,s.* FROM conversation_storage s JOIN conversations c ON c.id=s.conversation_id
      WHERE s.conversation_id=? AND c.deleted_at IS NULL`).get(cid);
    if(!row?.manifest_json || !row.manifest_sha256 || !row.archive_sha256 || !row.remote_path || !row.archive_bytes || !row.verified_at)throw new Error('legacy_conversation_not_verified');
    generation=Number(row.generation);const userId=String(row.user_id),manifestText=String(row.manifest_json),m=JSON.parse(manifestText) as ColdManifest;
    if(crypto.createHash('sha256').update(manifestText).digest('hex')!==row.manifest_sha256 || m.conversationId!==cid || m.userId!==userId || m.generation!==generation
      || !['conversation-cold-storage-v1','conversation-cold-storage-v2','conversation-cold-storage-v3'].includes(m.format))throw new Error('legacy_conversation_manifest_identity');
    const prior=catalog.db.prepare("SELECT * FROM storage_legacy_imports WHERE kind='conversation' AND subject_id=? AND generation=?").get(cid,generation);
    if(prior && (prior.archive_sha256!==row.archive_sha256 || prior.manifest_sha256!==row.manifest_sha256 || prior.user_id!==userId))throw new Error('legacy_import_identity_changed');
    if(prior?.verified_at)return {alreadyImported:true,members:m.entries.length};
    catalog.db.prepare(`INSERT OR IGNORE INTO storage_legacy_imports(kind,subject_id,generation,user_id,archive_sha256,manifest_sha256,started_at)
      VALUES('conversation',?,?,?,?,?,?)`).run(cid,generation,userId,row.archive_sha256,row.manifest_sha256,catalog.now());
    const entries=new Map<string,ColdManifestEntry>(),members:Record<string,TarMember>={
      'manifest.json':{size:Buffer.byteLength(manifestText),sha256:String(row.manifest_sha256)},
    };
    for(const entry of m.entries){
      const key=`${entry.kind}/${entry.relativePath}`;
      if(entries.has(key) || !Number.isSafeInteger(entry.size) || entry.size<0 || !/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('legacy_member_identity');
      // Resolve every owner/path before any cloud conversion starts.
      const loc=locator(entry,cid),root=storageRoot(catalog,roots,userId,loc.root);
      if(fs.existsSync(root))safeStorageMember(root,loc.path);
      entries.set(key,entry);members[key]={size:entry.size,sha256:entry.sha256};
    }
    await verifyTarStream({stream:await input.read(String(row.remote_path),Number(row.archive_bytes)),identity:chunks.policy.identity,
      progress:bytes=>input.progress?.(bytes,Number(row.archive_bytes)),
      ciphertextSha256:String(row.archive_sha256),ciphertextBytes:Number(row.archive_bytes),members,
      maxPlaintextBytes:m.entries.reduce((n,e)=>n+e.size,Buffer.byteLength(manifestText)),age:chunks.age,
      onMember:async(name,_size,stream)=>{
        const entry=entries.get(name);if(!entry){for await(const _chunk of stream){/* manifest is verified by the parser */}return;}
        const prior=catalog.db.prepare("SELECT * FROM storage_legacy_members WHERE kind='conversation' AND subject_id=? AND generation=? AND member=?").get(cid,generation,name) as Converted|undefined;
        if(prior){
          const v=catalog.version(userId,prior.version_id);
          if(v.sha256!==entry.sha256 || !v.verified_at)throw new Error('legacy_converted_member_changed');
          for await(const _chunk of stream){/* exact original SHA is still checked */}return;
        }
        const loc=locator(entry,cid),item=catalog.enroll({userId,scope:`legacy:${cid}`,sourceKey:name,
          kind:entry.root==='codexHome'?'native-history':'file',locator:loc,name:path.basename(entry.relativePath),
          trustedUsedAt:Date.parse(String(row.last_active_at)),timeBasis:'legacy-business-upper-bound'});
        catalog.link(userId,item.id,entry.root==='codexHome'?'native-conversation':'conversation',cid);
        const bytes=await chunks.archiveStream(userId,stream,{sha256:entry.sha256,bytes:entry.size});
        const version=catalog.registerVersion(userId,item.id,{...bytes,fingerprint:`legacy:${row.archive_sha256}:${name}`},false);
        const ownerRoot=storageRoot(catalog,roots,userId,loc.root),owner=fs.existsSync(ownerRoot)?fs.statSync(ownerRoot):fs.statSync(roots.tenantRoot);
        const fileManifest:FileManifest={format:'pp-storage-file-v1',userId,itemId:item.id,versionId:version.id,name:item.display_name,locator:loc,
          sha256:entry.sha256,bytes:entry.size,mode:entry.mode??0o600,uid:entry.uid??owner.uid,gid:entry.gid??owner.gid,chunks:bytes.chunks.map(c=>c.id)};
        catalog.verifyVersion(userId,version.id,fileManifest,bytes.chunks);
        catalog.db.prepare(`INSERT INTO storage_legacy_members(kind,subject_id,generation,member,user_id,item_id,version_id,prior_current_version)
          VALUES('conversation',?,?,?,?,?,?,?)`).run(cid,generation,name,userId,item.id,version.id,item.current_version);
        catalog.reference(userId,version.id,'legacy-conversion',`${cid}:${generation}:${name}`);
      }});
    const converted=catalog.db.prepare("SELECT * FROM storage_legacy_members WHERE kind='conversation' AND subject_id=? AND generation=?").all(cid,generation) as Converted[];
    if(converted.length!==entries.size)throw new Error('legacy_import_member_count');
    const localState=new Map<string,'cold'|'local'|'changed'>();
    for(const record of converted){
      const item=catalog.item(userId,record.item_id),v=catalog.version(userId,record.version_id),loc=JSON.parse(item.locator_json) as FileLocator;
      const root=storageRoot(catalog,roots,userId,loc.root);
      if(!fs.existsSync(root)){localState.set(item.id,'cold');continue;}
      const source=safeStorageMember(root,loc.path);
      localState.set(item.id,!fs.existsSync(source)?'cold':sha256Path(source)===v.sha256?'local':'changed');
    }
    catalog.transaction(()=>{
      const latest=catalog.db.prepare('SELECT generation,archive_sha256 FROM conversation_storage WHERE conversation_id=?').get(cid);
      if(latest?.generation!==generation || latest.archive_sha256!==row.archive_sha256)throw new Error('legacy_source_generation_changed');
      for(const record of converted){
        const item=catalog.item(userId,record.item_id),state=localState.get(item.id)!;
        if(item.current_version===record.prior_current_version && state!=='changed'){
          catalog.db.prepare('UPDATE storage_items SET current_version=?,revision=revision+1 WHERE id=? AND user_id=?').run(record.version_id,item.id,userId);
          catalog.db.prepare('UPDATE storage_versions SET state=? WHERE id=? AND user_id=?').run(state,record.version_id,userId);
        }
      }
      catalog.db.prepare("UPDATE storage_legacy_imports SET verified_at=?,blocked_reason=NULL WHERE kind='conversation' AND subject_id=? AND generation=?").run(catalog.now(),cid,generation);
      catalog.audit(userId,null,null,'legacy_file_objects_verified',Number(row.archive_bytes),{conversationId:cid,generation,members:converted.length});
    });
    return {alreadyImported:false,members:converted.length};
  }catch(e){catalog.db.prepare("UPDATE storage_legacy_imports SET blocked_reason=? WHERE kind='conversation' AND subject_id=? AND generation=?")
    .run(e instanceof Error?e.message:'legacy_import_failed',cid,generation);throw e;}
  finally{removeColdStorageLock(lock);}
}
