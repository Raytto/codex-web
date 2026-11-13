import { MAX_CHUNK_CIPHERTEXT_BYTES } from './storage-chunk-layout.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

type CloudFile = {file_id:string;name:string;type:'folder'|'file';size:number;status?:string;content_hash?:string;content_hash_name?:string};
type TokenConfig = {activeUID:string;userList:Array<{userId:string;openapiToken:{accessToken:string;expired:number}}>};
type ApiClock = {now:()=>number;wait:(ms:number)=>Promise<void>};
const apiClock:ApiClock={now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
const apiQueues=new Map<string,{tail:Promise<void>;nextAt:number}>();
const API_WAIT_BUDGET_MS=120_000,API_RATE_RETRIES=5;

/** OpenAPI adapter, read-only unless one explicit writeRoot is configured;
 * pinned to the API used by the installed
 * tickstep/aliyunpan v0.4.0 (aliyunpan-api v0.2.9). Authentication refresh stays
 * with the existing CLI. Signed URLs and tokens never enter durable metadata.
 * Range requests renew URLs during long archives without staging the package.
 * Source: github.com/tickstep/aliyunpan-api/blob/v0.2.9/aliyunpan_open/openapi/file_api.go */
export class AliyunStorageReader {
  private readonly files=new Map<string,CloudFile>();
  private readonly folders=new Map<string,string>();
  constructor(readonly config:{configFile:string;driveId:string;allowedRoots:string[];
    refresh:()=>Promise<void>;fetch?:typeof fetch;rangeBytes?:number;writeRoot?:string;writeStateRoot?:string;apiClock?:ApiClock;
    requestIntervalMs?:number}) {
    const interval=config.requestIntervalMs??0;
    if(!Number.isSafeInteger(interval)||interval<0||interval>60_000)throw new Error('storage_request_interval_invalid');
  }
  /** Only background clients enter this pacing queue. Interactive restores
   * have no artificial interval and cannot queue behind maintenance traffic.
   * Provider Retry-After remains authoritative for both kinds of client. */
  private async scheduled<T>(operation:(queue:{nextAt:number})=>Promise<T>):Promise<T>{
    if(!(this.config.requestIntervalMs??0))return operation({nextAt:0});
    const key=JSON.stringify([path.resolve(this.config.configFile),this.config.driveId]);
    let queue=apiQueues.get(key);if(!queue){queue={tail:Promise.resolve(),nextAt:0};apiQueues.set(key,queue);}
    const previous=queue.tail;let release!:()=>void;queue.tail=new Promise(resolve=>{release=resolve;});await previous;
    try{return await operation(queue);}finally{release();}
  }
  private async api(endpoint:'list'|'getDownloadUrl'|'create'|'complete'|'getUploadUrl'|'get'|'delete',body:Record<string,unknown>):Promise<Record<string,unknown>> {
    return this.scheduled(queue=>this.apiRequest(endpoint,body,queue));
  }
  private async transferFetch(input:string,init:RequestInit):Promise<Response>{
    return this.scheduled(async queue=>{
      const clock=this.config.apiClock??apiClock,interval=this.config.requestIntervalMs??0;
      if(interval){
        const delay=Math.max(0,queue.nextAt-clock.now());
        if(delay>API_WAIT_BUDGET_MS)throw new Error('storage_cloud_api_http_429');
        if(delay)await clock.wait(delay);
        queue.nextAt=clock.now()+interval;
      }
      return (this.config.fetch??fetch)(input,init);
    });
  }
  private cooldown(notBefore?:number):number {
    const root=this.config.writeStateRoot;if(!root)return 0;
    if(!path.isAbsolute(root))throw new Error('storage_cloud_cooldown_path');
    if(!fs.existsSync(root)){if(notBefore===undefined)return 0;fs.mkdirSync(root,{recursive:true,mode:0o700});}
    const directory=fs.lstatSync(root);if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('storage_cloud_cooldown_path');
    const file=path.join(root,'api-cooldown.json');let until=0;
    if(fs.existsSync(file)){
      const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.size>4096)throw new Error('storage_cloud_cooldown_state');
      const saved=JSON.parse(fs.readFileSync(file,'utf8'));
      if(saved.format!=='pp-aliyun-cooldown-v1'||saved.driveId!==this.config.driveId||!Number.isSafeInteger(saved.notBefore)||saved.notBefore<0)throw new Error('storage_cloud_cooldown_state');
      until=saved.notBefore;
    }
    if(notBefore!==undefined && notBefore>until){
      until=notBefore;const temporary=file+'.'+crypto.randomUUID()+'.tmp';
      const fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,JSON.stringify({format:'pp-aliyun-cooldown-v1',driveId:this.config.driveId,notBefore:until})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,file);
    }return until;
  }
  private async apiRequest(endpoint:string,body:Record<string,unknown>,queue:{nextAt:number}):Promise<Record<string,unknown>> {
    const clock=this.config.apiClock??apiClock;
    const read=()=>{
      const st=fs.lstatSync(this.config.configFile);
      if(!st.isFile() || st.isSymbolicLink() || (st.mode&0o077)!==0)throw new Error('storage_auth_config_permissions');
      const value=JSON.parse(fs.readFileSync(this.config.configFile,'utf8')) as TokenConfig;
      const user=value.userList.find(u=>u.userId===value.activeUID);
      if(!user?.openapiToken?.accessToken)throw new Error('storage_cloud_auth_missing');
      return user.openapiToken;
    };
    let token=read();
    if(token.expired*1000<clock.now()+60_000){await this.config.refresh();token=read();}
    let refreshed=false,rateRetries=0,waited=0;
    for(;;){
      const delay=Math.max(0,queue.nextAt,this.cooldown())-clock.now();
      if(delay>API_WAIT_BUDGET_MS-waited)throw new Error('storage_cloud_api_http_429');
      if(delay>0){await clock.wait(delay);waited+=delay;}
      queue.nextAt=clock.now()+(this.config.requestIntervalMs??0);
      let response:Response;
      try{response=await (this.config.fetch??fetch)(`https://openapi.alipan.com/adrive/v1.0/openFile/${endpoint}`,{
        method:'POST',headers:{authorization:`Bearer ${token.accessToken}`,'content-type':'application/json'},
        body:JSON.stringify({drive_id:this.config.driveId,...body}),redirect:'error',signal:AbortSignal.timeout(30_000)});}
      catch{throw new Error('storage_cloud_api_network');}
      if(response.status===401 && !refreshed){await response.body?.cancel();await this.config.refresh();token=read();refreshed=true;continue;}
      if(response.status===429){
        const header=response.headers.get('retry-after')?.trim();await response.body?.cancel();
        const parsed=header?(/^\d+(?:\.\d+)?$/.test(header)?clock.now()+Number(header)*1000:Date.parse(header)):NaN;
        const until=Math.max(clock.now()+2000*2**rateRetries,Number.isSafeInteger(parsed)?parsed:0);
        queue.nextAt=Math.max(queue.nextAt,until);this.cooldown(queue.nextAt);
        if(rateRetries++>=API_RATE_RETRIES)throw new Error('storage_cloud_api_http_429');
        continue;
      }
      if(!response.ok){await response.body?.cancel();throw new Error(`storage_cloud_api_http_${response.status}`);}
      const value=await response.json() as Record<string,unknown>;
      if(value.code)throw new Error('storage_cloud_api_rejected');
      return value;
    }
  }
  async locate(remote:string):Promise<CloudFile> {
    if(!this.config.allowedRoots.some(root=>root!=='/' && remote.startsWith(`${root}/`))
      || !remote.startsWith('/') || remote.includes('\\') || remote.split('/').slice(1).some(s=>!s || s==='.' || s==='..'))throw new Error('storage_cloud_scope');
    let parent='root',found:CloudFile|undefined;
    const parts=remote.split('/').filter(Boolean);
    for(let i=0;i<parts.length;i++){
      const folderPath='/'+parts.slice(0,i+1).join('/'),cached=this.folders.get(folderPath);
      if(i<parts.length-1 && cached){parent=cached;continue;}
      let marker='',match:CloudFile|undefined;const seen=new Set<string>();
      do{
        if(seen.has(marker) || seen.size>=10_000)throw new Error('storage_cloud_listing_loop');seen.add(marker);
        const page=await this.api('list',{parent_file_id:parent,limit:100,marker,order_by:'name',order_direction:'ASC'});
        if(!Array.isArray(page.items))throw new Error('storage_cloud_listing_invalid');
        for(const file of page.items as CloudFile[])if(file.name===parts[i]){if(match)throw new Error('storage_cloud_ambiguous');match=file;}
        marker=typeof page.next_marker==='string'?page.next_marker:'';
      }while(marker);
      if(!match?.file_id || (i<parts.length-1 && match.type!=='folder'))throw new Error('storage_cloud_object_missing');
      found=match;parent=match.file_id;
      if(match.type==='folder')this.folders.set(folderPath,match.file_id);
    }
    if(!found || found.type!=='file' || !Number.isSafeInteger(found.size) || found.size<0)throw new Error('storage_cloud_not_file');
    this.files.set(remote,found);return found;
  }
  fileId(remote:string):string|undefined {return this.files.get(remote)?.file_id;}
  private async child(parent:string,name:string):Promise<CloudFile|undefined>{
    let marker='',match:CloudFile|undefined;const seen=new Set<string>();
    do{if(seen.has(marker))throw new Error('storage_cloud_listing_loop');seen.add(marker);
      const page=await this.api('list',{parent_file_id:parent,limit:100,marker,order_by:'name',order_direction:'ASC'});
      if(!Array.isArray(page.items))throw new Error('storage_cloud_listing_invalid');
      for(const file of page.items as CloudFile[])if(file.name===name){if(match)throw new Error('storage_cloud_ambiguous');match=file;}
      marker=typeof page.next_marker==='string'?page.next_marker:'';
    }while(marker);return match;
  }
  private writeScope(remote:string):string{
    const root=this.config.writeRoot;
    if(!root || !this.config.allowedRoots.includes(root) || root==='/' || !remote.startsWith(root+'/')
      || remote.includes('\\') || remote.split('/').slice(1).some(p=>!p||p==='.'||p==='..'||/[\r\n\0]/.test(p)))throw new Error('storage_cloud_write_scope');
    return root;
  }
  private async writeParent(remote:string):Promise<string>{
    const root=this.writeScope(remote);let parent='root',current='';
    for(const part of remote.split('/').slice(1,-1)){
      current+='/'+part;const cached=this.folders.get(current);if(cached){parent=cached;continue;}
      let file=await this.child(parent,part);
      if(!file){
        if(current!==root && !current.startsWith(root+'/'))throw new Error('storage_cloud_write_parent_missing');
        const made=await this.api('create',{parent_file_id:parent,name:part,type:'folder',check_name_mode:'refuse'});
        if(typeof made.file_id!=='string')throw new Error('storage_cloud_folder_create');
        file={file_id:made.file_id,name:part,type:'folder',size:0};
      }
      if(file.type!=='folder')throw new Error('storage_cloud_parent_not_folder');parent=file.file_id;this.folders.set(current,parent);
    }return parent;
  }
  /** One immutable ciphertext file, uploaded directly as a single bounded
   * part. Only IDs/hashes are journaled; signed URLs stay in memory. */
  async putImmutable(source:string,remote:string):Promise<void>{
    this.writeScope(remote);const stateRoot=this.config.writeStateRoot;
    if(!stateRoot || !path.isAbsolute(stateRoot))throw new Error('storage_upload_journal_required');
    fs.mkdirSync(stateRoot,{recursive:true,mode:0o700});
    const st=fs.lstatSync(source);if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_CHUNK_CIPHERTEXT_BYTES)throw new Error('storage_upload_source_budget');
    const sha1=crypto.createHash('sha1');for await(const data of fs.createReadStream(source))sha1.update(data as Buffer);const hash=sha1.digest('hex');
    const journal=path.join(stateRoot,crypto.createHash('sha256').update(remote).digest('hex')+'.json');
    type Intent={remote:string;bytes:number;sha1:string;fileId?:string;uploadId?:string};
    let intent:Intent=fs.existsSync(journal)?JSON.parse(fs.readFileSync(journal,'utf8')):{remote,bytes:st.size,sha1:hash};
    if(intent.remote!==remote || intent.bytes!==st.size || intent.sha1!==hash)throw new Error('storage_upload_intent_mismatch');
    const save=()=>{const temporary=journal+'.tmp';fs.writeFileSync(temporary,JSON.stringify(intent),{mode:0o600});const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,journal);};
    save();const parent=await this.writeParent(remote),name=path.posix.basename(remote),existing=await this.child(parent,name);
    if(existing?.status==='available'){
      if(existing.size!==st.size || existing.content_hash && existing.content_hash.toLowerCase()!==hash)throw new Error('storage_upload_existing_mismatch');
      this.files.set(remote,existing);fs.unlinkSync(journal);return;
    }
    let created:Record<string,unknown>|undefined;
    if(!intent.fileId || !intent.uploadId){
      if(existing){
        // The durable pre-create intent fixes this exact name/hash. An
        // unfinished, unreferenced object can be recreated after a crash in
        // the API-response/journal gap; an available object is never deleted.
        const exact=await this.api('get',{file_id:existing.file_id});
        if(exact.status!=='uploading' || exact.name!==name || exact.size!==st.size)throw new Error('storage_upload_remote_intent_requires_reconciliation');
        const removed=await this.api('delete',{file_id:existing.file_id});if(removed.async_task_id)throw new Error('storage_upload_partial_delete_pending');
      }
      created=await this.api('create',{parent_file_id:parent,name,type:'file',check_name_mode:'refuse',size:st.size,part_info_list:[{part_number:1}],content_hash_name:'sha1',content_hash:hash});
      if(typeof created.file_id!=='string' || typeof created.upload_id!=='string')throw new Error('storage_upload_create_identity');
      intent={...intent,fileId:created.file_id,uploadId:created.upload_id};save();
    }
    const urls=created??await this.api('getUploadUrl',{file_id:intent.fileId,upload_id:intent.uploadId,part_info_list:[{part_number:1}]});
    const parts=urls.part_info_list as Array<{part_number:number;upload_url:string}>;
    if(!Array.isArray(parts)||parts.length!==1||parts[0].part_number!==1)throw new Error('storage_upload_part_identity');
    const url=new URL(parts[0].upload_url);
    if(url.protocol!=='https:'||!['aliyuncs.com','aliyundrive.com','aliyundrive.net','aliyundrive.cloud','alipan.com','alicdn.com'].some(h=>url.hostname===h||url.hostname.endsWith('.'+h)))throw new Error('storage_upload_host_invalid');
    let response:Response;const stream=fs.createReadStream(source);
    try{response=await this.transferFetch(url.href,{method:'PUT',body:stream,duplex:'half',headers:{'content-length':String(st.size)},redirect:'error',signal:AbortSignal.timeout(30*60_000)} as unknown as RequestInit);}
    catch{throw new Error('storage_cloud_upload_network');}finally{stream.destroy();}
    await response.body?.cancel();if(!response.ok)throw new Error(`storage_cloud_upload_http_${response.status}`);
    const complete=await this.api('complete',{file_id:intent.fileId,upload_id:intent.uploadId});
    if(complete.file_id!==intent.fileId || complete.size!==st.size || complete.content_hash && String(complete.content_hash).toLowerCase()!==hash)throw new Error('storage_cloud_upload_commit_mismatch');
    this.files.set(remote,{file_id:intent.fileId!,name,type:'file',size:st.size,status:'available',content_hash:hash,content_hash_name:'sha1'});fs.unlinkSync(journal);
  }
  async deleteExact(remote:string,fileId:string,bytes:number):Promise<{pending:boolean}>{
    this.writeScope(remote);const parent=await this.writeParent(remote),file=await this.child(parent,path.posix.basename(remote));
    if(!file)return {pending:false};
    if(file.file_id!==fileId || file.size!==bytes || file.type!=='file')throw new Error('storage_cloud_delete_identity_mismatch');
    const result=await this.api('delete',{file_id:fileId});return {pending:Boolean(result.async_task_id)};
  }
  async assertPresent(remote:string,bytes:number,fileId?:string|null):Promise<void>{
    if(!this.config.allowedRoots.some(root=>root!=='/' && remote.startsWith(root+'/')) || remote.split('/').slice(1).some(p=>!p || p==='.' || p==='..'))throw new Error('storage_cloud_scope');
    const file=fileId?{file_id:fileId,size:bytes}:await this.locate(remote);
    const result=await this.api('getDownloadUrl',{file_id:file.file_id,expire_sec:60});
    if(result.size!==bytes || typeof result.url!=='string')throw new Error('storage_cloud_object_missing_or_changed');
  }
  async stream(remote:string,expectedBytes?:number,knownFileId?:string|null):Promise<Readable> {
    if(!this.config.allowedRoots.some(root=>root!=='/' && remote.startsWith(`${root}/`)) || !remote.startsWith('/')
      || remote.includes(String.fromCharCode(92)) || remote.split('/').slice(1).some(s=>!s || s==='.' || s==='..'))throw new Error('storage_cloud_scope');
    if(knownFileId && (!/^[a-zA-Z0-9_-]{1,200}$/.test(knownFileId) || !Number.isSafeInteger(expectedBytes)))throw new Error('storage_cloud_file_id_invalid');
    const file=knownFileId?{file_id:knownFileId,size:expectedBytes!}:this.files.get(remote)??await this.locate(remote);
    if(expectedBytes!==undefined && file.size!==expectedBytes)throw new Error('storage_cloud_size_mismatch');
    const api=this.api.bind(this),fetcher=this.transferFetch.bind(this),rangeBytes=this.config.rangeBytes??16*1024**2;
    if(!Number.isSafeInteger(rangeBytes) || rangeBytes<1 || rangeBytes>64*1024**2)throw new Error('storage_range_budget_invalid');
    async function* content(){
      let offset=0,url='',expires=0,failures=0;
      while(offset<file.size){
        if(!url || expires<Date.now()+30_000){
          const signed=await api('getDownloadUrl',{file_id:file.file_id,expire_sec:900});
          if(signed.size!==file.size || typeof signed.url!=='string')throw new Error('storage_cloud_download_identity');
          let parsed:URL;try{parsed=new URL(signed.url);}catch{throw new Error('storage_cloud_download_url_invalid');}
          if(parsed.protocol!=='https:' || !['aliyuncs.com','aliyundrive.com','aliyundrive.net','aliyundrive.cloud','alipan.com','alicdn.com'].some(h=>parsed.hostname===h || parsed.hostname.endsWith(`.${h}`)))throw new Error('storage_cloud_download_host_invalid');
          url=parsed.href;expires=Date.parse(String(signed.expiration));
          if(!Number.isFinite(expires))expires=Date.now()+5*60_000;
        }
        const end=Math.min(file.size-1,offset+rangeBytes-1),start=offset;
        try{
          const response=await fetcher(url,{headers:{range:`bytes=${start}-${end}`,referer:'https://www.aliyundrive.com/',
            'user-agent':'PP-Agent-Storage/1'},redirect:'error',signal:AbortSignal.timeout(120_000)});
          if(response.status!==206 || response.headers.get('content-range')!==`bytes ${start}-${end}/${file.size}` || !response.body){
            await response.body?.cancel();if(response.status===401 || response.status===403)url='';throw new Error('storage_cloud_range_response');
          }
          const reader=response.body.getReader();
          try{
            for(;;){const next=await reader.read();if(next.done)break;
              if(offset+next.value.length>end+1)throw new Error('storage_cloud_range_overflow');
              offset+=next.value.length;yield Buffer.from(next.value);
            }
          }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
          if(offset!==end+1)throw new Error('storage_cloud_range_truncated');
          failures=0;
        }catch{
          // Continue exactly after delivered bytes; never feed duplicated
          // ciphertext to age following a mid-response connection failure.
          if(++failures>2)throw new Error('storage_cloud_stream_failed');url='';
        }
      }
    }
    return Readable.from(content());
  }
}
