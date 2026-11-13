import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {AppDatabase,LEGACY_USER_ID} from '../server/db.js';
import {StorageCatalog} from '../server/storage-catalog.js';
import type {StorageHost} from '../server/storage-host.js';
import {collectNativeRebuildable} from '../server/storage-local-gc.js';
import {STORAGE_DAY} from '../server/storage-lifecycle-policy.js';
import {acquireCodexLifecycleLock} from '../server/codex-lifecycle-lock.js';

test('scoped cache GC respects engine lock, real TTL, cursor, symlinks and valuable originals; debug deletion does not claim physical release',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-local-gc-')),dataRoot=path.join(root,'data'),db=new AppDatabase(dataRoot,undefined,false);
 const now=Date.now(),home=path.join(root,'tenants',LEGACY_USER_ID,'codex-home'),cache=path.join(home,'cache','codex_apps_tools');
 fs.mkdirSync(cache,{recursive:true});
 try{
  const host={db:db.sqlite,catalog:new StorageCatalog(db.sqlite,()=>now),roots:{dataRoot,tenantRoot:path.join(root,'tenants'),hostRootCodexHome:path.join(root,'host'),hostUserId:crypto.randomUUID()}} as unknown as StorageHost;
  for(const name of ['a','b','fresh']){const file=path.join(cache,name);fs.writeFileSync(file,'cache');if(name!=='fresh')fs.utimesSync(file,new Date(now-8*STORAGE_DAY),new Date(now-8*STORAGE_DAY));}
  const valuable=path.join(home,'generated_images','original.png');fs.mkdirSync(path.dirname(valuable));fs.writeFileSync(valuable,'unique');fs.utimesSync(valuable,new Date(now-100*STORAGE_DAY),new Date(now-100*STORAGE_DAY));
  fs.symlinkSync(valuable,path.join(cache,'linked'));
  const logs=new DatabaseSync(path.join(home,'logs_2.sqlite'));logs.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,level TEXT,payload TEXT)');
  for(const [id,age,level] of [[1,8,'DEBUG'],[2,8,'ERROR'],[3,31,'ERROR'],[4,0,'INFO']] as const)logs.prepare('INSERT INTO logs VALUES(?,?,?,?)').run(id,Math.floor((now-age*STORAGE_DAY)/1000),level,'debug only');
  logs.prepare('INSERT INTO logs VALUES(5,1,\'DEBUG\',\'unknown time\')').run();logs.close();
  const unlock=acquireCodexLifecycleLock(home);try{assert.equal(collectNativeRebuildable(host).files,0);}finally{unlock();}
  const first=collectNativeRebuildable(host,1);assert.equal(first.files,1);assert.ok(first.releasedBytes>0);assert.equal(first.debugRows,0);
  assert.equal(collectNativeRebuildable(host,1).files,1);const third=collectNativeRebuildable(host,1);assert.equal(third.files,0);assert.equal(third.debugRows,2);assert.equal(third.releasedBytes,0);
  assert.ok(fs.existsSync(valuable));assert.ok(fs.existsSync(path.join(cache,'fresh')));assert.ok(fs.lstatSync(path.join(cache,'linked')).isSymbolicLink());
  assert.equal(db.sqlite.prepare("SELECT resolved_at FROM storage_issues WHERE scope='local-gc'").get()!.resolved_at,now);
  const check=new DatabaseSync(path.join(home,'logs_2.sqlite'),{readOnly:true});assert.deepEqual(check.prepare('SELECT id FROM logs ORDER BY id').all().map(r=>r.id),[2,4,5]);check.close();
  fs.rmSync(cache,{recursive:true});fs.symlinkSync(path.dirname(valuable),cache);
  assert.equal(collectNativeRebuildable(host).blocked[0]?.reason,'storage_cache_symlink');assert.ok(fs.existsSync(valuable));
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
