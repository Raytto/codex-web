// Isolated real UI/API/SQLite; only the speech provider is replaced with fixed text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { createApp } from '../dist-server/server/app.js';
import { TranscriptionService } from '../dist-server/server/transcription.js';
import { run } from './composer-voice-edit-scenario.mjs';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fs.mkdtempSync(path.join(process.env.TEST_RUNTIME || os.tmpdir(), 'voice-edit-'));
const shortTemp = `/tmp/voice-edit-${crypto.randomUUID()}`;
fs.symlinkSync(root, shortTemp, 'dir');
const original = TranscriptionService.prototype.transcribe;
TranscriptionService.prototype.transcribe = async () => 'recognized voice instruction';
const password = crypto.randomUUID();
const instance = createApp({ projectRoot: process.cwd(), basePath: "/codex-web", dataRoot: path.join(root, 'data'), tenantRoot: path.join(root, 'tenants'), codexHome: path.join(root, 'codex'), hostRootCodexHome: path.join(root, 'host-codex'), hostRootSocketPath: path.join(root, 'no-host.sock'), queueAutoStart: false, username: 'demo-owner', passwordHash: bcrypt.hashSync(password, 4), sessionSecret: crypto.randomBytes(32).toString('hex') });
const server = instance.app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}/codex-web`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--disable-gpu'], env: { ...process.env, TMPDIR: shortTemp } });
  const context = await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { username: 'demo-owner', password } })).status(), 200);
  const checks = await run({ context, origin, assert, expectBug: process.argv.includes('--expect-bug'), audioBase64: Buffer.from('isolated microphone audio').toString('base64'), onCheck: (check) => console.log(check),
    cleanupFixture: ({ conversationId, recordingIds }) => {
      const voices = instance.db.sqlite.prepare('SELECT client_recording_id FROM voice_transcriptions WHERE conversation_id=?').all(conversationId);
      assert.ok(voices.length > 0);
      assert.ok(voices.every((voice) => recordingIds.includes(voice.client_recording_id)), 'Cleanup must track every recording made by its fixture');
    },
  });
  console.log(JSON.stringify({ ok: true, checks }));
  await context.close();
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  instance.db.close(); TranscriptionService.prototype.transcribe = original;
  fs.unlinkSync(shortTemp); fs.rmSync(root, { recursive: true, force: true });
}
