#!/usr/bin/env node
// Small encrypted metadata only. No business bytes or verified chunks are read.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const codeRoot=process.argv[2];
if(!codeRoot||!path.isAbsolute(codeRoot))throw Error('explicit installed code root required');
const load=name=>import(pathToFileURL(path.join(codeRoot,'dist-server/server',name+'.js')).href);
const [{StorageHost},{storageEnvironment},{maintenanceLock},{runStorageProcess}]=await Promise.all(['storage-host','storage-environment','storage-maintenance','storage-process'].map(load));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const write=(file,body)=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,body,{mode:0o600});const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);

async function main(){
 process.env.PPAGENT_STORAGE_MAINTENANCE='1';
 const host=new StorageHost(storageEnvironment(),{background:true});let release;
 const directory=path.join(host.roots.lifecycleRoot,'portable-catalog');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 try{
  try{release=maintenanceLock(host.roots.lifecycleRoot);}catch(e){if(String(e.message).includes('already_running'))return;throw e;}
  if(host.db.prepare("SELECT 1 FROM jobs WHERE status='running' LIMIT 1").get()
   ||host.db.prepare("SELECT 1 FROM storage_restores WHERE state IN ('queued','restoring') AND updated_at>? LIMIT 1").get(Date.now()-150000))return;
  const stateFile=path.join(directory,'state.json'),state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{};
  state.documents??={};
  const upload=async(local,remote,proof)=>{
   await host.reader.putImmutable(local,remote);
   const meter=crypto.createHash('sha256');let bytes=0;const parts=[];
   for await(const part of await host.reader.stream(remote,proof.bytes)){
    meter.update(part);bytes+=part.length;if(bytes>64*1024**2)throw Error('recovery_metadata_download_budget');
    if(proof.plaintextSha256)parts.push(part);
   }
   if(bytes!==proof.bytes||meter.digest('hex')!==proof.sha256)throw Error('recovery_metadata_roundtrip_mismatch');
   if(proof.plaintextSha256){
    let decoded;
    try{decoded=gunzipSync(execFileSync('age',['-d','-i',host.policy.identity],{input:Buffer.concat(parts),maxBuffer:64*1024**2,stdio:['pipe','pipe','pipe']}),{maxOutputLength:64*1024**2});}
    catch{throw Error('recovery_metadata_decrypt_failed');}
    if(hash(decoded)!==proof.plaintextSha256)throw Error('recovery_metadata_plaintext_hash_mismatch');
   }
  };
  // New helper/README once per content revision. No successful previous document is read again.
  for(const [file,prefix,suffix] of [['STORAGE_CLOUD_RECOVERY.md','RECOVERY-README-','.md'],['storage-recover-file.py','recovery/storage-recover-file-','.py']]){
   const local=path.join(here,file),body=fs.readFileSync(local),sha=hash(body);
   if(state.documents[file]?.sha256===sha)continue;
   const remote=host.policy.remoteRoot+'/'+prefix+sha.slice(0,16)+suffix,proof={bytes:body.length,sha256:sha};
   await upload(local,remote,proof);state.documents[file]={...proof,remote};write(stateFile,JSON.stringify(state));
  }
  const pendingFile=path.join(directory,'pending.json');let pending;
  if(fs.existsSync(pendingFile)){
   pending=JSON.parse(fs.readFileSync(pendingFile));
   if(state.catalogSha256===pending.resultSha256&&state.latestDescriptor===host.policy.remoteRoot+'/recovery/'+pending.name+'-receipt.json'){
    for(const file of [pendingFile,pending.cipher,path.join(directory,pending.name+'-receipt.json')])fs.rmSync(file,{force:true});
    process.stdout.write(JSON.stringify({changed:false,completedPendingCleanup:true,cloudCatalogWrites:0})+'\n');return;
   }
  }
  else{
   const next=path.join(directory,'next.json');fs.rmSync(next,{force:true});
   execFileSync('python3',[path.join(here,'storage-recovery-catalog.py'),'--database',process.env.STORAGE_DATABASE_PATH,'--output',next],{stdio:['ignore','ignore','pipe'],timeout:60000});
   const body=fs.readFileSync(next),sha=hash(body);
   if(state.catalogSha256===sha){fs.unlinkSync(next);process.stdout.write(JSON.stringify({changed:false,cloudCatalogWrites:0})+'\n');return;}
   const value=JSON.parse(body),priorFile=path.join(directory,'current.json');let payload=body,delta=false;
   if(state.catalogSha256&&fs.existsSync(priorFile)){
    const priorBody=fs.readFileSync(priorFile);if(hash(priorBody)!==state.catalogSha256)throw Error('recovery_catalog_local_chain_mismatch');
    const prior=JSON.parse(priorBody),changed={},removed={};
    for(const name of ['versions','chunks','legacy','nativeUnits','backupPoints']){
     const old=new Map(prior[name].map(r=>[r.id,r])),fresh=new Map(value[name].map(r=>[r.id,r]));
     changed[name]=value[name].filter(r=>!old.has(r.id)||canonical(old.get(r.id))!==canonical(r));
     removed[name]=prior[name].filter(r=>!fresh.has(r.id)).map(r=>r.id);
    }
    payload=Buffer.from(JSON.stringify({format:'pp-portable-catalog-delta-v1',baseSha256:state.catalogSha256,resultSha256:sha,changed,removed}));delta=true;
   }
   if(payload.length>64*1024**2)throw Error('recovery_catalog_metadata_budget');
   const stamp=new Date().toISOString().replace(/[-:.]/g,''),name='catalog-'+stamp;
   const plain=path.join(directory,name+'.json'),cipher=plain+'.gz.age';fs.writeFileSync(plain,payload,{mode:0o600});
   execFileSync('python3',['-c',"import gzip,subprocess,sys,os\np=subprocess.Popen(['age','-R',sys.argv[3]],stdin=subprocess.PIPE,stdout=open(sys.argv[2],'xb'),stderr=subprocess.DEVNULL)\nwith gzip.GzipFile(fileobj=p.stdin,mode='wb',mtime=0) as z:\n with open(sys.argv[1],'rb') as s:\n  while True:\n   b=s.read(1048576)\n   if not b: break\n   z.write(b)\np.stdin.close()\nif p.wait(): raise SystemExit('metadata encryption failed')\nos.chmod(sys.argv[2],0o600)",plain,cipher,host.policy.recipient],{stdio:'ignore',timeout:60000});
   fs.unlinkSync(plain);
   pending={name,cipher,remote:host.policy.remoteRoot+'/recovery/'+name+'.json.gz.age',sha256:hash(fs.readFileSync(cipher)),bytes:fs.statSync(cipher).size,plaintextSha256:hash(payload),resultSha256:sha,delta,createdAt:new Date().toISOString(),previous:state.latestDescriptor??null};
   write(pendingFile,JSON.stringify(pending));
  }
  await upload(pending.cipher,pending.remote,pending);
  const receipt={format:'pp-portable-catalog-receipt-v1',createdAt:pending.createdAt,remote:pending.remote,ciphertextSha256:pending.sha256,ciphertextBytes:pending.bytes,
   plaintextSha256:pending.plaintextSha256,catalogSha256:pending.resultSha256,delta:pending.delta,previous:pending.previous,completeSiteBackup:false,documents:state.documents};
  const descriptor=path.join(directory,pending.name+'-receipt.json'),descriptorRemote=host.policy.remoteRoot+'/recovery/'+pending.name+'-receipt.json';
  write(descriptor,JSON.stringify(receipt,null,2)+'\n');const descriptorBytes=fs.readFileSync(descriptor);
  await upload(descriptor,descriptorRemote,{bytes:descriptorBytes.length,sha256:hash(descriptorBytes)});
  const nextFile=path.join(directory,'next.json'),currentFile=path.join(directory,'current.json');
  if(fs.existsSync(nextFile)){
   if(hash(fs.readFileSync(nextFile))!==pending.resultSha256)throw Error('recovery_pending_snapshot_mismatch');
   fs.renameSync(nextFile,currentFile);
  }else if(!fs.existsSync(currentFile)||hash(fs.readFileSync(currentFile))!==pending.resultSha256)throw Error('recovery_pending_snapshot_missing');
  state.catalogSha256=pending.resultSha256;state.latestDescriptor=descriptorRemote;state.lastPublishedAt=new Date().toISOString();
  state.lastCipherBytes=pending.bytes;state.lastDelta=pending.delta;write(stateFile,JSON.stringify(state,null,2)+'\n');
  fs.unlinkSync(pendingFile);fs.unlinkSync(pending.cipher);fs.unlinkSync(descriptor);
  process.stdout.write(JSON.stringify({published:true,delta:pending.delta,ciphertextBytes:pending.bytes,remote:descriptorRemote,completeSiteBackup:false})+'\n');
 }finally{release?.();host.close();}
}
void runStorageProcess(main).catch(e=>{process.stderr.write(JSON.stringify({ok:false,error:e instanceof Error?e.message:'catalog publish failed'})+'\n');process.exitCode=1;});
