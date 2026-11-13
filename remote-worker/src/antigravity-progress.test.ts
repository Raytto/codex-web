import assert from "node:assert/strict";
import test from "node:test";
import { antigravityToolProgress } from "./antigravity-progress.js";

test("AGY tool progress explains the action and selected target instead of raw tool names", () => {
  assert.deepEqual(antigravityToolProgress("search_web", { query: "季度销售同比计算" }, false, false),
    { kind: "search", label: "正在搜索网页", detail: "季度销售同比计算" });
  assert.deepEqual(antigravityToolProgress("read_file", { AbsolutePath: "C:\\reports\\sales.csv" }, true, false),
    { kind: "tool", label: "文件读取完成", detail: "sales.csv" });
  // CLI 1.4.6 native capture uses Path for read_file.
  assert.equal(antigravityToolProgress("read_file", { Path: "/tmp/input.txt" }, false, false).detail, "input.txt");
  assert.deepEqual(antigravityToolProgress("call_mcp_tool", { ToolName: "web_search", Arguments: { credential: "private" } }, false, false),
    { kind: "tool", label: "正在调用扩展工具", detail: "web_search" });
  assert.equal(antigravityToolProgress("read_file", {}, false, false).label, "正在读取文件");
  assert.equal(antigravityToolProgress("write_to_file", { TargetFile: "/tmp/report.txt" }, false, false).label, "正在更新文件");
});

test("AGY failure never displays a successful completion and unrecognized tools have a readable fallback", () => {
  for (const name of ["read_file", "search_web", "run_command", "write_to_file", "read_url_content", "list_dir", "call_mcp_tool", "new_tool"]) {
    assert.match(antigravityToolProgress(name, {}, true, true).label, /失败/);
    assert.match(antigravityToolProgress(name, {}, false, false).label, /^正在/);
  }
});

test("AGY progress excludes arbitrary inputs, URL credentials, secret values and excessive content", () => {
  const call = antigravityToolProgress("read_url_content", { Url: "https://user:private@example.com/docs?q=secret#private", output: "private-result" }, false, false);
  assert.equal(call.detail, "https://example.com/docs");
  const search = antigravityToolProgress("search_web", { Query: "天气 token=private-value\n" + "气".repeat(1000), output: "private-result" }, false, false);
  assert.ok(search.detail!.length <= 240);
  assert.doesNotMatch(search.detail!, /private|\n/);
});
