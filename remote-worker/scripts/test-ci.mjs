// Emit failed TAP blocks as public check annotations without changing the gate.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = fs.readdirSync('dist/src').filter(name => name.endsWith('.test.js')).sort().map(name => 'dist/src/' + name);
if (!files.length) throw new Error('No compiled Worker tests found');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
const escape = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
if (result.status !== 0) {
  const blocks = (result.stdout || '').match(/(?:^|\n)not ok[^\n]*\n[\s\S]*?(?=\n# Subtest:|\n(?:ok|not ok) \d|\n1\.\.|$)/g) || [];
  for (const block of blocks) process.stdout.write('::error title=Worker test failure::' + escape(block.trim().slice(0, 12000)) + '\n');
  if (!blocks.length) process.stdout.write('::error title=Worker test runner::' + escape(String(result.error || result.stderr || 'Runner failed without TAP output')) + '\n');
}
process.exit(result.status ?? 1);
