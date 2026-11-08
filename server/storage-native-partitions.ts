import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';

const TABLES=['thread_turns','thread_items','thread_history_projection_state','thread_realtime_items'];
const q=(s:string)=>`"${s.replaceAll('"','""')}"`;
type Row=Record<string,SQLInputValue>;
type ObjectDefinition={type:string;name:string;sql:string};
export type NativeHistoryDefinition={format:'pp-native-history-parts-v1';userId:string;threadIds:string[];engineVersion:string;
  schema:ObjectDefinition[];schemaSha256:string;migrationsSha256:string;tables:string[]};
export type NativeHistoryDigest={rows:number;sha256:string};
export type NativeHistoryPage={table:string;rows:number;bytes:number;sha256:string;cursor:SQLInputValue[]|null;done:boolean};
const hash=(text:string)=>crypto.createHash('sha256').update(text).digest('hex');
function encode(row:Row):string{return JSON.stringify(Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Uint8Array?{$blob:Buffer.from(v).toString('base64')}:v])))+'\n';}
function decode(text:string):Row{return JSON.parse(text,(_key,v)=>v && typeof v==='object' && Object.keys(v).length===1 && typeof v.$blob==='string'?Buffer.from(v.$blob,'base64'):v) as Row;}
function open(home:string,write=false):DatabaseSync{
  if(fs.realpathSync(home)!==path.resolve(home))throw new Error('native_history_home_alias');
  if(fs.readdirSync(home).some(n=>/^thread_history_\d+\.sqlite$/.test(n) && n!=='thread_history_1.sqlite'))throw new Error('native_history_version_unsupported');
  const file=path.join(home,'thread_history_1.sqlite'),stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1)throw new Error('native_history_unsafe_database');
  const db=new DatabaseSync(file,{readOnly:!write});db.exec('PRAGMA busy_timeout=10000;');return db;
}
function objects(db:DatabaseSync):ObjectDefinition[]{
  const result=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as ObjectDefinition[];
  // Codex 0.167.0 deletes only the same thread's realtime projection when its
  // projection cursor is removed. Keep this exact trigger in the schema proof;
  // arbitrary triggers can mutate another thread and must still fail closed.
  const safeTrigger=(r:ObjectDefinition)=>r.name==='thread_realtime_items_projection_cleanup'
    && r.sql.replace(/\s+/g,' ').trim().replace(/;$/,'').toLowerCase()===
      'create trigger thread_realtime_items_projection_cleanup after delete on thread_history_projection_state begin delete from thread_realtime_items where thread_id = old.thread_id; end';
  if(result.some(r=>!['table','index'].includes(r.type) && !(r.type==='trigger' && safeTrigger(r))
      || r.type==='table' && ![...TABLES,'_sqlx_migrations'].includes(r.name))
    || !result.some(r=>r.name==='_sqlx_migrations'))throw new Error('native_history_schema_unsupported');
  return result;
}
function keys(db:DatabaseSync,table:string):string[]{
  const cols=db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{name:string;pk:number}>;
  if(table!=='_sqlx_migrations' && !cols.some(c=>c.name==='thread_id'))throw new Error('native_history_thread_key_missing');
  const pk=cols.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
  if(!pk.length)throw new Error('native_history_primary_key_missing');return pk;
}
function selected(db:DatabaseSync,table:string,ids?:string[],cursor:SQLInputValue[]|null=null){
  const pk=keys(db,table),where:string[]=[],args:SQLInputValue[]=[];
  if(ids){where.push(`thread_id IN (${ids.map(()=>'?').join(',')})`);args.push(...ids);}
  if(cursor){if(cursor.length!==pk.length || cursor.some(v=>v===null))throw new Error('native_history_cursor_invalid');
    where.push(pk.length===1?`${q(pk[0])}>?`:`(${pk.map(q).join(',')})>(${pk.map(()=>'?').join(',')})`);args.push(...cursor);}
  return db.prepare(`SELECT * FROM ${q(table)}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY ${pk.map(q).join(',')}`).iterate(...args) as IterableIterator<Row>;
}
function digest(db:DatabaseSync,table:string,ids?:string[]):NativeHistoryDigest{
  const sum=crypto.createHash('sha256');let rows=0;for(const row of selected(db,table,ids)){sum.update(encode(row));rows++;}return {rows,sha256:sum.digest('hex')};
}
function check(db:DatabaseSync,m:NativeHistoryDefinition):void{
  if(m.format!=='pp-native-history-parts-v1' || !m.threadIds.length || m.threadIds.some(id=>!/^[a-f0-9-]{36}$/i.test(id))
    || hash(JSON.stringify(m.schema))!==m.schemaSha256 || hash(JSON.stringify(objects(db)))!==m.schemaSha256
    || digest(db,'_sqlx_migrations').sha256!==m.migrationsSha256 || m.tables.some(t=>!TABLES.includes(t)))throw new Error('native_history_engine_schema_incompatible');
}
/** Metadata only; no large rows or database clone are retained locally. */
export function nativeHistoryDefinition(home:string,input:{userId:string;threadIds:string[];engineVersion:string}):NativeHistoryDefinition|null{
  if(!fs.existsSync(path.join(home,'thread_history_1.sqlite')))return null;
  const db=open(home);try{
    db.exec('BEGIN');const schema=objects(db),m:NativeHistoryDefinition={...input,threadIds:[...new Set(input.threadIds)].sort(),format:'pp-native-history-parts-v1',
      schema,schemaSha256:hash(JSON.stringify(schema)),migrationsSha256:digest(db,'_sqlx_migrations').sha256,
      tables:TABLES.filter(t=>schema.some(s=>s.type==='table' && s.name===t))};
    check(db,m);return m;
  }finally{db.close();}
}
/** Caller briefly holds the Home lock for each bounded page. It releases the
 * lock before uploading. Final row hashes must still match before deletion. */
export function snapshotNativeHistoryPage(home:string,m:NativeHistoryDefinition,table:string,cursor:SQLInputValue[]|null,target:string,maxBytes=256*1024**2):NativeHistoryPage{
  if(!m.tables.includes(table) || maxBytes<1024 || maxBytes>512*1024**2)throw new Error('native_history_page_invalid');
  const db=open(home);let fd:number|undefined,complete=false;
  try{
    db.exec('BEGIN');check(db,m);const pk=keys(db,table);fd=fs.openSync(target,'wx',0o600);
    let rows=0,bytes=0,last=cursor,done=true;const sum=crypto.createHash('sha256');
    for(const row of selected(db,table,m.threadIds,cursor)){
      const text=encode(row),length=Buffer.byteLength(text);
      if(length>maxBytes)throw new Error('native_history_single_row_exceeds_budget');
      if(bytes+length>maxBytes){done=false;break;}
      fs.writeSync(fd,text);sum.update(text);bytes+=length;rows++;last=pk.map(k=>row[k]);
    }
    fs.fsyncSync(fd);complete=true;return {table,rows,bytes,sha256:sum.digest('hex'),cursor:last,done};
  }finally{if(fd!==undefined)fs.closeSync(fd);db.close();if(!complete)try{fs.unlinkSync(target);}catch{}}
}
export function nativeHistoryDigests(home:string,m:NativeHistoryDefinition):Record<string,NativeHistoryDigest>{
  const db=open(home);try{db.exec('BEGIN');check(db,m);return Object.fromEntries(m.tables.map(t=>[t,digest(db,t,m.threadIds)]));}finally{db.close();}
}
export function removeNativeHistoryParts(home:string,m:NativeHistoryDefinition,expected:Record<string,NativeHistoryDigest>):void{
  const db=open(home,true);try{
    db.exec('BEGIN IMMEDIATE');check(db,m);
    for(const table of m.tables){const actual=digest(db,table,m.threadIds);if(actual.rows && JSON.stringify(actual)!==JSON.stringify(expected[table]))throw new Error('native_history_rows_conflict');}
    for(const table of [...m.tables].reverse())db.prepare(`DELETE FROM ${q(table)} WHERE thread_id IN (${m.threadIds.map(()=>'?').join(',')})`).run(...m.threadIds);
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
}
/** Apply one verified page. A crash is resumable; conflicting existing rows
 * abort the page. The rollout and index are published only after all pages. */
export async function restoreNativeHistoryPage(home:string,m:NativeHistoryDefinition,page:Pick<NativeHistoryPage,'table'|'rows'|'bytes'|'sha256'>,file:string):Promise<void>{
  if(!m.tables.includes(page.table) || fs.statSync(file).size!==page.bytes)throw new Error('native_history_page_invalid');
  const db=open(home,true);let rows=0;const sum=crypto.createHash('sha256');
  try{
    db.exec('BEGIN IMMEDIATE');check(db,m);const pk=keys(db,page.table);
    const cols=(db.prepare(`PRAGMA table_info(${q(page.table)})`).all() as Array<{name:string}>).map(c=>c.name);
    const get=db.prepare(`SELECT * FROM ${q(page.table)} WHERE ${pk.map(k=>`${q(k)} IS ?`).join(' AND ')}`);
    const insert=db.prepare(`INSERT INTO ${q(page.table)}(${cols.map(q).join(',')}) VALUES(${cols.map(()=>'?').join(',')})`);
    const input=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
    try{for await(const text of input){
      const row=decode(text);if(!m.threadIds.includes(String(row.thread_id)) || Object.keys(row).join(',')!==cols.join(','))throw new Error('native_history_page_identity');
      sum.update(text+'\n');rows++;const old=get.get(...pk.map(k=>row[k])) as Row|undefined;
      if(old && encode(old)!==encode(row))throw new Error('native_history_rows_conflict');
      if(!old)insert.run(...cols.map(k=>row[k]));
    }}finally{input.close();}
    if(rows!==page.rows || sum.digest('hex')!==page.sha256)throw new Error('native_history_page_checksum');
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
}
