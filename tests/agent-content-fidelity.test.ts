import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_OPTIONAL_AGENT_CAPABILITIES } from "../server/optional-capabilities.js";
import { startAppServerTurn, summarizeAppServerItem } from "../server/app-server-turn.js";
import { summarizeEvent as legacySummary } from "../server/codex-runner.js";
import { summarizeEvent as workerSummary } from "../server/codex-events.js";

const command = "$c.Name -eq 'codex.exe'; Get-Content C:\\Users\\ExampleUser\\.codex\\config.toml; codex --version";
const markdown = ["检查 Codex / ChatGPT", "", "```powershell", command, "```", "", "[文档](https://chatgpt.com/codex) 与 `CODEX_HOME`"].join("\n");

test("agent progress and copyable commands retain literal executable names, paths and URLs", () => {
  for (const summarize of [legacySummary, workerSummary]) {
    const message = summarize({ type: "item.completed", item: { type: "agent_message", text: markdown } } as never) as {detail:string};
    assert.equal(message.detail, markdown);
    const execution = summarize({ type: "item.started", item: { type: "command_execution", status: "in_progress", command } } as never) as {detail:string};
    assert.equal(execution.detail, command);
    const error = summarize({ type: "error", message: "Cannot open .codex/config.toml" } as never) as {label:string};
    assert.equal(error.label,"Cannot open .codex/config.toml");
  }
  assert.equal((workerSummary({ type: "item.updated", item: { type: "agent_message", text: markdown } } as never) as {detail:string}).detail, markdown);
  assert.equal((summarizeAppServerItem({ type: "agentMessage", text: markdown }, true) as {detail:string}).detail, markdown);
  assert.equal((summarizeAppServerItem({ type: "commandExecution", command, status: "inProgress" }, false) as {detail:string}).detail, command);
});

test("live app-server streaming and completed feedback preserve a copyable recovery command", { timeout: 10_000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-content-fidelity-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, "app-server");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const readline = require('node:readline');
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialize') send({id:m.id,result:{}});
 else if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'root'}}});
 else if (m.method === 'turn/start') {
   send({id:m.id,result:{turn:{id:'turn'}}});
   setTimeout(() => {
     send({method:'item/agentMessage/delta',params:{threadId:'root',turnId:'turn',itemId:'answer',delta:${JSON.stringify(markdown)}}});
     send({method:'item/completed',params:{threadId:'root',item:{type:'agentMessage',text:${JSON.stringify(markdown)}}}});
     send({method:'turn/completed',params:{threadId:'root',turn:{id:'turn',status:'completed'}}});
   },10);
 } else if (typeof m.id === 'number') send({id:m.id,result:{}});
});
`, {mode:0o755});
  const progress: Array<{kind?: string; detail?: string}> = [];
  const execution = startAppServerTurn({executablePath:fake,cwd:root,env:process.env,threadId:null,prompt:"test",imagePaths:[],model:"test",reasoningEffort:"low",library:root,shellEnvironment:{},networkAccessEnabled:false,webSearchMode:"cached",optionalCapabilities:DEFAULT_OPTIONAL_AGENT_CAPABILITIES,codexEgressKind:"unchanged"}, {
    signal:new AbortController().signal,onThreadStarted:()=>{},onProgress:value=>progress.push(value as {kind?:string;detail?:string}),
  });
  assert.equal(await execution.result, markdown);
  assert.equal(progress.find(value=>value.kind === "assistant_stream")?.detail, markdown);
  assert.equal(progress.find(value=>value.kind === "update")?.detail, markdown);
});
