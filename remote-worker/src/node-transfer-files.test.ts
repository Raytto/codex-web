import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { TransferFiles } from "./node-transfer-files.js";
import type { TransferSpec } from "./node-transfer-types.js";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppa-transfer-files-"));
  const files = new TransferFiles(path.join(root, "state"));
  const spec: TransferSpec = {
    id: crypto.randomUUID(),
    epoch: 1,
    role: "target",
    operation: "run",
    path: path.join(root, "target"),
    token: "a".repeat(43),
    url: "ws://localhost/api/node-transfers/connect",
    expiresAt: Date.now() + 600_000,
    overwrite: false,
    direct: false,
    iceServers: [],
  };
  return {
    root,
    files,
    spec,
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const hash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
test("checkpoint only resumes verified durable bytes and rejects changed source", async () => {
  const f = fixture();
  try {
    const manifest = { size: 6, sha256: hash("abcdef") };
    const r = await f.files.receive(f.spec, manifest);
    await r.file!.write(Buffer.from("abcXXX"), 0, 6, 0);
    await r.file!.sync();
    r.ledger.offset = 3;
    r.ledger.prefix = hash("abc");
    await f.files.save(r.ledger);
    await r.file!.close();
    const resumed = await f.files.receive({ ...f.spec, epoch: 2 }, manifest);
    assert.equal(resumed.ledger.offset, 3);
    assert.equal((await resumed.file!.stat()).size, 3);
    await resumed.file!.close();
    await assert.rejects(
      () => f.files.receive(f.spec, { size: 6, sha256: hash("abcdef!") }),
      /SOURCE_CHANGED/,
    );
    await f.files.cleanup(f.spec.id, true);
    assert.equal(fs.existsSync(r.ledger.staging), false);
  } finally {
    f.close();
  }
});
test("corrupted partial payload never resumes", async () => {
  const f = fixture();
  try {
    const r = await f.files.receive(f.spec, { size: 3, sha256: hash("abc") });
    await r.file!.writeFile("xyz");
    r.ledger.offset = 3;
    r.ledger.prefix = hash("abc");
    await f.files.save(r.ledger);
    await r.file!.close();
    await assert.rejects(
      () => f.files.receive(f.spec, { size: 3, sha256: hash("abc") }),
      /PARTIAL_FILE_CORRUPT/,
    );
  } finally {
    f.close();
  }
});
test("commit recovered after publication before receipt, cancellation preserves target", async () => {
  const f = fixture();
  try {
    const r = await f.files.receive(f.spec, { size: 3, sha256: hash("abc") });
    await r.file!.writeFile("abc");
    await r.file!.sync();
    r.ledger.offset = 3;
    r.ledger.prepared = true;
    await f.files.save(r.ledger);
    await r.file!.close();
    await fs.promises.rename(r.ledger.staging, r.ledger.target);
    assert.deepEqual(await f.files.committedReceipt(f.spec.id), {
      size: 3,
      sha256: hash("abc"),
    });
    await f.files.cleanup(f.spec.id, true);
    assert.equal(fs.readFileSync(f.spec.path, "utf8"), "abc");
  } finally {
    f.close();
  }
});
test("no-clobber publication handles a concurrent target creation", async () => {
  const f = fixture();
  try {
    const r = await f.files.receive(f.spec, { size: 0, sha256: hash("") });
    fs.writeFileSync(f.spec.path, "racing target");
    await assert.rejects(() => f.files.commit(r.file!, r.ledger));
    await f.files.cleanup(f.spec.id, true);
    assert.equal(fs.readFileSync(f.spec.path, "utf8"), "racing target");
  } finally {
    f.close();
  }
});
test("cleanup does not follow replaced directory or remove unrelated files", async () => {
  const f = fixture();
  try {
    const r = await f.files.receive(f.spec, { size: 0, sha256: hash("") });
    await r.file!.close();
    fs.writeFileSync(
      path.join(path.dirname(r.ledger.staging), "unrelated"),
      "keep",
    );
    await assert.rejects(() => f.files.cleanup(f.spec.id));
    assert.equal(
      fs.readFileSync(
        path.join(path.dirname(r.ledger.staging), "unrelated"),
        "utf8",
      ),
      "keep",
    );
  } finally {
    f.close();
  }
});
test("sweeper expires owned partial data but protects active transfers", async () => {
  const f = fixture();
  try {
    const r = await f.files.receive(f.spec, { size: 0, sha256: hash("") });
    await r.file!.close();
    r.ledger.expiresAt = 1;
    await f.files.save(r.ledger);
    await f.files.sweep(new Set([f.spec.id]));
    assert.equal(fs.existsSync(r.ledger.staging), true);
    await f.files.sweep(new Set());
    assert.equal(fs.existsSync(r.ledger.staging), false);
    assert.equal(f.files.read(f.spec.id), null);
  } finally {
    f.close();
  }
});
