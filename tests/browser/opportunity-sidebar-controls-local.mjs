import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../dist-server/server/app.js';
import { OpportunityStore } from '../../dist-server/server/opportunity-store.js';
import { run } from './opportunity-sidebar-controls.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = process.env.CWW_BROWSER_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-controls-'));
fs.mkdirSync(work, { recursive: true, mode: 0o700 });
const fixture = fs.mkdtempSync(path.join(work, 'api-'));
const shortTemp = '/tmp/sidebar-' + crypto.randomUUID(); fs.symlinkSync(fixture, shortTemp, 'dir');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/root/.cache/ms-playwright';
const playwrightRoot = process.env.PLAYWRIGHT_MODULE_PATH || fs.readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH + '/.links').map(name => fs.readFileSync(process.env.PLAYWRIGHT_BROWSERS_PATH + '/.links/' + name, 'utf8').trim()).find(root => fs.existsSync(root + '/index.mjs'));
const { chromium } = await import(playwrightRoot + '/index.mjs');
const password = crypto.randomUUID();
const instance = createApp({ basePath: "/codex-web", projectRoot: repo, dataRoot: fixture + '/data', tenantRoot: fixture + '/tenants', codexHome: fixture + '/codex', hostRootCodexHome: fixture + '/host-codex', hostRootSocketPath: fixture + '/no-host.sock', username: 'pp', passwordHash: bcrypt.hashSync(password,4), sessionSecret: crypto.randomBytes(32).toString('hex'), queueAutoStart: false, minimumFreeDiskBytes: 0,
});
const userId = instance.db.getUserByUsername('pp').id;
const server = instance.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const origin = 'http://127.0.0.1:' + server.address().port + '/codex-web';
let browser;
try {
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--disable-gpu'], env: { ...process.env, TMPDIR: shortTemp } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const login = await context.request.post(origin + '/api/auth/login', { data: { username: 'pp', password } }); assert.equal(login.status(), 200);
  const session = await login.json(); assert.equal(session.accountId, userId);
  const features = await (await context.request.get(origin + '/api/user-settings/features')).json();
  const settings = await context.request.put(origin + '/api/user-settings/features', { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken }, data: { ...features, opportunityCards: true } }); assert.equal(settings.status(), 200);
  const projects = await (await context.request.get(origin + '/api/projects')).json();
  const project = projects.projects.find(p => p.executor_id === 'tenant-local'); assert.ok(project);
  const store = new OpportunityStore(instance.db);
  for (let i = 0; i < 6; i++) {
    const topic = store.createTopic(userId, { name: 'Sidebar fixture ' + i, goal: 'Isolated sidebar regression', project_id: project.id }, crypto.randomUUID());
    if (i >= 4) store.lifecycle(userId, topic.id, topic.revision, 'archive');
  }
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(origin + '/?conversation=invalid');
  await run({ page, context, origin, work, assert });
  console.log(JSON.stringify({ ok: true, report: path.join(work, 'sidebar-controls.json') }));
} finally {
  await browser?.close(); instance.beginShutdown(); await new Promise(resolve => server.close(resolve)); instance.db.close();
  fs.unlinkSync(shortTemp); fs.rmSync(fixture, { recursive: true, force: true });
}
