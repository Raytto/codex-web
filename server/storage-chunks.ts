import { fileChunkBytes, LEGACY_CHUNK_BYTES, MAX_CHUNK_BYTES } from './storage-chunk-layout.js';
import {isStorageIdentity} from './storage-key.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import type { StoragePolicy } from './storage-lifecycle-policy.js';
import { StorageCatalog, type StorageChunk } from './storage-catalog.js';
import type {StorageProgressTick} from './storage-progress.js';

export type ChunkTransport = {
  /** Must reject mismatched/ambiguous remote objects. put is create-if-absent. */
  put: (file:string,remotePath:string) => Promise<void>;
  get: (remotePath:string,file:string,known?:{fileId?:string|null;bytes:number}) => Promise<void>;
  fileId?: (remotePath:string) => string|undefined;
};
type Pending = Omit<StorageChunk,'verified_at'> & {stage_path:string;created_at:number;last_error:string|null};
export const fileFingerprint = (stat:fs.Stats) => [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,stat.mode,stat.uid,stat.gid].join(':');
export function sha256Path(file:string): string {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
  try{for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null));)hash.update(buffer.subarray(0,n));}
  finally{fs.closeSync(fd);}return hash.digest('hex');
}
function processExit(child:ReturnType<typeof spawn>,label:string):Promise<void> {
  return new Promise((resolve,reject)=>{
    child.once('error',()=>reject(new Error(`${label}_start_failed`)));
    child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${label}_failed:${code??signal}`)));
  });
}
async function encodeRange(source:string,start:number,length:number,target:string,recipient:string,age:string):Promise<void> {
  const child=spawn(age,['-R',recipient],{stdio:['pipe','pipe','ignore']});
  const input=length ? fs.createReadStream(source,{fd:fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),autoClose:true,start,end:start+length-1}) : (await import('node:stream')).Readable.from([]);
  const output=fs.createWriteStream(target,{flags:'wx',mode:0o600});
  try {
    await Promise.all([processExit(child,'storage_encrypt'),pipeline(input,createGzip(),child.stdin!),pipeline(child.stdout!,output)]);
    const fd=fs.openSync(target,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  } catch(e){child.kill();throw e;}
}
async function decodeVerified(file:string,identity:string,age:string,expected:{sha256:string;bytes:number},destination?:Writable,onProgress?:(bytes:number)=>void):Promise<void> {
  const child=spawn(age,['-d','-i',identity,file],{stdio:['ignore','pipe','ignore']});
  const hash=crypto.createHash('sha256');let bytes=0;
  const meter=new Transform({transform(data:Buffer,_enc,done){
    bytes+=data.length;
    if(bytes>expected.bytes){done(new Error('storage_plaintext_size_exceeded'));return;}
    hash.update(data);onProgress?.(bytes);done(null,data);
  }});
  const sink=destination??new Writable({write(_data,_enc,done){done();}});
  try{await Promise.all([processExit(child,'storage_decrypt'),pipeline(child.stdout!,createGunzip(),meter,sink)]);}
  catch(e){child.kill();throw e;}
  if(bytes!==expected.bytes || hash.digest('hex')!==expected.sha256)throw new Error('storage_plaintext_hash_mismatch');
}
function hashRange(file:string,start:number,length:number):string {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(Math.min(1024*1024,Math.max(length,1)));
  try{let remaining=length,pos=start;while(remaining){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,remaining),pos);if(!n)throw new Error('storage_source_truncated');hash.update(buffer.subarray(0,n));pos+=n;remaining-=n;}}
  finally{fs.closeSync(fd);}return hash.digest('hex');
}
function ciphertextMatches(file:string,chunk:Pick<StorageChunk,'ciphertext_sha256'|'ciphertext_bytes'>):boolean {
  return fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()
    && fs.statSync(file).size===chunk.ciphertext_bytes && sha256Path(file)===chunk.ciphertext_sha256;
}

/** Bounded streaming chunks, one encrypted upload plus one verification download at a
 * time. No plaintext full-size staging or hardlinks to mutable originals. */
export class StorageChunkStore {
  onProgress?: (value:StorageProgressTick)=>void;
  constructor(readonly catalog:StorageCatalog,readonly policy:StoragePolicy,readonly scratch:string,
    readonly transport:ChunkTransport,readonly age='age',readonly budgetRoot:string|string[]=scratch) {
    if(!policy.enabled)throw new Error('storage_lifecycle_disabled');
    if(!Number.isSafeInteger(policy.chunkBytes) || policy.chunkBytes<=0 || policy.chunkBytes>MAX_CHUNK_BYTES || !Number.isSafeInteger(policy.scratchBytes) || policy.scratchBytes<3*policy.chunkBytes)throw new Error('storage_chunk_budget_invalid');
    fs.mkdirSync(scratch,{recursive:true,mode:0o700});
    if(fs.realpathSync(scratch)!==path.resolve(scratch))throw new Error('storage_scratch_symlink');
  }
  checkBudget(chunkBytes=this.policy.chunkBytes, additionalBytes=3*chunkBytes):void {
    let used=0;
    const visit=(dir:string)=>{for(const name of fs.readdirSync(dir)){
      const file=path.join(dir,name),s=fs.lstatSync(file);
      if(s.isSymbolicLink())throw new Error('storage_scratch_unexpected_member');
      if(s.isDirectory())visit(file);else if(s.isFile())used+=s.size;else throw new Error('storage_scratch_unexpected_member');
    }};for(const directory of typeof this.budgetRoot==='string'?[this.budgetRoot]:this.budgetRoot)if(fs.existsSync(directory))visit(directory);
    if(used+additionalBytes>this.policy.scratchBytes)throw new Error('storage_scratch_budget');
    const disk=fs.statfsSync(this.scratch);
    if(disk.bavail*disk.bsize-additionalBytes<disk.blocks*disk.bsize*0.1)throw new Error('storage_disk_reserve');
  }
  private async ioLock():Promise<()=>void> {
    const fd=fs.openSync(path.join(path.dirname(this.scratch),`.${path.basename(this.scratch)}.io.lock`),fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
    try{const child=spawn('flock',['--exclusive','--wait','900','3'],{stdio:['ignore','ignore','ignore',fd]});
      await processExit(child,'storage_io_lock');return ()=>fs.closeSync(fd);
    }catch(e){fs.closeSync(fd);throw e;}
  }
  async archiveFile(userId:string,source:string,options:{firstSeenAt?:number;legacyStream?:boolean}={}):Promise<{sha256:string;bytes:number;fingerprint:string;chunks:StorageChunk[]}> {
    if(isStorageIdentity(source,this.policy.identity))throw new Error('storage_identity_requires_external_custody');
    if(!/^[a-zA-Z0-9_-]+$/.test(userId))throw new Error('storage_user_path_invalid');
    const original=fs.lstatSync(source);
    if(!original.isFile() || original.isSymbolicLink() || original.nlink!==1)throw new Error('storage_source_not_exclusive_regular_file');
    const fingerprint=fileFingerprint(original),fullHash=sha256Path(source),chunks:StorageChunk[]=[];
    const chunkBytes=options.legacyStream?Math.min(this.policy.chunkBytes,LEGACY_CHUNK_BYTES)
      :fileChunkBytes(this.catalog.db,userId,path.resolve(source),original,this.policy.chunkBytes,options.firstSeenAt);
    for(let offset=0;offset<original.size || (offset===0 && original.size===0);offset+=chunkBytes){
      const release=await this.ioLock();
      try{
      const bytes=Math.min(chunkBytes,original.size-offset),plainHash=hashRange(source,offset,bytes);
      let chunk=this.catalog.chunk(userId,plainHash,bytes);
      if(chunk)this.catalog.protectChunk(chunk.id);
      if(!chunk) {
        let pending=this.catalog.db.prepare('SELECT * FROM storage_chunk_uploads WHERE user_id=? AND plaintext_sha256=? AND plaintext_bytes=?')
          .get(userId,plainHash,bytes) as Pending|undefined;
        if(!pending){
          this.checkBudget(chunkBytes);const id=crypto.randomUUID(),stage=path.join(this.scratch,`${id}.age`);
          try {
            await encodeRange(source,offset,bytes,stage,this.policy.recipient,this.age);
            const cipherHash=sha256Path(stage),cipherBytes=fs.statSync(stage).size;
            pending={id,user_id:userId,plaintext_sha256:plainHash,plaintext_bytes:bytes,ciphertext_sha256:cipherHash,ciphertext_bytes:cipherBytes,
              remote_drive:this.policy.driveId,remote_path:`${this.policy.remoteRoot}/${userId}/chunks/${plainHash.slice(0,2)}/${plainHash}-${cipherHash}.gz.age`,
              codec:'gzip-age-v1',stage_path:stage,created_at:this.catalog.now(),last_error:null};
            this.catalog.db.prepare(`INSERT INTO storage_chunk_uploads(id,user_id,plaintext_sha256,plaintext_bytes,ciphertext_sha256,ciphertext_bytes,
              remote_drive,remote_path,codec,stage_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,userId,plainHash,bytes,cipherHash,cipherBytes,
                pending.remote_drive,pending.remote_path,pending.codec,stage,pending.created_at);
          } catch(e){try{fs.unlinkSync(stage);}catch{}throw e;}
        }
        if(path.dirname(pending.stage_path)!==this.scratch || pending.remote_drive!==this.policy.driveId
          || !pending.remote_path.startsWith(`${this.policy.remoteRoot}/${userId}/chunks/`))throw new Error('storage_upload_scope_mismatch');
        const download=path.join(this.scratch,`${pending.id}.verify`);
        try {
          // A retry may coexist with interrupted uploads. Include the existing
          // ciphertext and reserve space for verification before any transfer.
          this.checkBudget(chunkBytes,pending.ciphertext_bytes);
          if(ciphertextMatches(pending.stage_path,pending))await this.transport.put(pending.stage_path,pending.remote_path);
          // After interruption, a lost stage is recoverable only from this exact
          // immutable remote name. Never generate different ciphertext under it.
          await this.transport.get(pending.remote_path,download);
          if(!ciphertextMatches(download,pending))throw new Error('storage_ciphertext_hash_mismatch');
          await decodeVerified(download,this.policy.identity,this.age,{sha256:plainHash,bytes});
          chunk=this.catalog.recordChunk({...pending,remote_file_id:this.transport.fileId?.(pending.remote_path)??null,verified_at:this.catalog.now()});
          this.catalog.db.prepare('DELETE FROM storage_chunk_uploads WHERE id=?').run(pending.id);
          try{fs.unlinkSync(pending.stage_path);}catch{}
        } catch(e) {
          // Keep the fixed upload identity and original due time for a retry.
          this.catalog.db.prepare('UPDATE storage_chunk_uploads SET last_error=? WHERE id=?').run(e instanceof Error?e.message:'storage_upload_failed',pending.id);
          throw e;
        } finally{try{fs.unlinkSync(download);}catch{}}
      }
      chunks.push(chunk);
      if(original.size===0)break;
      }finally{release();}
    }
    if(fileFingerprint(fs.lstatSync(source))!==fingerprint || sha256Path(source)!==fullHash)throw new Error('storage_source_changed');
    return {sha256:fullHash,bytes:original.size,fingerprint,chunks};
  }
  async restoreFile(userId:string,chunks:StorageChunk[],target:string,expected:{sha256:string;bytes:number}):Promise<void> {
    if(chunks.some(c=>c.user_id!==userId || c.remote_drive!==this.policy.driveId || c.codec!=='gzip-age-v1'
      || !c.remote_path.startsWith(`${this.policy.remoteRoot}/${userId}/chunks/`)))throw new Error('storage_restore_scope_mismatch');
    if(chunks.reduce((n,c)=>n+c.plaintext_bytes,0)!==expected.bytes)throw new Error('storage_restore_size_mismatch');
    if(fs.existsSync(target))throw new Error('storage_restore_target_exists');
    const maxChunkBytes=chunks.reduce((n,c)=>Math.max(n,c.plaintext_bytes),1);
    const maxCipherBytes=chunks.reduce((n,c)=>Math.max(n,c.ciphertext_bytes),1);
    this.checkBudget(maxChunkBytes,maxCipherBytes);
    const disk=fs.statfsSync(path.dirname(target));
    if(disk.bavail*disk.bsize-expected.bytes-2*maxChunkBytes<disk.blocks*disk.bsize*0.1)throw new Error('storage_restore_disk_reserve');
    const fd=fs.openSync(target,'wx',0o600);
    let completed=0;
    try {
      for(const chunk of chunks){
        const release=await this.ioLock();
        const download=path.join(this.scratch,`${crypto.randomUUID()}.restore`);
        const reportDownload=()=>{let downloaded=0;try{downloaded=fs.statSync(download).size;}catch{}
          this.onProgress?.({stage:'downloading',completed:completed+Math.min(1,downloaded/chunk.ciphertext_bytes)*chunk.plaintext_bytes*.85,total:expected.bytes,estimated:true});};
        reportDownload();const progressTimer=setInterval(reportDownload,500);progressTimer.unref();
        try {
          this.checkBudget(chunk.plaintext_bytes,chunk.ciphertext_bytes);
          await this.transport.get(chunk.remote_path,download,{fileId:chunk.remote_file_id,bytes:chunk.ciphertext_bytes});
          clearInterval(progressTimer);
          if(!ciphertextMatches(download,chunk))throw new Error('storage_ciphertext_hash_mismatch');
          const sink=new Writable({write(data:Buffer,_enc,done){try{let p=0;while(p<data.length)p+=fs.writeSync(fd,data,p,data.length-p);done();}catch(e){done(e as Error);}}});
          await decodeVerified(download,this.policy.identity,this.age,{sha256:chunk.plaintext_sha256,bytes:chunk.plaintext_bytes},sink,bytes=>this.onProgress?.({stage:'verifying',completed:completed+chunk.plaintext_bytes*.85+bytes*.15,total:expected.bytes,estimated:true}));
          completed+=chunk.plaintext_bytes;
        } finally{clearInterval(progressTimer);try{fs.unlinkSync(download);}catch{}release();}
      }
      fs.fsyncSync(fd);
      if(fs.fstatSync(fd).size!==expected.bytes || sha256Path(target)!==expected.sha256)throw new Error('storage_restored_hash_mismatch');
    } catch(e){try{fs.unlinkSync(target);}catch{}throw e;}
    finally{fs.closeSync(fd);}
  }
  /** Independent restore readers consume verified bounded plaintext parts,
   * without materializing an entire database dump or site archive. */
  verifiedStream(userId:string,chunks:StorageChunk[],expected:{sha256:string;bytes:number}):Readable {
    const store=this;
    async function* parts(){
      if(chunks.some(c=>c.user_id!==userId || c.remote_drive!==store.policy.driveId || c.codec!=='gzip-age-v1'
        || !c.remote_path.startsWith(`${store.policy.remoteRoot}/${userId}/chunks/`))
        || chunks.reduce((n,c)=>n+c.plaintext_bytes,0)!==expected.bytes)throw new Error('storage_restore_scope_mismatch');
      const hash=crypto.createHash('sha256');let bytes=0;
      for(const chunk of chunks){
        const release=await store.ioLock();
        const base=path.join(store.scratch,crypto.randomUUID()),encrypted=base+'.cipher',plain=base+'.plain';
        try{
          store.checkBudget(chunk.plaintext_bytes,chunk.ciphertext_bytes+chunk.plaintext_bytes);
          await store.transport.get(chunk.remote_path,encrypted,{fileId:chunk.remote_file_id,bytes:chunk.ciphertext_bytes});
          if(!ciphertextMatches(encrypted,chunk))throw new Error('storage_ciphertext_hash_mismatch');
          await decodeVerified(encrypted,store.policy.identity,store.age,{sha256:chunk.plaintext_sha256,bytes:chunk.plaintext_bytes},fs.createWriteStream(plain,{flags:'wx',mode:0o600}));
          fs.unlinkSync(encrypted);
          for await(const data of fs.createReadStream(plain)){const value=data as Buffer;hash.update(value);bytes+=value.length;yield value;}
        }finally{for(const file of [encrypted,plain])try{fs.unlinkSync(file);}catch{}release();}
      }
      if(bytes!==expected.bytes || hash.digest('hex')!==expected.sha256)throw new Error('storage_restore_hash_mismatch');
    }
    return Readable.from(parts());
  }
  /** Compatibility conversion consumes each legacy tar member once. Only a
   * single plaintext chunk is staged; a multi-GiB member never needs a full
   * local copy. The parent archive remains authoritative until conversion
   * and its complete ciphertext verification have both committed. */
  async archiveStream(userId:string,input:Readable,expected:{sha256:string;bytes:number}):Promise<{sha256:string;bytes:number;fingerprint:string;chunks:StorageChunk[]}> {
    if(!/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes<0)throw new Error('storage_stream_identity');
    const chunkBytes=Math.min(this.policy.chunkBytes,LEGACY_CHUNK_BYTES);
    this.checkBudget(chunkBytes);let total=0,partBytes=0,fd:number|undefined;
    const plain=path.join(this.scratch,`${crypto.randomUUID()}.plaintext-part`),hash=crypto.createHash('sha256'),chunks:StorageChunk[]=[];
    const flush=async()=>{
      if(fd===undefined)fd=fs.openSync(plain,'wx',0o600);
      fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      const archived=await this.archiveFile(userId,plain,{legacyStream:true});chunks.push(...archived.chunks);
      fs.unlinkSync(plain);partBytes=0;
    };
    try{
      for await(const value of input){
        const data=Buffer.isBuffer(value)?value:Buffer.from(value);
        if(total+data.length>expected.bytes)throw new Error('storage_stream_size_exceeded');
        hash.update(data);total+=data.length;
        for(let offset=0;offset<data.length;){
          if(fd===undefined){this.checkBudget(chunkBytes);fd=fs.openSync(plain,'wx',0o600);}
          const length=Math.min(chunkBytes-partBytes,data.length-offset);
          let written=0;while(written<length)written+=fs.writeSync(fd,data,offset+written,length-written);
          offset+=length;partBytes+=length;
          if(partBytes===chunkBytes)await flush();
        }
      }
      if(partBytes || !total)await flush();
      const sha256=hash.digest('hex');
      if(total!==expected.bytes || sha256!==expected.sha256)throw new Error('storage_stream_hash_mismatch');
      return {sha256,bytes:total,fingerprint:`verified-stream:${sha256}:${total}`,chunks};
    }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(plain);}catch{}input.destroy();}
  }
}
