import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {Readable} from 'node:stream';
import type {StorageCatalog} from './storage-catalog.js';
import type {StorageChunkStore} from './storage-chunks.js';
import {sha256Path} from './storage-chunks.js';
import {safeStorageMember,type FileManifest} from './storage-file-lifecycle.js';
import {storageRoot,type StorageRoots,enrollVoiceFiles} from './storage-inventory.js';
import {consumeAgeFile} from './storage-age-stream.js';
import {verifyTarStream,type TarMember} from './storage-tar.js';
import {acquireColdStorageLock,removeColdStorageLock,type ColdStorageRoots} from './conversation-cold-storage.js';

type Member={relativePath:string;size:number;sha256:string};
/** Legacy reader tar and raw voice age objects become ordinary immutable
 * account objects. Conversion is a retryable streaming pass; it never deletes
 * an old archive or changes an original's usage clock or isolation timestamp. */
export async function importLegacyResource(input:{catalog:StorageCatalog;chunks:StorageChunkStore;roots:StorageRoots;legacyRoots:ColdStorageRoots;
 kind:'reader'|'voice';id:string;userId:string;read:(remote:string,bytes:number)=>Promise<Readable>}){
 const {catalog,chunks,roots,kind,id,userId}=input,lock=acquireColdStorageLock(input.legacyRoots,`${kind}-${id}`);
 let generation=0;
 try{
  const row=kind==='reader'?catalog.db.prepare(`SELECT * FROM reading_source_versions WHERE id=? AND user_id=?`).get(id,userId):catalog.db.prepare('SELECT * FROM voice_transcriptions WHERE id=? AND user_id=?').get(id,userId);
  if(!row)throw new Error('storage_legacy_resource_owner');
  const voice=kind==='voice',remote=String(voice?row.audio_remote_path:row.remote_path),drive=voice?row.audio_remote_drive_id:row.remote_drive_id;
  const cipherSha=String(voice?row.audio_archive_sha256:row.storage_archive_sha256),cipherBytes=Number(voice?row.audio_archive_bytes:row.storage_archive_bytes);
  generation=Number(voice?row.audio_generation:row.storage_generation);
  if(drive!==chunks.policy.driveId || !(voice?row.audio_verified_at:row.storage_verified_at) || !/^[a-f0-9]{64}$/.test(cipherSha) || cipherBytes<1)throw new Error('storage_legacy_resource_unverified');
  const rootKey=voice?'voice':`reader:${id}`,root=storageRoot(catalog,roots,userId,rootKey);
  const prefix=`voice-recordings/${userId}/`;
  if(voice && !String(row.audio_relative_path).startsWith(prefix))throw new Error('storage_legacy_voice_path');
  const text=voice?JSON.stringify({format:'pp-legacy-voice-v1',size:row.audio_bytes,sha256:row.audio_sha256}):String(row.storage_manifest_json),manifestHash=crypto.createHash('sha256').update(text).digest('hex');
  const manifest=JSON.parse(text);
  if(!voice && (manifestHash!==row.storage_manifest_sha256 || manifest.format!=='reader-normalized-v1' || manifest.userId!==userId || manifest.versionId!==id || manifest.generation!==generation))throw new Error('storage_legacy_reader_manifest');
  const members:Member[]=voice?[{relativePath:String(row.audio_relative_path).slice(prefix.length),size:Number(row.audio_bytes),sha256:String(row.audio_sha256)}]:manifest.entries;
  if(!Array.isArray(members) || new Set(members.map(m=>m.relativePath)).size!==members.length)throw new Error('storage_legacy_resource_members');
  const prior=catalog.db.prepare('SELECT * FROM storage_legacy_imports WHERE kind=? AND subject_id=? AND generation=?').get(kind,id,generation);
  if(prior && (prior.archive_sha256!==cipherSha || prior.manifest_sha256!==manifestHash || prior.user_id!==userId))throw new Error('storage_legacy_resource_changed');
  if(prior?.verified_at)return {alreadyImported:true,members:members.length};
  catalog.db.prepare('INSERT OR IGNORE INTO storage_legacy_imports(kind,subject_id,generation,user_id,archive_sha256,manifest_sha256,started_at) VALUES(?,?,?,?,?,?,?)').run(kind,id,generation,userId,cipherSha,manifestHash,catalog.now());
  if(voice)enrollVoiceFiles(catalog);
  const expected:Record<string,TarMember>=voice?{}:{'manifest.json':{size:Buffer.byteLength(text),sha256:manifestHash}},byName=new Map<string,Member>();
  for(const member of members){
   safeStorageMember(root,member.relativePath);
   if(!Number.isSafeInteger(member.size) || member.size<0 || !/^[a-f0-9]{64}$/.test(member.sha256))throw new Error('storage_legacy_member_identity');
   const name=voice?member.relativePath:`resources/${member.relativePath}`;byName.set(name,member);expected[name]={size:member.size,sha256:member.sha256};
  }
  const convert=async(name:string,_size:number,stream:Readable)=>{
   const member=byName.get(name);if(!member){for await(const _ of stream){}return;}
   const converted=catalog.db.prepare('SELECT version_id FROM storage_legacy_members WHERE kind=? AND subject_id=? AND generation=? AND member=?').get(kind,id,generation,name);
   if(converted){const version=catalog.version(userId,String(converted.version_id));if(!version.verified_at || version.sha256!==member.sha256)throw new Error('storage_legacy_converted_member_changed');for await(const _ of stream){}return;}
   const loc={root:rootKey,path:member.relativePath},item=catalog.enroll({userId,scope:voice?'voice':rootKey,sourceKey:voice?id:member.relativePath,kind:voice?'voice':'reader',locator:loc,name:path.basename(member.relativePath),
    trustedUsedAt:Date.parse(String(voice?row.submitted_at??row.created_at:row.last_accessed_at))||undefined,timeBasis:'legacy-resource-business-time'});
   catalog.link(userId,item.id,kind,id);
   const data=await chunks.archiveStream(userId,stream,{sha256:member.sha256,bytes:member.size}),version=catalog.registerVersion(userId,item.id,{...data,fingerprint:`legacy:${cipherSha}:${name}`},false);
   const owner=fs.statSync(fs.existsSync(root)?root:roots.dataRoot);
   const file:FileManifest={format:'pp-storage-file-v1',userId,itemId:item.id,versionId:version.id,name:item.display_name,locator:loc,sha256:member.sha256,bytes:member.size,mode:0o600,uid:owner.uid,gid:owner.gid,chunks:data.chunks.map(c=>c.id)};
   catalog.verifyVersion(userId,version.id,file,data.chunks);
   catalog.db.prepare('INSERT INTO storage_legacy_members VALUES(?,?,?,?,?,?,?,?)').run(kind,id,generation,name,userId,item.id,version.id,item.current_version);
   catalog.reference(userId,version.id,'legacy-conversion',`${kind}:${id}:${generation}:${name}`);
  };
  const stream=await input.read(remote,cipherBytes);
  if(voice){const member=members[0];await consumeAgeFile({stream,identity:chunks.policy.identity,cipherSha256:cipherSha,cipherBytes,sha256:member.sha256,bytes:member.size,consume:plain=>convert(member.relativePath,member.size,plain)});}
  else await verifyTarStream({stream,identity:chunks.policy.identity,ciphertextSha256:cipherSha,ciphertextBytes:cipherBytes,members:expected,
   maxPlaintextBytes:members.reduce((n,m)=>n+m.size,Buffer.byteLength(text)),onMember:convert});
  const converted=catalog.db.prepare('SELECT * FROM storage_legacy_members WHERE kind=? AND subject_id=? AND generation=?').all(kind,id,generation);
  if(converted.length!==members.length)throw new Error('storage_legacy_resource_incomplete');
  const states=new Map<string,string>();
  for(const record of converted){const item=catalog.item(userId,String(record.item_id)),version=catalog.version(userId,String(record.version_id)),loc=JSON.parse(item.locator_json),file=safeStorageMember(root,loc.path);
   states.set(item.id,!fs.existsSync(file)?'cold':sha256Path(file)===version.sha256?'local':'changed');}
  catalog.transaction(()=>{
   const current=voice?catalog.db.prepare('SELECT audio_generation g,audio_archive_sha256 h FROM voice_transcriptions WHERE id=?').get(id):catalog.db.prepare('SELECT storage_generation g,storage_archive_sha256 h FROM reading_source_versions WHERE id=?').get(id);
   if(current?.g!==generation || current.h!==cipherSha)throw new Error('storage_legacy_resource_changed');
   for(const record of converted){const item=catalog.item(userId,String(record.item_id)),state=states.get(item.id)!;
    if(item.current_version===record.prior_current_version && state!=='changed'){
     catalog.db.prepare('UPDATE storage_items SET current_version=?,revision=revision+1 WHERE id=?').run(record.version_id,item.id);
     catalog.db.prepare('UPDATE storage_versions SET state=? WHERE id=?').run(state,record.version_id);
    }
   }
   catalog.db.prepare('UPDATE storage_legacy_imports SET verified_at=?,blocked_reason=NULL WHERE kind=? AND subject_id=? AND generation=?').run(catalog.now(),kind,id,generation);
   catalog.audit(userId,null,null,'legacy_resource_objects_verified',cipherBytes,{kind,id,generation,members:converted.length});
  });
  return {alreadyImported:false,members:members.length};
 }catch(e){catalog.db.prepare('UPDATE storage_legacy_imports SET blocked_reason=? WHERE kind=? AND subject_id=? AND generation=?').run(e instanceof Error?e.message:'storage_legacy_resource_failed',kind,id,generation);throw e;}
 finally{removeColdStorageLock(lock);}
}
