import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import type { ChunkTransport } from './storage-chunks.js';
import type { AliyunStorageReader } from './storage-aliyun-reader.js';

export type AliyunStorageOptions = {
  command:string; driveId:string; remoteRoot:string; transferRoot:string;
  uid:number; gid:number; timeoutMs?:number;
};

/** The account's configured CLI owns authentication. Tokens and CLI errors
 * are never copied to the application database or logs. Exact immutable names
 * make a retry after a committed upload safe. All scratch stays in one budget. */
export class AliyunChunkTransport implements ChunkTransport {
  private readonly directories=new Set<string>();
  constructor(readonly options:AliyunStorageOptions,readonly reader?:AliyunStorageReader){
    if(!path.isAbsolute(options.command) || !path.isAbsolute(options.transferRoot)
      || !options.driveId || !options.remoteRoot.startsWith('/') || options.remoteRoot==='/'
      || !Number.isInteger(options.uid) || !Number.isInteger(options.gid))throw new Error('storage_transport_config_invalid');
    fs.mkdirSync(options.transferRoot,{recursive:true,mode:0o700});
    if(fs.realpathSync(options.transferRoot)!==path.resolve(options.transferRoot))throw new Error('storage_transport_root_alias');
    fs.chownSync(options.transferRoot,options.uid,options.gid);
    fs.chmodSync(options.transferRoot,0o700);
  }
  private command(args:string[]):string {
    try{return execFileSync(this.options.command,args,{encoding:'utf8',timeout:this.options.timeoutMs??30*60_000,maxBuffer:4*1024**2,stdio:['ignore','pipe','pipe']});}
    catch{throw new Error(`storage_cloud_${args[0]}_failed`);}
  }
  private remote(remote:string):void {
    if(!remote.startsWith(`${this.options.remoteRoot}/`) || remote.includes('\\')
      || remote.split('/').slice(1).some(p=>!p || p==='.' || p==='..' || /[\r\n\0]/.test(p)))throw new Error('storage_cloud_scope');
  }
  private list(directory:string):string {
    const value=this.command(['ls','--driveId',this.options.driveId,directory]);
    if(!value.split(/\r?\n/).some(line=>line.trim()===`当前目录: ${directory}`))throw new Error('storage_cloud_listing_invalid');
    return value;
  }
  private ensureDirectory(directory:string):void {
    let current='';
    for(const part of directory.split('/').filter(Boolean)){
      current+=`/${part}`;
      if(this.directories.has(current))continue;
      try{this.list(current);}
      catch{this.command(['mkdir','--driveId',this.options.driveId,current]);this.list(current);}
      this.directories.add(current);
    }
  }
  visible(remote:string):boolean {
    this.remote(remote);
    const parent=path.posix.dirname(remote),value=this.command(['tree','--driveId',this.options.driveId,'-fp',parent]);
    if(!value.split(/\r?\n/).some(line=>line.trim()===parent))throw new Error('storage_cloud_listing_invalid');
    const matches=value.split(/\r?\n/).filter(line=>line.trim().endsWith(`-> ${remote}`));
    if(matches.length>1)throw new Error('storage_cloud_ambiguous');
    return matches.length===1;
  }
  private directory():string {
    const dir=fs.mkdtempSync(path.join(this.options.transferRoot,'transfer-'));
    fs.chownSync(dir,this.options.uid,this.options.gid);fs.chmodSync(dir,0o700);return dir;
  }
  async put(file:string,remote:string):Promise<void> {
    if(this.reader?.config.writeRoot){this.remote(remote);await this.reader.putImmutable(file,remote);return;}
    this.remote(remote);this.ensureDirectory(path.posix.dirname(remote));
    if(this.visible(remote))return; // Caller still downloads and verifies it.
    const dir=this.directory(),stage=path.join(dir,path.posix.basename(remote));
    try{
      const st=fs.lstatSync(file);if(!st.isFile() || st.isSymbolicLink())throw new Error('storage_upload_not_regular');
      fs.copyFileSync(file,stage,fs.constants.COPYFILE_EXCL);
      fs.chownSync(stage,this.options.uid,this.options.gid);fs.chmodSync(stage,0o600);
      this.command(['upload','--driveId',this.options.driveId,'--np','--retry','2','--timeout','120',stage,path.posix.dirname(remote)]);
      if(!this.visible(remote))throw new Error('storage_cloud_upload_not_visible');
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  fileId(remote:string):string|undefined{return this.reader?.fileId(remote);}
  async get(remote:string,file:string,known?:{fileId?:string|null;bytes:number}):Promise<void> {
    this.remote(remote);if(fs.existsSync(file))throw new Error('storage_download_target_exists');
    if(this.reader){
      try{await pipeline(await this.reader.stream(remote,known?.bytes,known?.fileId),fs.createWriteStream(file,{flags:'wx',mode:0o600}));}
      catch(e){try{fs.unlinkSync(file);}catch{}throw e;}
      return;
    }
    const dir=this.directory();
    try{
      this.command(['download','--driveId',this.options.driveId,'--np',`--saveto=${dir}`,remote]);
      const matches:string[]=[];
      const visit=(current:string)=>{
        for(const entry of fs.readdirSync(current,{withFileTypes:true})){
          if(entry.isSymbolicLink())throw new Error('storage_download_symlink');
          const member=path.join(current,entry.name);
          if(entry.isDirectory())visit(member);
          else if(entry.isFile() && entry.name===path.posix.basename(remote))matches.push(member);
        }
      };visit(dir);
      if(matches.length!==1)throw new Error('storage_cloud_download_missing_or_ambiguous');
      // A same-filesystem move avoids a third copy. Installation itself still
      // occurs only after the chunk's ciphertext and plaintext hashes pass.
      const temporary=path.join(path.dirname(file),`.transfer-${crypto.randomUUID()}`);
      try{
        fs.renameSync(matches[0],temporary);fs.chmodSync(temporary,0o600);
        if(process.getuid?.()===0)fs.chownSync(temporary,0,0);
        fs.linkSync(temporary,file);fs.unlinkSync(temporary);
      }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
}
