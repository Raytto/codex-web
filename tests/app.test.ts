import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { createApp, migrateExistingOutputFiles } from "../server/app.js";
import { assertProductionConfig, loadConfig } from "../server/config.js";
import { AUTO_TITLE_OUTPUT_SCHEMA, extractLeakedAutoTitleAnswer, parseAutoTitleResponse, redactBrandForDisplay, summarizeEvent } from "../server/codex-runner.js";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { loadAgentOptions, repairAgentSelection, resolveAgentSelection } from "../server/model-options.js";
import { ensureTenant, ensureTenantWorkspace, ensureWorkspace, isDeliverablePath, isPersistedDeliverablePath, normalizeStoredRelativePath, normalizeUploadFileName, persistDeliverable, resolveInside, safeUploadName } from "../server/paths.js";
import { buildShellEnvironment, cleanupJobRuntime, prepareJobRuntime } from "../server/python-runtime.js";
import { assessTaskPolicy } from "../server/task-policy.js";
import { listTenantIdentities, tenantIdentityForUser } from "../server/tenant-identities.js";
import { consumeTenantTurnEvents, validateTenantWorkerRequest } from "../server/tenant-worker-execution.js";
import type { TenantWorkerRunRequest } from "../server/tenant-worker-protocol.js";
import { isRetryableUpstreamError, runWithTransientRetries } from "../server/retry-policy.js";
import { isBrowserPreviewable, isLocalMarkdownUrl, resolveMessageFileLink } from "../src/file-links.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { resolveAccountIdentity } from "../src/account-identity.js";
import { chooseComposerPrimaryAction } from "../src/composer-action.js";
import { ASK_AGENT_SELECTION_MAX_CHARS, buildAskAgentDraft, normalizeAskAgentSelection } from "../src/ask-agent-selection.js";
import { mergeMessagePages, preservePrependedScrollTop } from "../src/message-history.js";
import { resolveScrollFollow } from "../src/scroll-follow.js";
import { CHAT_FONT_SIZE_DEFAULT, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, normalizeChatFontSize } from "../src/chat-font-size.js";
import { chooseSelectedConversation, isTerminalJob, mergeJobEvents } from "../src/recovery.js";
import { normalizeThemePreference, resolveTheme, THEME_PREFERENCE_KEY } from "../src/theme.js";
import type { Conversation, WorkFile } from "../src/api.js";
import { buildAgentSteerPrompt, buildAgentTurnPrompt } from "../server/agent-context.js";

test("user-visible branding uses Codex Web without the private product name", () => {
  const index = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8")
    .replace(/^const SELECTED_CONVERSATION_KEY = .*$/m, "");
  assert.match(index, /<title>Codex Web<\/title>/);
  assert.match(index, /name="application-name" content="Codex Web"/);
  assert.doesNotMatch(`${index}\n${appSource}`, /PP Agent/i);
  assert.doesNotMatch(appSource, /localStorage\.setItem\([^)]*codex-web:(?:model|reasoning)/);
  assert.equal(redactBrandForDisplay("Codex / CHATGPT / agent"), "Codex / Codex Web / agent");
});

test("login form leaves the username empty for each user to enter", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /const \[username, setUsername\] = useState\(""\)/);
  assert.doesNotMatch(appSource, /useState\("owner"\)/);
  assert.match(appSource, /用户名<input autoComplete="username" autoFocus/);
});

test("composer replaces stop with send as soon as there is sendable input", () => {
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: false, voiceActive: false }), "stop");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: true, hasAttachments: false, voiceActive: false }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: true, voiceActive: false }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: false, voiceActive: true }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: false, hasText: false, hasAttachments: false, voiceActive: false }), "send");
});

test("chat font sizing keeps readable bounds and scales from the default", () => {
  assert.equal(normalizeChatFontSize(undefined), CHAT_FONT_SIZE_DEFAULT);
  assert.equal(normalizeChatFontSize("18"), 18);
  assert.equal(normalizeChatFontSize(9), CHAT_FONT_SIZE_MIN);
  assert.equal(normalizeChatFontSize(99), CHAT_FONT_SIZE_MAX);
});

test("appearance setting supports light, dark, and live system preference", () => {
  assert.equal(THEME_PREFERENCE_KEY, "codex-web:theme");
  assert.equal(normalizeThemePreference("light"), "light");
  assert.equal(normalizeThemePreference("dark"), "dark");
  assert.equal(normalizeThemePreference("system"), "system");
  assert.equal(normalizeThemePreference("unexpected"), "light");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /使用浅色模式[\s\S]*使用深色模式[\s\S]*外观跟随系统/);
  assert.match(appSource, /matchMedia\?\.\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /\.theme-options button\[aria-pressed="true"\]/);

  const darkBlock = styles.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const color = (name: string) => darkBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? "";
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const contrast = (foreground: string, background: string) => {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
  };
  assert.ok(contrast(color("ink"), color("canvas")) >= 7);
  assert.ok(contrast(color("ink-soft"), color("canvas")) >= 4.5);
  assert.ok(contrast(color("indigo"), color("paper")) >= 4.5);
});

test("switching conversations hides stale detail until the selected task loads", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /currentDetail = detail\?\.conversation\.id === selectedId \? detail : null/);
  assert.match(appSource, /loadingConversation \? <ConversationLoading \/>/);
  assert.match(appSource, /\(!selectedId \|\| currentDetail\) && <Composer/);
  assert.match(appSource, /role="status" aria-live="polite"/);
  assert.match(styles, /\.conversation-loading \{[^}]*place-content: center;/);
});
test("closed mobile sidebar is not painted as an offscreen shadow layer", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const mobileBlock = styles.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(mobileBlock, /\.sidebar \{[^}]*visibility: hidden;[^}]*pointer-events: none;[^}]*box-shadow: none;/);
  assert.match(mobileBlock, /\.sidebar\.open \{[^}]*visibility: visible;[^}]*pointer-events: auto;[^}]*box-shadow:/);
  assert.match(styles, /:root\[data-theme="dark"\] \.sidebar:not\(\.open\) \{ box-shadow: none; \}/);
});
test("selected message text can be quoted into a focused Agent question", () => {
  assert.equal(normalizeAskAgentSelection("  第一行  \r\n\r\n\r\n第二行  \n"), "第一行\n\n第二行");
  assert.equal(buildAskAgentDraft("", "第一行\n第二行"), "请结合以下引用回答我的问题：\n\n> 第一行\n> 第二行\n\n请解释这段引用。");
  assert.equal(buildAskAgentDraft("已有草稿", "引用"), "请结合以下引用回答我的问题：\n\n> 引用\n\n我的问题：\n已有草稿");
  const capped = buildAskAgentDraft("", "很".repeat(ASK_AGENT_SELECTION_MAX_CHARS + 50));
  assert.match(capped, /引用内容过长，已截断/);
  assert.ok(capped.length < ASK_AGENT_SELECTION_MAX_CHARS + 100);

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /data-agent-selectable="true"/);
  assert.match(appSource, /document\.addEventListener\("selectionchange", update\)/);
  assert.match(appSource, /询问 Agent/);
  assert.match(appSource, /className="ask-agent-reference"/);
  assert.match(appSource, /setAskAgentQuote\(normalized\.slice/);
  assert.doesNotMatch(appSource, /buildAskAgentDraft/);
  assert.match(appSource, /api\.sendMessage\(id, message, files, askAgentQuote\)/);
  assert.match(appSource, /className="message-reference"/);
  assert.match(appSource, /focusRequest=\{composerFocusRequest\}/);
  assert.match(styles, /\.ask-agent-selection \{[^}]*position: fixed;[^}]*touch-action: manipulation/);
  assert.match(styles, /\.ask-agent-reference \{/);
  assert.match(styles, /\.message-reference \{/);
  assert.match(styles, /:root\[data-theme="dark"\] \.ask-agent-selection/);
  assert.match(styles, /:root\[data-theme="dark"\] \.ask-agent-reference/);
});

test("live updates pause while reading older paged messages", () => {
  assert.equal(resolveScrollFollow({ previousScrollTop: 500, scrollTop: 496, scrollHeight: 1000, clientHeight: 500, following: true }), false);
  assert.equal(resolveScrollFollow({ previousScrollTop: 420, scrollTop: 420, scrollHeight: 1080, clientHeight: 500, following: true }), true);
  assert.equal(resolveScrollFollow({ previousScrollTop: 500, scrollTop: 510, scrollHeight: 1080, clientHeight: 500, following: false }), true);
  const newest = [
    { id: "m3", created_at: "2026-07-20T00:00:03.000Z", content: "3" },
    { id: "m4", created_at: "2026-07-20T00:00:04.000Z", content: "4" },
  ];
  const older = [
    { id: "m1", created_at: "2026-07-20T00:00:01.000Z", content: "1" },
    { id: "m2", created_at: "2026-07-20T00:00:02.000Z", content: "2" },
    { id: "m3", created_at: "2026-07-20T00:00:03.000Z", content: "updated" },
  ];
  assert.deepEqual(mergeMessagePages(newest, older).map((message) => [message.id, message.content]), [
    ["m1", "1"], ["m2", "2"], ["m3", "updated"], ["m4", "4"],
  ]);
  assert.equal(preservePrependedScrollTop(40, 900, 1350), 490);
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.doesNotMatch(appSource, /scrollIntoView/);
  assert.match(appSource, /messages\.scrollTop <= 80/);
  assert.match(appSource, /conversationMessages\(conversationId, before\)/);
});

test("progress labels do not report intermediate agent messages as complete", () => {
  assert.equal(summarizeEvent({ type: "item.updated", item: { type: "agent_message", text: "draft" } } as never), null);
  assert.deepEqual(summarizeEvent({ type: "item.completed", item: { type: "agent_message", text: "正在核对表格结构" } } as never), {
    kind: "update", label: "阶段反馈", detail: "正在核对表格结构",
  });
  assert.deepEqual(summarizeEvent({ type: "item.completed", item: { type: "reasoning", text: "先核对排名口径，再制作图表。" } } as never), {
    kind: "reasoning", label: "模型思路摘要", detail: "先核对排名口径，再制作图表。",
  });
  assert.deepEqual(summarizeEvent({ type: "turn.completed" } as never), {
    kind: "status", label: "工作已完成，正在整理结果",
  });
  assert.deepEqual(summarizeEvent({
    type: "item.started",
    item: { type: "command_execution", status: "in_progress", command: "& $py slides_test.py result.pptx" },
  } as never), {
    kind: "command", label: "正在检查演示文稿质量", detail: "& $py slides_test.py result.pptx",
  });
  assert.deepEqual(summarizeEvent({
    type: "item.completed",
    item: { type: "command_execution", status: "completed", command: "Get-Content slides_test.py" },
  } as never), {
    kind: "command", label: "质量验证完成", detail: "Get-Content slides_test.py",
  });
});

test("recoverable stream errors remain progress events until the turn completes", async () => {
  async function* stream(): AsyncIterable<ThreadEvent> {
    yield { type: "thread.started", thread_id: crypto.randomUUID() } as ThreadEvent;
    yield { type: "turn.started" } as ThreadEvent;
    yield { type: "error", message: "Reconnecting... 2/2 (stream disconnected before completion: websocket closed by server before response.completed)" } as ThreadEvent;
    yield {
      type: "item.completed",
      item: { id: "item_1", type: "error", message: "Falling back from WebSockets to HTTPS transport." },
    } as ThreadEvent;
    yield { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "recovered" } } as ThreadEvent;
    yield { type: "turn.completed", usage: {} } as ThreadEvent;
  }
  const progress: unknown[] = [];
  const response = await consumeTenantTurnEvents(stream(), {
    onThreadStarted: () => undefined,
    onProgress: (event) => progress.push(event),
  });
  assert.equal(response, "recovered");
  assert.ok(progress.some((event) => (event as { status?: string }).status === "retrying"));
});

test("a stream that never completes still fails with its last upstream error", async () => {
  async function* stream(): AsyncIterable<ThreadEvent> {
    yield { type: "turn.started" } as ThreadEvent;
    yield { type: "error", message: "stream disconnected before completion" } as ThreadEvent;
  }
  await assert.rejects(() => consumeTenantTurnEvents(stream(), {
    onThreadStarted: () => undefined,
    onProgress: () => undefined,
  }), /stream disconnected before completion/);
});

test("structured first-turn responses separate the visible answer from a short task title", () => {
  assert.equal(AUTO_TITLE_OUTPUT_SCHEMA.properties.title.maxLength, 10);
  assert.deepEqual(parseAutoTitleResponse(JSON.stringify({
    answer: "文件已经生成。",
    title: "高三家长会成绩分析报告",
  }), "请帮我制作一份家长会成绩分析报告"), {
    answer: "文件已经生成。",
    title: "高三家长会成绩分析报",
  });
  assert.deepEqual(parseAutoTitleResponse("普通完成回复", "请帮我检查这份成绩表"), {
    answer: "普通完成回复",
    title: "检查这份成绩表",
  });
  assert.equal(parseAutoTitleResponse('{"answer":"完成","title":"新任务"}', "整理生物复习资料").title, "整理生物复习资料");
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"已收到：asdf。未生成任何文件。","title":"输入测试"}'), "已收到：asdf。未生成任何文件。");
  assert.equal(extractLeakedAutoTitleAnswer('```json\n{"answer":"正常回复","title":"后续测试"}\n```'), "正常回复");
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"用户要求的 JSON","title":"标题","extra":true}'), null);
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"用户要求的 JSON","title":"这是一个明显超过十个字符的普通字段值"}'), null);
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"正常回复","title":"NAS 双出口抖动已停止"}', true), "正常回复");
});

test("transient upstream failures use bounded 15/45/120 retry policy", async () => {
  assert.equal(isRetryableUpstreamError("websocket closed by server before response.completed"), true);
  assert.equal(isRetryableUpstreamError("HTTP 503 server overload"), true);
  assert.equal(isRetryableUpstreamError("authentication failed"), false);
  assert.equal(isRetryableUpstreamError("permission denied"), false);

  let calls = 0;
  const notices: Array<{ attempt: number; delayMs: number }> = [];
  const value = await runWithTransientRetries(async () => {
    calls += 1;
    if (calls < 3) throw new Error("stream disconnected before completion");
    return "ok";
  }, {
    signal: new AbortController().signal,
    delaysMs: [0, 0, 0],
    onRetry: ({ attempt, delayMs }) => notices.push({ attempt, delayMs }),
  });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(notices, [{ attempt: 1, delayMs: 0 }, { attempt: 2, delayMs: 0 }]);

  let permanentCalls = 0;
  await assert.rejects(() => runWithTransientRetries(async () => {
    permanentCalls += 1;
    throw new Error("authentication failed");
  }, { signal: new AbortController().signal, delaysMs: [0, 0, 0] }), /authentication failed/);
  assert.equal(permanentCalls, 1);
});

test("path confinement rejects traversal", () => {
  const root = path.join(os.tmpdir(), "cww-root");
  assert.equal(resolveInside(root, "outputs/result.txt"), path.join(root, "outputs", "result.txt"));
  assert.equal(resolveInside(root, "outputs\\legacy.txt"), path.join(root, "outputs", "legacy.txt"));
  assert.equal(normalizeStoredRelativePath("outputs\\legacy.txt"), "outputs/legacy.txt");
  assert.throws(() => resolveInside(root, "../secret.txt"), /escapes workspace/);
  const safe = safeUploadName("../../bad:name?.pptx");
  assert.match(safe.diskName, /^[0-9a-f-]{36}\.pptx$/);
  assert.equal(safe.displayName, "bad_name_.pptx");
});

test("the owner tenant has a dedicated Unix identity and workers reject cross-tenant paths", () => {
  const identities = listTenantIdentities();
  assert.deepEqual(identities.map((identity) => identity.label), ["owner"]);
  assert.equal(new Set(identities.map((identity) => identity.uid)).size, identities.length);
  assert.equal(new Set(identities.map((identity) => identity.gid)).size, identities.length);
  const owner = tenantIdentityForUser(LEGACY_USER_ID)!;
  const jobId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const tenantRoot = path.join(os.tmpdir(), "cww-tenants", owner.userId);
  const workspace = path.join(tenantRoot, "conversations", conversationId);
  const request: TenantWorkerRunRequest = {
    jobId,
    userId: owner.userId,
    conversationId,
    projectRoot: process.cwd(),
    pythonRuntimeRoot: path.join(process.cwd(), "python-runtime"),
    tenantRoot,
    workspace,
    runtimeRoot: path.join(workspace, ".runtime", "jobs", jobId),
    codexHome: path.join(tenantRoot, "codex-home"),
    library: path.join(tenantRoot, "library"),
    codexThreadId: null,
    effectivePrompt: "test",
    imagePaths: [path.join(workspace, "uploads", "image.png")],
    selection: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    networkAccessEnabled: false,
    webSearchMode: "cached",
    codexWindowsSandbox: "elevated",
  };
  assert.doesNotThrow(() => validateTenantWorkerRequest(request, owner.userId, tenantRoot));
  assert.throws(() => validateTenantWorkerRequest({ ...request, tenantRoot: path.join(os.tmpdir(), "other") }, owner.userId, tenantRoot), /path mismatch/);
  assert.throws(() => validateTenantWorkerRequest({ ...request, imagePaths: [path.join(tenantRoot, "..", "secret.png")] }, owner.userId, tenantRoot), /escapes workspace/);
  const executionSource = fs.readFileSync(path.join(process.cwd(), "server", "tenant-worker-execution.ts"), "utf8");
  const composeSource = fs.readFileSync(path.join(process.cwd(), "compose.yaml"), "utf8");
  assert.match(executionSource, /executablePath: process\.env\.CODEX_RUNTIME_PATH/);
  const appServerSource = fs.readFileSync(path.join(process.cwd(), "server", "app-server-turn.ts"), "utf8");
  assert.match(appServerSource, /"turn\/steer"/);
  assert.match(appServerSource, /expectedTurnId: this\.activeTurnId/);
  assert.match(appServerSource, /this\.request\("thread\/resume", \{ threadId: this\.options\.threadId, \.\.\.common, excludeTurns: true \}\)/);
  assert.match(appServerSource, /this\.request\("thread\/start", common\)/);
  assert.match(composeSource, /codex-runtime:\/opt\/codex-runtime/);
});

test("conversation workspace receives managed local spreadsheet instructions without losing custom guidance", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-workspace-guidance-test-"));
  const conversationId = crypto.randomUUID();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = ensureWorkspace(root, conversationId);
  const agentsPath = path.join(workspace, "AGENTS.md");
  const initial = fs.readFileSync(agentsPath, "utf8");
  assert.match(initial, /does not provide `load_workspace_dependencies` or `@oai\/artifact-tool`/);
  assert.match(initial, /`CWW_SHARED_PYTHON`/);
  assert.match(initial, /`CWW_JOB_RUNTIME`/);
  assert.match(initial, /`CWW_PYTHON_RUNNER`/);
  assert.match(initial, /Never expose absolute paths/);
  assert.match(initial, /Never read codex-home/);
  fs.appendFileSync(agentsPath, "\n- Keep this custom instruction.\n", "utf8");
  ensureWorkspace(root, conversationId);
  const updated = fs.readFileSync(agentsPath, "utf8");
  assert.match(updated, /Keep this custom instruction/);
  assert.equal(updated.match(/codex-web-managed-start/g)?.length, 1);
});

test("agent turn context keeps only current intent, attachments, and conditional safety", () => {
  assert.equal(buildAgentTurnPrompt({ userPrompt: "  请整理这份文件  ", attachments: [] }), "请整理这份文件");
  const withFile = buildAgentTurnPrompt({
    userPrompt: "请汇总",
    attachments: [{ name: "成绩表.xlsx", path: "uploads/abc.xlsx" }],
  });
  assert.match(withFile, /^请汇总\n\n本轮附件：/);
  assert.match(withFile, /成绩表\.xlsx: uploads\/abc\.xlsx/);
  assert.doesNotMatch(withFile, /租户边界|Python 环境策略|绝对路径|answer,title|outputs 中只能/);
  const isolated = buildAgentTurnPrompt({ userPrompt: "检查脚本", attachments: [], isolationReason: "检测到脚本" });
  assert.match(isolated, /离线隔离/);
  assert.match(isolated, /不执行不受信任/);
  assert.equal(buildAgentSteerPrompt("改成蓝色", []), "实时调整当前任务：改成蓝色");
});

test("each job gets an isolated runtime directory without traversing stale siblings", (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cww-job-runtime-test-"));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const staleMarker = path.join(workspace, ".runtime", "stale", "marker.txt");
  fs.mkdirSync(path.dirname(staleMarker), { recursive: true });
  fs.writeFileSync(staleMarker, "stale", "utf8");
  const jobId = crypto.randomUUID();
  const runtimeRoot = prepareJobRuntime(workspace, jobId);
  assert.equal(runtimeRoot, path.join(workspace, ".runtime", "jobs", jobId));
  for (const directory of ["uv-cache", "pip-cache", "tmp", "home", "xdg-cache", "xdg-config", "xdg-state", "xdg-runtime"]) {
    assert.equal(fs.existsSync(path.join(runtimeRoot, directory)), true);
  }
  const shellEnvironment = buildShellEnvironment({ uvPath: "uv", pythonPath: "python", runnerPath: "runner", ready: true }, runtimeRoot);
  assert.equal(shellEnvironment.HOME, path.join(runtimeRoot, "home"));
  assert.equal(shellEnvironment.TMPDIR, path.join(runtimeRoot, "tmp"));
  assert.equal(shellEnvironment.XDG_CONFIG_HOME, path.join(runtimeRoot, "xdg-config"));
  assert.equal(fs.readFileSync(staleMarker, "utf8"), "stale");
  cleanupJobRuntime(runtimeRoot);
  assert.equal(fs.existsSync(runtimeRoot), false);
  assert.throws(() => prepareJobRuntime(workspace, "../escape"), /Invalid job id/);
});

test("multipart UTF-8 filename mojibake is repaired without corrupting valid names", () => {
  const originalName = "高二下零诊成绩分析2024.xlsm";
  const latin1Decoded = Buffer.from(originalName, "utf8").toString("latin1");
  assert.equal(normalizeUploadFileName(latin1Decoded), originalName);
  assert.equal(normalizeUploadFileName(originalName), originalName);
  assert.equal(normalizeUploadFileName("café.xlsx"), "café.xlsx");
  assert.equal(safeUploadName(latin1Decoded).displayName, originalName);
});

test("database startup repairs previously stored mojibake upload names", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-name-repair-test-"));
  const conversationId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const originalName = "高二下零诊成绩分析2024.xlsm";
  const latin1Decoded = Buffer.from(originalName, "utf8").toString("latin1");
  const first = new AppDatabase(root);
  first.createConversation(conversationId, "name repair");
  first.addFile({
    id: fileId, conversation_id: conversationId, message_id: null, original_name: latin1Decoded,
    relative_path: path.join("uploads", `${fileId}.xlsm`), mime_type: "application/vnd.ms-excel.sheet.macroEnabled.12",
    size: 10, kind: "upload", created_at: new Date().toISOString(),
  });
  first.close();
  const reopened = new AppDatabase(root);
  context.after(() => { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(reopened.getFile(fileId)?.original_name, originalName);
  assert.equal(reopened.getFile(fileId)?.relative_path, `uploads/${fileId}.xlsm`);
});

test("production binding permits public bind only when explicitly containerized", () => {
  const base = loadConfig({
    passwordHash: bcrypt.hashSync("password", 4),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  assert.doesNotThrow(() => assertProductionConfig({ ...base, host: "127.0.0.1", containerized: false }));
  assert.doesNotThrow(() => assertProductionConfig({ ...base, host: "0.0.0.0", containerized: true }));
  assert.throws(() => assertProductionConfig({ ...base, host: "0.0.0.0", containerized: false }), /hardened container/);
});

test("agent options use the live image-capable catalog and default to Sol with extra-high reasoning", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-model-options-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({
    models: [
      {
        slug: "gpt-5.5", display_name: "GPT-5.5", description: "general", priority: 0,
        visibility: "list", input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }],
      },
      {
        slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", description: "frontier", priority: 1,
        visibility: "list", input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }],
      },
      {
        slug: "text-only", display_name: "Text only", priority: 2,
        visibility: "list", input_modalities: ["text"], supported_reasoning_levels: [{ effort: "high" }],
      },
      {
        slug: "hidden-model", display_name: "Hidden", priority: 3,
        visibility: "hide", input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }],
      },
    ],
  }), "utf8");
  const options = loadAgentOptions(loadConfig({ codexHome: root, codexModel: undefined }));
  assert.deepEqual(options.models.map((model) => model.id), ["gpt-5.5", "gpt-5.6-sol"]);
  assert.deepEqual(options.models[1].reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(options.reasoningEfforts.at(-1), { id: "max", label: "最大" });
  assert.deepEqual(options.defaults, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  assert.deepEqual(resolveAgentSelection(options, "gpt-5.5", "high"), { model: "gpt-5.5", reasoningEffort: "high" });
  assert.deepEqual(resolveAgentSelection(options, "gpt-5.6-sol", "max"), { model: "gpt-5.6-sol", reasoningEffort: "max" });
  assert.deepEqual(repairAgentSelection(options, "retired-model", "high"), { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  assert.deepEqual(repairAgentSelection(options, "gpt-5.5", "medium"), { model: "gpt-5.5", reasoningEffort: "xhigh" });
  assert.throws(() => resolveAgentSelection(options, "hidden-model", "high"), /当前不可用/);
  assert.throws(() => resolveAgentSelection(options, "gpt-5.6-sol", "ultra"), /不受该模型支持/);
  fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({ models: [{
    slug: "gpt-5.7-sol", display_name: "GPT-5.7-Sol", priority: 0, visibility: "list",
    input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }],
  }, ...JSON.parse(fs.readFileSync(path.join(root, "models_cache.json"), "utf8")).models] }), "utf8");
  assert.deepEqual(loadAgentOptions(loadConfig({ codexHome: root })).defaults, { model: "gpt-5.7-sol", reasoningEffort: "xhigh" });
});

test("legacy databases gain durable selections and preserve existing titles", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-agent-selection-db-test-"));
  let reopened: AppDatabase | undefined;
  context.after(() => { reopened?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const legacy = new DatabaseSync(path.join(root, "codex-web.sqlite"));
  legacy.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, codex_thread_id TEXT, status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO conversations(id,title,status,created_at,updated_at) VALUES('legacy','Legacy','idle','now','now');
  `);
  legacy.close();

  const first = new AppDatabase(root);
  assert.equal(first.getConversation("legacy")?.agent_model, null);
  assert.equal(first.getConversation("legacy")?.title_source, "legacy");
  const freshId = crypto.randomUUID();
  first.createConversation(freshId, "新任务");
  assert.equal(first.getConversation(freshId)?.title_source, "default");
  first.updateConversation(freshId, { title: "用户命名", titleSource: "manual" });
  assert.equal(first.setAiConversationTitleIfDefault(freshId, "AI 标题"), false);
  assert.equal(first.getConversation(freshId)?.title, "用户命名");
  assert.equal(first.getConversation(freshId)?.title_source, "manual");
  first.setAgentSelectionPreference({ model: "gpt-5.6-terra", reasoningEffort: "high" });
  first.updateConversation("legacy", { agentSelection: { model: "gpt-5.6-luna", reasoningEffort: "low" } });
  first.close();

  reopened = new AppDatabase(root);
  assert.deepEqual(reopened.getAgentSelectionPreference(), { model: "gpt-5.6-terra", reasoningEffort: "high" });
  assert.equal(reopened.getConversation("legacy")?.agent_model, "gpt-5.6-luna");
  assert.equal(reopened.getConversation("legacy")?.reasoning_effort, "low");
});

test("only finished files under outputs are deliverables", () => {
  assert.equal(isDeliverablePath("outputs/ConditionType 统计结果.xlsx"), true);
  assert.equal(isDeliverablePath("outputs/reports/final.pdf"), true);
  assert.equal(isDeliverablePath("scratch/chart.png"), false);
  assert.equal(isDeliverablePath("outputs/chart.tmp"), false);
  assert.equal(isDeliverablePath("outputs/~$draft.xlsx"), false);
  assert.equal(isDeliverablePath("outputs/../secret.txt"), false);
  assert.equal(isDeliverablePath("deliverables/550e8400-e29b-41d4-a716-446655440000/final.xlsx"), true);
});

test("finished outputs are copied to immutable app storage and legacy rows migrate", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-persisted-output-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const conversationId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  const legacyPath = "outputs/中文结果.txt";
  fs.writeFileSync(resolveInside(workspace, legacyPath), "result", "utf8");
  const db = new AppDatabase(dataRoot);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.createConversation(conversationId, "persist output");
  db.addFile({
    id: fileId, conversation_id: conversationId, message_id: null, original_name: "中文结果.txt",
    relative_path: legacyPath, mime_type: "text/plain", size: 6, kind: "output", created_at: new Date().toISOString(),
  });
  const migrated = migrateExistingOutputFiles(loadConfig({ dataRoot, tenantRoot }), db);
  assert.equal(migrated, 1);
  const storedPath = db.getFile(fileId)?.relative_path ?? "";
  assert.equal(isPersistedDeliverablePath(storedPath), true);
  assert.equal(fs.readFileSync(resolveInside(dataRoot, storedPath), "utf8"), "result");
  const anotherId = crypto.randomUUID();
  const copiedPath = await persistDeliverable(dataRoot, workspace, legacyPath, anotherId);
  assert.equal(fs.readFileSync(resolveInside(dataRoot, copiedPath), "utf8"), "result");
});

test("browser preview is limited to formats browsers can display directly", () => {
  const file = (mime_type: string) => ({ mime_type } as WorkFile);
  assert.equal(isBrowserPreviewable(file("image/png")), true);
  assert.equal(isBrowserPreviewable(file("application/pdf")), true);
  assert.equal(isBrowserPreviewable(file("text/plain")), true);
  assert.equal(isBrowserPreviewable(file("application/vnd.openxmlformats-officedocument.presentationml.presentation")), false);
});

test("risky uploads and execution requests use offline isolation", () => {
  assert.deepEqual(assessTaskPolicy("整理表格", [{ original_name: "source.xlsx" }]), { isolated: false, networkAccessEnabled: true });
  const macro = assessTaskPolicy("看看这个文件", [{ original_name: "unknown.xlsm" }]);
  assert.equal(macro.isolated, true);
  assert.equal(macro.networkAccessEnabled, false);
  assert.equal(assessTaskPolicy("请分析这个恶意软件样本", []).isolated, true);
});

test("single-user login and CSRF protection", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot,
    username: "owner",
    passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);

  await agent.post("/codex-web/api/auth/login").send({ username: "wrong", password: "Correct-Horse-2026!" }).expect(401);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  assert.equal(login.body.authenticated, true);
  assert.ok(login.body.csrfToken);
  assert.equal(login.body.chatFontSize, CHAT_FONT_SIZE_DEFAULT);
  await agent.put("/codex-web/api/user-settings/chat-font-size")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ chatFontSize: 19 }).expect(200, { chatFontSize: 19 });
  const restoredSession = await agent.get("/codex-web/api/auth/session").expect(200);
  assert.equal(restoredSession.body.chatFontSize, 19);
  await agent.put("/codex-web/api/user-settings/chat-font-size")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ chatFontSize: "large" }).expect(400);

  const options = await agent.get("/codex-web/api/agent-options").expect(200);
  assert.equal(options.body.defaults.model, "gpt-5.6-sol");
  assert.equal(options.body.defaults.reasoningEffort, "xhigh");
  assert.deepEqual(options.body.selection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });

  await agent.post("/codex-web/api/conversations").expect(403);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  assert.equal(created.body.conversation.title, "新任务");
  assert.equal(created.body.conversation.title_source, "default");
  assert.deepEqual(created.body.agentSelection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  await agent.put(`/codex-web/api/conversations/${created.body.conversation.id}/agent-selection`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-luna", reasoningEffort: "low" }).expect(200);
  const second = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  assert.deepEqual(second.body.agentSelection, { model: "gpt-5.6-luna", reasoningEffort: "low" });
  const renamed = await agent.patch(`/codex-web/api/conversations/${second.body.conversation.id}`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ title: "我的自定义标题" }).expect(200);
  assert.equal(renamed.body.conversation.title_source, "manual");
  assert.equal(instance.db.setAiConversationTitleIfDefault(second.body.conversation.id, "AI 不应覆盖"), false);
  assert.equal(instance.db.getConversation(second.body.conversation.id)?.title, "我的自定义标题");
  await agent.put(`/codex-web/api/conversations/${second.body.conversation.id}/agent-selection`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-terra", reasoningEffort: "high" }).expect(200);
  const firstDetail = await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200);
  assert.deepEqual(firstDetail.body.agentSelection, { model: "gpt-5.6-luna", reasoningEffort: "low" });

  const codexHome = ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome;
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{
    slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", description: "frontier", priority: 0,
    visibility: "list", input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }],
  }] }), "utf8");
  const repaired = await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200);
  assert.deepEqual(repaired.body.agentSelection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.agent_model, "gpt-5.6-sol");
  await agent.get("/codex-web/api/conversations").expect(200);

  const fileId = crypto.randomUUID();
  const originalName = "高三生物复习大纲与冲刺指南.pptx";
  const relativePath = path.join("outputs", originalName);
  const absolutePath = path.join(ensureTenant(tenantRoot, LEGACY_USER_ID).conversations, created.body.conversation.id, relativePath);
  fs.writeFileSync(absolutePath, Buffer.from("pptx-test"));
  instance.db.addFile({
    id: fileId, conversation_id: created.body.conversation.id, message_id: null,
    original_name: originalName, relative_path: relativePath,
    mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 9, kind: "output", created_at: new Date().toISOString(),
  });
  const download = await agent.get(`/codex-web/api/files/${fileId}?download=1`).expect(200);
  assert.equal(download.headers["cache-control"], "private, no-store");
  assert.match(download.headers["content-disposition"], /^attachment; filename="download\.pptx"; filename\*=UTF-8''/);
  assert.match(download.headers["content-disposition"], /%E9%AB%98%E4%B8%89%E7%94%9F%E7%89%A9/);

  await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "请制作一份很长很长的家长会成绩分析演示文稿").expect(202);
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.title, "新任务");
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.title_source, "default");
});

test("quoted selections stay outside the visible message body and survive the pending queue", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-message-quote-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "pp", passwordHash: bcrypt.hashSync("Quote-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "pp", password: "Quote-Password-2026!" }).expect(200);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "这和上一段有什么关系？")
    .field("quoteExcerpt", "  被引用的第一行\r\n被引用的第二行  ")
    .expect(202);
  let detail = await agent.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.messages[0].content, "这和上一段有什么关系？");
  assert.equal(detail.body.messages[0].quote_excerpt, "被引用的第一行\n被引用的第二行");
  assert.doesNotMatch(detail.body.messages[0].content, /请结合以下引用|被引用的第一行/);

  const queued = await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "")
    .field("quoteExcerpt", "只引用、不写正文")
    .expect(202);
  assert.equal(queued.body.pendingPrompt.content, "");
  assert.equal(queued.body.pendingPrompt.quote_excerpt, "只引用、不写正文");

  const pendingId = queued.body.pendingPrompt.id as string;
  await agent.post(`/api/conversations/${conversationId}/pending-prompts/${pendingId}/edit`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  await agent.post(`/api/conversations/${conversationId}/pending-prompts/${pendingId}/restore`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const materialized = instance.db.materializePendingPrompt(pendingId, crypto.randomUUID(), crypto.randomUUID());
  assert.ok(materialized?.message_id);
  const quotedMessage = instance.db.getMessage(materialized!.message_id!);
  assert.equal(quotedMessage?.content, "");
  assert.equal(quotedMessage?.quote_excerpt, "只引用、不写正文");
  detail = await agent.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.messages.at(-1).quote_excerpt, "只引用、不写正文");
});

test("conversation stop cancels every active job and deletion preserves audit rows while removing physical state", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-soft-delete-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;
  const messageId = crypto.randomUUID();
  const queuedJobId = crypto.randomUUID();
  const runningJobId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "keep for audit", created_at: now });
  instance.db.createJob(queuedJobId, conversationId, messageId);
  instance.db.createJob(runningJobId, conversationId, messageId);
  instance.db.updateJob(runningJobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  instance.db.appendEvent(runningJobId, "progress", { label: "saved diagnostic event" });

  await agent.post(`/codex-web/api/conversations/${conversationId}/cancel`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(instance.db.getJob(queuedJobId)?.status, "cancelled");
  assert.equal(instance.db.getJob(runningJobId)?.status, "cancelled");
  assert.equal(instance.db.getConversationForUser(conversationId, LEGACY_USER_ID)?.id, conversationId);

  const deletionJobId = crypto.randomUUID();
  instance.db.createJob(deletionJobId, conversationId, messageId);
  instance.db.updateJob(deletionJobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  fs.writeFileSync(path.join(workspace, "uploads", "input.txt"), "physical input", "utf8");
  const pending = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "draft that must never be promoted during deletion")
    .attach("files", Buffer.from("draft input"), { filename: "draft.txt", contentType: "text/plain" })
    .expect(202);
  const pendingFile = pending.body.pendingPrompt.files[0] as { relative_path: string };
  const pendingAbsolute = path.join(workspace, ...pendingFile.relative_path.split("/"));
  assert.equal(fs.existsSync(pendingAbsolute), true);
  const fileId = crypto.randomUUID();
  const storedPath = path.posix.join("deliverables", fileId, "result.txt");
  const storedAbsolute = path.join(dataRoot, ...storedPath.split("/"));
  fs.mkdirSync(path.dirname(storedAbsolute), { recursive: true });
  fs.writeFileSync(storedAbsolute, "physical result", "utf8");
  instance.db.addFile({
    id: fileId, conversation_id: conversationId, message_id: messageId,
    original_name: "result.txt", relative_path: storedPath, mime_type: "text/plain",
    size: 15, kind: "output", created_at: now,
  });
  const threadId = crypto.randomUUID();
  instance.db.updateConversation(conversationId, { codexThreadId: threadId });
  const sessionFile = path.join(ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome, "sessions", "2026", "07", "19", `rollout-${threadId}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, "thread state", "utf8");

  await agent.delete(`/codex-web/api/conversations/${conversationId}`).set("X-CSRF-Token", login.body.csrfToken).expect(204);
  const retained = instance.db.getConversation(conversationId);
  assert.ok(retained?.deleted_at);
  assert.equal(instance.db.listConversations(LEGACY_USER_ID).some((row) => row.id === conversationId), false);
  assert.equal(instance.db.listMessages(conversationId).length, 1);
  assert.equal(instance.db.listFiles(conversationId).length, 1);
  assert.equal(instance.db.getJob(deletionJobId)?.status, "cancelled");
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  assert.equal(instance.db.listPendingPrompts(conversationId, "editing").length, 0);
  assert.ok(instance.db.listEvents(runningJobId).some((event) => JSON.parse(event.payload).label === "saved diagnostic event"));
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(fs.existsSync(pendingAbsolute), false);
  assert.equal(fs.existsSync(storedAbsolute), false);
  assert.equal(fs.existsSync(sessionFile), false);
  await instance.pumpQueue();
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["keep for audit"]);
  await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(404);
  await agent.get(`/codex-web/api/files/${fileId}`).expect(404);
  await agent.get(`/codex-web/api/jobs/${deletionJobId}/events`).expect(404);
});

test("web users have isolated conversations, files, jobs, settings, and tenant directories", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-multi-user-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Owner-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  const memberId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.createUser({
    id: memberId, username: "member", display_name: "朋友", password_hash: bcrypt.hashSync("Member-Password-2026!", 8),
    role: "member", status: "active", created_at: now, updated_at: now,
  });
  const memberTenant = ensureTenant(tenantRoot, memberId);
  const ownerTenant = ensureTenant(tenantRoot, LEGACY_USER_ID);
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  assert.notEqual(memberTenant.codexHome, ownerTenant.codexHome);
  assert.ok(fs.existsSync(path.join(memberTenant.library, "PROFILE.md")));
  assert.ok(fs.existsSync(path.join(memberTenant.library, "projects")));

  const owner = request.agent(instance.app);
  const member = request.agent(instance.app);
  const ownerLogin = await owner.post("/codex-web/api/auth/login").send({ username: "owner", password: "Owner-Password-2026!" }).expect(200);
  const memberLogin = await member.post("/codex-web/api/auth/login").send({ username: "member", password: "Member-Password-2026!" }).expect(200);
  const ownerConversation = await owner.post("/codex-web/api/conversations").set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(201);
  const memberConversation = await member.post("/codex-web/api/conversations").set("X-CSRF-Token", memberLogin.body.csrfToken).expect(201);

  const ownerList = await owner.get("/codex-web/api/conversations").expect(200);
  const memberList = await member.get("/codex-web/api/conversations").expect(200);
  assert.deepEqual(ownerList.body.conversations.map((row: { id: string }) => row.id), [ownerConversation.body.conversation.id]);
  assert.deepEqual(memberList.body.conversations.map((row: { id: string }) => row.id), [memberConversation.body.conversation.id]);
  await owner.get(`/codex-web/api/conversations/${memberConversation.body.conversation.id}`).expect(404);
  await member.get(`/codex-web/api/conversations/${ownerConversation.body.conversation.id}`).expect(404);

  instance.db.setAgentSelectionPreference({ model: "gpt-5.6-terra", reasoningEffort: "high" }, memberId);
  assert.notDeepEqual(instance.db.getAgentSelectionPreference(LEGACY_USER_ID), instance.db.getAgentSelectionPreference(memberId));
  await member.put("/codex-web/api/user-settings/chat-font-size")
    .set("X-CSRF-Token", memberLogin.body.csrfToken).send({ chatFontSize: 20 }).expect(200);
  assert.equal(instance.db.getChatFontSize(memberId), 20);
  assert.equal(instance.db.getChatFontSize(LEGACY_USER_ID), CHAT_FONT_SIZE_DEFAULT);
  assert.equal((await owner.get("/codex-web/api/auth/session").expect(200)).body.chatFontSize, CHAT_FONT_SIZE_DEFAULT);
  assert.equal((await member.get("/codex-web/api/auth/session").expect(200)).body.chatFontSize, 20);

  const memberMessageId = crypto.randomUUID();
  instance.db.addMessage({ id: memberMessageId, conversation_id: memberConversation.body.conversation.id, role: "user", content: "private", created_at: now });
  const memberFileId = crypto.randomUUID();
  const memberWorkspace = ensureTenantWorkspace(tenantRoot, memberId, memberConversation.body.conversation.id);
  fs.writeFileSync(path.join(memberWorkspace, "uploads", "private.txt"), "private", "utf8");
  instance.db.addFile({
    id: memberFileId, conversation_id: memberConversation.body.conversation.id, message_id: memberMessageId,
    original_name: "private.txt", relative_path: "uploads/private.txt", mime_type: "text/plain", size: 7, kind: "upload", created_at: now,
  });
  await owner.get(`/codex-web/api/files/${memberFileId}`).expect(404);
  await member.get(`/codex-web/api/files/${memberFileId}`).expect(200);

  const memberJobId = crypto.randomUUID();
  instance.db.createJob(memberJobId, memberConversation.body.conversation.id, memberMessageId, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  await owner.get(`/codex-web/api/jobs/${memberJobId}/events`).expect(404);
  await owner.post(`/codex-web/api/jobs/${memberJobId}/cancel`).set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(404);
  await member.post(`/codex-web/api/jobs/${memberJobId}/cancel`).set("X-CSRF-Token", memberLogin.body.csrfToken).expect(200);
});

test("file-only submissions persist on the server and wait for a real instruction", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-awaiting-instruction-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Awaiting-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const firstBrowser = request.agent(instance.app);
  const firstLogin = await firstBrowser.post("/codex-web/api/auth/login").send({ username: "owner", password: "Awaiting-Password-2026!" }).expect(200);
  const created = await firstBrowser.post("/codex-web/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  const uploadedOnly = await firstBrowser.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .field("message", "   ")
    .attach("files", Buffer.from("first image"), { filename: "first.png", contentType: "image/png" })
    .expect(202);
  assert.equal(uploadedOnly.body.needsInstruction, true);
  assert.match(uploadedOnly.body.guidance, /具体操作/);
  assert.equal(instance.db.listMessages(conversationId).length, 0);
  assert.equal(instance.db.listActiveJobsForConversation(conversationId).length, 0);
  assert.equal(instance.db.listQueuedJobs().length, 0);
  const awaitingId = uploadedOnly.body.pendingPrompt.id as string;
  let awaiting = instance.db.getPendingPrompt(awaitingId)!;
  assert.equal(awaiting.status, "editing");
  assert.equal(awaiting.content, "");
  assert.deepEqual(awaiting.files.map((file) => file.original_name), ["first.png"]);
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  assert.equal(fs.existsSync(path.join(workspace, awaiting.files[0].relative_path)), true);

  // A new HTTP session represents a closed/reopened browser. The draft and
  // server-side upload must be recovered without any browser-local state.
  const reopenedBrowser = request.agent(instance.app);
  const reopenedLogin = await reopenedBrowser.post("/codex-web/api/auth/login").send({ username: "owner", password: "Awaiting-Password-2026!" }).expect(200);
  let detail = await reopenedBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.editingPrompt.id, awaitingId);
  assert.deepEqual(detail.body.editingPrompt.files.map((file: { original_name: string }) => file.original_name), ["first.png"]);
  await reopenedBrowser.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${awaitingId}/restore`)
    .set("X-CSRF-Token", reopenedLogin.body.csrfToken)
    .expect(409);
  assert.equal(instance.db.listQueuedJobs().length, 0);

  const moreFiles = await reopenedBrowser.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/${awaitingId}`)
    .set("X-CSRF-Token", reopenedLogin.body.csrfToken)
    .field("message", " ")
    .field("removedFileIds", "[]")
    .attach("files", Buffer.from("second document"), { filename: "second.txt", contentType: "text/plain" })
    .expect(202);
  assert.equal(moreFiles.body.needsInstruction, true);
  assert.equal(instance.db.listQueuedJobs().length, 0);
  awaiting = instance.db.getPendingPrompt(awaitingId)!;
  assert.equal(awaiting.status, "editing");
  assert.deepEqual(awaiting.files.map((file) => file.original_name), ["first.png", "second.txt"]);

  await reopenedBrowser.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/${awaitingId}`)
    .set("X-CSRF-Token", reopenedLogin.body.csrfToken)
    .field("message", "请把图片和文档整理成一份说明")
    .field("removedFileIds", "[]")
    .expect(200);
  assert.equal(instance.db.getPendingPrompt(awaitingId)?.status, "queued");
  assert.equal(instance.db.listMessages(conversationId).length, 0);

  let executed: { prompt: string; files: string[] } | undefined;
  instance.runner.run = async (jobId, id, prompt, uploads) => {
    executed = { prompt, files: uploads.map((file) => file.original_name) };
    instance.db.finishJob(jobId, id, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 20 && !executed; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(executed, { prompt: "请把图片和文档整理成一份说明", files: ["first.png", "second.txt"] });
  assert.equal(instance.db.getPendingPrompt(awaitingId), undefined);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => ({ content: message.content, files: message.files.map((file) => file.original_name) })), [
    { content: "请把图片和文档整理成一份说明", files: ["first.png", "second.txt"] },
  ]);
  detail = await reopenedBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.editingPrompt, null);
  assert.equal(detail.body.pendingPrompts.length, 0);
});

test("later submissions stay out of chat as drafts and materialize one at a time", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-queue-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Queue-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Queue-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const first = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "first" }).expect(202);
  const second = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "second" }).expect(202);
  const third = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "third" }).expect(202);
  assert.equal(first.body.job.queuePosition, 1);
  assert.equal(second.body.queued, true);
  assert.equal(second.body.pendingPrompt.content, "second");
  assert.equal(instance.db.getJob(first.body.job.id)?.status, "queued");
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 2);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first"]);
  await agent.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/order`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ ids: [third.body.pendingPrompt.id, second.body.pendingPrompt.id] })
    .expect(200);

  const processed: string[] = [];
  const release = new Map<string, () => void>();
  instance.runner.run = async (jobId, id) => {
    processed.push(jobId);
    await new Promise<void>((resolve) => release.set(jobId, resolve));
    instance.db.finishJob(jobId, id, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 10 && processed.length < 1; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(processed, [first.body.job.id]);
  assert.equal(instance.db.getJob(first.body.job.id)?.status, "running");
  release.get(first.body.job.id)!();
  for (let attempt = 0; attempt < 30 && processed.length < 2; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const thirdJobId = processed[1];
  assert.ok(thirdJobId);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "third"]);
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 1);
  release.get(thirdJobId)!();
  for (let attempt = 0; attempt < 30 && processed.length < 3; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const secondJobId = processed[2];
  assert.ok(secondJobId);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "third", "second"]);
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  release.get(secondJobId)!();
  for (let attempt = 0; attempt < 30 && instance.db.getJob(secondJobId)?.status !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(instance.db.getJob(first.body.job.id)?.status, "completed");
  assert.equal(instance.db.getJob(thirdJobId)?.status, "completed");
  assert.equal(instance.db.getJob(secondJobId)?.status, "completed");
});

test("pending drafts support reorder, steer, edit with attachments, and delete", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-pending-actions-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Pending-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Pending-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const first = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "first" }).expect(202);
  const alpha = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).field("message", "alpha").attach("files", Buffer.from("old"), { filename: "old.txt", contentType: "text/plain" }).expect(202);
  const beta = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "beta" }).expect(202);
  const gamma = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "gamma" }).expect(202);
  const alphaId = alpha.body.pendingPrompt.id as string;
  const betaId = beta.body.pendingPrompt.id as string;
  const gammaId = gamma.body.pendingPrompt.id as string;
  const oldFile = instance.db.getPendingPrompt(alphaId)!.files[0];
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  assert.equal(fs.existsSync(path.join(workspace, oldFile.relative_path)), true);
  let detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.deepEqual(detail.body.messages.map((message: { content: string }) => message.content), ["first"]);
  assert.deepEqual(detail.body.pendingPrompts.map((prompt: { id: string }) => prompt.id), [alphaId, betaId, gammaId]);

  await agent.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/order`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ ids: [gammaId, alphaId, betaId] }).expect(200);
  assert.deepEqual(instance.db.listPendingPrompts(conversationId).map((prompt) => prompt.id), [gammaId, alphaId, betaId]);

  const releases = new Map<string, () => void>();
  instance.runner.run = async (jobId, id) => {
    await new Promise<void>((resolve) => releases.set(jobId, resolve));
    instance.db.finishJob(jobId, id, "completed");
  };
  let steeredPrompt = "";
  instance.runner.steer = async (jobId, prompt) => {
    assert.equal(jobId, first.body.job.id);
    steeredPrompt = prompt;
    return crypto.randomUUID();
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 20 && !releases.has(first.body.job.id); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  await agent.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${gammaId}/steer`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(steeredPrompt, "gamma");
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "gamma"]);

  await agent.delete(`/codex-web/api/conversations/${conversationId}/pending-prompts/${betaId}`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(204);
  await agent.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${alphaId}/edit`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  assert.equal(instance.db.listPendingPrompts(conversationId, "editing")[0].id, alphaId);

  releases.get(first.body.job.id)!();
  for (let attempt = 0; attempt < 30 && instance.db.getJob(first.body.job.id)?.status !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(instance.db.listActiveJobsForConversation(conversationId).length, 0);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "gamma"]);

  await agent.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/${alphaId}`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "alpha edited")
    .field("removedFileIds", JSON.stringify([oldFile.id]))
    .attach("files", Buffer.from("new"), { filename: "new.txt", contentType: "text/plain" })
    .expect(200);
  assert.equal(instance.db.getFile(oldFile.id), undefined);
  assert.equal(fs.existsSync(path.join(workspace, oldFile.relative_path)), false);
  const updated = instance.db.getPendingPrompt(alphaId)!;
  assert.equal(updated.content, "alpha edited");
  assert.deepEqual(updated.files.map((file) => file.original_name), ["new.txt"]);

  await instance.pumpQueue();
  for (let attempt = 0; attempt < 30 && !instance.db.listActiveJobsForConversation(conversationId).some((job) => job.id !== first.body.job.id); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const editedJob = instance.db.listActiveJobsForConversation(conversationId)[0];
  assert.ok(editedJob);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "gamma", "alpha edited"]);
  for (let attempt = 0; attempt < 20 && !releases.has(editedJob.id); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  releases.get(editedJob.id)!();
  for (let attempt = 0; attempt < 20 && instance.db.getJob(editedJob.id)?.status !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.pendingPrompts.length, 0);
  assert.equal(detail.body.editingPrompt, null);
});

test("nightly Codex maintenance gate prevents a new job from racing runtime promotion", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-update-gate-test-"));
  const dataRoot = path.join(root, "data");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Update-Gate-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Update-Gate-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  fs.writeFileSync(path.join(dataRoot, ".codex-update-maintenance"), "test");
  const response = await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "must not queue" }).expect(503);
  assert.match(response.body.error, /Codex/);
  assert.equal(instance.db.listQueuedJobs().length, 0);
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dataRoot, ".codex-update-maintenance"), stale, stale);
  await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "stale gate must recover" }).expect(202);
  assert.equal(instance.db.listQueuedJobs().length, 1);
});

test("account identity uses the signed-in display name for the label and avatar", () => {
  assert.deepEqual(resolveAccountIdentity({ username: "wh", displayName: "WH" }), { displayName: "WH", initials: "WH" });
  assert.deepEqual(resolveAccountIdentity({ username: "wenhao", displayName: "Wen Hao" }), { displayName: "Wen Hao", initials: "WH" });
  assert.deepEqual(resolveAccountIdentity({ username: "member", displayName: "文豪" }), { displayName: "文豪", initials: "文豪" });
});

test("different conversations start concurrently without global or per-user limits", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-parallel-conversations-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Parallel-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Parallel-Password-2026!" }).expect(200);
  const jobIds: string[] = [];
  for (const message of ["alpha", "beta", "gamma"]) {
    const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
    const submitted = await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/messages`)
      .set("X-CSRF-Token", login.body.csrfToken).send({ message }).expect(202);
    assert.equal(submitted.body.job.queuePosition, 1);
    jobIds.push(submitted.body.job.id);
  }

  const started: string[] = [];
  const release = new Map<string, () => void>();
  instance.runner.run = async (jobId, conversationId) => {
    started.push(jobId);
    await new Promise<void>((resolve) => release.set(jobId, resolve));
    instance.db.finishJob(jobId, conversationId, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 10 && started.length < jobIds.length; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(started, jobIds);
  assert.deepEqual(jobIds.map((id) => instance.db.getJob(id)?.status), ["running", "running", "running"]);
  for (const id of jobIds) release.get(id)!();
  for (let attempt = 0; attempt < 10 && jobIds.some((id) => instance.db.getJob(id)?.status !== "completed"); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(jobIds.map((id) => instance.db.getJob(id)?.status), ["completed", "completed", "completed"]);
});

test("database restart keeps queued work but interrupts a previously running job", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-durable-queue-test-"));
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const queuedId = crypto.randomUUID();
  const runningId = crypto.randomUUID();
  const first = new AppDatabase(root);
  first.createConversation(conversationId, "durable queue");
  first.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "resume later", created_at: new Date().toISOString() });
  first.createJob(queuedId, conversationId, messageId, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  first.createJob(runningId, conversationId, messageId, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  first.updateJob(runningId, "running");
  first.close();
  const reopened = new AppDatabase(root);
  context.after(() => { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(reopened.getJob(queuedId)?.status, "queued");
  assert.equal(reopened.getJob(runningId)?.status, "interrupted");
  assert.equal(reopened.getNextQueuedJob()?.id, queuedId);
});

test("message file links map only registered safe attachments", () => {
  const file: WorkFile = {
    id: "file-1",
    original_name: "ConditionType 统计结果.xlsx",
    relative_path: "outputs/ConditionType 统计结果.xlsx",
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 42,
    kind: "output",
  };
  const expected = "/codex-web/api/files/file-1?download=1";
  assert.equal(isLocalMarkdownUrl("sandbox:/mnt/data/ConditionType 统计结果.xlsx"), true);
  assert.deepEqual(resolveMessageFileLink("sandbox:/mnt/data/ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("D:\\workspace\\codex-web\\workspaces\\abc\\outputs\\ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("/home/owner/app/workspaces/abc/outputs/ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("outputs/ConditionType 统计结果.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("sandbox:/mnt/data/not-registered.xlsx", [file]), { kind: "unavailable" });
  assert.deepEqual(resolveMessageFileLink("D:\\secret\\not-registered.xlsx", [file]), { kind: "unavailable" });
  assert.deepEqual(resolveMessageFileLink("outputs/../secret.xlsx", [file]), { kind: "unavailable" });
  assert.deepEqual(resolveMessageFileLink("https://example.com/help", [file]), { kind: "regular", href: "https://example.com/help" });
});

test("private file citations become safe readable references", () => {
  const file = {
    original_name: "24级6班物理成绩复盘.pptx",
    relative_path: "uploads/5466e122-8e9c-4b42-8912-2ce9c539eecf.pptx",
  };
  const raw = '已读完。 :codex-file-citation{path="/app/workspaces/conversation/uploads/5466e122-8e9c-4b42-8912-2ce9c539eecf.pptx" artifact_kind="presentation" slide_number="1"}';
  const safe = sanitizeAgentMarkdown(raw, [file]);
  assert.equal(safe, "已读完。 （引用：24级6班物理成绩复盘.pptx，第 1 页）");
  assert.doesNotMatch(safe, /codex-file-citation|\/app\/workspaces/);
  assert.equal(
    sanitizeAgentMarkdown(':codex-file-citation{path="/tmp/unknown.pdf" artifact_kind="pdf" page_number="3"}'),
    "（引用：PDF，第 3 页）",
  );
});

test("conversation API sanitizes historical file citations without rewriting the database", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-citation-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);

  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const diskName = `${crypto.randomUUID()}.pptx`;
  const raw = `结论。 :codex-file-citation{path="/app/workspaces/${conversationId}/uploads/${diskName}" artifact_kind="presentation" slide_number="2"}`;
  instance.db.createConversation(conversationId, "citation");
  instance.db.addMessage({ id: userMessageId, conversation_id: conversationId, role: "user", content: "读一下", created_at: new Date().toISOString() });
  instance.db.addFile({
    id: crypto.randomUUID(), conversation_id: conversationId, message_id: userMessageId,
    original_name: "班级复盘.pptx", relative_path: `uploads/${diskName}`,
    mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 10, kind: "upload", created_at: new Date().toISOString(),
  });
  instance.db.addMessage({ id: assistantMessageId, conversation_id: conversationId, role: "assistant", content: raw, created_at: new Date().toISOString() });

  const response = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(response.body.messages.at(-1).content, "结论。 （引用：班级复盘.pptx，第 2 页）");
  assert.equal(instance.db.listMessages(conversationId).at(-1)?.content, raw);
});

test("AI-titled conversations hide repeated title envelopes without rewriting audit rows", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-title-envelope-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);

  const conversationId = crypto.randomUUID();
  const raw = '{"answer":"已确认：双出口抖动已经停止。\\n\\n连续检查均正常。","title":"NAS 双出口抖动已停止"}';
  instance.db.createConversation(conversationId, "新任务");
  assert.equal(instance.db.setAiConversationTitleIfDefault(conversationId, "会话测试"), true);
  instance.db.addMessage({ id: crypto.randomUUID(), conversation_id: conversationId, role: "assistant", content: raw, created_at: new Date().toISOString() });

  const response = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(response.body.messages[0].content, "已确认：双出口抖动已经停止。\n\n连续检查均正常。");
  assert.equal(instance.db.listMessages(conversationId)[0].content, raw);
});

test("selection and activity recovery reject stale conversations and deduplicate replay", () => {
  const conversations = [{ id: "valid", title: "Valid", status: "idle", created_at: "", updated_at: "" }] as Conversation[];
  assert.equal(chooseSelectedConversation("valid", conversations), "valid");
  assert.equal(chooseSelectedConversation("deleted", conversations), "valid");
  assert.equal(chooseSelectedConversation("deleted", []), null);
  assert.deepEqual(mergeJobEvents([{ seq: 1, type: "progress", label: "old" }], [
    { seq: 1, type: "progress", label: "new" },
    { seq: 2, type: "done" },
  ]).map((event) => [event.seq, event.label ?? event.type]), [[1, "new"], [2, "done"]]);
  assert.equal(isTerminalJob({ id: "j", conversation_id: "valid", status: "cancelled" }), true);
  assert.equal(isTerminalJob({ id: "j", conversation_id: "valid", status: "running" }), false);
});

test("job finalization makes job and conversation terminal atomically", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-db-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
    const conversationId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    db.createConversation(conversationId, status);
    db.createJob(jobId, conversationId);
    db.updateJob(jobId, "running");
    db.updateConversation(conversationId, { status: "running" });
    db.appendEvent(jobId, "progress", { label: "saved step" });
    if (status === "completed") db.addMessage({ id: crypto.randomUUID(), conversation_id: conversationId, role: "assistant", content: "result", created_at: new Date().toISOString() });
    db.finishJob(jobId, conversationId, status, status === "failed" ? "boom" : null);
    assert.equal(db.getJob(jobId)?.status, status);
    assert.equal(db.getConversation(conversationId)?.status, "idle");
    assert.equal(db.getActiveJobForConversation(conversationId), undefined);
    assert.equal(db.listEvents(jobId).length, 1);
    if (status === "completed") assert.equal(db.listMessages(conversationId).at(-1)?.content, "result");
  }
});

test("job progress events refresh the job activity timestamp", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-job-activity-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  db.createConversation(conversationId, "activity");
  db.createJob(jobId, conversationId);
  db.sqlite.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", jobId);
  db.appendEvent(jobId, "progress", { label: "still working" });
  assert.equal(db.getJob(jobId)?.updated_at, db.listEvents(jobId)[0].created_at);
  assert.notEqual(db.getJob(jobId)?.updated_at, "2000-01-01T00:00:00.000Z");
});

test("conversation history loads the newest page first and older pages on demand", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-message-pages-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);

  const conversationId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "paged history");
  const ids = Array.from({ length: 65 }, (_, index) => `message-${String(index).padStart(3, "0")}`);
  ids.forEach((id, index) => instance.db.addMessage({
    id,
    conversation_id: conversationId,
    role: index % 2 ? "assistant" : "user",
    content: `message ${index}`,
    created_at: new Date(Date.UTC(2026, 6, 20, 0, 0, index)).toISOString(),
  }));

  const first = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.deepEqual(first.body.messages.map((message: { id: string }) => message.id), ids.slice(35));
  assert.deepEqual(first.body.messagePage, { hasMore: true, nextCursor: ids[35] });
  const second = await agent.get(`/codex-web/api/conversations/${conversationId}/messages?before=${ids[35]}`).expect(200);
  assert.deepEqual(second.body.messages.map((message: { id: string }) => message.id), ids.slice(5, 35));
  assert.deepEqual(second.body.messagePage, { hasMore: true, nextCursor: ids[5] });
  const third = await agent.get(`/codex-web/api/conversations/${conversationId}/messages?before=${ids[5]}`).expect(200);
  assert.deepEqual(third.body.messages.map((message: { id: string }) => message.id), ids.slice(0, 5));
  assert.deepEqual(third.body.messagePage, { hasMore: false, nextCursor: null });
  await agent.get(`/codex-web/api/conversations/${conversationId}/messages`).expect(400);
  await agent.get(`/codex-web/api/conversations/${conversationId}/messages?before=missing-message`).expect(400);
});

test("conversation detail restores running progress and terminal SSE replay", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-recovery-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);

  const conversationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "recover me");
  instance.db.createJob(jobId, conversationId);
  instance.db.updateJob(jobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  instance.db.appendEvent(jobId, "status", { label: "started" });
  instance.db.appendEvent(jobId, "progress", { label: "step two" });

  const running = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(running.body.activeJob.id, jobId);
  assert.equal(running.body.jobEvents.length, 2);
  assert.equal(running.body.jobEvents[1].label, "step two");

  instance.db.addMessage({ id: crypto.randomUUID(), conversation_id: conversationId, role: "assistant", content: "finished", created_at: new Date().toISOString() });
  instance.db.finishJob(jobId, conversationId, "completed");
  instance.db.appendEvent(jobId, "done", { status: "completed" });
  const terminal = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(terminal.body.activeJob, null);
  assert.equal(terminal.body.latestJob.status, "completed");
  assert.equal(terminal.body.messages.at(-1).content, "finished");

  const replay = await agent.get(`/codex-web/api/jobs/${jobId}/events?after=1`).expect(200);
  assert.equal(replay.headers["x-accel-buffering"], "no");
  assert.doesNotMatch(replay.text, /id: 1\n/);
  assert.match(replay.text, /id: 2\n/);
  assert.match(replay.text, /id: 3\n/);
  await agent.get(`/codex-web/api/conversations/${crypto.randomUUID()}`).expect(404);
});
