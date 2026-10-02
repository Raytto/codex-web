// Browser regression against an isolated real API/SQLite instance; no model jobs run.
// Run after npm run build with PLAYWRIGHT_MODULE pointing to playwright/index.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { createApp } from '../dist-server/server/app.js';
import { run } from './composer-race-scenario.mjs';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fs.mkdtempSync(path.join(process.env.TEST_RUNTIME || os.tmpdir(), 'composer-race-'));
const shortTemp = `/tmp/composer-${crypto.randomUUID()}`;
fs.symlinkSync(root, shortTemp, 'dir');
const password = crypto.randomUUID();
const instance = createApp({
  projectRoot: process.cwd(), basePath: "/codex-web", dataRoot: path.join(root, 'data'), tenantRoot: path.join(root, 'tenants'),
  codexHome: path.join(root, 'codex'), hostRootCodexHome: path.join(root, 'host-codex'),
  hostRootSocketPath: path.join(root, 'no-host.sock'), queueAutoStart: false,
  username: 'demo-owner', passwordHash: bcrypt.hashSync(password, 4), sessionSecret: crypto.randomBytes(32).toString('hex'),
});
const server = instance.app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}/codex-web`;
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--disable-gpu'], env: { ...process.env, TMPDIR: shortTemp } });
  const context = await browser.newContext();
  const login = await context.request.post(`${origin}/api/auth/login`, { data: { username: 'demo-owner', password } });
  assert.equal(login.status(), 200);
  results.push(...await run({ context, origin, assert, expectBug: process.argv.includes('--expect-bug') }));
  await context.close();
  console.log(JSON.stringify({ ok: true, results }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  instance.db.close();
  fs.unlinkSync(shortTemp);
  fs.rmSync(root, { recursive: true, force: true });
}
