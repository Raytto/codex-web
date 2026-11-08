import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStreamSnapshot,SqliteBinarySnapshot,createDatabaseSnapshot,verifySqliteBinary,restoreSqliteStream} from '../server/storage-sqlite-stream.js';
import {Readable} from 'node:stream';

test('bounded logical database snapshots preserve WAL consistency, BLOBs, int64, rowids, sequences, indices and triggers',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-sqlite-stream-')),file=path.join(root,'source.sqlite'),db=new DatabaseSync(file);
 try{
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA user_version=12;PRAGMA application_id=17;
   CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT);INSERT INTO parent VALUES(50,'first');DELETE FROM parent;
   INSERT INTO parent(name) VALUES('retained');
   CREATE TABLE child(id TEXT PRIMARY KEY,parent_id INTEGER REFERENCES parent(id),bytes BLOB,big INTEGER);
   INSERT INTO child(rowid,id,parent_id,bytes,big) VALUES(77,'child',51,X'00ff0061',9223372036854775807);
   CREATE INDEX child_parent ON child(parent_id);
   CREATE TABLE audit(text TEXT);
   CREATE TRIGGER observe_insert AFTER INSERT ON child BEGIN INSERT INTO audit VALUES(NEW.id);END;`);
  const snapshot=new SqliteStreamSnapshot(file),expected=snapshot.measure();
  db.exec("INSERT INTO parent(name) VALUES('new WAL row after snapshot')");
  const result=await restoreSqliteStream(snapshot.stream(),path.join(root,'restored.sqlite'));snapshot.close();
  assert.equal(result.sha256,expected.sha256);assert.equal(result.bytes,expected.bytes);
  const restored=new DatabaseSync(path.join(root,'restored.sqlite'));
  try{
   assert.equal(restored.prepare('SELECT count(*) n FROM parent').get()!.n,1);
   assert.equal(restored.prepare('SELECT rowid,hex(bytes) b,CAST(big AS TEXT) n FROM child').get()!.rowid,77);
   assert.equal(restored.prepare('SELECT hex(bytes) b,CAST(big AS TEXT) n FROM child').get()!.b,'00FF0061');
   assert.equal(restored.prepare('SELECT CAST(big AS TEXT) n FROM child').get()!.n,'9223372036854775807');
   assert.equal(restored.prepare('SELECT count(*) n FROM audit').get()!.n,0);
   restored.exec("INSERT INTO parent(name) VALUES('after restore');INSERT INTO child(id,parent_id) VALUES('next',52)");
   assert.equal(restored.prepare("SELECT text FROM audit").get()!.text,'next');
   assert.equal(restored.prepare('PRAGMA user_version').get()!.user_version,12);
   assert.equal(restored.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
  }finally{restored.close();}
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('a truncated or corrupt stream cannot publish a usable recovery database',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-sqlite-corrupt-')),target=path.join(root,'recovery.sqlite');
 try{
  await assert.rejects(restoreSqliteStream(Readable.from(['not-json\n']),target));assert.equal(fs.existsSync(target),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a long SQLite snapshot stops when concurrent WAL growth exceeds its budget',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-sqlite-budget-')),file=path.join(root,'source.sqlite'),db=new DatabaseSync(file);
 try{
  db.exec('PRAGMA journal_mode=WAL;CREATE TABLE source(value TEXT)');
  const snapshot=new SqliteStreamSnapshot(file,{maxMs:60_000,maxWalGrowthBytes:0});
  try{db.prepare('INSERT INTO source VALUES(?)').run('new writer');assert.throws(()=>snapshot.measure(),/storage_sqlite_snapshot_budget/);}
  finally{snapshot.close();}
  assert.equal(db.prepare('SELECT count(*) n FROM source').get()!.n,1);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('virtual-table snapshots preserve FTS shadow data and a WAL boundary within a bounded scratch budget',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-sqlite-virtual-')),file=path.join(root,'source.sqlite'),scratch=path.join(root,'scratch');fs.mkdirSync(scratch);
 const db=new DatabaseSync(file);
 try{
  db.exec(`PRAGMA journal_mode=WAL;CREATE VIRTUAL TABLE documents USING fts5(body,tokenize='trigram');
   INSERT INTO documents(rowid,body) VALUES(17,'needle in a planning document');
   CREATE VIRTUAL TABLE contentless USING fts5(body,content='');INSERT INTO contentless(rowid,body) VALUES(27,'retained searchable words');`);
  assert.throws(()=>new SqliteStreamSnapshot(file),/schema_unsupported/);
  const snapshot=createDatabaseSnapshot(file,scratch,1024**2);assert.ok(snapshot instanceof SqliteBinarySnapshot);
  try{
   db.exec("INSERT INTO documents VALUES('new needle written after snapshot')");
   verifySqliteBinary(snapshot.target);
   const restored=new DatabaseSync(snapshot.target,{readOnly:true});
   try{
    assert.deepEqual({...restored.prepare("SELECT rowid,body FROM documents WHERE documents MATCH 'needle'").get()}, {rowid:17,body:'needle in a planning document'});
    assert.equal(restored.prepare('SELECT count(*) n FROM documents').get()!.n,1);
    assert.equal(restored.prepare("SELECT rowid FROM contentless WHERE contentless MATCH 'searchable'").get()!.rowid,27);
    assert.equal(restored.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
   }finally{restored.close();}
  }finally{snapshot.close();}
  assert.deepEqual(fs.readdirSync(scratch),[]);
  assert.throws(()=>createDatabaseSnapshot(file,scratch,4096),/binary_snapshot_failed:budget/);
  assert.deepEqual(fs.readdirSync(scratch),[]);
  assert.equal(db.prepare('SELECT count(*) n FROM documents').get()!.n,2);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
