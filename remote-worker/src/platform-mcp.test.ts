import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ensureAntigravityMcpConfig } from "./antigravity-runtime.js";
import { createPlatformMcpHandler, platformAutomationConfig, workerPlatformTools } from "./platform-mcp.js";

test("platform MCP is scoped to the current job and rejects unavailable tools", async () => {
  assert.equal(platformAutomationConfig({}), null);
  assert.deepEqual(workerPlatformTools(null), []);
  const handler = createPlatformMcpHandler([{ name: "authorized", description: "test", inputSchema: { type: "object" }, call: async () => "ok" }]);
  const init = await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) as any;
  assert.deepEqual(init.result.capabilities, { tools: {} });
  const list = await handler({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any;
  assert.equal(list.result.tools[0].name, "authorized");
  assert.equal("call" in list.result.tools[0], false);
  const denied = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "other" } }) as any;
  assert.equal(denied.error.code, -32602);
  const reply = await handler({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "authorized" } }) as any;
  assert.equal(reply.result.content[0].text, "ok");
  assert.equal(await handler({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("AGY MCP config preserves existing servers and contains no job credentials", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-agy-mcp-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".gemini", "config", "mcp_config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { existing: { command: "existing-command" } }, other: true }));
  ensureAntigravityMcpConfig(root, "/app/platform-mcp.js");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.other, true);
  assert.equal(config.mcpServers.existing.command, "existing-command");
  assert.deepEqual(config.mcpServers.pp_agent.args, [path.resolve("/app/platform-mcp.js")]);
  assert.equal(config.mcpServers.pp_agent.env, undefined);
  fs.writeFileSync(file, "not JSON");
  assert.throws(() => ensureAntigravityMcpConfig(root, "/app/platform-mcp.js"));
  assert.equal(fs.readFileSync(file, "utf8"), "not JSON");
});

test("standalone MCP child creates waits through the existing authenticated business handler", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-platform-mcp-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests: Array<{ path: string; authorization: string | undefined; body: any }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      requests.push({ path: request.url!, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ wakePlan: { id: "wake-1", deadline_at: "2026-10-23T15:00:00Z", agent_model: "antigravity:gemini-test", reasoning_effort: "high", target_conversation_id: "conversation-1" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address() as { port: number };
  const child = spawn(process.execPath, [fileURLToPath(new URL("./platform-mcp.js", import.meta.url))], {
    env: { ...process.env, CODEX_WEB_AUTOMATION_BASE_URL: `http://127.0.0.1:${address.port}`, CODEX_WEB_AUTOMATION_TOKEN: "job-only-test-token", CODEX_WEB_AUTOMATION_JOB_ID: "job-1", CODEX_WEB_AUTOMATION_RECEIPT_DIR: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = readline.createInterface({ input: child.stdout });
  const reply = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP child did not reply")), 5000);
    lines.once("line", (line) => { clearTimeout(timeout); resolve(JSON.parse(line)); });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_web_schedule_wait", arguments: { mode: "after", delaySeconds: 60, successPrompt: "Continue this task" } } }) + "\n");
  const result = await reply;
  assert.equal(result.result.isError, false);
  assert.equal(JSON.parse(result.result.content[0].text).scheduled, true);
  assert.equal(requests[0]?.path, "/api/automation/jobs/job-1/wake-plans");
  assert.equal(requests[0]?.authorization, "Bearer job-only-test-token");
  assert.equal(requests[0]?.body.mode, "time");
  assert.equal(requests[0]?.body.delaySeconds, 60);
  assert.equal(requests[0]?.body.model, undefined);
  assert.equal(requests[0]?.body.reasoningEffort, undefined);
  child.stdin.end();
});
