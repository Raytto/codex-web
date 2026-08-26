import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changedFilePaths, CODEX_QUOTA_REFRESH_INTERVAL_MS, CodexExecution, codexNotificationBelongsToThread, makeUserInput, normalizeCodexQuotaUsage, normalizeContextUsage, normalizeThreadSnapshot, PROJECT_SYNC_SOURCE_KINDS, summarizeCodexItem, waitAutomationEnvironment } from "./codex-client.js";
import { buildRemoteOptionalCapabilityConfig, buildRemoteTurnPrompt } from "./agent-context.js";
import { WAIT_DYNAMIC_TOOL_SPEC } from "./wait-dynamic-tool.js";

test("project sync includes non-interactive exec threads", () => {
  assert.deepEqual(PROJECT_SYNC_SOURCE_KINDS, ["cli", "vscode", "exec"]);
});

test("wait automation is injected into Codex tool shells without changing the worker process environment", () => {
  const environment = waitAutomationEnvironment({ baseUrl: "https://codex-web.test", token: "scoped-token", jobId: "job-1" });
  assert.equal(environment.CODEX_WEB_AUTOMATION_BASE_URL, "https://codex-web.test");
  assert.equal(environment.CODEX_WEB_AUTOMATION_TOKEN, "scoped-token");
  assert.equal(environment.CODEX_WEB_AUTOMATION_JOB_ID, "job-1");
  assert.match(environment.CODEX_WEB_WAIT_CLI, /wait-cli\.js$/);
  assert.deepEqual(waitAutomationEnvironment(), {});
  assert.ok("model" in WAIT_DYNAMIC_TOOL_SPEC.inputSchema.properties);
  assert.ok("reasoningEffort" in WAIT_DYNAMIC_TOOL_SPEC.inputSchema.properties);
  assert.match(WAIT_DYNAMIC_TOOL_SPEC.description, /only pass model or reasoningEffort for an explicit user request/);
});

test("steer input keeps supplemental images on the same Codex turn", () => {
  assert.deepEqual(makeUserInput("adjust", ["C:\\runs\\image.png"]), [
    { type: "text", text: "adjust", text_elements: [] },
    { type: "localImage", path: "C:\\runs\\image.png" },
  ]);
});

test("sub-agent notifications cannot replace Remote Worker root turn state", () => {
  assert.equal(codexNotificationBelongsToThread("root-thread", { threadId: "root-thread" }), true);
  assert.equal(codexNotificationBelongsToThread("root-thread", { threadId: "child-thread" }), false);
  assert.equal(codexNotificationBelongsToThread("root-thread", {}), true);
  assert.equal(codexNotificationBelongsToThread(null, { threadId: "child-thread" }), true);

  assert.deepEqual(changedFilePaths({
    threadId: "child-thread",
    item: { type: "fileChange", changes: [{ path: "src/child.ts" }, { file_path: "docs/result.md" }] },
  }), ["src/child.ts", "docs/result.md"]);
  assert.deepEqual(changedFilePaths({ threadId: "child-thread", item: { type: "agentMessage", text: "child reply" } }), []);

  const source = fs.readFileSync(path.join(process.cwd(), "src", "codex-client.ts"), "utf8");
  assert.match(source, /if \(!belongsToRootThread\) \{/);
  assert.match(source, /for \(const changed of changedFilePaths\(params\)\) this\.callbacks\.onChangedFile\(changed\);/);
});

test("Remote Worker isolates interleaved sub-agent state while retaining its changed files", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-app-server-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeAppServer = path.join(root, "fake-app-server.js");
  fs.writeFileSync(fakeAppServer, `
    const readline = require("node:readline");
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") send({ id: message.id, result: {} });
      else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "root-thread" } } });
      else if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: "root-turn" } } });
        setTimeout(() => {
          send({ method: "turn/started", params: { threadId: "root-thread", turn: { id: "root-turn" } } });
          send({ method: "item/completed", params: { threadId: "root-thread", item: { type: "subAgentActivity", kind: "started", agentThreadId: "child-thread", agentPath: "/root/child_audit" } } });
          send({ method: "turn/started", params: { threadId: "child-thread", turn: { id: "child-turn" } } });
          send({ method: "thread/tokenUsage/updated", params: { threadId: "child-thread", tokenUsage: { last: { inputTokens: 900 }, modelContextWindow: 1000 } } });
          send({ method: "item/completed", params: { threadId: "child-thread", item: { type: "agentMessage", phase: "final_answer", text: "child final" } } });
          send({ method: "item/completed", params: { threadId: "child-thread", item: { type: "fileChange", changes: [{ path: "src/child.ts" }] } } });
          send({ method: "thread/tokenUsage/updated", params: { threadId: "root-thread", tokenUsage: { last: { inputTokens: 100 }, modelContextWindow: 1000 } } });
          send({ method: "turn/completed", params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } } });
          send({ method: "item/completed", params: { threadId: "root-thread", item: { type: "collabAgentToolCall", status: "completed", receiverThreadIds: [], agentsStates: {} } } });
          send({ method: "item/completed", params: { threadId: "root-thread", item: { type: "agentMessage", text: "root final" } } });
          send({ method: "turn/completed", params: { threadId: "root-thread", turn: { id: "root-turn", status: "completed" } } });
        }, 20);
      } else if (typeof message.id === "number") send({ id: message.id, result: {} });
    });
  `, "utf8");
  const previousRuntime = process.env.CODEX_RUNTIME_PATH;
  process.env.CODEX_RUNTIME_PATH = fakeAppServer;
  context.after(() => {
    if (previousRuntime === undefined) delete process.env.CODEX_RUNTIME_PATH;
    else process.env.CODEX_RUNTIME_PATH = previousRuntime;
  });

  const controller = new AbortController();
  const changedFiles: string[] = [];
  const contextUsages: unknown[] = [];
  const progress: unknown[] = [];
  const execution = new CodexExecution({
    cwd: root, threadId: null, prompt: "test", imagePaths: [], model: "gpt-test", reasoningEffort: "low", optionalCapabilities: {},
  }, {
    signal: controller.signal,
    onThreadStarted: () => undefined,
    onProgress: (payload) => progress.push(payload),
    onContextUsage: (usage) => contextUsages.push(usage),
    onQuotaUsage: () => undefined,
    onChangedFile: (filePath) => changedFiles.push(filePath),
  });

  assert.equal(await execution.result, "root final");
  assert.deepEqual(changedFiles, ["src/child.ts"]);
  assert.deepEqual(contextUsages, [{ threadId: "root-thread", inputTokens: 100, modelContextWindow: 1000 }]);
  assert.equal(progress.some((item) => (item as { kind?: string; detail?: string }).kind === "update" && (item as { detail?: string }).detail === "child final"), false);
  assert.equal(JSON.stringify(progress).includes("child_audit"), true);
  assert.equal(JSON.stringify(progress).includes("child final"), true);
  assert.ok(progress.some((item) => (item as { agents?: Array<{ status?: string }> }).agents?.[0]?.status === "completed"));
});

test("Remote Worker maps live and persisted sub-agent state without child-thread output", () => {
  assert.deepEqual(summarizeCodexItem({
    type: "subAgentActivity", kind: "started", agentThreadId: "agent-a", agentPath: "/root/ui_audit",
  }, true), {
    kind: "agent", label: "协作 Agent 状态更新", agents: [{ id: "agent-a", path: "/root/ui_audit", status: "running" }],
  });
  assert.deepEqual(summarizeCodexItem({
    type: "collabAgentToolCall", status: "completed", receiverThreadIds: ["agent-a"],
    agentsStates: { "agent-a": { status: "completed", message: "audit complete" } },
  }, true), {
    kind: "agent", label: "协作 Agent 状态更新", agents: [{ id: "agent-a", status: "completed", summary: "audit complete" }],
  });
  const snapshot = normalizeThreadSnapshot({
    id: "root", preview: "Root task", createdAt: 100, updatedAt: 120,
    turns: [{ id: "turn", status: "inProgress", startedAt: 101, items: [
      { id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "agent-a", agentPath: "/root/ui_audit" },
      { id: "wait", type: "collabAgentToolCall", status: "completed", receiverThreadIds: ["agent-a"], agentsStates: { "agent-a": { status: "completed", message: "audit complete" } } },
    ] }],
  });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.activities.map((activity) => [activity.itemId, activity.kind, activity.agents?.[0]?.status]), [
    ["spawn", "agent", "running"], ["wait", "agent", "completed"],
  ]);
});

test("remote turn context applies server intent, image gating, and optional capabilities", () => {
  const request = {
    jobId: "00000000-0000-4000-8000-000000000001", conversationId: "00000000-0000-4000-8000-000000000002",
    projectRoot: "C:\\work", codexThreadId: null, prompt: "legacy", attachments: [], transferToken: "x".repeat(43),
    selection: { model: "gpt-test", reasoningEffort: "high" }, optionalCapabilities: { apps: true, remotePlugin: true, goals: false, multiAgent: false, gameAnalysisMcp: false },
    turnContext: { version: 1 as const, userPrompt: "重命名图片", imageInput: "path_only" as const },
  };
  const built = buildRemoteTurnPrompt(request, [{ name: "screen.png", path: "C:\\run\\screen.png", mimeType: "image/png" }]);
  assert.equal(built.imagePaths.length, 0);
  assert.match(built.prompt, /view_image/);
  const capabilityConfig = buildRemoteOptionalCapabilityConfig(request.optionalCapabilities, "修复 GitHub Actions CI 失败") as any;
  assert.deepEqual(capabilityConfig.features, { apps: true, remote_plugin: true, plugins: true, tool_suggest: true, goals: false, multi_agent: false });
  assert.deepEqual(capabilityConfig.plugins, { "spreadsheets@openai-primary-runtime": { enabled: false } });
  assert.equal(capabilityConfig.skills.config.find((skill: { name: string }) => skill.name === "github:gh-fix-ci")?.enabled, true);
  assert.equal(capabilityConfig.skills.config.find((skill: { name: string }) => skill.name === "google-calendar:google-calendar-daily-brief")?.enabled, false);
});

test("context usage reports the latest input size and model window", () => {
  assert.deepEqual(normalizeContextUsage({
    threadId: "thread-context",
    tokenUsage: { last: { inputTokens: 123_456 }, modelContextWindow: 258_400 },
  }), {
    threadId: "thread-context",
    inputTokens: 123_456,
    modelContextWindow: 258_400,
  });
});

test("quota usage reports the tightest general Codex package window", () => {
  assert.equal(CODEX_QUOTA_REFRESH_INTERVAL_MS, 30_000);
  assert.deepEqual(normalizeCodexQuotaUsage({
    rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300 },
      secondary: { usedPercent: 56, windowDurationMins: 10_080 },
    },
  }), { remainingPercent: 44 });
  assert.deepEqual(normalizeCodexQuotaUsage({
    rateLimits: { primary: { usedPercent: 0 } },
    rateLimitsByLimitId: {
      codex_bengalfox: { primary: { usedPercent: 0 } },
      codex: { primary: { usedPercent: 93 } },
    },
  }), { remainingPercent: 7 });
  assert.deepEqual(normalizeCodexQuotaUsage({
    rateLimits: { primary: { used_percent: 48, resets_at: 1787557108 } },
  }), { remainingPercent: 52, resetAt: "2026-08-24T07:38:28.000Z" });
  assert.equal(normalizeCodexQuotaUsage({ rateLimits: { primary: null } }), null);
});

test("thread snapshots keep user messages and only the final assistant message per turn", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-1", name: "App task", createdAt: 100, updatedAt: 110,
    turns: [{
      id: "turn-1", status: "completed", startedAt: 101, completedAt: 109,
      items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Run test" }] },
        { id: "agent-progress", type: "agentMessage", text: "I will inspect it." },
        { id: "command-1", type: "commandExecution", command: "dir" },
        { id: "agent-final", type: "agentMessage", text: "Test completed." },
      ],
    }],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.nameSource, "explicit");
  assert.equal(snapshot.status, "idle");
  assert.deepEqual(snapshot.messages.map((item) => [item.itemId, item.role, item.content]), [
    ["user-1", "user", "Run test"],
    ["agent-final", "assistant", "Test completed."],
  ]);
  assert.deepEqual(snapshot.activities.map((item) => [item.itemId, item.kind, item.label]), [
    ["agent-progress", "update", "阶段反馈"],
    ["command-1", "command", "本机处理步骤完成"],
  ]);
});

test("thread snapshots expose in-progress turns without requiring command details", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-running", preview: "Still working", createdAt: 100, updatedAt: 110,
    turns: [{
      id: "turn-running", status: "inProgress", startedAt: 109,
      items: [
        { id: "partial-agent", type: "agentMessage", text: "token-level partial text" },
        { id: "running-command", type: "commandExecution", status: "inProgress", command: "npm test" },
        { id: "finished-command", type: "commandExecution", status: "completed", command: "npm run lint" },
        { id: "finished-tool", type: "dynamicToolCall", status: "completed", namespace: "document", tool: "render" },
      ],
    }],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.name, "Still working");
  assert.equal(snapshot.nameSource, "preview");
  assert.equal(snapshot.status, "running");
  assert.deepEqual(snapshot.messages, []);
  assert.deepEqual(snapshot.activities.map((item) => item.itemId), ["finished-command", "finished-tool"]);
});

test("thread snapshots keep turns without a completion timestamp running and withhold the latest assistant candidate", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-persisted-running", preview: "Still processing", createdAt: 100, updatedAt: 115,
    turns: [{
      id: "turn-persisted-running", status: "completed", startedAt: 101, completedAt: null,
      items: [
        { id: "user-running", type: "userMessage", content: [{ type: "text", text: "Process the recording" }] },
        { id: "agent-stage", type: "agentMessage", phase: "commentary", text: "I found the candidate sections." },
        { id: "finished-command", type: "commandExecution", status: "completed", command: "ffmpeg -i input.mp4" },
        { id: "agent-current", type: "agentMessage", phase: "commentary", text: "The final verification is still running." },
      ],
    }],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.status, "running");
  assert.deepEqual(snapshot.messages.map((item) => [item.itemId, item.role]), [["user-running", "user"]]);
  assert.deepEqual(snapshot.activities.map((item) => [item.itemId, item.kind]), [
    ["agent-stage", "update"],
    ["finished-command", "command"],
    ["agent-current", "update"],
  ]);
});

test("completed external turns keep explicit commentary live until a final answer is persisted", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-external-growing", preview: "Background analysis", createdAt: 100, updatedAt: 130,
    turns: [{
      id: "turn-external-growing", status: "completed", startedAt: 101, completedAt: 102,
      items: [
        { id: "user-external", type: "userMessage", content: [{ type: "text", text: "Analyze the recording" }] },
        { id: "agent-stage", type: "agentMessage", phase: "commentary", text: "The low-priority decode is still running." },
      ],
    }],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.status, "running");
  assert.deepEqual(snapshot.messages.map((item) => [item.itemId, item.role]), [["user-external", "user"]]);
  assert.deepEqual(snapshot.activities.map((item) => [item.itemId, item.kind]), [["agent-stage", "update"]]);
});

test("completed external turns stay live while a persisted item remains in progress", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-external-command", preview: "Background command", createdAt: 100, updatedAt: 130,
    turns: [{
      id: "turn-external-command", status: "completed", startedAt: 101, completedAt: 102,
      items: [
        { id: "user-external", type: "userMessage", content: [{ type: "text", text: "Run ffmpeg" }] },
        { id: "command-running", type: "commandExecution", status: "inProgress", command: "ffmpeg -i input.mp4" },
      ],
    }],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.status, "running");
  assert.deepEqual(snapshot.messages.map((item) => [item.itemId, item.role]), [["user-external", "user"]]);
  assert.deepEqual(snapshot.activities, []);
});

test("a final answer closes a completed turn despite stale in-progress metadata", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-final-with-stale-item", preview: "Completed work", createdAt: 100, updatedAt: 130,
    turns: [{
      id: "turn-final-with-stale-item", status: "completed", startedAt: 101, completedAt: null,
      items: [
        { id: "user-final", type: "userMessage", content: [{ type: "text", text: "Finish the work" }] },
        { id: "command-stale", type: "commandExecution", status: "inProgress", command: "long-running-helper" },
        { id: "agent-final", type: "agentMessage", phase: "final_answer", text: "The work is complete." },
      ],
    }],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.status, "idle");
  assert.deepEqual(snapshot.messages.map((item) => [item.itemId, item.role, item.content]), [
    ["user-final", "user", "Finish the work"],
    ["agent-final", "assistant", "The work is complete."],
  ]);
});

test("a legacy assistant reply closes a completed turn despite stale in-progress metadata", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-legacy-final-with-stale-item", preview: "Completed legacy work", createdAt: 100, updatedAt: 130,
    turns: [{
      id: "turn-legacy-final-with-stale-item", status: "completed", startedAt: 101, completedAt: 129,
      items: [
        { id: "user-final", type: "userMessage", content: [{ type: "text", text: "Finish the legacy work" }] },
        { id: "command-stale", type: "commandExecution", status: "inProgress", command: "long-running-helper" },
        { id: "agent-final", type: "agentMessage", text: "The legacy work is complete." },
      ],
    }],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.status, "idle");
  assert.deepEqual(snapshot.messages.map((item) => [item.itemId, item.role, item.content]), [
    ["user-final", "user", "Finish the legacy work"],
    ["agent-final", "assistant", "The legacy work is complete."],
  ]);
});

test("a later terminal turn supersedes completed commentary-only history", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-superseded-commentary", preview: "Completed follow-up", createdAt: 100, updatedAt: 150,
    turns: [
      {
        id: "turn-stale-history", status: "completed", startedAt: 101, completedAt: 120,
        items: [
          { id: "user-stale", type: "userMessage", content: [{ type: "text", text: "Start the maintenance" }] },
          { id: "agent-stale", type: "agentMessage", phase: "commentary", text: "The maintenance is still running." },
        ],
      },
      {
        id: "turn-terminal-follow-up", status: "completed", startedAt: 130, completedAt: 149,
        items: [
          { id: "user-follow-up", type: "userMessage", content: [{ type: "text", text: "Report the final state" }] },
          { id: "agent-final", type: "agentMessage", phase: "final_answer", text: "The maintenance completed successfully." },
        ],
      },
    ],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.status, "idle");
  assert.deepEqual(snapshot.messages.map((item) => [item.turnId, item.itemId, item.role]), [
    ["turn-stale-history", "user-stale", "user"],
    ["turn-terminal-follow-up", "user-follow-up", "user"],
    ["turn-terminal-follow-up", "agent-final", "assistant"],
  ]);
  assert.deepEqual(snapshot.activities.map((item) => [item.turnId, item.itemId, item.kind]), [
    ["turn-stale-history", "agent-stale", "update"],
  ]);
});

test("completed commentary on the latest turn remains live", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-current-commentary", preview: "Current work", createdAt: 100, updatedAt: 160,
    turns: [
      {
        id: "turn-terminal-history", status: "completed", startedAt: 101, completedAt: 120,
        items: [
          { id: "user-history", type: "userMessage", content: [{ type: "text", text: "Complete the first check" }] },
          { id: "agent-history", type: "agentMessage", phase: "final_answer", text: "The first check passed." },
        ],
      },
      {
        id: "turn-current", status: "completed", startedAt: 130, completedAt: 140,
        items: [
          { id: "user-current", type: "userMessage", content: [{ type: "text", text: "Run the follow-up" }] },
          { id: "agent-current", type: "agentMessage", phase: "commentary", text: "The follow-up is still running." },
        ],
      },
    ],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.status, "running");
  assert.deepEqual(snapshot.messages.map((item) => [item.turnId, item.itemId, item.role]), [
    ["turn-terminal-history", "user-history", "user"],
    ["turn-terminal-history", "agent-history", "assistant"],
    ["turn-current", "user-current", "user"],
  ]);
  assert.deepEqual(snapshot.activities.map((item) => [item.turnId, item.itemId, item.kind]), [
    ["turn-current", "agent-current", "update"],
  ]);
});

test("interrupted turns without a completion timestamp do not keep a thread running", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-interrupted", preview: "Stopped", createdAt: 100, updatedAt: 115,
    turns: [{
      id: "turn-interrupted", status: "interrupted", startedAt: 101, completedAt: null,
      items: [
        { id: "user-interrupted", type: "userMessage", content: [{ type: "text", text: "Process the recording" }] },
        { id: "finished-command", type: "commandExecution", status: "completed", command: "ffmpeg -i input.mp4" },
      ],
    }],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.status, "idle");
  assert.deepEqual(snapshot.messages.map((item) => [item.itemId, item.role]), [["user-interrupted", "user"]]);
});

test("a completed snapshot promotes only the final assistant item to the transcript", () => {
  const snapshot = normalizeThreadSnapshot({
    id: "thread-completed", preview: "Completed", createdAt: 100, updatedAt: 130,
    turns: [{
      id: "turn-completed", status: "completed", startedAt: 101, completedAt: 129,
      items: [
        { id: "user-completed", type: "userMessage", content: [{ type: "text", text: "Process the recording" }] },
        { id: "agent-stage", type: "agentMessage", phase: "commentary", text: "I found the candidate sections." },
        { id: "finished-command", type: "commandExecution", status: "completed", command: "ffmpeg -i input.mp4" },
        { id: "agent-final", type: "agentMessage", phase: "final_answer", text: "The recording is archived." },
      ],
    }],
  });
  assert.ok(snapshot);
  assert.equal(snapshot.status, "idle");
  assert.deepEqual(snapshot.messages.map((item) => [item.itemId, item.role]), [
    ["user-completed", "user"],
    ["agent-final", "assistant"],
  ]);
  assert.deepEqual(snapshot.activities.map((item) => [item.itemId, item.kind]), [
    ["agent-stage", "update"],
    ["finished-command", "command"],
  ]);
});

test("thread snapshots report rollout bytes from the app-server path", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-rollout-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, "1234567", "utf8");
  const snapshot = normalizeThreadSnapshot({
    id: "thread-sized", path: rollout, createdAt: 100, updatedAt: 110, turns: [],
  });
  assert.equal(snapshot?.rolloutBytes, 7);
  assert.equal(snapshot?.nameSource, "fallback");
});
