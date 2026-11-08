import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
const exec=promisify(execFile);
test('a maintenance CLI waits for unreferenced network completion and reports errors instead of silent success',async()=>{
 const module=new URL('../server/storage-process.ts',import.meta.url).href;
 const prefix=`import {runStorageProcess} from ${JSON.stringify(module)};`;
 const success=await exec(process.execPath,['--import','tsx','--input-type=module','-e',prefix+`void runStorageProcess(async()=>{try{await new Promise(r=>setTimeout(r,50).unref());process.stdout.write('receipt');}finally{process.stdout.write(':cleaned');}});`],{timeout:10000});
 assert.equal(success.stdout,'receipt:cleaned');
 await assert.rejects(exec(process.execPath,['--import','tsx','--input-type=module','-e',prefix+`void runStorageProcess(async()=>{try{await new Promise((_,r)=>setTimeout(()=>r(new Error('network_failed')),50).unref());}finally{process.stdout.write('cleaned');}}).catch(()=>{process.stderr.write('failed');process.exitCode=1;});`],{timeout:10000}),e=>{
  const failure=e as Error&{code:number;stdout:string;stderr:string};assert.equal(failure.code,1);assert.equal(failure.stdout,'cleaned');assert.equal(failure.stderr,'failed');return true;
 });
});
