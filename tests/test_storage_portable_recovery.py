import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('recover', ROOT / 'deploy/storage-recover-file.py')
recover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recover)
sha = lambda b: hashlib.sha256(b).hexdigest()


class PortableRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        # Cryptography is already verified elsewhere; these tests exercise the
        # new offline format/ordering/path/integrity code without any cloud IO.
        age = self.bin / 'age'
        age.write_text('#!/usr/bin/python3\nimport sys\nsys.stdout.buffer.write(open(sys.argv[-1],"rb").read())\n')
        age.chmod(0o755)
        self.old_path = os.environ['PATH']
        os.environ['PATH'] = str(self.bin) + ':' + self.old_path
        self.catalog = dict(format='pp-portable-catalog-v1', completeSiteBackup=False,
            versions=[], chunks=[], legacy=[], nativeUnits=[], backupPoints=[], limits=[])

    def tearDown(self):
        os.environ['PATH'] = self.old_path
        self.temp.cleanup()

    def chunk(self, text, cid):
        cipher = gzip.compress(text, mtime=0)
        file = self.root / ('piece-' + cid)
        file.write_bytes(cipher)
        row = dict(id=cid, user_id='owner', codec='gzip-age-v1', remote_path='/' + file.name,
            ciphertext_bytes=len(cipher), ciphertext_sha256=sha(cipher), plaintext_bytes=len(text), plaintext_sha256=sha(text))
        self.catalog['chunks'].append(row)
        return row

    def test_two_chunks_integrity_and_order(self):
        a, b = b'first\n', '第二块'.encode()
        self.chunk(a, 'a'); self.chunk(b, 'b')
        row = dict(id='v1', account='owner', bytes=len(a+b), sha256=sha(a+b), chunkIds=['a', 'b'])
        out = io.BytesIO()
        self.assertEqual(recover.recover(self.catalog, row, self.root, self.root/'unused-key', out), (len(a+b), sha(a+b)))
        self.assertEqual(out.getvalue(), a+b)

    def test_wrong_ciphertext_and_cross_owner_are_rejected(self):
        chunk = self.chunk(b'data', 'a')
        row = dict(account='wrong-owner', bytes=4, sha256=sha(b'data'), chunkIds=['a'])
        with self.assertRaisesRegex(ValueError, 'owner'):
            recover.recover(self.catalog, row, self.root, self.root/'unused', io.BytesIO())
        row['account'] = 'owner'
        (self.root/'piece-a').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'mismatch|exceeded'):
            recover.recover(self.catalog, row, self.root, self.root/'unused', io.BytesIO())

    def test_cloud_symlink_refused(self):
        target = self.root/'real'; target.write_bytes(b'abc')
        (self.root/'alias').symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            recover.cloud_file(self.root, '/alias', 3, sha(b'abc'))

    def test_legacy_selected_member_only(self):
        content=b'plan content'; buf=io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w:gz') as archive:
            for name, data in [('files/plan.txt',content),('../../outside',b'do not extract')]:
                entry=tarfile.TarInfo(name);entry.size=len(data);archive.addfile(entry,io.BytesIO(data))
        body=buf.getvalue();(self.root/'old.age').write_bytes(body)
        manifest=dict(entries=[dict(kind='files',relativePath='plan.txt',size=len(content),sha256=sha(content))])
        row=dict(kind='conversation',remote_path='/old.age',archive_bytes=len(body),archive_sha256=sha(body),manifest_json=json.dumps(manifest))
        out=io.BytesIO();recover.recover(self.catalog,row,self.root,self.root/'unused',out,'files/plan.txt')
        self.assertEqual(out.getvalue(),content)
        self.assertFalse((self.root.parent/'outside').exists())

    def test_delta_chain_and_missing_link(self):
        base=self.catalog; updated=json.loads(json.dumps(base)); updated['versions']=[dict(id='v1',name='规划')]
        self.root.joinpath('catalog-001.json').write_bytes(recover.encoded(base))
        changed={name:updated[name] for name in ['versions','chunks','legacy','nativeUnits','backupPoints']}
        delta=dict(format='pp-portable-catalog-delta-v1',baseSha256=sha(recover.encoded(base)),resultSha256=sha(recover.encoded(updated)),changed=changed,removed={k:[] for k in changed})
        self.root.joinpath('catalog-002.json').write_text(json.dumps(delta))
        self.assertEqual(recover.load_catalog(self.root),updated)
        delta['baseSha256']='0'*64;self.root.joinpath('catalog-002.json').write_text(json.dumps(delta))
        with self.assertRaisesRegex(ValueError,'missing_or_out_of_order'):
            recover.load_catalog(self.root)

    def test_cli_preserves_existing_output(self):
        self.chunk(b'data','a');self.catalog['versions']=[dict(id='v1',account='owner',bytes=4,sha256=sha(b'data'),chunkIds=['a'])]
        c=self.root/'catalog.json';c.write_bytes(recover.encoded(self.catalog))
        target=self.root/'existing';target.write_text('original')
        p=subprocess.run(['python3',str(ROOT/'deploy/storage-recover-file.py'),'--catalog',str(c),'--id','v1','--cloud-directory',str(self.root),'--key',str(self.root/'unused'),'--output',str(target)],capture_output=True)
        self.assertNotEqual(p.returncode,0);self.assertEqual(target.read_text(),'original')


if __name__ == '__main__':
    unittest.main()
