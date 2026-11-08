import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type TarMember = {size?:number;maxBytes?:number;sha256?:string;target?:string;sqlite?:boolean};
export type TarVerification = {files:number;directories:number;links:number;plaintextBytes:number;memberDigest:string;
  selected:number;sqliteChecks:number;ciphertextBytes:number;ciphertextSha256:string};

// Python's streaming tar reader supports existing GNU/PAX and gzip archives.
// It never calls extract/extractall, follows links or trusts a tar pathname as
// a destination. Only explicit, exclusive target files may be materialized.
const VERIFY_TAR=String.raw`
import os,sys,json,tarfile,hashlib,sqlite3,stat,re,struct
config=json.load(os.fdopen(3)); expected=config['members']; seen=set(); all_seen=set()
result=dict(files=0,directories=0,links=0,plaintextBytes=0,selected=0,sqliteChecks=0)
digest=hashlib.sha256(); index=None
def emit(value):
 data=json.dumps(value,separators=(',',':')).encode()
 sys.stdout.buffer.write(struct.pack('>I',len(data)));sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
try:
 if config.get('indexFile'): index=open(config['indexFile'],'x',encoding='utf-8')
 archive=tarfile.open(fileobj=sys.stdin.buffer,mode='r|*')
 for member in archive:
  name=member.name
  while name.startswith('./'): name=name[2:]
  name=name.rstrip('/')
  if name in ('','.') and member.isdir(): continue
  if not name or name.startswith('/') or chr(92) in name or any(p in ('','..','.') for p in name.split('/')): raise ValueError('unsafe_member')
  if len(name)>16384 or len(all_seen)>2000000: raise ValueError('metadata_budget')
  if name in all_seen: raise ValueError('duplicate_member')
  all_seen.add(name)
  if member.isdir(): result['directories']+=1; continue
  if not member.isfile():
   if config['strict'] or not (member.issym() or member.islnk()): raise ValueError('unsupported_member')
   # Recovery inventory records links without ever resolving or installing them.
   record=dict(path=name,type='symlink' if member.issym() else 'hardlink',link=member.linkname)
   result['links']+=1
  else:
   spec=expected.get(name)
   if config['strict'] and spec is None: raise ValueError('unexpected_member')
   if member.size<0 or (spec and spec.get('size') is not None and member.size!=spec['size']): raise ValueError('member_size')
   if config['strict'] and (not spec or spec.get('size') is None): raise ValueError('strict_size_required')
   if spec and spec.get('maxBytes') is not None and member.size>spec['maxBytes']: raise ValueError('selected_member_budget')
   if result['plaintextBytes']+member.size>config['maxPlaintextBytes']: raise ValueError('plaintext_budget')
   output=None; stream=archive.extractfile(member); h=hashlib.sha256(); total=0
   if config.get('forward'): emit(dict(event='member',name=name,size=member.size))
   if spec and spec.get('target'):
    target=spec['target']; parent=os.path.dirname(target)
    if os.path.realpath(parent)!=parent: raise ValueError('target_alias')
    fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600); output=os.fdopen(fd,'wb')
   try:
    while True:
     data=stream.read(1024*1024)
     if not data: break
     total+=len(data); h.update(data)
     if output: output.write(data)
     if config.get('forward'): sys.stdout.buffer.write(data)
    if total!=member.size: raise ValueError('member_truncated')
    if spec and spec.get('sha256') and h.hexdigest()!=spec['sha256']: raise ValueError('member_hash')
    if output: output.flush(); os.fsync(output.fileno())
   finally:
    if output: output.close()
    stream.close()
   if spec:
    seen.add(name)
    if spec.get('target'): result['selected']+=1
    if spec.get('sqlite'):
     db=sqlite3.connect('file:'+spec['target']+'?mode=ro',uri=True)
     try:
      if list(db.execute('PRAGMA quick_check'))!=[('ok',)]: raise ValueError('sqlite_integrity')
      if list(db.execute('PRAGMA foreign_key_check')): raise ValueError('sqlite_foreign_keys')
     finally: db.close()
     result['sqliteChecks']+=1
   result['files']+=1; result['plaintextBytes']+=total
   record=dict(path=name,type='file',size=total,sha256=h.hexdigest(),mode=member.mode,uid=member.uid,gid=member.gid)
  encoded=json.dumps(record,ensure_ascii=True,separators=(',',':'))+'\n'
  digest.update(encoded.encode())
  if index: index.write(encoded)
 if seen!=set(expected): raise ValueError('missing_member')
 # Consume the authenticated age stream to EOF, including tar padding.
 while sys.stdin.buffer.read(1024*1024): pass
 result['memberDigest']=digest.hexdigest()
 if index: index.flush(); os.fsync(index.fileno())
 if config.get('forward'): emit(dict(event='report',result=result))
 else: print(json.dumps(result))
except Exception as error:
 # Names, bodies and secrets are deliberately omitted from process diagnostics.
 reason=str(error) if type(error) is ValueError and re.fullmatch('[a-z_]+',str(error)) else type(error).__name__
 print(json.dumps(dict(error=reason)),file=sys.stderr)
 sys.exit(1)
finally:
 if index: index.close()
`;

class FrameReader {
  private readonly iterator:AsyncIterator<Buffer>;private buffer:Buffer=Buffer.alloc(0);private ended=false;
  constructor(stream:Readable){this.iterator=stream[Symbol.asyncIterator]();}
  async *bytes(size:number):AsyncGenerator<Buffer>{
    let left=size;
    while(left){
      if(!this.buffer.length){const value=await this.iterator.next();if(value.done){this.ended=true;throw new Error('storage_member_stream_truncated');}this.buffer=value.value;}
      const length=Math.min(left,this.buffer.length),piece=this.buffer.subarray(0,length);
      this.buffer=this.buffer.subarray(length);left-=length;yield piece;
    }
  }
  async header():Promise<Record<string,unknown>|null>{
    if(!this.buffer.length && !this.ended){const value=await this.iterator.next();if(value.done){this.ended=true;return null;}this.buffer=value.value;}
    if(this.ended)return null;
    const prefix:Buffer[]=[];for await(const chunk of this.bytes(4))prefix.push(chunk);
    const size=Buffer.concat(prefix).readUInt32BE();if(size<1 || size>65536)throw new Error('storage_member_header_budget');
    const parts:Buffer[]=[];for await(const chunk of this.bytes(size))parts.push(chunk);
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string,unknown>;
  }
}

function completed(child:ReturnType<typeof spawn>,name:string):Promise<void> {
  return new Promise((resolve,reject)=>{
    child.once('error',()=>reject(new Error(`${name}_start_failed`)));
    child.once('close',code=>code===0?resolve():reject(new Error(`${name}_failed`)));
  });
}

/** No original is published by this function. Callers may install selected
 * targets only after this returns: every member and the entire ciphertext
 * have then passed validation using the independently supplied identity. */
export async function verifyTarStream(input:{stream:Readable;identity:string;ciphertextSha256:string;ciphertextBytes:number;
  members:Record<string,TarMember>;strict?:boolean;indexFile?:string;maxPlaintextBytes:number;age?:string;
  onMember?:(name:string,size:number,stream:Readable)=>Promise<void>;
  progress?:(bytes:number)=>void}):Promise<TarVerification> {
  if(!/^[a-f0-9]{64}$/.test(input.ciphertextSha256) || input.ciphertextBytes<1)throw new Error('storage_archive_proof_invalid');
  let bytes=0,report='',diagnostic='';const hash=crypto.createHash('sha256');
  const age=spawn(input.age??'age',['--decrypt','-i',input.identity],{stdio:['pipe','pipe','ignore']});
  const tar=spawn('python3',['-c',VERIFY_TAR],{stdio:['pipe','pipe','pipe','pipe']});
  const config=tar.stdio[3] as NodeJS.WritableStream;
  config.on('error',()=>undefined);
  config.end(JSON.stringify({members:input.members,strict:input.strict!==false,indexFile:input.indexFile,maxPlaintextBytes:input.maxPlaintextBytes,forward:Boolean(input.onMember)}));
  const readForward=async()=>{
    const reader=new FrameReader(tar.stdout!);let reported=false;
    for(;;){
      const header=await reader.header();if(!header)break;
      if(header.event==='report' && !reported){report=JSON.stringify(header.result);reported=true;continue;}
      if(reported || header.event!=='member' || typeof header.name!=='string' || !Number.isSafeInteger(header.size) || Number(header.size)<0)throw new Error('storage_member_frame_invalid');
      const member=Readable.from(reader.bytes(Number(header.size)));
      await input.onMember!(header.name,Number(header.size),member);
      if(!member.readableEnded)throw new Error('storage_member_not_consumed');
    }
    if(!reported)throw new Error('storage_member_report_missing');
  };
  if(!input.onMember)tar.stdout!.on('data',(chunk:Buffer)=>{if(report.length<1024*1024)report+=chunk.toString('utf8');});
  tar.stderr!.on('data',(chunk:Buffer)=>{if(diagnostic.length<1024)diagnostic+=chunk.toString('utf8');});
  const meter=new Transform({transform(chunk:Buffer,_enc,done){
    bytes+=chunk.length;
    if(bytes>input.ciphertextBytes){done(new Error('storage_archive_size_exceeded'));return;}
    hash.update(chunk);input.progress?.(bytes);done(null,chunk);
  }});
  const work=[completed(age,'storage_archive_decrypt'),completed(tar,'storage_archive_members'),pipeline(input.stream,meter,age.stdin!),pipeline(age.stdout!,tar.stdin!)];
  if(input.onMember)work.push(readForward());
  try{await Promise.all(work);}
  catch{age.kill();tar.kill();input.stream.destroy();await Promise.allSettled(work);
    let reason='';try{const value=JSON.parse(diagnostic);if(typeof value.error==='string' && /^[a-zA-Z_]+$/.test(value.error))reason=`:${value.error}`;}catch{}
    throw new Error(`storage_archive_stream_verification_failed${reason}`);}
  const ciphertextSha256=hash.digest('hex');
  if(bytes!==input.ciphertextBytes || ciphertextSha256!==input.ciphertextSha256)throw new Error('storage_archive_ciphertext_mismatch');
  let parsed:Omit<TarVerification,'ciphertextBytes'|'ciphertextSha256'>;
  try{parsed=JSON.parse(report);}catch{throw new Error('storage_archive_report_invalid');}
  if(!Number.isSafeInteger(parsed.files) || typeof parsed.memberDigest!=='string')throw new Error('storage_archive_report_invalid');
  return {...parsed,ciphertextBytes:bytes,ciphertextSha256};
}
