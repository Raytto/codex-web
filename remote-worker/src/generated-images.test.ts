import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectGeneratedImages, snapshotGeneratedImages } from "./generated-images.js";

test("generated image collection is scoped to one Codex thread and only uploads changes", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-generated-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  const threadId = crypto.randomUUID();
  const otherThreadId = crypto.randomUUID();
  const threadRoot = path.join(codexHome, "generated_images", threadId);
  const otherThreadRoot = path.join(codexHome, "generated_images", otherThreadId);
  fs.mkdirSync(threadRoot, { recursive: true });
  fs.mkdirSync(otherThreadRoot, { recursive: true });
  fs.writeFileSync(path.join(threadRoot, "before.png"), "before");
  fs.writeFileSync(path.join(threadRoot, "ignore.txt"), "ignore");
  fs.writeFileSync(path.join(otherThreadRoot, "other.png"), "other");
  const before = await snapshotGeneratedImages(codexHome, threadId);

  fs.writeFileSync(path.join(threadRoot, "new.webp"), "new");
  const uploaded: string[] = [];
  const result = await collectGeneratedImages(codexHome, threadId, before, async (file) => { uploaded.push(file); });
  assert.deepEqual(uploaded.map((file) => path.basename(file)), ["new.webp"]);
  assert.equal(result.uploaded, 1);
  assert.deepEqual(result.omitted, []);
});

test("generated image collection rejects invalid threads and applies transfer limits", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-generated-limit-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const threadId = crypto.randomUUID();
  const threadRoot = path.join(codexHome, "generated_images", threadId);
  fs.mkdirSync(threadRoot, { recursive: true });
  fs.writeFileSync(path.join(threadRoot, "first.png"), "12345");
  fs.writeFileSync(path.join(threadRoot, "second.jpg"), "12");
  const result = await collectGeneratedImages(codexHome, threadId, new Map(), async () => undefined, {
    maximumFiles: 1,
    maximumFileBytes: 4,
  });
  assert.equal(result.uploaded, 1);
  assert.ok(result.omitted.some((item) => item.reason === "too_large"));
  await assert.rejects(() => snapshotGeneratedImages(codexHome, "../escape"), /Invalid Codex thread id/);
});
