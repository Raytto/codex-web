import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
process.env.CWW_ANTIGRAVITY_TITLE_MODEL = "antigravity:gemini-title-fixture";
process.env.CWW_ANTIGRAVITY_TITLE_EFFORT = "low";
const { parseAntigravityTitleOutput, runAntigravityConversationTitle } = await import("./antigravity-title.js");
import { normalizeAntigravityModels } from "./antigravity-runtime.js";

test("Gemini naming resolves exact Flash low, uses a tool-free agent and cleans its isolated workspace", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "title-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const capture = path.join(root, "capture.json"), executable = path.join(root, "fake.cjs");
  fs.writeFileSync(executable, `
    const fs=require('node:fs'),readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line', line=>{
      fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),agent:fs.readFileSync('.agents/agents/codex-web-title/agent.md','utf8'),env:process.env,input:JSON.parse(line)}));
      console.log(JSON.stringify({event:'init',conversation_id:'title-native'}));
      console.log(JSON.stringify({event:'result',result:{conversation_id:'title-native',status:'SUCCESS',response:'{"title":"整理季度销售"}'}}));
    });`);
  const catalog = normalizeAntigravityModels({ models: [{ id: 'gemini-title-fixture-low' }, { id: 'gemini-title-fixture-high' }] })!;
  const trusted = { runtime: { executable, home: root, accountId: "test", env: { ...process.env, CAPTURE: capture, CWW_JOB_TOKEN: "not-for-title", CWW_OUTPUTS_DIR: "not-for-title" } }, catalog };
  assert.equal(await runAntigravityConversationTitle("整理季度销售", 15000, trusted, new AbortController().signal), '{"title":"整理季度销售"}');
  const data = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(data.args[data.args.indexOf('--model')+1], 'gemini-title-fixture-low');
  assert.equal(data.args[data.args.indexOf('--effort')+1], 'low');
  assert.equal(data.args[data.args.indexOf('--agent')+1], 'codex-web-title');
  assert.equal(data.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(data.args.includes('--conversation'), false);
  assert.match(data.agent, /tools: \[\]/);
  assert.match(data.agent, /subagent: false/);
  assert.equal(data.env.CWW_JOB_TOKEN, undefined);
  assert.equal(data.env.CWW_OUTPUTS_DIR, undefined);
  assert.equal(fs.existsSync(data.cwd), false);
  const missing = normalizeAntigravityModels({ models: [{ id: 'gemini-4-argon-low' }] })!;
  await assert.rejects(runAntigravityConversationTitle("整理销售", 15000, { ...trusted, catalog: missing }, new AbortController().signal));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(runAntigravityConversationTitle("整理销售", 15000, trusted, aborted.signal), { name: 'AbortError' });
});

test("Gemini repeated structured results are normalized but malformed or oversized output fails", () => {
  assert.equal(parseAntigravityTitleOutput('{"title":"分析销售增长"}\n{"title":"整理季度销售"}'), '{"title":"整理季度销售"}');
  assert.equal(parseAntigravityTitleOutput('```json\n{"title":"整理季度销售"}\n```'), '{"title":"整理季度销售"}');
  for (const output of ['{"title":"这是一个超过十个字符的长标题"}', '{"title":"整理销售"}\nnot JSON', 'null', '']) assert.throws(() => parseAntigravityTitleOutput(output));
});
