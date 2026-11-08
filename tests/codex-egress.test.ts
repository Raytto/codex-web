import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import { probeOpenAIConnect, selectCodexEgress } from "../server/codex-egress.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/egress-test-tls.json", import.meta.url), "utf8"));

async function proxy(t: test.TestContext, handler: (socket: net.Socket) => void) {
  const server = http.createServer();
  const sockets = new Set<net.Socket>();
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); disconnected(); });
    socket.on("error", () => {});
  });
  server.on("connect", (req, socket) => {
    assert.equal(req.url, "chatgpt.com:443");
    handler(socket as net.Socket);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, sockets, closed };
}

test("CONNECT 200 followed by a dead upstream selects backup", async t => {
  const p = await proxy(t, socket => { socket.end("HTTP/1.1 200 Connection established\r\n\r\n"); });
  const choice = await selectCodexEgress({ primaryProxyUrl: p.url,
    backupProxyUrl: "http://127.0.0.1:17891", timeoutMs: 1000, signal: AbortSignal.timeout(3000) });
  assert.deepEqual(choice, { kind: "backup", proxyUrl: "http://127.0.0.1:17891" });
});

for (const phase of ["CONNECT", "TLS"]) {
  test(`one deadline closes a proxy stalled during ${phase}`, async t => {
    const p = await proxy(t, socket => {
      if (phase === "TLS") socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.on("end", () => socket.end());
      socket.resume();
    });
    const started = Date.now();
    await assert.rejects(probeOpenAIConnect(p.url, 100, new AbortController().signal), /timed out after 100ms/);
    assert.ok(Date.now() - started < 2000);
    await p.closed;
    assert.equal(p.sockets.size, 0);
  });
  test(`cancellation during ${phase} closes the probe without selecting backup`, async t => {
    const controller = new AbortController();
    const p = await proxy(t, socket => {
      if (phase === "TLS") socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.on("end", () => socket.end());
      socket.resume();
      setTimeout(() => controller.abort(), 20);
    });
    await assert.rejects(selectCodexEgress({ primaryProxyUrl: p.url,
      backupProxyUrl: "http://127.0.0.1:17891", signal: controller.signal }), { name: "AbortError" });
    await p.closed;
    assert.equal(p.sockets.size, 0);
  });
}

async function secureProxy(t: test.TestContext, status: number | null) {
  const sockets = new Set<net.Socket>();
  let received = false;
  const origin = https.createServer(fixture, (req, res) => {
    received = true;
    assert.equal(req.url, "/backend-api/codex/models");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    if (status !== null) { res.writeHead(status); res.end(); }
  });
  origin.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  origin.on("tlsClientError", () => {});
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as net.AddressInfo).port;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => origin.close(() => resolve()));
  });
  const p = await proxy(t, socket => {
    const upstream = net.connect(port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  return { ...p, received: () => received };
}

for (const status of [200, 401, 403, 502]) {
  test(`certificate-verified upstream HTTP ${status} ${status < 402 ? "passes" : "fails"}`, async t => {
    const p = await secureProxy(t, status);
    const probe = probeOpenAIConnect(p.url, 2000, new AbortController().signal, { ca: fixture.cert });
    if (status === 200 || status === 401) await probe;
    else await assert.rejects(probe, new RegExp(`HTTPS returned HTTP ${status}`));
    assert.ok(p.received());
  });
}

test("an untrusted upstream certificate cannot pass the probe", async t => {
  const p = await secureProxy(t, 401);
  await assert.rejects(probeOpenAIConnect(p.url, 2000, new AbortController().signal), /self.signed|certificate/i);
  assert.equal(p.received(), false);
});

test("the same deadline also covers waiting for HTTPS headers", async t => {
  const p = await secureProxy(t, null);
  await assert.rejects(probeOpenAIConnect(p.url, 300, new AbortController().signal, { ca: fixture.cert }), /timed out after 300ms/);
  assert.ok(p.received());
});
