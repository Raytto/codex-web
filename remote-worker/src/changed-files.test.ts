import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectChangedFiles } from "./changed-files.js";

test("shell-written managed HTML is collected with its declaration without fileChange events", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-managed-output-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outputs = path.join(root, "outputs", "current-job");
  const oldOutputs = path.join(root, "outputs", "other-job");
  const runtime = path.join(root, "runtime");
  for (const dir of [project, outputs, oldOutputs, runtime]) fs.mkdirSync(dir, { recursive: true });
  const html = path.join(outputs, "demo.html");
  const declaration = `${html}.pp-agent.json`;
  fs.writeFileSync(html, "<script>document.body.textContent='interactive'</script>");
  fs.writeFileSync(declaration, '{"presentation_mode":"web","sha256":"declared"}');
  fs.writeFileSync(path.join(oldOutputs, "private.txt"), "other job");
  fs.writeFileSync(path.join(runtime, "log.txt"), "runtime log");
  const uploads: string[] = [];
  const result = await collectChangedFiles(project, [], async (_, name) => { uploads.push(name); }, { managedOutputRoot: outputs });
  assert.deepEqual(uploads, ["demo.html", "demo.html.pp-agent.json"]);
  assert.equal(result.uploaded, 2);
  assert.deepEqual(result.omitted, []);
  const deduplicated: string[] = [];
  await collectChangedFiles(project, [declaration, html], async (_, name) => { deduplicated.push(name); }, { managedOutputRoot: outputs });
  assert.deepEqual(deduplicated, uploads);
});

test("project HTML pulls its undeclared-in-events sidecar and reserves the complete pair budget", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-output-pair-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "demo.html"), "html");
  fs.writeFileSync(path.join(root, "demo.html.pp-agent.json"), "declaration");
  const uploaded: string[] = [];
  const result = await collectChangedFiles(root, ["demo.html"], async (_, name) => { uploaded.push(name); });
  assert.deepEqual(uploaded, ["demo.html", "demo.html.pp-agent.json"]);
  assert.equal(result.uploadedBytes, 15);
  for (const options of [{ maximumFiles: 1 }, { maximumTotalBytes: 14 }]) {
    const partial: string[] = [];
    const limited = await collectChangedFiles(root, ["demo.html"], async (_, name) => { partial.push(name); }, options);
    assert.deepEqual(partial, []);
    assert.equal(limited.omitted.length, 1);
    assert.equal(limited.omitted[0].path, "demo.html");
  }
});

test("managed outputs reject a substituted root and sidecar symlinks outside collection roots", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-output-containment-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outputs = path.join(root, "outputs");
  fs.mkdirSync(project);
  fs.mkdirSync(outputs);
  fs.writeFileSync(path.join(outputs, "demo.html"), "html");
  const secret = path.join(root, "secret.json");
  fs.writeFileSync(secret, "private");
  try { fs.symlinkSync(secret, path.join(outputs, "demo.html.pp-agent.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip("symlinks unavailable"); return; } throw error; }
  const uploaded: string[] = [];
  const result = await collectChangedFiles(project, [], async (_, name) => { uploaded.push(name); }, { managedOutputRoot: outputs });
  assert.deepEqual(uploaded, []);
  assert.equal(result.omitted[0].reason, "outside_project");
  const substituted = path.join(root, "substituted");
  fs.symlinkSync(outputs, substituted, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => collectChangedFiles(project, [], async () => undefined, { managedOutputRoot: substituted }), /普通文件夹/);
});

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

test("changed files share a byte budget and leave oversized batches available for on-demand fetch", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-budget-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, body] of [["a.zip", "1234"], ["b.zip", "1234"], ["c.zip", "12"]]) fs.writeFileSync(path.join(root, name), body);
  const uploaded: string[] = [];
  const result = await collectChangedFiles(root, ["a.zip", "b.zip", "c.zip"], async (_, name) => { uploaded.push(name); }, { maximumTotalBytes: 6 });
  assert.deepEqual(uploaded, ["a.zip", "c.zip"]);
  assert.equal(result.uploadedBytes, 6);
  assert.deepEqual(result.omitted, [{ path: "b.zip", reason: "total_size_limit" }]);
  assert.equal(fs.readFileSync(path.join(root, "b.zip"), "utf8"), "1234");
});


test("automatic results deliver 256 files and leave overflow intact on the execution computer", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-result-count-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = Array.from({ length: 257 }, (_, index) => {
    const name = `result-${index}.md`;
    fs.writeFileSync(path.join(root, name), "result");
    return name;
  });
  const uploaded: string[] = [];
  const result = await collectChangedFiles(root, files, async (_, name) => { uploaded.push(name); });
  assert.deepEqual(uploaded, files.slice(0, 256));
  assert.equal(result.uploaded, 256);
  assert.equal(result.uploadedBytes, 256 * 6);
  assert.deepEqual(result.omitted, [{ path: files[256], reason: "count_limit" }]);
  assert.equal(fs.readFileSync(path.join(root, files[256]), "utf8"), "result");
});
