import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const TABLES = ['thread_turns','thread_items','thread_history_projection_state','thread_realtime_items'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (s: string) => `"${s.replaceAll('"','""')}"`;
type Row = Record<string,SQLInputValue>;
type Schema = Array<{type:string;name:string;sql:string}>;
type NativeManifest = {
  format:'pp-native-history-v1'; userId:string; engineVersion:string; database:'thread_history_1.sqlite';
  threadIds:string[]; schemaSha256:string; migrationsSha256:string;
  tables:Record<string,{rows:number;sha256:string}>;
};
function schema(db: DatabaseSync): Schema {
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_pp_storage_%' ORDER BY type,name").all() as Schema;
  const tables = objects.filter(o=>o.type==='table').map(o=>o.name);
  if (!tables.includes('_sqlx_migrations') || tables.some(t=>t!=='_sqlx_migrations' && !TABLES.includes(t))) throw new Error('native_history_schema_unsupported');
  for (const table of tables.filter(t=>TABLES.includes(t))) {
    if (!(db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{name:string}>).some(c=>c.name==='thread_id')) throw new Error('native_history_thread_key_missing');
  }
  if (objects.some(o=>!['table','index'].includes(o.type))) throw new Error('native_history_schema_unsupported');
  return objects;
}
function orderedRows(db:DatabaseSync,table:string,threadIds?:string[]) {
  const columns = db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{name:string;pk:number}>;
  const order = columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>q(c.name)).join(',');
  if (!order) throw new Error('native_history_primary_key_missing');
  return db.prepare(`SELECT * FROM ${q(table)}${threadIds ? ` WHERE thread_id IN (${threadIds.map(()=>'?').join(',')})` : ''} ORDER BY ${order}`)
    .iterate(...(threadIds ?? [])) as IterableIterator<Row>;
}
const hashText = (text:string) => crypto.createHash('sha256').update(text).digest('hex');
function digestRows(db:DatabaseSync,table:string,ids?:string[]) {
  const hash=crypto.createHash('sha256'); let rows=0;
  for (const row of orderedRows(db,table,ids)) { hash.update(JSON.stringify(row)); hash.update('\n'); rows++; }
  return {rows,sha256:hash.digest('hex')};
}
function databasePath(home:string) {
  if (fs.realpathSync(home)!==path.resolve(home)) throw new Error('native_history_home_alias');
  const names=fs.readdirSync(home).filter(n=>/^thread_history_\d+\.sqlite$/.test(n));
  if (names.some(n=>n!=='thread_history_1.sqlite')) throw new Error('native_history_version_unsupported');
  const file=path.join(home,'thread_history_1.sqlite');
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).nlink!==1)) throw new Error('native_history_unsafe_database');
  return file;
}
function copyRows(source:DatabaseSync,target:DatabaseSync,table:string,ids?:string[]) {
  const columns=(source.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{name:string}>).map(c=>c.name);
  const insert=target.prepare(`INSERT INTO ${q(table)}(${columns.map(q).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
  for(const row of orderedRows(source,table,ids)) insert.run(...columns.map(c=>row[c]));
}

/** Caller holds the native Home lifecycle lock. The result is a consistent
 * per-thread SQLite unit, never a hard link or a copy of a live DB/WAL. */
export function snapshotNativeHistory(home:string,target:string,input:{userId:string;threadIds:string[];engineVersion:string}): NativeManifest | null {
  if (!input.threadIds.length || input.threadIds.some(id=>!UUID.test(id))) throw new Error('native_history_invalid_threads');
  const file=databasePath(home); if(!fs.existsSync(file)) return null;
  if(fs.existsSync(target)) throw new Error('native_history_snapshot_exists');
  const source=new DatabaseSync(file,{readOnly:true}); let output:DatabaseSync|undefined;
  try {
    source.exec('BEGIN'); const objects=schema(source); const ids=[...new Set(input.threadIds)].sort();
    const tables=Object.fromEntries(objects.filter(o=>o.type==='table' && TABLES.includes(o.name)).map(o=>[o.name,digestRows(source,o.name,ids)]));
    const manifest:NativeManifest={format:'pp-native-history-v1',userId:input.userId,engineVersion:input.engineVersion,
      database:'thread_history_1.sqlite',threadIds:ids,schemaSha256:hashText(JSON.stringify(objects)),migrationsSha256:digestRows(source,'_sqlx_migrations').sha256,tables};
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    const fd=fs.openSync(target,'wx',0o600); fs.closeSync(fd);
    output=new DatabaseSync(target); output.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
    for(const object of objects.filter(o=>o.type==='table')) output.exec(object.sql);
    copyRows(source,output,'_sqlx_migrations');
    for(const table of Object.keys(tables)) copyRows(source,output,table,ids);
    for(const object of objects.filter(o=>o.type==='index')) output.exec(object.sql);
    output.exec('CREATE TABLE _pp_storage_native_manifest(json TEXT NOT NULL)');
    output.prepare('INSERT INTO _pp_storage_native_manifest VALUES(?)').run(JSON.stringify(manifest));
    output.exec('COMMIT');
    if ((output.prepare('PRAGMA quick_check').get() as {quick_check:string}).quick_check!=='ok') throw new Error('native_history_snapshot_integrity');
    output.close(); output=undefined;
    const sync=fs.openSync(target,'r'); try{fs.fsyncSync(sync);}finally{fs.closeSync(sync);}
    return manifest;
  } catch(e) { output?.close(); output=undefined; try{fs.unlinkSync(target);}catch{} throw e; }
  finally { output?.close(); source.close(); }
}

/** The caller verifies this snapshot against its authenticated cloud manifest
 * and holds the Home lock. All row changes and source comparison are one TX. */
export function applyNativeHistory(home:string,snapshot:string,userId:string,operation:'restore'|'remove'): void {
  const file=databasePath(home);
  // Recreating an unknown engine database would skip its own migration setup.
  if(!fs.existsSync(file)) throw new Error('native_history_engine_initialization_required');
  const archived=new DatabaseSync(snapshot,{readOnly:true}); let live:DatabaseSync|undefined;
  try {
    const m=JSON.parse((archived.prepare('SELECT json FROM _pp_storage_native_manifest').get() as {json:string}).json) as NativeManifest;
    if(m.format!=='pp-native-history-v1' || m.userId!==userId || m.database!=='thread_history_1.sqlite'
      || !m.threadIds.length || m.threadIds.some(id=>!UUID.test(id))) throw new Error('native_history_identity_mismatch');
    if(hashText(JSON.stringify(schema(archived)))!==m.schemaSha256 || digestRows(archived,'_sqlx_migrations').sha256!==m.migrationsSha256) throw new Error('native_history_snapshot_schema_changed');
    for(const [table,digest] of Object.entries(m.tables)) {
      if(!TABLES.includes(table) || JSON.stringify(digestRows(archived,table,m.threadIds))!==JSON.stringify(digest)) throw new Error('native_history_snapshot_rows_changed');
    }
    live=new DatabaseSync(file); live.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
    if(hashText(JSON.stringify(schema(live)))!==m.schemaSha256 || digestRows(live,'_sqlx_migrations').sha256!==m.migrationsSha256) throw new Error('native_history_engine_schema_incompatible');
    // Compare all tables before any change. A changed/new turn cannot be lost.
    const skip=new Set<string>();
    for(const [table,digest] of Object.entries(m.tables)) {
      const actual=digestRows(live,table,m.threadIds);
      if(JSON.stringify(actual)===JSON.stringify(digest)) { if(operation==='restore') skip.add(table); continue; }
      if(operation==='restore' && actual.rows===0) continue;
      if(operation==='remove' && actual.rows===0) { skip.add(table); continue; }
      throw new Error('native_history_rows_conflict');
    }
    for(const table of Object.keys(m.tables).filter(t=>!skip.has(t))) {
      if(operation==='remove') live.prepare(`DELETE FROM ${q(table)} WHERE thread_id IN (${m.threadIds.map(()=>'?').join(',')})`).run(...m.threadIds);
      else copyRows(archived,live,table,m.threadIds);
    }
    live.exec('COMMIT');
  } catch(e) { try{live?.exec('ROLLBACK');}catch{} throw e; }
  finally { live?.close(); archived.close(); }
}
