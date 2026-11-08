import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {assertStorageIdentity,isStorageIdentity} from '../server/storage-key.js';

test('an instance uses one private local identity; a different public recipient or exposed key fails before upload',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-storage-key-'));
  try{
    const key=path.join(root,'identity'),other=path.join(root,'other'),pub=path.join(root,'recipient');
    for(const file of [key,other])execFileSync('age-keygen',['-o',file],{stdio:'ignore'});
    fs.writeFileSync(pub,execFileSync('age-keygen',['-y',key]));
    assertStorageIdentity(key,pub);
    const link=path.join(root,'alias');fs.linkSync(key,link);assert.equal(isStorageIdentity(link,key),true);
    const copy=path.join(root,'export.agekey');fs.copyFileSync(key,copy);assert.equal(isStorageIdentity(copy,key),true);assert.equal(isStorageIdentity(other,key),false);
    fs.writeFileSync(pub,execFileSync('age-keygen',['-y',other]));
    assert.throws(()=>assertStorageIdentity(key,pub),/storage_key_recipient_mismatch/);
    fs.writeFileSync(pub,execFileSync('age-keygen',['-y',key]));fs.chmodSync(key,0o644);
    assert.throws(()=>assertStorageIdentity(key,pub),/storage_key_permissions/);
    fs.chmodSync(key,0o600);fs.appendFileSync(key,fs.readFileSync(other));
    assert.throws(()=>assertStorageIdentity(key,pub),/storage_single_identity_required/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
