import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {verifyTarStream} from '../server/storage-tar.js';
import {sha256Path} from '../server/storage-chunks.js';

test('streams a real age/tar archive, validates every member and materializes only the selected file',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-storage-tar-'));try{
    const source=path.join(root,'source');fs.mkdirSync(source);const key=path.join(root,'key'),recipient=path.join(root,'recipient');
    execFileSync('age-keygen',['-o',key],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',key]));
    fs.writeFileSync(path.join(source,'one.bin'),crypto.randomBytes(2*1024**2));fs.writeFileSync(path.join(source,'two.txt'),'untouched second member');
    const tar=path.join(root,'input.tar'),encrypted=path.join(root,'input.age');
    execFileSync('tar',['-cf',tar,'-C',source,'.']);execFileSync('age',['-R',recipient,'-o',encrypted,tar]);
    const target=path.join(root,'selected'),index=path.join(root,'index.jsonl');
    const members=Object.fromEntries(['one.bin','two.txt'].map(name=>[name,{size:fs.statSync(path.join(source,name)).size,sha256:sha256Path(path.join(source,name)),...(name==='one.bin'?{target}:{})}]));
    const options={identity:key,ciphertextSha256:sha256Path(encrypted),ciphertextBytes:fs.statSync(encrypted).size,members,maxPlaintextBytes:3*1024**2};
    const result=await verifyTarStream({...options,stream:fs.createReadStream(encrypted),indexFile:index});
    assert.equal(result.files,2);assert.equal(result.selected,1);assert.equal(sha256Path(target),members['one.bin'].sha256);
    assert.equal(fs.readFileSync(index,'utf8').trim().split('\n').map(s=>JSON.parse(s)).length,2);
    fs.unlinkSync(target);
    await assert.rejects(verifyTarStream({...options,stream:fs.createReadStream(encrypted),ciphertextSha256:'0'.repeat(64)}),/ciphertext_mismatch/);
    // A staged file after failure is not a published original. Caller cleanup
    // is explicit so a failed verification can never be mistaken for success.
    fs.unlinkSync(target);
    await assert.rejects(verifyTarStream({...options,stream:fs.createReadStream(encrypted),members:{...members,'missing':{size:1,sha256:'0'.repeat(64)}}}),/verification_failed/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
