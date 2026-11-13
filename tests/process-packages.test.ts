import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('process packages retain real dependency assets and reject missing or changed members',t=>{
 const generated=spawnSync(process.execPath,['scripts/process-manifests.mjs'],{encoding:'utf8'});
 assert.equal(generated.status,0,generated.stderr);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'process-package-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const profile of ['host','observer']){
  const target=path.join(root,profile);
  const built=spawnSync('python3',['deploy/prepare-process-package.py','--source',process.cwd(),'--target',target,'--manifest',`process-manifests/${profile}.json`],{encoding:'utf8'});
  assert.equal(built.status,0,built.stderr);
  const help=spawnSync(process.execPath,[path.join(target,'dist-server/server/storage-maintenance-cli.js'),'--help'],{encoding:'utf8',cwd:target});
  assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/inventory/);
  if(profile==='host'){
   const loaded=spawnSync(process.execPath,['--input-type=module','-e',"await import('./dist-server/remote-worker/src/node-transfer-endpoint.js'); await import('./dist-server/server/codex-account-manager.js');"],{encoding:'utf8',cwd:target});
   assert.equal(loaded.status,0,loaded.stderr);
  }
  const check=()=>spawnSync('python3',['deploy/prepare-process-package.py','--source',target,'--check','--manifest',path.join(target,'process-manifest.json')],{encoding:'utf8'});
  assert.equal(check().status,0);
  const entry=path.join(target,'dist-server/server/storage-maintenance-cli.js');
  fs.appendFileSync(entry,'\n// unexpected change');assert.notEqual(check().status,0);
  fs.unlinkSync(entry);assert.notEqual(check().status,0);
 }
});
