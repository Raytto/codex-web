import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

/** One explicitly configured instance identity serves both cold objects and
 * recovery points. Validate it locally, without logging or uploading it. */
export function assertStorageIdentity(identity:string,recipient:string):void {
  const key=fs.lstatSync(identity),pub=fs.lstatSync(recipient);
  if(!key.isFile() || key.isSymbolicLink() || key.size>4096 || (key.mode&0o077)!==0
    || !pub.isFile() || pub.isSymbolicLink() || pub.size>4096)throw new Error('storage_key_permissions');
  const entries=fs.readFileSync(identity,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s && !s.startsWith('#'));
  const recipients=fs.readFileSync(recipient,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s && !s.startsWith('#'));
  if(entries.length!==1 || !/^AGE-SECRET-KEY-1[A-Z0-9]+$/.test(entries[0]!) || recipients.length!==1)throw new Error('storage_single_identity_required');
  let derived:string;
  try{derived=execFileSync('age-keygen',['-y',identity],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:10_000}).trim();}
  catch{throw new Error('storage_identity_invalid');}
  if(derived!==recipients[0])throw new Error('storage_key_recipient_mismatch');
}

export function isStorageIdentity(file:string,identity:string):boolean {
  if(file===identity)return true;
  const stat=fs.statSync(file),key=fs.statSync(identity);
  if(stat.dev===key.dev && stat.ino===key.ino)return true;
  // A copied key has a different inode. Do not accidentally archive a user
  // recovery-key export just because it was placed in an enrolled directory.
  if(!stat.isFile() || stat.size>4096 || key.size>4096)return false;
  const token=fs.readFileSync(identity,'utf8').match(/^AGE-SECRET-KEY-1[A-Z0-9]+$/m)?.[0];
  return Boolean(token && fs.readFileSync(file,'utf8').includes(token));
}
