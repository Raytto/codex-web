import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AntigravityExecution, buildAntigravityArguments, type AntigravityTurnOptions } from "./antigravity-client.js";
import { ensureAntigravityInstalled, ensureAntigravityMcpConfig, managedAntigravityExecutable, normalizeAntigravityModels, readAntigravityModels, resolveAntigravityModel } from "./antigravity-runtime.js";

function fixture(context: test.TestContext, source: string): { root: string; executable: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-agy-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "agy.cjs");
  fs.writeFileSync(executable, source);
  return { root, executable };
}
const prelude = `
  const fs=require('node:fs'), readline=require('node:readline');
  const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
  const lines=readline.createInterface({input:process.stdin});
  const args=process.argv.slice(2);
  const conversation=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:'agy-native-thread';
  const init=()=>emit({event:'init',conversation_id:conversation,init:{permission_mode:'always-proceed'}});
  const step=value=>emit({event:'step_update',step_update:{conversation_id:conversation,step_index:1,...value}});
  const result=(value={})=>emit({event:'result',result:{conversation_id:conversation,status:'SUCCESS',response:'Finished',...value}});
`;
function run(root: string, executable: string, overrides: Partial<AntigravityTurnOptions> = {}) {
  const progress: Array<Record<string, unknown>> = [], threads: string[] = [], changed: string[] = [];
  const controller = new AbortController();
  let authCount = 0;
  const execution = new AntigravityExecution({ cwd: root, executablePath: executable, threadId: null, prompt: "complete this task", model: "gemini-test-high", reasoningEffort: "high", ...overrides }, {
    signal: controller.signal, onThreadStarted: (id) => threads.push(id), onProgress: (item) => progress.push(item as Record<string, unknown>),
    onAuthReady: () => { authCount++; }, onChangedFile: (file) => changed.push(file),
  });
  return { execution, controller, progress, threads, changed, authCount: () => authCount };
}

test("AGY streams one request, preserves native resume ids and run environment without prompt argv", async (context) => {
  const { root, executable } = fixture(context, `${prelude}
    lines.on('line',line=>{
      const event=JSON.parse(line);
      fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,event,outputs:process.env.CWW_OUTPUTS_DIR,marker:process.env.REQUEST_MARKER}));
      init(); step({step_type:'user_input',state:'DONE'});
      step({step_index:2,step_type:'agent_response',state:'ACTIVE',text_delta:'First '});
      step({step_index:2,step_type:'agent_response',state:'DONE',text_delta:'response'});
      step({conversation_id:'child-thread',step_type:'agent_response',text_delta:'must not leak'});
      step({step_index:3,step_type:'tool',state:'DONE',tool_name:'write_to_file',tool_info:{parameters:{TargetFile:'result.txt'}}});
      result({response:'First response'});
    });
  `);
  const before = process.env.CWW_OUTPUTS_DIR;
  for (const threadId of [null, "existing-agy-thread"]) {
    const capture = path.join(root, "capture.json");
    const running = run(root, executable, {
      threadId, env: { ...process.env, CAPTURE: capture }, threadInstructions: "Read the shared AGENTS.md", shellEnvironment: { REQUEST_MARKER: "request-only" },
      directories: { outputs: path.join(root, "outputs"), uploads: path.join(root, "uploads"), runtime: path.join(root, "runtime") },
    });
    assert.equal(await running.execution.result, "First response");
    assert.deepEqual(running.threads, [threadId ?? "agy-native-thread"]);
    assert.equal(running.authCount(), 1);
    assert.deepEqual(running.changed, ["result.txt"]);
    assert.equal(running.progress.some((item) => String(item.detail).includes("must not leak")), false);
    assert.ok(running.progress.some((item) => item.kind === "assistant_stream" && item.detail === "First response"));
    const data = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(data.args.includes("--continue"), false);
    assert.equal(data.args.includes("--conversation"), Boolean(threadId));
    assert.equal(data.args.includes("complete this task"), false);
    assert.equal(data.event.event, "user");
    assert.match(data.event.message.content, /shared AGENTS.md/);
    assert.match(data.event.message.content, /公开工作说明/);
    assert.equal(data.outputs, path.join(root, "outputs"));
    assert.equal(data.marker, "request-only");
  }
  assert.equal(process.env.CWW_OUTPUTS_DIR, before);
});

test("AGY emits readable call targets, failed read state, and keeps tool outputs out of progress", async (context) => {
  const { root, executable } = fixture(context, `${prelude}lines.on('line',()=>{
    init();
    step({step_type:'tool',tool_name:'search_web',state:'ACTIVE',tool_info:{parameters:{query:'季度销售同比计算'}}});
    step({step_type:'tool',tool_name:'search_web',state:'DONE',tool_info:{parameters:{query:'季度销售同比计算'},output:'private-result'}});
    step({step_type:'tool',tool_name:'read_file',state:'DONE',tool_info:{parameters:{AbsolutePath:'/tmp/sales.csv'},error:{message:'file does not exist'}}});
    result();
  });`);
  const running = run(root, executable);
  await running.execution.result;
  assert.ok(running.progress.some(item => item.label === "正在搜索网页" && item.detail === "季度销售同比计算"));
  assert.ok(running.progress.some(item => item.label === "文件读取失败" && item.detail === "sales.csv"));
  assert.doesNotMatch(JSON.stringify(running.progress), /private-result|文件读取完成/);
});

test("AGY never reports success after a denied tool, trailing stderr denial, partial timeout, or nonzero exit", async (context) => {
  const scenarios = [
    { body: `step({step_type:'tool',tool_name:'write_to_file',state:'DONE',tool_info:{error:{type:'PERMISSION_DENIED',message:'Policy blocked write'}}});result();`, expected: /权限规则拒绝/ },
    { body: `result();process.stderr.write('Permission denied by workspace policy\\n');`, expected: /权限规则拒绝/ },
    { body: `result();process.stderr.write('Warning: print-timeout reached; partial output returned\\n');`, expected: /部分结果/ },
    { body: `result();process.exitCode=3;`, expected: /未完成/ },
    { body: `result({status:'ERROR',error:'model capacity exhausted'});`, expected: /capacity/ },
    { body: `result({status:'WAITING',response:'Please approve'});`, expected: /WAITING/ },
    { body: `result({response:''});`, expected: /空结果/ },
    { body: `process.stdin.destroy();`, expected: /未返回最终结果/ },
  ];
  for (const scenario of scenarios) {
    const { root, executable } = fixture(context, `${prelude}lines.on('line',()=>{init();${scenario.body}});`);
    const running = run(root, executable);
    await assert.rejects(running.execution.result, scenario.expected);
    assert.equal(running.progress.some((item) => String(item.label).includes("工作已完成")), false);
  }
});

test("AGY handles cancellation, rejects unsupported steer, and terminates its process", async (context) => {
  const { root, executable } = fixture(context, `${prelude}lines.on('line',()=>{init();step({step_type:'user_input',state:'DONE'});});setInterval(()=>{},1000);`);
  const running = run(root, executable);
  await assert.rejects(running.execution.steer("change this"), /不支持.*实时调整/);
  const result = assert.rejects(running.execution.result, (error: Error) => error.name === "AbortError");
  running.controller.abort();
  await result;
});

test("AGY refuses wrong resume identifiers, malformed output, and unconfirmed visual input", async (context) => {
  for (const body of [
    `emit({event:'init',conversation_id:'someone-elses-thread'});`,
    `process.stdout.write('not json\\n');`,
  ]) {
    const { root, executable } = fixture(context, `${prelude}lines.on('line',()=>{${body}});`);
    await assert.rejects(run(root, executable, { threadId: "expected-thread" }).execution.result, /会话标识|无效的流数据/);
  }
  assert.throws(() => buildAntigravityArguments({ cwd: "/tmp", threadId: null, prompt: "test", model: "antigravity:gemini-test", reasoningEffort: "high" }), /尚未解析/);
  assert.throws(() => buildAntigravityArguments({ cwd: "/tmp", threadId: null, prompt: "test", model: "gemini-test-high", reasoningEffort: "high", imagePaths: ["photo.png"] }), /不支持直接预载图片/);
});

test("AGY catalog groups only advertised effort variants and keeps exact executable slugs", () => {
  const catalog = normalizeAntigravityModels({ models: ["gemini-test-high", "gemini-test-low", "claude-fixed-thinking", "gpt-test-medium"], display_names: { "gemini-test-high": "Gemini Test (High)", "gemini-test-low": "Gemini Test (Low)" } });
  assert.ok(catalog);
  assert.equal(catalog.models[0]?.label, "Gemini Test");
  assert.deepEqual(catalog.models[0]?.reasoningEfforts, ["low", "high"]);
  assert.deepEqual(resolveAntigravityModel(catalog, "antigravity:gemini-test", "high"), { model: "gemini-test-high", reasoningEffort: "high" });
  assert.throws(() => resolveAntigravityModel(catalog, "antigravity:gemini-test", "xhigh"), /不支持此思考深度/);
  assert.deepEqual(resolveAntigravityModel(catalog, "antigravity:claude-fixed-thinking", "default"), { model: "claude-fixed-thinking", reasoningEffort: "" });
  assert.equal(normalizeAntigravityModels({ models: [] }), null);
  assert.equal(normalizeAntigravityModels({ models: [{ slug: "hidden-model", available: false }] }), null);
  assert.deepEqual(normalizeAntigravityModels({ models: [{ slug: "gemini-flex", efforts: ["low", "max"], default_effort: "max" }] })?.models[0]?.reasoningEfforts, ["low", "max"]);
  // Actual 1.4.6 no-inference command envelope; model names below are fixture data.
  const official = normalizeAntigravityModels({ conversation_id: "", status: "SUCCESS", response: "unused TSV display", usage: { total_tokens: 0 }, command: { name: "models", data: { models: [{ id: "gemini-test-high", label: "Gemini Test (High)" }, { id: "gemini-test-low", label: "Gemini Test (Low)" }] } } });
  assert.deepEqual(official?.models[0]?.reasoningEfforts, ["low", "high"]);
  assert.equal(normalizeAntigravityModels({ status: "ERROR", command: { name: "models", data: { models: [{ id: "gemini-test-high" }] } } }), null);
});

test("AGY catalogs preserve model families while grouping them under the execution engine", () => {
  const catalog = normalizeAntigravityModels({ status: "SUCCESS", command: { name: "models", data: { models: [
    { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
    { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ] } } });
  assert.ok(catalog);
  assert.deepEqual(catalog.models.map(model => model.label), ["Gemini 4 Argon", "Claude Opus 5.5", "GPT-OSS 120B"]);
  assert.ok(catalog.models.every(model => model.providerLabel === "Antigravity" && model.engineId === "antigravity"));
  assert.deepEqual(catalog.models[1]?.reasoningEfforts, ["low", "high"]);
  assert.deepEqual(resolveAntigravityModel(catalog, "antigravity:claude-opus-5-5", "high"), { model: "claude-opus-5-5-high", reasoningEffort: "high" });
  assert.deepEqual(catalog.models[2]?.reasoningEfforts, ["medium"]);
  assert.throws(() => resolveAntigravityModel(catalog, "antigravity:gpt-oss-120b", "high"), /不支持此思考深度/);
});

test("AGY model discovery requires CLI auth and places global flags before the subcommand", async (context) => {
  const { root, executable } = fixture(context, `
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--output-format','json','models'])) process.exit(4);
    if (process.env.SIGNED_IN !== 'yes') { process.stderr.write('Please sign in to view available models.'); process.exit(1); }
    process.stdout.write(JSON.stringify({models:['gemini-test-high']}));
  `);
  await assert.rejects(readAntigravityModels({ executable, cwd: root, env: { ...process.env, SIGNED_IN: "no" } }), /sign in/);
  assert.equal((await readAntigravityModels({ executable, cwd: root, env: { ...process.env, SIGNED_IN: "yes" } }))?.models[0]?.id, "antigravity:gemini-test");
});

test("AGY initializes the official login's empty MCP placeholder and preserves existing servers", context => {
  const { root } = fixture(context, "");
  const directory = path.join(root, ".gemini", "config");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "mcp_config.json");
  const entrypoint = path.join(root, "platform-mcp.js");
  for (const content of ["", " \n\t\r\n"]) {
    fs.writeFileSync(file, content);
    ensureAntigravityMcpConfig(root, entrypoint);
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(config.mcpServers.pp_agent, { command: process.execPath, args: [entrypoint], timeoutSeconds: 120 });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(directory), ["mcp_config.json"], "atomic replacement must leave no temporary file");
  }
  const otherServer = { command: "existing-command", args: ["existing-argument"], env: { FIXTURE: "preserved" } };
  fs.writeFileSync(file, JSON.stringify({ preference: "keep", mcpServers: { other: otherServer } }));
  ensureAntigravityMcpConfig(root, entrypoint);
  const updated = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(updated.preference, "keep"); assert.deepEqual(updated.mcpServers.other, otherServer);
  const before = fs.statSync(file), bytes = fs.readFileSync(file);
  ensureAntigravityMcpConfig(root, entrypoint);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs, "an unchanged config is not rewritten");
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("AGY refuses nonempty malformed or nonobject MCP config without replacing its bytes", context => {
  const { root } = fixture(context, "");
  const directory = path.join(root, ".gemini", "config");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "mcp_config.json");
  for (const content of ['{"mcpServers":', "null", "[]", '"text"']) {
    fs.writeFileSync(file, content);
    assert.throws(() => ensureAntigravityMcpConfig(root, path.join(root, "platform-mcp.js")), /Gemini MCP 配置不是有效.*未覆盖原配置/);
    assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.deepEqual(fs.readdirSync(directory), ["mcp_config.json"]);
  }
});

test("managed AGY installation rejects a tampered vendor download before any executable is installed", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-agy-install-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.redirect, "error");
    return new Response("not the checksum-verified vendor archive", { status: 200 });
  };
  context.after(() => { globalThis.fetch = previousFetch; });
  await assert.rejects(ensureAntigravityInstalled({ root }), /SHA-512/);
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\/1\.4\.6-/);
  assert.equal(managedAntigravityExecutable(root), null);
  const parent = path.join(root, "runtime", "1.4.6", `${process.platform}-${process.arch}`);
  assert.deepEqual(fs.readdirSync(parent), []);
});
