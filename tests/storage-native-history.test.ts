import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { snapshotNativeHistory, applyNativeHistory } from '../server/storage-native-history.js';
const parent='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-native-history-')),home=path.join(root,'home');fs.mkdirSync(home);
  const db=new DatabaseSync(path.join(home,'thread_history_1.sqlite'));
  db.exec(`CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,checksum BLOB); INSERT INTO _sqlx_migrations VALUES(1,X'aa00bb');
    CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,root_turn_id TEXT,PRIMARY KEY(thread_id,turn_id));
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_json TEXT,PRIMARY KEY(thread_id,turn_id,item_id));
    CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_byte_offset INTEGER,next_rollout_ordinal INTEGER);
    CREATE TABLE thread_realtime_items(thread_id TEXT,item_id TEXT,item_json TEXT,PRIMARY KEY(thread_id,item_id));`);
  for(const id of [parent,child]){
    db.prepare('INSERT INTO thread_turns VALUES(?,?,?)').run(id,'t1','root-t1');
    db.prepare('INSERT INTO thread_items VALUES(?,?,?,?)').run(id,'t1','i1',JSON.stringify({text:'native-history-content',parent}));
    db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?,?)').run(id,123,4);
    db.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?)').run(id,'r1','realtime');
  }
  return {root,home,db,snapshot:path.join(root,'snapshot.sqlite'),close:()=>{db.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('native history retains exact parent/child IDs, turn relations, projection offsets and migration BLOBs',()=>{
  const f=fixture();try{
    const manifest=snapshotNativeHistory(f.home,f.snapshot,{userId:'alice',threadIds:[parent,child],engineVersion:'test-engine'});
    assert.equal(manifest?.tables.thread_items.rows,2);
    applyNativeHistory(f.home,f.snapshot,'alice','remove');applyNativeHistory(f.home,f.snapshot,'alice','remove');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM thread_items').get() as {n:number}).n,0);
    applyNativeHistory(f.home,f.snapshot,'alice','restore');applyNativeHistory(f.home,f.snapshot,'alice','restore');
    assert.deepEqual(f.db.prepare('SELECT thread_id,next_rollout_byte_offset FROM thread_history_projection_state ORDER BY thread_id').all().map(r=>[r.thread_id,r.next_rollout_byte_offset]),[[parent,123],[child,123]]);
    assert.equal((f.db.prepare('SELECT hex(checksum) AS x FROM _sqlx_migrations').get() as {x:string}).x,'AA00BB');
  }finally{f.close();}
});
test('concurrent new rows, cross-owner restore and engine schema changes fail closed without deleting data',()=>{
  const f=fixture();try{
    snapshotNativeHistory(f.home,f.snapshot,{userId:'alice',threadIds:[parent],engineVersion:'test-engine'});
    assert.throws(()=>applyNativeHistory(f.home,f.snapshot,'bob','remove'),/identity_mismatch/);
    f.db.prepare('INSERT INTO thread_items VALUES(?,?,?,?)').run(parent,'t1','later','new data');
    assert.throws(()=>applyNativeHistory(f.home,f.snapshot,'alice','remove'),/rows_conflict/);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM thread_items').get() as {n:number}).n,3);
    f.db.exec('ALTER TABLE thread_turns ADD COLUMN newer_engine_field TEXT');
    assert.throws(()=>applyNativeHistory(f.home,f.snapshot,'alice','remove'),/schema_incompatible/);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM thread_items').get() as {n:number}).n,3);
  }finally{f.close();}
});
test('unknown per-thread materials block snapshot rather than disappearing from a restore unit',()=>{
  const f=fixture();try{
    f.db.exec('CREATE TABLE thread_future_material(thread_id TEXT PRIMARY KEY,payload BLOB)');
    assert.throws(()=>snapshotNativeHistory(f.home,f.snapshot,{userId:'alice',threadIds:[parent],engineVersion:'test'}),/schema_unsupported/);
    assert.equal(fs.existsSync(f.snapshot),false);
  }finally{f.close();}
});
