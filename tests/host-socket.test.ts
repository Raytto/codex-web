import assert from "node:assert/strict";
import net from "node:net";
import readline from "node:readline";
import { once } from "node:events";
import test from "node:test";
import { guardHostSocket } from "../server/host-socket.js";

for (const source of ["socket", "readline"] as const) {
  test(`host RPC survives a ${source} EPIPE and serves the next connection`, async t => {
    let disconnected = 0;
    let bothClosed!: () => void;
    const closed = new Promise<void>(resolve => { bothClosed = resolve; });
    const server = net.createServer(socket => {
      const input = readline.createInterface({ input: socket });
      guardHostSocket(socket, input);
      socket.on("close", () => { disconnected++; input.close(); if (disconnected === 2) bothClosed(); });
      input.on("line", line => {
        if (line === "disconnect") {
          // Deterministically deliver the error Node emits when a delayed RPC
          // reply races the client's timeout, without relying on TCP timing.
          (source === "socket" ? socket : input).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        } else socket.end("ready\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const failed = net.createConnection(port, "127.0.0.1");
    await once(failed, "connect");
    failed.write("disconnect\n");
    await once(failed, "close");
    assert.equal(disconnected, 1);
    const healthy = net.createConnection(port, "127.0.0.1");
    await once(healthy, "connect");
    healthy.write("validate\n");
    const [response] = await once(healthy, "data");
    assert.equal(response.toString(), "ready\n");
    await once(healthy, "close");
    await closed;
    assert.equal(disconnected, 2);
  });
}
