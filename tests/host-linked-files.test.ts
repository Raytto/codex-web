import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeHostLinkedFiles } from "../server/host-linked-files.js";

test("CODEX_WEB host replies promote explicit local file links into output attachments", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-linked-files-"));
  const workspace = path.join(root, "conversation");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(workspace, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const absolute = path.join(root, "server notes.md");
  fs.writeFileSync(absolute, "absolute", "utf8");
  fs.writeFileSync(path.join(project, "docs", "guide.md"), "relative", "utf8");
  fs.writeFileSync(path.join(project, ".env"), "secret-but-explicitly-linked", "utf8");
  const response = [
    `[绝对文件](<${absolute}:12>)`,
    `[重复引用](<${absolute}>)`,
    `[${absolute}](<${absolute}>)`,
    "[项目文件](docs/guide.md)",
    "[隐藏文件](.env)",
    "[网站](https://example.com/file.md)",
    `纯文字路径不提升：${path.join(root, "plain.txt")}`,
  ].join("\n");

  const result = await materializeHostLinkedFiles(response, workspace, project);
  assert.equal(result.omissions.length, 0);
  assert.equal(result.delivered.length, 3);
  assert.match(result.finalResponse, /\[绝对文件\]\(<outputs\/server notes\.md>\)/);
  assert.match(result.finalResponse, /\[重复引用\]\(<outputs\/server notes\.md>\)/);
  assert.match(result.finalResponse, new RegExp(`\\[${absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(<outputs/server notes\\.md>\\)`));
  assert.match(result.finalResponse, /\[项目文件\]\(outputs\/guide\.md\)/);
  assert.match(result.finalResponse, /\[隐藏文件\]\(outputs\/download-env\)/);
  assert.match(result.finalResponse, /\[网站\]\(https:\/\/example\.com\/file\.md\)/);
  assert.match(result.finalResponse, /纯文字路径不提升/);
  assert.equal(fs.readFileSync(path.join(workspace, "outputs", "server notes.md"), "utf8"), "absolute");
  assert.equal(fs.readFileSync(path.join(workspace, "outputs", "guide.md"), "utf8"), "relative");
  assert.equal(fs.readFileSync(path.join(workspace, "outputs", "download-env"), "utf8"), "secret-but-explicitly-linked");
});

test("host linked-file promotion keeps failures visible and enforces transfer bounds", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-linked-limits-"));
  const workspace = path.join(root, "conversation");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(workspace, "outputs"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, "large.bin"), "12345", "utf8");

  const result = await materializeHostLinkedFiles(
    "[过大](large.bin)\n[不存在](/missing/file.txt)\n[目录](.)",
    workspace,
    project,
    { maxFileBytes: 4 },
  );
  assert.deepEqual(result.omissions.map((item) => item.reason), ["too_large", "missing", "not_file"]);
  assert.equal(result.delivered.length, 0);
  assert.match(result.finalResponse, /\[过大\]\(large\.bin\)/);
});

test("host worker materializes linked files before publishing its terminal event", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server", "host-root-job.ts"), "utf8");
  assert.match(source, /materializeHostLinkedFiles\(finalResponse, message\.request\.workspace, message\.request\.knowledgeRoot\)/);
  assert.match(source, /type: "completed", finalResponse: `\$\{linkedFiles\.finalResponse\}\$\{omissionNotice\}`/);
});
