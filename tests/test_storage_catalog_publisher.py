import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('recover',ROOT/'deploy/storage-recover-file.py')
recover=importlib.util.module_from_spec(spec);spec.loader.exec_module(recover)


class Publisher(unittest.TestCase):
 def test_initial_delta_unchanged_and_interrupted_publish(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);code=root/'code';tools=root/'tools';modules=code/'dist-server/server'
   modules.mkdir(parents=True);tools.mkdir();(code/'package.json').write_text('{"type":"module"}')
   for name in ['storage-publish-recovery-catalog.mjs','storage-recover-file.py','STORAGE_CLOUD_RECOVERY.md']:
    shutil.copyfile(ROOT/'deploy'/name,tools/name)
   (tools/'storage-recovery-catalog.py').write_text('import sys,shutil\nshutil.copyfile(sys.argv[2],sys.argv[4])\n')
   (modules/'storage-environment.js').write_text('export const storageEnvironment=()=>({});')
   (modules/'storage-maintenance.js').write_text('export const maintenanceLock=()=>()=>{};')
   (modules/'storage-process.js').write_text('export const runStorageProcess=f=>f();')
   (modules/'storage-host.js').write_text('''import fs from 'node:fs';import path from 'node:path';
const root=process.env.TEST_ROOT;
export class StorageHost{
 constructor(){this.roots={lifecycleRoot:path.join(root,'state')};this.policy={remoteRoot:'/instance',recipient:path.join(root,'recipient'),identity:path.join(root,'key')};
 this.db={prepare:()=>({get:()=>undefined})};this.reader={fileId:()=>"fixture-file-id",
 putImmutable:async(source,remote)=>{let target=path.join(root,'cloud',remote);fs.mkdirSync(path.dirname(target),{recursive:true});
 if(fs.existsSync(target)&&!fs.readFileSync(target).equals(fs.readFileSync(source)))throw Error('immutable mismatch');
 fs.copyFileSync(source,target);fs.appendFileSync(path.join(root,'calls'),'put\\n');},
 stream:async(remote)=>{fs.appendFileSync(path.join(root,'calls'),'get\\n');
 if(fs.existsSync(path.join(root,'fail'))&&remote.endsWith('-receipt.json')){fs.unlinkSync(path.join(root,'fail'));throw Error('injected metadata read failure');}
 return fs.createReadStream(path.join(root,'cloud',remote));}};}close(){}
}''')
   subprocess.run(['age-keygen','-o',str(root/'key')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   (root/'recipient').write_bytes(subprocess.check_output(['age-keygen','-y',str(root/'key')]))
   catalog=dict(format='pp-portable-catalog-v1',completeSiteBackup=False,versions=[],chunks=[],legacy=[],nativeUnits=[],backupPoints=[],limits=[])
   source=root/'source.json'
   env={**os.environ,'TEST_ROOT':str(root),'STORAGE_DATABASE_PATH':str(source)}
   def run(expected=0):
    source.write_bytes(recover.encoded(catalog))
    p=subprocess.run(['node',str(tools/'storage-publish-recovery-catalog.mjs'),str(code)],env=env,capture_output=True,text=True)
    self.assertEqual(p.returncode,expected,p.stderr)
    return p
   run();calls=(root/'calls').read_text();run();self.assertEqual((root/'calls').read_text(),calls)
   catalog['versions']=[dict(id='v1',name='规划')]
   (root/'fail').write_text('once');run(1)
   pending=root/'state/portable-catalog/pending.json';self.assertTrue(pending.exists())
   original=json.loads(pending.read_text());cipher=Path(original['cipher']).read_bytes()
   run();self.assertFalse(pending.exists())
   remote=root/'cloud'/original['remote'].lstrip('/');self.assertEqual(remote.read_bytes(),cipher)
   decoded=root/'decoded';decoded.mkdir()
   for file in sorted((root/'cloud/instance/recovery').glob('catalog-*.json.gz.age')):
    p=subprocess.run(['age','-d','-i',str(root/'key'),str(file)],capture_output=True,check=True)
    (decoded/file.name.removesuffix('.gz.age')).write_bytes(gzip.decompress(p.stdout))
   self.assertEqual(recover.load_catalog(decoded),catalog)
   calls=(root/'calls').read_text();run();self.assertEqual((root/'calls').read_text(),calls)
   state=json.loads((root/'state/portable-catalog/state.json').read_text())
   self.assertEqual(state['catalogSha256'],hashlib.sha256(recover.encoded(catalog)).hexdigest())
   self.assertTrue(state['lastDelta'])
   self.assertEqual(state['descriptorProof']['catalogSha256'],state['catalogSha256'])
   self.assertEqual(state['descriptorProof']['fileId'],'fixture-file-id')
   # Upgrade an already published catalogue without rereading old business
   # objects: only a new empty delta and its receipt acquire the missing proof.
   prior_descriptor=state['latestDescriptor'];state.pop('descriptorProof')
   (root/'state/portable-catalog/state.json').write_text(json.dumps(state))
   before=(root/'calls').read_text().splitlines();run()
   state=json.loads((root/'state/portable-catalog/state.json').read_text())
   self.assertNotEqual(state['latestDescriptor'],prior_descriptor)
   self.assertEqual(state['descriptorProof']['catalogSha256'],state['catalogSha256'])
   self.assertEqual((root/'calls').read_text().splitlines()[len(before):],['put','get','put','get'])
   calls=(root/'calls').read_text();run();self.assertEqual((root/'calls').read_text(),calls)


if __name__=='__main__':unittest.main()
