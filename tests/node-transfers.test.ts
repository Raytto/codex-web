import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  NodeTransferCoordinator,
  parseTransferInput,
} from "../server/node-transfer-coordinator.js";
import { NodeTransferEndpoint } from "../remote-worker/src/node-transfer-endpoint.js";
async function setup() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ppa-node-transfer-test-"),
  );
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/codex-web`;
  const db = new DatabaseSync(path.join(root, "state.sqlite"));
  const nodes = {
    a: new NodeTransferEndpoint(path.join(root, "a"), origin),
    b: new NodeTransferEndpoint(path.join(root, "b"), origin),
  };
  let coordinator = new NodeTransferCoordinator(
    db,
    (id, spec) => nodes[id as "a" | "b"].start(spec),
    origin.replace("http", "ws") + "/api/node-transfers/connect",
    (id) => id === "a" || id === "b",
    [],
  );
  coordinator.attach(server);
  return {
    root,
    nodes,
    get coordinator() {
      return coordinator;
    },
    restartServer() {
      coordinator.close();
      coordinator = new NodeTransferCoordinator(
        db,
        (id, spec) => nodes[id as "a" | "b"].start(spec),
        origin.replace("http", "ws") + "/api/node-transfers/connect",
        (id) => id === "a" || id === "b",
        [],
      );
      coordinator.attach(server);
    },
    async close() {
      coordinator.close();
      await Promise.all(Object.values(nodes).map((n) => n.close()));
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
async function finished(c: NodeTransferCoordinator, id: string) {
  for (let i = 0; i < 350; i++) {
    const r = c.get(id, "owner")!;
    if (["completed", "failed", "cancelled"].includes(r.state)) return r;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(JSON.stringify(c.get(id, "owner")));
}
for (const route of ["relay", "auto"] as const)
  test(
    `real endpoints transfer ${route}, checksum and no relay disk copy`,
    { timeout: 45_000 },
    async () => {
      const f = await setup();
      try {
        const bytes = crypto.randomBytes(2 * 1024 * 1024 + 123),
          source = path.join(f.root, "source.bin"),
          target = path.join(f.root, "target.bin");
        fs.writeFileSync(source, bytes);
        const row = f.coordinator.create("owner", null, {
          source: { executorId: "a", path: source },
          target: { executorId: "b", path: target },
          route,
          idempotencyKey: `transfer-${route}`,
        });
        const done = await finished(f.coordinator, row.id);
        assert.equal(done.state, "completed", JSON.stringify(done));
        assert.equal(
          done.sha256,
          crypto.createHash("sha256").update(bytes).digest("hex"),
        );
        assert.deepEqual(fs.readFileSync(target), bytes);
        assert.deepEqual(fs.readFileSync(source), bytes);
        assert.equal(done.actualRoute, route === "auto" ? "direct" : "relay");
        assert.equal(done.relayBytes === 0, route === "auto");
        assert.deepEqual(done.cleaned, { source: true, target: true });
        assert.equal(
          fs.readdirSync(f.root).some((n) => n.startsWith(".ppa-transfer-")),
          false,
        );
        assert.equal(f.coordinator.get(row.id, "someone-else"), undefined);
      } finally {
        await f.close();
      }
    },
  );
test(
  "reject replacement, preserve existing target and clean receiving state",
  { timeout: 45_000 },
  async () => {
    const f = await setup();
    try {
      const source = path.join(f.root, "src"),
        target = path.join(f.root, "dest");
      fs.writeFileSync(source, "new");
      fs.writeFileSync(target, "existing");
      const row = f.coordinator.create("owner", null, {
        source: { executorId: "a", path: source },
        target: { executorId: "b", path: target },
        route: "relay",
        idempotencyKey: "no-overwrite",
      });
      const done = await finished(f.coordinator, row.id);
      assert.equal(done.state, "failed", JSON.stringify(done));
      assert.equal(fs.readFileSync(target, "utf8"), "existing");
    } finally {
      await f.close();
    }
  },
);
test("strict requests and idempotency do not allow task retargeting", async () => {
  assert.throws(() =>
    parseTransferInput({
      source: { executorId: "a", path: "/s" },
      target: { executorId: "a", path: "/t" },
      idempotencyKey: "same-node",
    }),
  );
  const f = await setup();
  try {
    const input = {
      source: { executorId: "a", path: path.join(f.root, "s") },
      target: { executorId: "b", path: path.join(f.root, "t") },
      idempotencyKey: "stable-key",
    };
    const row = f.coordinator.create("owner", null, input);
    assert.equal(f.coordinator.create("owner", null, input).id, row.id);
    assert.throws(
      () =>
        f.coordinator.create("owner", null, {
          ...input,
          target: { ...input.target, path: "/different" },
        }),
      /IDEMPOTENCY_CONFLICT/,
    );
  } finally {
    await f.close();
  }
});
test(
  "receiver process restart resumes a durable transfer and original idempotency key",
  { timeout: 60_000 },
  async () => {
    const f = await setup();
    try {
      const source = path.join(f.root, "large-source"),
        target = path.join(f.root, "resumed-target");
      fs.writeFileSync(source, crypto.randomBytes(24 * 1024 * 1024));
      const input = {
        source: { executorId: "a", path: source },
        target: { executorId: "b", path: target },
        route: "auto",
        idempotencyKey: "restart-receiver",
      };
      const row = f.coordinator.create("owner", null, input);
      let interrupted = false;
      for (let i = 0; i < 2000; i++) {
        const current = f.coordinator.get(row.id, "owner")!;
        if (current.bytes >= 1024 * 1024 && !current.committed) {
          await f.nodes.b.close();
          const coordinatorUrl = (f.coordinator as unknown as { url: string })
            .url;
          f.nodes.b = new NodeTransferEndpoint(
            path.join(f.root, "b"),
            coordinatorUrl
              .replace(/^ws/, "http")
              .replace("/api/node-transfers/connect", ""),
          );
          interrupted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(interrupted, "interrupted after durable checkpoint");
      const done = await finished(f.coordinator, row.id);
      assert.equal(done.state, "completed", JSON.stringify(done));
      assert.ok(done.epoch >= 2);
      assert.deepEqual(fs.readFileSync(source), fs.readFileSync(target));
      assert.equal(f.coordinator.create("owner", null, input).id, row.id);
    } finally {
      await f.close();
    }
  },
);
test(
  "empty file completes and cancellation returns independent cleanup outcome",
  { timeout: 45_000 },
  async () => {
    const f = await setup();
    try {
      const source = path.join(f.root, "empty"),
        target = path.join(f.root, "empty-target");
      fs.writeFileSync(source, "");
      const row = f.coordinator.create("owner", null, {
        source: { executorId: "a", path: source },
        target: { executorId: "b", path: target },
        route: "relay",
        idempotencyKey: "empty-file",
      });
      assert.equal((await finished(f.coordinator, row.id)).state, "completed");
      assert.equal(fs.statSync(target).size, 0);
      const cancel = f.coordinator.create("owner", null, {
        source: { executorId: "a", path: source },
        target: { executorId: "b", path: target + "-cancel" },
        idempotencyKey: "cancel-file",
      });
      f.coordinator.cancel(cancel.id, "owner");
      const done = await finished(f.coordinator, cancel.id);
      assert.equal(done.state, "cancelled", JSON.stringify(done));
      assert.deepEqual(done.cleaned, { source: true, target: true });
    } finally {
      await f.close();
    }
  },
);

test(
  "coordinator restart preserves task and resumes with fenced epoch",
  { timeout: 60_000 },
  async () => {
    const f = await setup();
    try {
      const source = path.join(f.root, "restart-source"),
        target = path.join(f.root, "restart-target");
      fs.writeFileSync(source, crypto.randomBytes(24 * 1024 * 1024));
      const row = f.coordinator.create("owner", null, {
        source: { executorId: "a", path: source },
        target: { executorId: "b", path: target },
        route: "relay",
        idempotencyKey: "server-restart",
      });
      let interrupted = false;
      for (let i = 0; i < 2000; i++) {
        const current = f.coordinator.get(row.id, "owner")!;
        if (current.bytes >= 1024 * 1024 && !current.committed) {
          f.restartServer();
          interrupted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(interrupted);
      const done = await finished(f.coordinator, row.id);
      assert.equal(done.state, "completed", JSON.stringify(done));
      assert.ok(done.epoch >= 2);
      assert.deepEqual(fs.readFileSync(source), fs.readFileSync(target));
    } finally {
      await f.close();
    }
  },
);
