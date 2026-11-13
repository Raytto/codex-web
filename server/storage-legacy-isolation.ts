import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sha256Path } from './storage-chunks.js';
import { assertFileNotOpen, safeStorageMember } from './storage-file-lifecycle.js';
import { STORAGE_DAY } from './storage-lifecycle-policy.js';
import {storageMetadataRows} from './storage-scan.js';

export type LegacyGeneration = {
  kind:'conversation'|'voice'|'reader'; subject_id:string; generation:number; user_id:string;
  manifest_json:string; manifest_sha256:string; remote_drive:string; remote_path:string; archive_sha256:string;
  archive_bytes:number; verified_at:number; isolated_path:string|null; isolated_at:number|null; purge_started_at:number|null; released_at:number|null; blocked_reason:string|null;
};
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
const time=(s:unknown)=>typeof s==='string' && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null;

/** Current state and last updated time are deliberately absent from this key.
 * Rewarming cannot hide or restart the grace period of an earlier generation. */
export function importLegacyIsolation(db:DatabaseSync):{imported:number;issues:Array<{kind:string;id:string;reason:string}>} {
  const issues:Array<{kind:string;id:string;reason:string}>=[];let imported=0;
  const put=(r:LegacyGeneration)=>{
    if(!r.isolated_path || !r.isolated_at || !r.verified_at || !/^[a-f0-9]{64}$/.test(r.archive_sha256)
      || hash(r.manifest_json)!==r.manifest_sha256 || !r.remote_path || !r.remote_drive || r.archive_bytes<1)throw new Error('legacy_evidence_incomplete');
    imported+=Number(db.prepare(`INSERT INTO storage_legacy_generations(kind,subject_id,generation,user_id,manifest_json,manifest_sha256,
      remote_drive,remote_path,archive_sha256,archive_bytes,verified_at,isolated_path,isolated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,subject_id,generation) DO NOTHING`).run(r.kind,r.subject_id,r.generation,r.user_id,
        r.manifest_json,r.manifest_sha256,r.remote_drive,r.remote_path,r.archive_sha256,r.archive_bytes,r.verified_at,r.isolated_path,r.isolated_at).changes);
    const existing=db.prepare('SELECT * FROM storage_legacy_generations WHERE kind=? AND subject_id=? AND generation=?').get(r.kind,r.subject_id,r.generation) as LegacyGeneration;
    if(existing.user_id!==r.user_id || existing.manifest_sha256!==r.manifest_sha256 || existing.remote_path!==r.remote_path
      || existing.archive_sha256!==r.archive_sha256 || existing.isolated_path!==r.isolated_path)throw new Error('legacy_generation_identity_conflict');
  };
  for(const kind of ['conversation','reader','voice'] as const){
    const table=kind==='conversation'?'conversation_storage_audit':kind==='reader'?'reading_storage_audit':'voice_recording_storage_audit';
    const idColumn=kind==='conversation'?'conversation_id':kind==='reader'?'version_id':'transcription_id';
    const action=kind==='voice'?'archive_remote_verified':'remote_verify';
    const rows=storageMetadataRows(db,`SELECT rowid AS _storage_rowid,${idColumn} AS id,generation,details_json,created_at FROM ${table} WHERE action=?`,[action]);
    for(const raw of rows){
      const id=String(raw.id),generation=Number(raw.generation);
      try{
        const evict=db.prepare(`SELECT details_json,created_at FROM ${table} WHERE ${idColumn}=? AND generation=? AND action='local_evict_complete' ORDER BY created_at LIMIT 1`).get(id,generation);
        if(!evict)continue; // upload success without successful isolation never authorizes deletion
        const verified=JSON.parse(String(raw.details_json)),isolated=JSON.parse(String(evict.details_json));
        let userId:string,manifest:string,manifestHash:string,drive:string,remote:string,sha:string,bytes:number,isolatedPath:string;
        if(kind==='conversation'){
          manifest=verified.manifest_json;manifestHash=verified.manifest_sha256;
          const m=JSON.parse(manifest);userId=m.userId;
          if(m.conversationId!==id || m.generation!==generation || !['conversation-cold-storage-v1','conversation-cold-storage-v2','conversation-cold-storage-v3'].includes(m.format))throw new Error('legacy_manifest_identity');
          drive=verified.remote_drive_id;remote=verified.remote_path;sha=verified.archive_sha256;bytes=verified.archive_bytes;isolatedPath=isolated.local_isolated_path;
        }else if(kind==='reader'){
          manifest=verified.storage_manifest_json;manifestHash=verified.storage_manifest_sha256;
          const m=JSON.parse(manifest);userId=m.userId;
          if(m.versionId!==id || m.generation!==generation || m.format!=='reader-normalized-v1')throw new Error('legacy_manifest_identity');
          drive=verified.remote_drive_id;remote=verified.remote_path;sha=verified.storage_archive_sha256;bytes=verified.storage_archive_bytes;isolatedPath=isolated.local_isolated_path;
        }else{
          const voice=db.prepare('SELECT user_id,audio_relative_path,audio_bytes,audio_sha256 FROM voice_transcriptions WHERE id=?').get(id);
          if(!voice)throw new Error('legacy_voice_owner_unknown');
          userId=String(voice.user_id);manifest=JSON.stringify({format:'pp-legacy-voice-v1',userId,id,generation,
            path:voice.audio_relative_path,size:voice.audio_bytes,sha256:voice.audio_sha256});manifestHash=hash(manifest);
          drive=verified.audio_remote_drive_id;remote=verified.audio_remote_path;sha=verified.audio_archive_sha256;bytes=verified.audio_archive_bytes;isolatedPath=isolated.audio_local_isolated_path;
        }
        put({kind,subject_id:id,generation,user_id:userId,manifest_json:manifest,manifest_sha256:manifestHash,remote_drive:drive,
          remote_path:remote,archive_sha256:sha,archive_bytes:bytes,verified_at:time(raw.created_at)!,isolated_path:isolatedPath,
          isolated_at:time(evict.created_at),purge_started_at:null,released_at:null,blocked_reason:null});
      }catch(e){issues.push({kind,id,reason:e instanceof Error?e.message:'legacy_import_failed'});}
    }
  }
  return {imported,issues};
}

export function legacyIsolationDue(db:DatabaseSync,now=Date.now(),graceDays=3):LegacyGeneration[]{
  if(!Number.isFinite(graceDays)||graceDays<3)throw new Error('legacy_grace_too_short');
  return db.prepare(`SELECT * FROM storage_legacy_generations WHERE released_at IS NULL AND isolated_path IS NOT NULL
    AND COALESCE(blocked_reason,'')!='storage_original_host_not_present'
    AND isolated_at<=? ORDER BY COALESCE((SELECT last_seen_at FROM storage_issues
     WHERE scope='legacy-purge' AND source_key=kind||':'||subject_id||':'||generation AND resolved_at IS NULL),0),isolated_at`).all(now-graceDays*STORAGE_DAY) as LegacyGeneration[];
}

/** Existing subject lock is required. Caller reconciles live activity and
 * validates the exact remote immutable object before passing remoteVerified. */
export function purgeLegacyGeneration(db:DatabaseSync,row:LegacyGeneration,options:{isolationRoot:string;remoteVerified:boolean;
  now?:number;graceDays?:number;guard?:(paths:string[])=>void}):{releasedBytes:number;alreadyMissing:boolean} {
  const now=options.now??Date.now(),grace=options.graceDays??3;
  try{
    const current=db.prepare('SELECT * FROM storage_legacy_generations WHERE kind=? AND subject_id=? AND generation=?').get(row.kind,row.subject_id,row.generation) as LegacyGeneration;
    for(const key of ['user_id','manifest_sha256','remote_drive','remote_path','archive_sha256','archive_bytes','isolated_path','isolated_at'] as const)
      if(current[key]!==row[key])throw new Error('legacy_generation_changed_before_purge');
    if(current.released_at)return {releasedBytes:0,alreadyMissing:true};
    if(!options.remoteVerified || !current.verified_at || !current.isolated_at || grace<3 || current.isolated_at+grace*STORAGE_DAY>now)throw new Error('legacy_purge_not_verified_or_due');
    if(hash(current.manifest_json)!==current.manifest_sha256)throw new Error('legacy_manifest_hash');
    const m=JSON.parse(current.manifest_json),root=path.resolve(options.isolationRoot);
    let expected:string;
    if(row.kind==='voice')expected=path.join(root,row.user_id,row.subject_id,String(row.generation),path.basename(m.path));
    else expected=path.join(root,row.subject_id,String(row.generation));
    if(expected!==current.isolated_path || safeStorageMember(root,path.relative(root,expected))!==expected)throw new Error('legacy_isolation_path_mismatch');
    if(!fs.existsSync(expected)){
      // No claimed byte release for an absent legacy copy. Keep its cloud proof.
      db.prepare('UPDATE storage_legacy_generations SET released_at=?,blocked_reason=NULL WHERE kind=? AND subject_id=? AND generation=?').run(now,row.kind,row.subject_id,row.generation);
      return {releasedBytes:0,alreadyMissing:true};
    }
    const entries:Array<{relative:string;size:number;sha256:string}>=row.kind==='voice'?[{relative:'',size:m.size,sha256:m.sha256}]:m.entries.map((e:{kind?:string;relativePath:string;size:number;sha256:string})=>({
      relative:row.kind==='conversation'?`${e.kind}/${e.relativePath}`:e.relativePath,size:e.size,sha256:e.sha256}));
    const expectedFiles=new Map(entries.map(e=>[e.relative,e])),files:string[]=[];let bytes=0;
    const walk=(file:string,relative:string)=>{
      const stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new Error('legacy_isolation_symlink');bytes+=stat.blocks*512;
      if(stat.isDirectory()){for(const name of fs.readdirSync(file))walk(path.join(file,name),relative?`${relative}/${name}`:name);return;}
      const entry=expectedFiles.get(relative);
      if(!stat.isFile() || stat.nlink!==1 || !entry || stat.size!==entry.size || sha256Path(file)!==entry.sha256)throw new Error('legacy_isolation_member_changed');
      files.push(file);expectedFiles.delete(relative);
    };
    walk(expected,'');if(expectedFiles.size && !current.purge_started_at)throw new Error('legacy_isolation_member_missing');
    (options.guard??((paths:string[])=>paths.forEach(assertFileNotOpen)))(files);
    // Persist intent only after the complete tree passed validation. A killed
    // recursive unlink may leave a subset; retries still validate every
    // surviving member and may only tolerate missing members of this manifest.
    db.prepare('UPDATE storage_legacy_generations SET purge_started_at=COALESCE(purge_started_at,?) WHERE kind=? AND subject_id=? AND generation=?')
      .run(now,row.kind,row.subject_id,row.generation);
    // Delete only this exact verified generation. The current conversation may
    // be local or on a later generation; no state=cold filter is used.
    fs.rmSync(expected,{recursive:row.kind!=='voice'});
    db.prepare('UPDATE storage_legacy_generations SET released_at=?,blocked_reason=NULL WHERE kind=? AND subject_id=? AND generation=?').run(now,row.kind,row.subject_id,row.generation);
    if(row.kind==='conversation')db.prepare('UPDATE conversation_storage SET local_isolated_path=NULL WHERE conversation_id=? AND local_isolated_path=?').run(row.subject_id,expected);
    else if(row.kind==='voice')db.prepare('UPDATE voice_transcriptions SET audio_local_isolated_path=NULL WHERE id=? AND audio_local_isolated_path=?').run(row.subject_id,expected);
    else db.prepare('UPDATE reading_source_versions SET local_isolated_path=NULL WHERE id=? AND local_isolated_path=?').run(row.subject_id,expected);
    db.prepare('INSERT INTO storage_audit(user_id,item_id,version_id,action,at,bytes,details_json) VALUES(?,NULL,NULL,?,?,?,?)')
      .run(row.user_id,'legacy_physically_released',now,bytes,JSON.stringify({kind:row.kind,id:row.subject_id,generation:row.generation}));
    return {releasedBytes:bytes,alreadyMissing:false};
  }catch(e){db.prepare('UPDATE storage_legacy_generations SET blocked_reason=? WHERE kind=? AND subject_id=? AND generation=?')
    .run(e instanceof Error?e.message:'legacy_purge_failed',row.kind,row.subject_id,row.generation);throw e;}
}
