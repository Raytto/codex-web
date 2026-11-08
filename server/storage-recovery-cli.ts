#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {storagePolicy} from './storage-lifecycle-policy.js';
import {assertStorageIdentity} from './storage-key.js';
import {migrateStorageLifecycle} from './storage-lifecycle-schema.js';
import {StorageCatalog} from './storage-catalog.js';
import {StorageChunkStore} from './storage-chunks.js';
import {AliyunStorageReader} from './storage-aliyun-reader.js';
import {recoverStorageSite,recordRecoveryDrill} from './storage-recovery.js';
import {pipeline} from 'node:stream/promises';
import type {BackupDescriptor} from './storage-backups.js';
import {runStorageProcess} from './storage-process.js';

async function main(){
 const args=process.argv.slice(2),options=new Map<string,string>();
 if(!args.length || args.includes('--help')){
  process.stdout.write('storage-recovery-cli --descriptor /cloud/root/recovery/point.json --destination /empty/private/directory --scratch /private/scratch [--record-drill-db /explicit/database.sqlite]\nRequires explicit STORAGE_INSTANCE_ID, STORAGE_REMOTE_ROOT, STORAGE_DRIVE_ID, STORAGE_AGE_IDENTITY, STORAGE_AGE_RECIPIENT, STORAGE_ALIYUN_CONFIG. No original installation is needed. Never supply key contents as arguments.\n');return;
 }
 for(let i=0;i<args.length;i+=2){if(!['--descriptor','--destination','--scratch','--record-drill-db'].includes(args[i]) || !args[i+1] || options.has(args[i]))throw new Error('storage_recovery_arguments');options.set(args[i],args[i+1]);}
 const required=(key:string)=>{const value=options.get(key);if(!value)throw new Error('storage_recovery_arguments');return value;};
 process.env.PPAGENT_STORAGE_MAINTENANCE='1';
 const policy=storagePolicy({...process.env,STORAGE_LIFECYCLE_ENABLED:'1'}),descriptorPath=required('--descriptor'),destination=required('--destination'),scratch=required('--scratch');
 if(!path.isAbsolute(scratch) || !descriptorPath.startsWith(policy.remoteRoot+'/recovery/'))throw new Error('storage_recovery_scope');
 assertStorageIdentity(policy.identity,policy.recipient);
 const configFile=process.env.STORAGE_ALIYUN_CONFIG;if(!configFile || !path.isAbsolute(configFile))throw new Error('storage_cloud_configuration');
 const reader=new AliyunStorageReader({configFile,driveId:policy.driveId,allowedRoots:[policy.remoteRoot,...(process.env.STORAGE_LEGACY_REMOTE_ROOTS??'').split(',').filter(Boolean)],
  refresh:async()=>{const command=process.env.STORAGE_ALIYUN_COMMAND;if(!command || !path.isAbsolute(command))throw new Error('storage_recovery_auth_refresh_required');
   try{execFileSync(command,['ls','--driveId',policy.driveId,policy.remoteRoot],{stdio:'ignore',timeout:60_000});}catch{throw new Error('storage_recovery_auth_refresh_failed');}}});
 const raw:Buffer[]=[];let bytes=0;
 for await(const value of await reader.stream(descriptorPath)){const b=value as Buffer;bytes+=b.length;if(bytes>1024*1024)throw new Error('storage_recovery_descriptor_budget');raw.push(b);}
 const descriptor=JSON.parse(Buffer.concat(raw).toString('utf8')) as BackupDescriptor;
 const db=new DatabaseSync(':memory:');migrateStorageLifecycle(db);
 try{
  const chunks=new StorageChunkStore(new StorageCatalog(db),policy,scratch,{put:async()=>{throw new Error('storage_recovery_is_read_only');},
   get:async(remote,file,known)=>{await pipeline(await reader.stream(remote,known?.bytes,known?.fileId),fs.createWriteStream(file,{flags:'wx',mode:0o600}));}});
  const journal=await recoverStorageSite({chunks,descriptor,destination,legacyStream:async(remote,size,drive)=>{if(drive!==policy.driveId)throw new Error('storage_recovery_legacy_drive');return reader.stream(remote,size);},
   onProgress:event=>process.stdout.write(JSON.stringify(event)+'\n')});
  if(options.has('--record-drill-db')){
   const file=options.get('--record-drill-db')!;if(!path.isAbsolute(file) || !fs.existsSync(file))throw new Error('storage_recovery_proof_database');
   const production=new DatabaseSync(file);try{production.exec('PRAGMA busy_timeout=10000');recordRecoveryDrill(production,descriptor,journal);}finally{production.close();}
  }
  process.stdout.write(JSON.stringify({complete:journal.complete,pointId:journal.pointId,materials:Object.keys(journal.materials).length,legacy:Object.keys(journal.legacy).length,preexistingUnavailableOriginals:journal.unavailableOriginals?.length??0})+'\n');
 }finally{db.close();}
}
void runStorageProcess(main).catch(error=>{process.stderr.write(JSON.stringify({ok:false,error:error instanceof Error?error.message:'storage_recovery_failed'})+'\n');process.exitCode=1;});
