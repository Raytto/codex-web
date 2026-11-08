import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { HostRootWorkerClient } from '../server/host-root-worker-client.js';
import type { HostRootRunRequest } from '../server/host-root-protocol.js';

async function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-steer-'));
  let peer: net.Socket;
  const server = net.createServer(socket => { peer = socket; });
  server.listen(path.join(dir, 'rpc.sock'));
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = new HostRootWorkerClient(path.join(dir, 'rpc.sock'));
  const connected = new Promise<net.Socket>(resolve => server.once('connection', resolve));
  const result = client.run({ jobId: 'job' } as HostRootRunRequest, {
    onThreadStarted() {}, onProgress() {}, onContextUsage() {}, onQuotaUsage() {},
  }).then(value => ({ value }), error => ({ error: String(error.message) }));
  const socket = await connected;
  const lines = readline.createInterface({ input: socket });
  const send = (value: unknown) => socket.write(JSON.stringify(value) + '\n');
  return { client, result, lines, send };
}

test('a rejected host steer leaves the original job alive and can be followed by a valid steer', async t => {
  const f = await fixture(t);
  let count = 0;
  f.lines.on('line', line => {
    const request = JSON.parse(line);
    if (request.type !== 'steer') return;
    if (++count === 1) f.send({ type: 'request_failed', requestId: request.requestId, message: '当前任务尚未开始，请稍后引导' });
    else f.send({ type: 'event', jobId: 'job', event: { type: 'steer_completed', requestId: request.requestId, turnId: 'real-turn' } });
  });
  await assert.rejects(f.client.steer('job', 'first'), /尚未开始/);
  assert.equal(await f.client.steer('job', 'second'), 'real-turn');
  f.send({ type: 'event', jobId: 'job', event: { type: 'completed', finalResponse: 'original result' } });
  assert.deepEqual(await f.result, { value: 'original result' });
});

test('late request-scoped failures do not abort a job, while unscoped execution failures do', async t => {
  const f = await fixture(t);
  f.send({ type: 'request_failed', requestId: 'expired-steer', message: 'late failure' });
  f.send({ type: 'request_failed', message: 'worker could not start' });
  assert.deepEqual(await f.result, { error: 'worker could not start' });
});
