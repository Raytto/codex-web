import type {DatabaseSync,SQLInputValue,SQLOutputValue} from 'node:sqlite';

/** Materialize one metadata page before yielding to code that writes. Keeping
 * a SQLite iterator open across those writes makes a concurrent observer's
 * commit turn the reader into SQLITE_BUSY_SNAPSHOT, ignoring busy_timeout.
 * Callers select a unique source rowid as _storage_rowid; new rows wait for
 * the next pass. Payload streams use their own consistent snapshot instead. */
export function* storageMetadataRows(db:DatabaseSync,sql:string,args:SQLInputValue[]=[]):Generator<Record<string,SQLOutputValue>>{
  const end=db.prepare(`SELECT MAX(_storage_rowid) AS last FROM (${sql})`).get(...args)?.last;
  if(end===null || end===undefined)return;
  if(typeof end!=='number' || !Number.isSafeInteger(end))throw new Error('storage_scan_rowid_invalid');
  const statement=db.prepare(`SELECT * FROM (${sql}) WHERE _storage_rowid>? AND _storage_rowid<=? ORDER BY _storage_rowid LIMIT 128`);
  let after=0;
  while(after<end){
    const page=statement.all(...args,after,end);if(!page.length)return;
    const next=page.at(-1)!._storage_rowid;
    if(typeof next!=='number' || !Number.isSafeInteger(next) || next<=after)throw new Error('storage_scan_cursor_invalid');
    after=next;
    yield* page;
  }
}
