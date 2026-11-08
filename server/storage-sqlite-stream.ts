import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {Readable} from 'node:stream';
import readline from 'node:readline';

type Definition={type:string;name:string;tbl_name:string;sql:string};
type SqliteHeader={format:'pp-sqlite-stream-v1';objects:Definition[];userVersion:number;applicationId:number;sequences:Array<{name:string;seq:bigint}>};
const q=(s:string)=>`"${s.replaceAll('"','""')}"`;
const encode=(value:unknown)=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?{$integer:v.toString()}:v instanceof Uint8Array?{$blob:Buffer.from(v).toString('base64')}:v)+'\n';
const decode=(value:string)=>JSON.parse(value,(_key,v)=>v && typeof v==='object' && Object.keys(v).length===1
  ?typeof v.$integer==='string'?BigInt(v.$integer):typeof v.$blob==='string'?Buffer.from(v.$blob,'base64'):v:v);

/** Virtual tables may contain unique state in module-owned shadow tables.
 * Preserve those bytes through SQLite's backup API rather than replaying
 * their rows as ordinary tables. This fallback is limited to one chunk;
 * large ordinary databases continue to use the bounded logical stream. */
export class SqliteBinarySnapshot {
  readonly target:string;private readonly directory:string;
  constructor(readonly file:string,scratch:string,maxBytes:number){
    if(!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>512*1024**2)throw new Error('storage_sqlite_binary_budget');
    const stat=fs.lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1)throw new Error('storage_sqlite_source_invalid');
    this.directory=fs.mkdtempSync(path.join(scratch,'sqlite-snapshot-'));fs.chmodSync(this.directory,0o700);
    this.target=path.join(this.directory,'database.sqlite');
    try{
      execFileSync('python3',['-c',String.raw`
import os,sys,sqlite3,time,pathlib
source=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True,timeout=5)
target=None; limit=int(sys.argv[3]); started=time.monotonic()
try:
 source.execute('BEGIN'); source.execute('SELECT count(*) FROM sqlite_master').fetchone()
 page_size=source.execute('PRAGMA page_size').fetchone()[0]
 if source.execute('PRAGMA page_count').fetchone()[0]*page_size>limit: raise ValueError('budget')
 fd=os.open(sys.argv[2],os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
 target=sqlite3.connect(sys.argv[2],timeout=5)
 def progress(status,remaining,total):
  if total*page_size>limit or time.monotonic()-started>55: raise ValueError('budget')
 source.backup(target,pages=256,progress=progress,sleep=0.01)
 target.execute('PRAGMA journal_mode=DELETE')
 if target.execute('PRAGMA quick_check').fetchall()!=[('ok',)] or target.execute('PRAGMA foreign_key_check').fetchone(): raise ValueError('integrity')
 target.close();target=None
 if os.stat(sys.argv[2]).st_size>limit: raise ValueError('budget')
 with open(sys.argv[2],'rb') as output: os.fsync(output.fileno())
except Exception as error:
 reason=str(error) if type(error) is ValueError and str(error) in ('budget','integrity') else type(error).__name__
 print(reason,file=sys.stderr);sys.exit(1)
finally:
 if target is not None: target.close()
 source.close()
`,file,this.target,String(maxBytes)],{stdio:['ignore','ignore','pipe'],timeout:60_000});
      verifySqliteBinary(this.target);
    }catch(error){
      // This directory is a never-published, uniquely owned backup candidate,
      // not a source database or its live WAL/SHM.
      const diagnostic=String((error as {stderr?:Buffer}).stderr??'').trim();
      this.close();throw new Error('storage_sqlite_binary_snapshot_failed'+(/^[a-zA-Z_]{1,80}$/.test(diagnostic)?':'+diagnostic:''));
    }
  }
  close():void{fs.rmSync(this.directory,{recursive:true,force:true});}
}

export function verifySqliteBinary(file:string):void{
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok' || db.prepare('PRAGMA foreign_key_check').get())throw new Error('storage_sqlite_binary_integrity');
  }finally{db.close();}
}

export function createDatabaseSnapshot(file:string,scratch:string,maxBytes:number):SqliteStreamSnapshot|SqliteBinarySnapshot{
  try{return new SqliteStreamSnapshot(file);}
  catch(error){
    if(!(error instanceof Error) || error.message!=='storage_sqlite_schema_unsupported')throw error;
    return new SqliteBinarySnapshot(file,scratch,maxBytes);
  }
}

/** Holds one SQLite read transaction. WAL writers may continue, but a caller
 * must cap duration and check available disk between network chunks. No live
 * DB/WAL file is copied, linked, truncated or put on a cloud mount. */
export class SqliteStreamSnapshot{
  readonly db:DatabaseSync;readonly header:SqliteHeader;
  private readonly startedAt=Date.now();private readonly initialWalBytes:number;
  constructor(readonly file:string,readonly limits={maxMs:2*3600_000,maxWalGrowthBytes:1024**3}){
    this.initialWalBytes=fs.existsSync(file+'-wal')?fs.statSync(file+'-wal').size:0;
    const stat=fs.lstatSync(file);if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1)throw new Error('storage_sqlite_source_invalid');
    this.db=new DatabaseSync(file,{readOnly:true});
    try{
      this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
      const objects=this.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Definition[];
      if(objects.some(o=>!['table','index','view','trigger'].includes(o.type) || /CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql)))throw new Error('storage_sqlite_schema_unsupported');
      const sequences=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()?this.db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name'):null;
      sequences?.setReadBigInts(true);
      this.header={format:'pp-sqlite-stream-v1',objects,userVersion:Number(this.db.prepare('PRAGMA user_version').get()!.user_version),
        applicationId:Number(this.db.prepare('PRAGMA application_id').get()!.application_id),sequences:sequences?.all() as SqliteHeader['sequences']??[]};
    }catch(e){this.db.close();throw e;}
  }
  private checkBudget():void{
    const wal=fs.existsSync(this.file+'-wal')?fs.statSync(this.file+'-wal').size:0;
    if(Date.now()-this.startedAt>this.limits.maxMs || wal-this.initialWalBytes>this.limits.maxWalGrowthBytes)throw new Error('storage_sqlite_snapshot_budget');
  }
  *lines():Generator<string>{
    this.checkBudget();
    yield encode(this.header);
    let rows=0;
    for(const table of this.header.objects.filter(o=>o.type==='table')){
      const columns=this.db.prepare(`PRAGMA table_xinfo(${q(table.name)})`).all() as Array<{name:string;hidden:number;pk:number;type:string}>;
      if(columns.some(c=>c.name==='__pp_rowid'))throw new Error('storage_sqlite_reserved_column');
      const normal=columns.filter(c=>c.hidden===0),primary=normal.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk);
      const hasRowId=!/WITHOUT\s+ROWID/i.test(table.sql),explicitRowId=primary.length===1 && primary[0].type.toUpperCase()==='INTEGER';
      const keepRowId=hasRowId&&!explicitRowId;
      const order=hasRowId?'rowid':primary.map(c=>q(c.name)).join(',');
      if(!order)throw new Error('storage_sqlite_order_unknown');
      const statement=this.db.prepare(`SELECT ${keepRowId?'rowid AS __pp_rowid,':''}${normal.map(c=>q(c.name)).join(',')} FROM ${q(table.name)} ORDER BY ${order}`);
      statement.setReadBigInts(true);
      yield encode({table:table.name,columns:[...(keepRowId?['rowid']:[]),...normal.map(c=>c.name)]});
      for(const row of statement.iterate()){if(rows%1024===0)this.checkBudget();yield encode({values:Object.values(row)});rows++;}
    }
    yield encode({end:true,rows});
  }
  measure():{sha256:string;bytes:number}{const sum=crypto.createHash('sha256');let bytes=0;for(const line of this.lines()){sum.update(line);bytes+=Buffer.byteLength(line);}return {sha256:sum.digest('hex'),bytes};}
  stream():Readable{return Readable.from(this.lines());}
  close():void{this.db.close();}
}

/** The destination must be new and private. It is only published by the
 * caller after this entire stream, quick_check and foreign keys pass. */
export async function restoreSqliteStream(stream:Readable,target:string):Promise<{sha256:string;bytes:number;rows:number}>{
  const fd=fs.openSync(target,'wx',0o600);fs.closeSync(fd);let db:DatabaseSync|undefined,finished=false;
  const input=readline.createInterface({input:stream,crlfDelay:Infinity});
  const sum=crypto.createHash('sha256');let bytes=0,rows=0,ended=false,header:SqliteHeader|undefined,insert:ReturnType<DatabaseSync['prepare']>|undefined;
  try{
    db=new DatabaseSync(target);db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    for await(const line of input){
      if(ended)throw new Error('storage_sqlite_after_footer');
      sum.update(line+'\n');bytes+=Buffer.byteLength(line)+1;
      if(Buffer.byteLength(line)>512*1024**2)throw new Error('storage_sqlite_row_budget');
      const record=decode(line);
      if(!header){
        header=record as SqliteHeader;
        if(header.format!=='pp-sqlite-stream-v1' || !Array.isArray(header.objects) || header.objects.some(o=>!['table','index','view','trigger'].includes(o.type)
          || /CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql)) || !Number.isSafeInteger(header.userVersion) || !Number.isSafeInteger(header.applicationId))throw new Error('storage_sqlite_stream_header');
        for(const table of header.objects.filter(o=>o.type==='table'))db.exec(table.sql);
      }else if(record.end===true){if(record.rows!==rows)throw new Error('storage_sqlite_row_count');ended=true;
      }else if(typeof record.table==='string'){
        if(!header.objects.some(o=>o.type==='table' && o.name===record.table) || !Array.isArray(record.columns) || record.columns.some((c:unknown)=>typeof c!=='string'))throw new Error('storage_sqlite_stream_table');
        insert=db.prepare(`INSERT INTO ${q(record.table)}(${record.columns.map(q).join(',')}) VALUES(${record.columns.map(()=>'?').join(',')})`);
      }else if(Array.isArray(record.values) && insert){insert.run(...record.values as SQLInputValue[]);rows++;}
      else throw new Error('storage_sqlite_stream_row');
    }
    if(!header || !ended)throw new Error('storage_sqlite_stream_incomplete');
    for(const object of header.objects.filter(o=>o.type!=='table'))db.exec(object.sql);
    if(header.sequences.length){db.exec('DELETE FROM sqlite_sequence');const add=db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)');for(const row of header.sequences)add.run(row.name,row.seq);}
    db.exec(`PRAGMA user_version=${header.userVersion};PRAGMA application_id=${header.applicationId};COMMIT`);
    if(db.prepare('PRAGMA quick_check').get()!.quick_check!=='ok' || db.prepare('PRAGMA foreign_key_check').get())throw new Error('storage_sqlite_restored_integrity');
    db.close();db=undefined;const sync=fs.openSync(target,'r');try{fs.fsyncSync(sync);}finally{fs.closeSync(sync);}
    finished=true;return {sha256:sum.digest('hex'),bytes,rows};
  }finally{
    input.close();stream.destroy();try{db?.close();}catch{}
    // Only this newly created destination may be removed; never live WAL/SHM.
    if(!finished){try{fs.unlinkSync(target);}catch{}try{fs.unlinkSync(target+'-journal');}catch{}}
  }
}
