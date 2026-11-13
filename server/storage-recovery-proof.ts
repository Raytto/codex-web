import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {StorageHost} from './storage-host.js';
import type {LegacyGeneration} from './storage-legacy-isolation.js';

const hash=(body:string|Buffer)=>crypto.createHash('sha256').update(body).digest('hex');
type Portable={versions:Array<{id:string;account:string;sha256:string;bytes:number;manifestSha256:string;manifestJson:string;chunkIds:string[]}>;
 legacy:Array<LegacyGeneration>;nativeUnits:Array<{id:string;user_id:string;manifest_sha256:string}>};
const verified=new WeakMap<StorageHost,Promise<Portable>>();
export function resetPortableRecoveryProof(host:StorageHost):void{verified.delete(host);}
function privateRead(file:string,max:number):Buffer{
 const st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.size>max)throw new Error('storage_recovery_catalog_file');
 return fs.readFileSync(file);
}
/** The publisher writes this proof only after uploading, downloading and
 * decrypting the immutable catalogue plus its descriptor. This is an object
 * recovery index, never a claim that the incomplete whole-site point passed. */
async function portable(host:StorageHost):Promise<Portable>{
 let promise=verified.get(host);if(promise)return promise;
 promise=(async()=>{
  try{
   const directory=path.join(host.roots.lifecycleRoot!,'portable-catalog');
   const state=JSON.parse(privateRead(path.join(directory,'state.json'),1024**2).toString());
   const body=privateRead(path.join(directory,'current.json'),64*1024**2);
   const proof=state.descriptorProof;
   if(!proof||proof.catalogSha256!==state.catalogSha256||hash(body)!==state.catalogSha256
     ||proof.remote!==state.latestDescriptor||!proof.remote.startsWith(host.policy.remoteRoot+'/recovery/')
     ||!Number.isSafeInteger(proof.bytes)||proof.bytes<1||proof.bytes>65536||!proof.fileId
     ||!Number.isFinite(Date.parse(state.lastPublishedAt)))throw new Error('storage_recovery_catalog_proof_pending');
   const catalog=JSON.parse(body.toString());
   if(catalog.format!=='pp-portable-catalog-v1'||catalog.completeSiteBackup!==false)throw new Error('storage_recovery_catalog_format');
   // Metadata-only presence check. Never download successful business objects again.
   await host.reader.assertPresent(proof.remote,proof.bytes,proof.fileId);
   return catalog as Portable;
  }catch(error){if(error instanceof Error&&error.message.startsWith('storage_'))throw error;throw new Error('storage_recovery_catalog_proof_pending');}
 })();verified.set(host,promise);return promise;
}
export async function verifyPortableVersion(host:StorageHost,userId:string,versionId:string):Promise<void>{
 const snapshot=await portable(host),version=host.catalog.version(userId,versionId);
 const entry=snapshot.versions.find(v=>v.id===versionId&&v.account===userId);
 if(!entry||entry.sha256!==version.sha256||entry.bytes!==version.logical_bytes
   ||entry.manifestSha256!==version.manifest_sha256||entry.manifestJson!==version.manifest_json
   ||hash(entry.manifestJson)!==entry.manifestSha256)throw new Error('storage_version_recovery_manifest_pending');
 const ids=host.db.prepare('SELECT chunk_id FROM storage_version_chunks WHERE version_id=? ORDER BY ordinal').all(versionId).map(r=>r.chunk_id);
 if(JSON.stringify(ids)!==JSON.stringify(entry.chunkIds))throw new Error('storage_recovery_catalog_chunks_changed');
}
export async function verifyPortableNative(host:StorageHost,id:string,userId:string,manifestSha256:string):Promise<void>{
 const snapshot=await portable(host);
 if(!snapshot.nativeUnits.some(u=>u.id===id&&u.user_id===userId&&u.manifest_sha256===manifestSha256))throw new Error('storage_native_recovery_manifest_pending');
}
export async function verifyPortableLegacy(host:StorageHost,row:LegacyGeneration):Promise<void>{
 const snapshot=await portable(host),entry=snapshot.legacy.find(v=>v.remote_drive===row.remote_drive&&v.remote_path===row.remote_path);
 if(!entry||entry.user_id!==row.user_id||entry.kind!==row.kind||entry.subject_id!==row.subject_id
   ||entry.generation!==row.generation||entry.archive_sha256!==row.archive_sha256||entry.archive_bytes!==row.archive_bytes)
  throw new Error('storage_legacy_recovery_manifest_pending');
 if(row.kind==='voice'){
  const a=JSON.parse(entry.manifest_json),b=JSON.parse(row.manifest_json);
  if(a.size!==b.size||a.sha256!==b.sha256||a.path!==b.path)throw new Error('storage_legacy_recovery_manifest_changed');
 }else if(hash(entry.manifest_json)!==row.manifest_sha256)throw new Error('storage_legacy_recovery_manifest_changed');
}
