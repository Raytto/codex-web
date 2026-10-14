import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import test from 'node:test';
test('password helper accepts stdin without including the password in arguments and rejects short input', () => {
  const password = 'synthetic-stdin-fixture-2026';
  const r = spawnSync(process.execPath, ['scripts/hash-password.mjs'], { input: password, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.ok(bcrypt.compareSync(password, r.stdout.trim()));
  assert.equal(r.stdout.includes(password), false);
  const short = spawnSync(process.execPath, ['scripts/hash-password.mjs'], { input: 'short', encoding: 'utf8' });
  assert.equal(short.status, 1); assert.equal(short.stdout, '');
});
