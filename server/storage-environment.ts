import path from 'node:path';
import {storagePolicy} from './storage-lifecycle-policy.js';
import type {ReaderColdRoots} from './reader-cold-storage.js';

export function storageEnvironment(env:NodeJS.ProcessEnv=process.env):ReaderColdRoots{
 const policy=storagePolicy(env);
 const required=(key:string)=>{const value=env[key]?.trim();if(!value || !path.isAbsolute(value))throw new Error(`storage_path_configuration:${key}`);return path.resolve(value);};
 const lifecycle=required('STORAGE_LIFECYCLE_ROOT'),transfer=required('STORAGE_TRANSFER_ROOT');
 return {dataRoot:required('STORAGE_DATA_ROOT'),tenantRoot:required('STORAGE_TENANT_ROOT'),hostRootCodexHome:required('STORAGE_HOST_CODEX_HOME'),databasePath:required('STORAGE_DATABASE_PATH'),
  aliyunpan:required('STORAGE_ALIYUN_COMMAND'),age:env.STORAGE_AGE_COMMAND||'/usr/bin/age',relayDir:transfer,downloadDir:path.join(transfer,'legacy-downloads'),
  remoteRoot:env.STORAGE_LEGACY_CONVERSATION_REMOTE_ROOT||`${policy.remoteRoot}/legacy/conversations`,driveId:policy.driveId,ageRecipient:policy.recipient,ageIdentity:policy.identity,
  isolationRoot:env.STORAGE_LEGACY_CONVERSATION_ISOLATION||path.join(lifecycle,'legacy-isolated','conversations'),
  voiceIsolationRoot:env.STORAGE_LEGACY_VOICE_ISOLATION||path.join(lifecycle,'legacy-isolated','voice'),
  readerIsolationRoot:env.STORAGE_LEGACY_READER_ISOLATION||path.join(lifecycle,'legacy-isolated','reader'),
  readerRemoteRoot:env.STORAGE_LEGACY_READER_REMOTE_ROOT||`${policy.remoteRoot}/legacy/readers`,
  readerOwnerUid:env.STORAGE_READER_OWNER_UID===undefined?undefined:Number(env.STORAGE_READER_OWNER_UID),
  readerOwnerGid:env.STORAGE_READER_OWNER_GID===undefined?undefined:Number(env.STORAGE_READER_OWNER_GID),
 };
}
