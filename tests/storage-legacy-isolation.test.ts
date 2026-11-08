import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { migrateStorageLifecycle } from '../server/storage-lifecycle-schema.js';
import { importLegacyIsolation, legacyIsolationDue, purgeLegacyGeneration } from '../server/storage-legacy-isolation.js';
import { STORAGE_DAY } from '../server/storage-lifecycle-policy.js';

const sha=(value:string)=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-legacy-')),db=new DatabaseSync(':memory:');
  migrateStorageLifecycle(db);
  for(const [table,id] of [['conversation_storage_audit','conversation_id'],['reading_storage_audit','version_id'],['voice_recording_storage_audit','transcription_id']]){
    db.exec(`CREATE TABLE ${table} (${id} TEXT,generation INTEGER,action TEXT,details_json TEXT,created_at TEXT)`);
  }
  db.exec(`CREATE TABLE conversation_storage(conversation_id TEXT,state TEXT,local_isolated_path TEXT);
    CREATE TABLE reading_source_versions(id TEXT,local_isolated_path TEXT);
    CREATE TABLE voice_transcriptions(id TEXT,user_id TEXT,audio_relative_path TEXT,audio_bytes INTEGER,audio_sha256 TEXT,audio_local_isolated_path TEXT)`);
  const isolated=path.join(root,'conversation-1','1');fs.mkdirSync(path.join(isolated,'file'),{recursive:true});
  for(const name of ['one','two'])fs.writeFileSync(path.join(isolated,'file',name),name);
  const manifest=JSON.stringify({format:'conversation-cold-storage-v3',conversationId:'conversation-1',userId:'account-1',generation:1,
    entries:['one','two'].map(name=>({kind:'file',root:'conversation',relativePath:name,size:name.length,sha256:sha(name)}))});
  const then=Date.parse('2026-10-01T00:00:00Z');
  const insert=db.prepare('INSERT INTO conversation_storage_audit VALUES(?,?,?,?,?)');
  insert.run('conversation-1',1,'remote_verify',JSON.stringify({manifest_json:manifest,manifest_sha256:sha(manifest),
    remote_drive_id:'drive',remote_path:'/instance/account-1/archive.age',archive_sha256:sha('encrypted'),archive_bytes:100}),new Date(then).toISOString());
  insert.run('conversation-1',1,'local_evict_complete',JSON.stringify({local_isolated_path:isolated}),new Date(then+1000).toISOString());
  // Restored current state and a later pointer must not hide this generation.
  db.prepare('INSERT INTO conversation_storage VALUES(?,?,?)').run('conversation-1','local','a-newer-isolation');
  return {root,db,isolated,then,close(){db.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('imports immutable audit generations once and purges after their own real grace even when restored',()=>{
  const f=fixture();try{
    assert.deepEqual(importLegacyIsolation(f.db),{imported:1,issues:[]});
    assert.deepEqual(importLegacyIsolation(f.db),{imported:0,issues:[]});
    assert.equal(legacyIsolationDue(f.db,f.then+3*STORAGE_DAY).length,0);
    const [row]=legacyIsolationDue(f.db,f.then+4*STORAGE_DAY);
    assert.throws(()=>purgeLegacyGeneration(f.db,row,{isolationRoot:f.root,remoteVerified:false,now:f.then+4*STORAGE_DAY,guard(){}}),/not_verified/);
    assert.ok(fs.existsSync(f.isolated));
    assert.ok(purgeLegacyGeneration(f.db,row,{isolationRoot:f.root,remoteVerified:true,now:f.then+4*STORAGE_DAY,guard(){}}).releasedBytes>0);
    assert.equal(f.db.prepare('SELECT local_isolated_path FROM conversation_storage').get()!.local_isolated_path,'a-newer-isolation');
    assert.equal(legacyIsolationDue(f.db,f.then+5*STORAGE_DAY).length,0);
    assert.equal(purgeLegacyGeneration(f.db,row,{isolationRoot:f.root,remoteVerified:true,now:f.then+5*STORAGE_DAY}).releasedBytes,0);
  }finally{f.close();}
});

test('changed members block deletion; process exit during removal is retryable with the durable intent',()=>{
  const f=fixture();const rm=fs.rmSync;try{
    importLegacyIsolation(f.db);const [row]=legacyIsolationDue(f.db,f.then+4*STORAGE_DAY);
    fs.writeFileSync(path.join(f.isolated,'file','one'),'ONE');
    assert.throws(()=>purgeLegacyGeneration(f.db,row,{isolationRoot:f.root,remoteVerified:true,now:f.then+4*STORAGE_DAY,guard(){}}),/member_changed/);
    assert.equal(f.db.prepare('SELECT purge_started_at FROM storage_legacy_generations').get()!.purge_started_at,null);
    fs.writeFileSync(path.join(f.isolated,'file','one'),'one');
    fs.rmSync=((target,...args)=>{
      if(String(target)===f.isolated){fs.unlinkSync(path.join(f.isolated,'file','one'));throw new Error('simulated_exit');}
      return rm(target,...args);
    }) as typeof fs.rmSync;
    assert.throws(()=>purgeLegacyGeneration(f.db,row,{isolationRoot:f.root,remoteVerified:true,now:f.then+4*STORAGE_DAY,guard(){}}),/simulated_exit/);
    fs.rmSync=rm;
    assert.ok(purgeLegacyGeneration(f.db,row,{isolationRoot:f.root,remoteVerified:true,now:f.then+5*STORAGE_DAY,guard(){}}).releasedBytes>0);
    assert.ok(!fs.existsSync(f.isolated));
  }finally{fs.rmSync=rm;f.close();}
});
