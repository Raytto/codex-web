import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateStorageLifecycle } from '../server/storage-lifecycle-schema.js';
import { StorageCatalog, type StorageChunk } from '../server/storage-catalog.js';
import { STORAGE_DAY, storagePolicy } from '../server/storage-lifecycle-policy.js';
import { migrateJobEventSequence, nextJobEventSequence } from '../server/job-event-sequence.js';

const now = Date.UTC(2026,10,7);
function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrateStorageLifecycle(db);
  t.after(() => db.close()); let clock = now;
  return { db, catalog: new StorageCatalog(db,() => clock), advance: (ms: number) => { clock += ms; } };
}
const enroll = (c: StorageCatalog, userId = 'alice') => c.enroll({userId,scope:'conversation:c1',sourceKey:'f1',kind:'file',locator:{root:'conversation',path:'uploads/a.bin'},name:'a.bin',trustedUsedAt:now-90*STORAGE_DAY,timeBasis:'file-business-read'});
const version = (c: StorageCatalog, id: string, userId = 'alice') => c.registerVersion(userId,id,{sha256:'a'.repeat(64),bytes:123,fingerprint:'dev:ino:size:mtime:ctime'});
const chunk = (userId = 'alice'): StorageChunk => ({id:`${userId}-chunk`,user_id:userId,plaintext_sha256:'b'.repeat(64),plaintext_bytes:123,
  ciphertext_sha256:'c'.repeat(64),ciphertext_bytes:100,remote_drive:'d',remote_path:`/instance/${userId}/c.age`,codec:'gzip-age-v1',verified_at:now});

test('catalog writes reserve the WAL writer before reads and preserve nested rollback boundaries', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-catalog-wal-'));
  const db=new DatabaseSync(path.join(root,'catalog.sqlite'));
  db.exec('PRAGMA journal_mode=WAL'); migrateStorageLifecycle(db);
  const peer=new DatabaseSync(path.join(root,'catalog.sqlite'));
  peer.exec('PRAGMA busy_timeout=1');
  const catalog=new StorageCatalog(db);
  const initialNames=peer.prepare('SELECT name FROM storage_scan_state ORDER BY name').all().map(row=>row.name);
  const insert=(name:string)=>db.prepare("INSERT INTO storage_scan_state VALUES(?, '{}', 1)").run(name);
  try {
    catalog.transaction(()=>{
      assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_scan_state').get()!.n,initialNames.length);
      assert.throws(()=>peer.prepare("INSERT INTO storage_scan_state VALUES('peer','{}',1)").run(),/locked/);
      insert('outer');
      assert.throws(()=>catalog.transaction(()=>{insert('rolled-back-inner');throw new Error('abort-inner');}),/abort-inner/);
      catalog.transaction(()=>insert('committed-inner'));
    });
    assert.deepEqual(peer.prepare('SELECT name FROM storage_scan_state ORDER BY name').all().map(row=>row.name),[...initialNames,'committed-inner','outer'].sort());
    assert.throws(()=>catalog.transaction(()=>{insert('rolled-back-outer');throw new Error('abort-outer');}),/abort-outer/);
    assert.equal(db.isTransaction,false);
    // A caller-owned transaction is never committed by the catalog savepoint.
    db.exec('BEGIN IMMEDIATE'); catalog.transaction(()=>insert('caller-owned')); db.exec('ROLLBACK');
    peer.prepare("INSERT INTO storage_scan_state VALUES('peer-after-commit','{}',1)").run();
    assert.equal(peer.prepare('SELECT COUNT(*) n FROM storage_scan_state').get()!.n,initialNames.length+3);
  } finally {peer.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('migration keeps known old business time; scans, retries and references cannot reheat objects', t => {
  const {catalog:c,advance} = fixture(t); const item = enroll(c); assert.equal(c.due(item),true);
  const v = version(c,item.id); c.reference('alice',v.id,'draft','draft-1'); c.reference('alice',v.id,'backup','backup-1');
  c.block('alice',item.id,'network'); advance(STORAGE_DAY);
  const again = enroll(c); assert.equal(again.id,item.id); assert.equal(again.last_used_at,item.last_used_at); assert.equal(c.due(again),true);
  for (const action of ['scan','backup','sidebar','login','heartbeat']) assert.throws(() => c.touch('alice',item.id,action),/not_usage/);
  c.touch('alice',item.id,'tool-read'); assert.equal(c.due(c.item('alice',item.id)),false);
});
test('unknown historical access uses migration T0 once and recovery references have a finite sixty-day window', t => {
  const {catalog:c,advance} = fixture(t);
  const input = {userId:'alice',scope:'library:p',sourceKey:'x',kind:'library' as const,locator:{root:'library',path:'x'},name:'x'};
  const a = c.enroll(input); assert.equal(a.time_basis,'migration-t0-unknown-access'); assert.equal(a.retention_days,30);
  advance(40*STORAGE_DAY); assert.equal(c.enroll(input).last_used_at,now); assert.equal(c.due(c.enroll(input)),true);
  const r = c.enroll({...input,sourceKey:'r',locator:{root:'library',path:'r'},kind:'recovery'}); assert.equal(r.retention_days,60);
  advance(60*STORAGE_DAY); assert.equal(c.due(r),true);
});
test('content deduplication and references never cross an account boundary', t => {
  const {catalog:c,db} = fixture(t); const a = enroll(c), b = enroll(c,'bob'); const va=version(c,a.id),vb=version(c,b.id,'bob');
  const ca = c.recordChunk(chunk()); assert.equal(c.chunk('bob',ca.plaintext_sha256,123),undefined);
  assert.throws(() => c.verifyVersion('bob',vb.id,{},[ca]),/owner_mismatch/);
  assert.throws(() => c.reference('bob',va.id,'backup','b1'),/not_found/);
  assert.throws(() => c.item('bob',a.id),/not_found/);
  c.verifyVersion('alice',va.id,{sha256:va.sha256},[ca]);
  assert.throws(() => db.prepare('UPDATE storage_versions SET sha256=? WHERE id=?').run('d'.repeat(64),va.id),/immutable/);
  assert.throws(() => db.prepare('UPDATE storage_chunks SET remote_path=? WHERE id=?').run('/other',ca.id),/immutable/);
});
test('restoring and retrying do not reset the per-generation isolation clock', t => {
  const {catalog:c,db,advance} = fixture(t); const item=enroll(c), v=version(c,item.id); const ck=c.recordChunk(chunk());
  c.verifyVersion('alice',v.id,{},[ck]); c.recordIsolation('alice',v.id,'/isolated/v1',4096);
  advance(2*STORAGE_DAY); assert.equal(c.isolationDue().length,0);
  db.prepare("UPDATE storage_versions SET state='local',restored_at=? WHERE id=?").run(now+2*STORAGE_DAY,v.id);
  c.recordIsolation('alice',v.id,'/isolated/v1',4096); advance(STORAGE_DAY);
  assert.equal(c.isolationDue().length,1); assert.equal(c.isolationDue()[0].isolated_at,now);
  assert.throws(() => c.isolationDue(1),/grace_too_short/);
});
test('expired leases require process reconciliation; dead owners release without killing live tasks', t => {
  const {catalog:c,advance} = fixture(t); const item=enroll(c);
  c.acquireLease('alice',item.id,{processIdentity:'boot:pid:start',purpose:'tool-read',ttlMs:1000}); advance(2000);
  assert.equal(c.activeLeases('alice',item.id,()=>'unknown').length,1);
  assert.equal(c.activeLeases('alice',item.id,()=>'live').length,1);
  assert.equal(c.activeLeases('alice',item.id,()=>'dead').length,0);
  assert.equal(c.item('alice',item.id).last_used_at,item.last_used_at);
});
test('instance configuration fails closed instead of borrowing another instance keys or drive', () => {
  assert.equal(storagePolicy({}).enabled,false);
  assert.throws(() => storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1'}),/missing/);
  const config={STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'manage',STORAGE_REMOTE_ROOT:'/private/manage',STORAGE_DRIVE_ID:'own-drive',STORAGE_AGE_RECIPIENT:'/own/recipient',STORAGE_AGE_IDENTITY:'/own/key'};
  assert.equal(storagePolicy(config).remoteRoot,'/private/manage');
  assert.throws(() => storagePolicy({...config,STORAGE_REMOTE_ROOT:'/'}),/invalid/);
});
test('event sequence survives complete payload pruning, reopen migration and transaction rollback', () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE jobs(id TEXT PRIMARY KEY); INSERT INTO jobs VALUES('j');
      CREATE TABLE job_events(job_id TEXT,seq INTEGER,payload TEXT,PRIMARY KEY(job_id,seq)); INSERT INTO job_events VALUES('j',42,'old');`);
    migrateJobEventSequence(db); db.exec('DELETE FROM job_events'); migrateJobEventSequence(db);
    db.exec('BEGIN'); assert.equal(nextJobEventSequence(db,'j'),43); db.exec('ROLLBACK');
    db.exec('BEGIN'); assert.equal(nextJobEventSequence(db,'j'),43); db.exec("INSERT INTO job_events VALUES('j',43,'new'); COMMIT;");
    db.exec("INSERT INTO job_events VALUES('j',99,'legacy writer'); DELETE FROM job_events;");
    assert.equal(nextJobEventSequence(db,'j'),100);
  } finally { db.close(); }
});
