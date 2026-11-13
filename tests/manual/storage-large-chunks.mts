// Explicit opt-in integration: real gzip/age, bounded RSS and disk measurements.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {StorageCatalog} from '../../server/storage-catalog.js';import {migrateStorageLifecycle} from '../../server/storage-lifecycle-schema.js';import {storagePolicy,STORAGE_GIB} from '../../server/storage-lifecycle-policy.js';import {StorageChunkStore,sha256Path} from '../../server/storage-chunks.js';
const out=process.env.STORAGE_TEST_OUTPUT;assert.ok(out,'STORAGE_TEST_OUTPUT required');fs.mkdirSync(out,{recursive:true});
const root=fs.mkdtempSync(path.join(out,'scratch-case-')),identity=root+'/key',recipient=root+'/recipient',scratch=root+'/scratch',remote=root+'/remote';fs.mkdirSync(remote);
execFileSync('age-keygen',['-o',identity],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',identity]));
const db=new DatabaseSync(':memory:');migrateStorageLifecycle(db);const catalog=new StorageCatalog(db);
const policy=storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/isolated',STORAGE_DRIVE_ID:'fixture',STORAGE_AGE_RECIPIENT:recipient,STORAGE_AGE_IDENTITY:identity});
let failDownload=false,uploads=0,downloads=0;const result:any={checks:[],peakScratchBytes:0,peakRssBytes:0,defaultBytes:policy.chunkBytes,maxBytes:1.5*STORAGE_GIB,budget:policy.scratchBytes,scope:'local isolated real gzip/age and disk transport; cloud acceptance separate'};
const sample=()=>{if(fs.existsSync(scratch)){const n=fs.readdirSync(scratch).reduce((s,n)=>s+fs.statSync(path.join(scratch,n)).size,0);result.peakScratchBytes=Math.max(result.peakScratchBytes,n);}result.peakRssBytes=Math.max(result.peakRssBytes,process.memoryUsage().rss);};const timer=setInterval(sample,100);
const key=(s:string)=>remote+'/'+crypto.createHash('sha256').update(s).digest('hex');
const transport={async put(file:string,name:string){uploads++;fs.copyFileSync(file,key(name));sample();},async get(name:string,file:string){if(failDownload)throw Error('injected_interrupted_download');downloads++;fs.copyFileSync(key(name),file);sample();}};
const write=(file:string,n:number)=>{const fd=fs.openSync(file,'wx'),buffer=crypto.randomBytes(1024**2);try{for(let i=0;i<n;i+=buffer.length)fs.writeSync(fd,buffer,0,Math.min(buffer.length,n-i));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sample();};
try{
 const chunks=new StorageChunkStore(catalog,policy,scratch,transport);
 await new Promise(r=>setTimeout(r,30)); // Filesystem timestamps can lag wall clock by one kernel tick.
 const source=root+'/new-1GiB-plus-one';write(source,STORAGE_GIB+1);const first=await chunks.archiveFile('fixture',source);
 assert.deepEqual(first.chunks.map(c=>c.plaintext_bytes),[STORAGE_GIB,1]);await chunks.restoreFile('fixture',first.chunks,root+'/restored',first);assert.equal(sha256Path(root+'/restored'),sha256Path(source));fs.unlinkSync(root+'/restored');result.checks.push('default1GiB+1 split and exact restore');
 const oldSource=root+'/legacy-file';write(oldSource,256*1024**2+1);
 const old=await chunks.archiveFile('fixture',oldSource,{firstSeenAt:1});assert.deepEqual(old.chunks.map(c=>c.plaintext_bytes),[256*1024**2,1]);await chunks.restoreFile('fixture',old.chunks,root+'/old-restored',old);assert.equal(sha256Path(root+'/old-restored'),sha256Path(oldSource));fs.unlinkSync(root+'/old-restored');result.checks.push('pre-upgrade256MiB manifest restored by new reader');
 const upper=new StorageChunkStore(catalog,{...policy,chunkBytes:1.5*STORAGE_GIB},scratch,transport);
 const maxSource=root+'/new-at-ceiling';write(maxSource,1.5*STORAGE_GIB);failDownload=true;
 await assert.rejects(upper.archiveFile('fixture',maxSource),/interrupted_download/);assert.equal(fs.statSync(maxSource).size,1.5*STORAGE_GIB);
 const pending=db.prepare('SELECT * FROM storage_chunk_uploads').get()!;assert.ok(Number(pending.ciphertext_bytes)>1.5*STORAGE_GIB,'incompressible encrypted bytes include expansion');
 // A real retained ciphertext alongside the retry, not a preallocated budget.
 fs.copyFileSync(String(pending.stage_path),scratch+'/unrelated-interrupted.age');sample();failDownload=false;
 const max=await upper.archiveFile('fixture',maxSource);assert.equal(max.chunks.length,1);assert.equal(max.chunks[0].remote_path,pending.remote_path);
 await upper.restoreFile('fixture',max.chunks,root+'/max-restored',max);assert.equal(sha256Path(root+'/max-restored'),sha256Path(maxSource));
 result.checks.push('inclusive1.5GiB real expansion, ciphertext retry, residual and restore');
 result.cipherExpansionBytes=Number(pending.ciphertext_bytes)-1.5*STORAGE_GIB;
 assert.ok(result.peakScratchBytes<6*STORAGE_GIB);assert.ok(result.peakRssBytes<256*1024**2,'streaming does not hold a whole chunk in RAM');result.ok=true;
}catch(e){result.error=String(e);throw e;}
finally{clearInterval(timer);result.uploads=uploads;result.downloads=downloads;db.close();fs.rmSync(root,{recursive:true,force:true});result.cleaned=true;fs.writeFileSync(out+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
