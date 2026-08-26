import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { parseRemoteContentLength, REMOTE_TRANSFER_MAX_FILE_BYTES, RemoteTransferError, streamRemoteUpload } from "../server/remote-transfer.js";

test("remote transfer requires a canonical bounded Content-Length", () => {
  assert.equal(parseRemoteContentLength("0"), 0);
  assert.equal(parseRemoteContentLength("1048576"), 1_048_576);
  for (const value of [undefined, "", "-1", "1.5", "1,2", ["1", "2"]] as Array<string | string[] | undefined>) {
    assert.throws(() => parseRemoteContentLength(value), RemoteTransferError);
  }
  assert.throws(
    () => parseRemoteContentLength(String(REMOTE_TRANSFER_MAX_FILE_BYTES + 1)),
    (error: unknown) => error instanceof RemoteTransferError && error.status === 413,
  );
});

test("remote transfer streams bytes to a UUID temporary file while hashing", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-remote-transfer-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = Buffer.from("streamed remote artifact");
  const temporary = path.join(root, `${crypto.randomUUID()}.part`);
  const result = await streamRemoteUpload(Readable.from([content.subarray(0, 5), content.subarray(5)]), temporary, content.length);
  assert.equal(result.size, content.length);
  assert.equal(result.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  assert.deepEqual(fs.readFileSync(temporary), content);
});

test("remote transfer rejects body length mismatches and removes partial files", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-remote-transfer-mismatch-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [body, declared] of [[Buffer.from("short"), 10], [Buffer.from("too long"), 2]] as const) {
    const temporary = path.join(root, `${crypto.randomUUID()}.part`);
    await assert.rejects(
      () => streamRemoteUpload(Readable.from([body]), temporary, declared),
      (error: unknown) => error instanceof RemoteTransferError && error.code === "REMOTE_BODY_SIZE_MISMATCH",
    );
    assert.equal(fs.existsSync(temporary), false);
  }
});
