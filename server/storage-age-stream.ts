import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {Transform,Writable,type Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

/** Legacy voice objects are age-encrypted raw files, not tar/gzip packages. */
export async function consumeAgeFile<T>(input:{stream:Readable;identity:string;cipherSha256:string;cipherBytes:number;
 sha256:string;bytes:number;consume?:(plain:Readable)=>Promise<T>}):Promise<T|undefined>{
 if(!/^[a-f0-9]{64}$/.test(input.sha256) || !/^[a-f0-9]{64}$/.test(input.cipherSha256)
  || !Number.isSafeInteger(input.bytes) || input.bytes<0 || !Number.isSafeInteger(input.cipherBytes) || input.cipherBytes<1)throw new Error('storage_age_proof_invalid');
 const child=spawn('age',['-d','-i',input.identity],{stdio:['pipe','pipe','ignore']});
 const ended=new Promise<void>((resolve,reject)=>{child.once('error',()=>reject(new Error('storage_age_start')));child.once('close',code=>code===0?resolve():reject(new Error('storage_age_decrypt')));});
 let cipherBytes=0,bytes=0;const cipher=crypto.createHash('sha256'),plain=crypto.createHash('sha256');
 const encryptedMeter=new Transform({transform(data:Buffer,_encoding,done){cipherBytes+=data.length;if(cipherBytes>input.cipherBytes){done(new Error('storage_age_cipher_size'));return;}cipher.update(data);done(null,data);}});
 const plainMeter=new Transform({transform(data:Buffer,_encoding,done){bytes+=data.length;if(bytes>input.bytes){done(new Error('storage_age_plain_size'));return;}plain.update(data);done(null,data);}});
 const consume=input.consume?input.consume(plainMeter):pipeline(plainMeter,new Writable({write(_data,_encoding,done){done();}})).then(()=>undefined);
 const work=[ended,pipeline(input.stream,encryptedMeter,child.stdin!),pipeline(child.stdout!,plainMeter),consume];
 try{
  await Promise.all(work);
  if(cipherBytes!==input.cipherBytes || cipher.digest('hex')!==input.cipherSha256 || bytes!==input.bytes || plain.digest('hex')!==input.sha256)throw new Error('storage_age_hash_mismatch');
  return await consume;
 }catch(e){child.kill();input.stream.destroy();plainMeter.destroy();await Promise.allSettled(work);throw e;}
}
