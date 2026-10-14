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

test("generated images respect the remaining result byte budget", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppagent-image-budget-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = crypto.randomUUID();
  const directory = path.join(root, "generated_images", threadId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "a.png"), "1234");
  fs.writeFileSync(path.join(directory, "b.png"), "12");
  const result = await collectGeneratedImages(root, threadId, new Map(), async () => {}, { maximumTotalBytes: 2 });
  assert.equal(result.uploaded, 1);
  assert.deepEqual(result.omitted, [{ path: "a.png", reason: "total_size_limit" }]);
});


test("generated images can exceed twenty files and obey the remaining shared count", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppagent-image-count-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = crypto.randomUUID();
  const directory = path.join(root, "generated_images", threadId);
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 257; index += 1) fs.writeFileSync(path.join(directory, `${index}.png`), "image");
  const full = await collectGeneratedImages(root, threadId, new Map(), async () => {});
  assert.equal(full.uploaded, 256);
  assert.equal(full.omitted.length, 1);
  assert.equal(full.omitted[0].reason, "count_limit");
  const remaining = await collectGeneratedImages(root, threadId, new Map(), async () => {}, { maximumFiles: 1 });
  assert.equal(remaining.uploaded, 1);
  const exhausted = await collectGeneratedImages(root, threadId, new Map(), async () => {}, { maximumFiles: 0 });
  assert.equal(exhausted.uploaded, 0);
  assert.equal(fs.readdirSync(directory).length, 257);
});
