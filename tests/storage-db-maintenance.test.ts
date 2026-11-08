import {execFileSync} from 'node:child_process';
import test from 'node:test';

test('database compaction respects the maintenance gate, job races and independent recovery, and releases actual blocks',()=>{
 execFileSync('python3',['tests/test_storage_db_maintenance.py'],{timeout:60_000,stdio:'pipe'});
});
