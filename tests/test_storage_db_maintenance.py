import importlib.util
from pathlib import Path
import json
import sqlite3
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('storage_db', Path(__file__).resolve().parents[1]/'deploy/storage-db-maintenance.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class DatabaseMaintenance(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pp-storage-db-')
        self.root = Path(self.temporary.name)
        self.file = self.root/'main.sqlite'
        self.db = sqlite3.connect(self.file)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript("CREATE TABLE jobs(id TEXT PRIMARY KEY,status TEXT);CREATE TABLE storage_backup_points(state TEXT,restore_tested_at INTEGER);INSERT INTO storage_backup_points VALUES('verified',1);CREATE TABLE content(id INTEGER PRIMARY KEY,body BLOB);")
        self.db.executemany('INSERT INTO content(body) VALUES(?)', [(b'x'*4096,)]*512)
        self.db.commit(); self.db.execute('DELETE FROM content WHERE id>5'); self.db.commit()
        self.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.args = [self.file,self.root/'gate',self.root/'gate.lock',self.root/'lifecycle',self.root/'recovery']
    def tearDown(self):
        self.db.close(); self.temporary.cleanup()
    def run_compaction(self, delay=0):
        return module.compact(*self.args,minimum_reclaim_bytes=1024,settle_seconds=delay)
    def test_compact_preserves_live_connection_rows_and_verified_recovery(self):
        before = self.file.stat().st_size; inode = self.file.stat().st_ino
        receipt = self.run_compaction()
        self.assertEqual(receipt['state'],'compacted'); self.assertGreater(receipt['physicalReleasedBytes'],0)
        self.assertLess(self.file.stat().st_size,before); self.assertEqual(self.file.stat().st_ino,inode)
        self.assertEqual(self.db.execute('SELECT count(*) FROM content').fetchone()[0],5)
        point = json.loads((self.root/'recovery/current.json').read_text())
        copy = self.root/'recovery'/point['directory']/'database.sqlite'
        self.assertEqual(module.digest(copy),point['sha256'])
        check=sqlite3.connect(copy); self.assertEqual(check.execute('PRAGMA quick_check').fetchone()[0],'ok'); check.close()
        self.assertFalse((self.root/'gate').exists())
        self.assertEqual(self.run_compaction()['state'],'not_needed')
    def test_other_gate_and_active_job_are_never_disturbed(self):
        gate=self.root/'gate';gate.write_text('other-owner')
        self.assertEqual(self.run_compaction()['reason'],'maintenance_gate_owned_elsewhere');self.assertEqual(gate.read_text(),'other-owner');gate.unlink()
        self.db.execute("INSERT INTO jobs VALUES('running','running')");self.db.commit()
        self.assertEqual(self.run_compaction()['reason'],'actual_job_running');self.assertFalse(gate.exists())
    def test_job_claim_race_reopens_gate_and_does_not_touch_data(self):
        def claim():
            while not (self.root/'gate').exists():time.sleep(.005)
            writer=sqlite3.connect(self.file);writer.execute("INSERT INTO jobs VALUES('winner','running')");writer.commit();writer.close()
        thread=threading.Thread(target=claim);thread.start()
        try:self.assertEqual(self.run_compaction(.15)['reason'],'job_won_idle_race')
        finally:thread.join(5)
        self.assertFalse((self.root/'gate').exists());self.assertFalse((self.root/'recovery/current.json').exists())
    def test_native_history_compacts_under_its_engine_lock_and_keeps_snapshot(self):
        home=self.root/'native';home.mkdir();source=home/'thread_history_1.sqlite'
        native=sqlite3.connect(source);native.execute('CREATE TABLE history(value BLOB)');native.executemany('INSERT INTO history VALUES(?)',[(b'x'*4096,)]*200);native.commit();native.execute('DELETE FROM history WHERE rowid>3');native.commit();native.close()
        before=source.stat().st_size
        result=module.compact(*self.args,minimum_reclaim_bytes=1024,settle_seconds=0,native_homes={'account':home})
        self.assertEqual(result['native'][0]['state'],'compacted');self.assertLess(source.stat().st_size,before)
        check=sqlite3.connect(source);self.assertEqual(check.execute('SELECT count(*) FROM history').fetchone()[0],3);check.close()
        self.assertTrue((self.root/'recovery/native/account/thread_history_1/current.json').exists())
    def test_independent_cloud_recovery_required_before_snapshot_replacement(self):
        self.db.execute('DELETE FROM storage_backup_points');self.db.commit()
        self.assertEqual(self.run_compaction()['reason'],'independent_cloud_recovery_required')
        self.assertFalse((self.root/'recovery/current.json').exists())

if __name__=='__main__':unittest.main()
