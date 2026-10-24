import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectChangedFiles } from "./changed-files.js";
import { uploadFile } from "./file-upload.js";

test("automatic HTML and declaration upload preserves MIME, bytes and declaration hash over HTTP", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-html-upload-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outputs = path.join(root, "outputs");
  fs.mkdirSync(project);
  fs.mkdirSync(outputs);
  const html = "<!doctype html><html><body><button onclick=\"this.textContent='已点击'\">开始</button></body></html>";
  const sha256 = crypto.createHash("sha256").update(html).digest("hex");
  const declaration = JSON.stringify({ presentation_mode: "web", sha256 });
  for (const name of ["演示.html", "upper.HTM"]) {
    fs.writeFileSync(path.join(outputs, name), html);
    fs.writeFileSync(path.join(outputs, `${name}.pp-agent.json`), declaration);
  }
  const received: Array<{ name: string; type: string | undefined; length: number; body: Buffer }> = [];
  const server = http.createServer(async (request, response) => {
    assert.equal(request.method, "PUT");
    assert.equal(request.headers.authorization, "Bearer test-transfer-token");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    received.push({ name: decodeURIComponent(String(request.headers["x-file-name"])), type: request.headers["content-type"],
      length: Number(request.headers["content-length"]), body });
    response.writeHead(201, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const result = await collectChangedFiles(project, [], async (file, name) => {
    const response = await uploadFile(`http://127.0.0.1:${address.port}/output`, "test-transfer-token", file, name);
    assert.equal(response.status, 201);
    await response.json();
  }, { managedOutputRoot: outputs });
  assert.equal(result.uploaded, 4);
  assert.deepEqual(result.omitted, []);
  for (const file of received) {
    assert.equal(file.length, file.body.length);
    if (file.name.endsWith(".pp-agent.json")) {
      assert.equal(file.type, "application/json");
      assert.deepEqual(JSON.parse(file.body.toString("utf8")), { presentation_mode: "web", sha256 });
    } else {
      assert.equal(file.type, "text/html");
      assert.equal(file.body.toString("utf8"), html);
      assert.equal(crypto.createHash("sha256").update(file.body).digest("hex"), sha256);
    }
  }
});
