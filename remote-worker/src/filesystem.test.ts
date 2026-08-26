import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectFilesystem, resolveDirectory, resolveReadableFile } from "./filesystem.js";

test("directory operations use real absolute paths without an allowlist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-"));
  try {
    const listed = projectFilesystem("list", root);
    assert.equal(listed.directory, resolveDirectory(root));
    const created = projectFilesystem("create", root, "project-a");
    assert.equal(created.directory, resolveDirectory(path.join(root, "project-a")));
    const validated = projectFilesystem("validate", created.directory);
    assert.equal(validated.directory, created.directory);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe project folder names and relative paths are rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-"));
  try {
    assert.throws(() => resolveDirectory("relative"));
    assert.throws(() => projectFilesystem("create", root, "../escape"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote downloads resolve any readable regular file for the Worker account", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-files-"));
  const root = path.join(parent, "project");
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "public", "index.html"), "hello", "utf8");
  fs.writeFileSync(path.join(parent, "outside.txt"), "secret", "utf8");
  try {
    const relative = resolveReadableFile(root, path.join("public", "index.html"));
    assert.equal(relative.path, fs.realpathSync.native(path.join(root, "public", "index.html")));
    assert.equal(relative.name, "index.html");
    assert.equal(relative.size, 5);
    assert.equal(resolveReadableFile(root, relative.path).path, relative.path);
    assert.equal(resolveReadableFile(root, path.join(parent, "outside.txt")).name, "outside.txt");
    assert.equal(resolveReadableFile(root, path.join("..", "outside.txt")).name, "outside.txt");
    assert.throws(() => resolveReadableFile(root, "public"), /普通文件/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("remote downloads reject files larger than 100 MiB", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-large-"));
  const large = path.join(root, "large.bin");
  fs.writeFileSync(large, Buffer.alloc(1));
  fs.truncateSync(large, 100 * 1024 * 1024 + 1);
  try { assert.throws(() => resolveReadableFile(root, large), /100 MiB/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
