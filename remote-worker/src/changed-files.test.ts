import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectChangedFiles } from "./changed-files.js";

test("changed file collection cannot escape the real project root and reports omissions", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-changes-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside.txt");
  fs.mkdirSync(path.join(project, "folder"), { recursive: true });
  fs.writeFileSync(path.join(project, "ok.txt"), "ok");
  fs.writeFileSync(path.join(project, "large.bin"), "12345");
  fs.writeFileSync(outside, "outside");
  const symlink = path.join(project, "outside-link.txt");
  try { fs.symlinkSync(outside, symlink); } catch { /* Some Windows test hosts may deny symlink creation. */ }
  const uploaded: string[] = [];
  const result = await collectChangedFiles(project, [
    "ok.txt", "folder", "large.bin", "missing.txt", outside,
    ...(fs.existsSync(symlink) ? [symlink] : []),
  ], async (file) => { uploaded.push(file); }, { maximumFileBytes: 4 });
  assert.deepEqual(uploaded.map((file) => path.basename(file)), ["ok.txt"]);
  assert.equal(result.hasUploadedImage, false);
  assert.ok(result.omitted.some((item) => item.reason === "not_file"));
  assert.ok(result.omitted.some((item) => item.reason === "too_large"));
  assert.ok(result.omitted.some((item) => item.reason === "missing"));
  assert.ok(result.omitted.filter((item) => item.reason === "outside_project").length >= 1);
});

test("changed file collection caps uploads and emits a bounded manifest summary", async (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-change-limit-"));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const files = Array.from({ length: 8 }, (_, index) => {
    const name = `${index}.txt`;
    fs.writeFileSync(path.join(project, name), String(index));
    return name;
  });
  const result = await collectChangedFiles(project, files, async () => undefined, {
    maximumFiles: 2,
    maximumManifestItems: 3,
  });
  assert.equal(result.uploaded, 2);
  assert.equal(result.hasUploadedImage, false);
  assert.equal(result.omitted.length, 3);
  assert.equal(result.omitted.at(-1)?.reason, "manifest_limit");
});
