import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import request from "supertest";
import sharp from "sharp";
import type { ThreadEvent } from "@openai/codex-sdk";
import { createApp, fileResponseContentType, migrateExistingOutputFiles } from "../server/app.js";
import { assertProductionConfig, loadConfig } from "../server/config.js";
import { AUTO_TITLE_OUTPUT_SCHEMA, MODEL_CAPACITY_CONTINUATION_PROMPT, capacityRetryPrompt, extractLeakedAutoTitleAnswer, parseAutoTitleResponse, redactBrandForDisplay, summarizeEvent } from "../server/codex-runner.js";
import { buildConversationTitlePrompt, CONVERSATION_TITLE_CODEX_MODEL, CONVERSATION_TITLE_REASONING_EFFORT, normalizeConversationTitle, parseConversationTitleOutput } from "../server/conversation-title.js";
import { IMAGE_THUMBNAIL_HEIGHT, IMAGE_THUMBNAIL_WIDTH } from "../server/image-thumbnail.js";
import { AppDatabase, LEGACY_USER_ID, type FileRow } from "../server/db.js";
import { loadAgentOptions, repairAgentSelection, resolveAgentSelection } from "../server/model-options.js";
import { codexThreadRolloutBytes, ensureTenant, ensureTenantWorkspace, ensureWorkspace, isDeliverablePath, isPersistedDeliverablePath, normalizeStoredRelativePath, normalizeUploadFileName, persistDeliverable, resolveGeneratedImage, resolveInside, safeUploadName, snapshotGeneratedImages } from "../server/paths.js";
import { buildShellEnvironment, cleanupJobRuntime, prepareJobRuntime } from "../server/python-runtime.js";
import { assessTaskPolicy } from "../server/task-policy.js";
import { listTenantIdentities, tenantIdentityForUser } from "../server/tenant-identities.js";
import { consumeTenantTurnEvents, validateTenantWorkerRequest } from "../server/tenant-worker-execution.js";
import type { TenantWorkerRunRequest } from "../server/tenant-worker-protocol.js";
import { isModelCapacityError, isRetryableUpstreamError, modelCapacityRetryDelayMs, runWithTransientRetries } from "../server/retry-policy.js";
import { filePreviewIdFromPath, filePreviewUrl, fileReaderKind, isBrowserPreviewable, isLocalMarkdownUrl, publicFilePreviewIdFromPath, publicFilePreviewUrl, resolveMessageFileLink } from "../src/file-links.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { resolveAccountIdentity } from "../src/account-identity.js";
import { chooseComposerPrimaryAction } from "../src/composer-action.js";
import { prepareMarkdownMath } from "../src/markdown-math.js";
import { ASK_AGENT_SELECTION_MAX_CHARS, buildAskAgentDraft, normalizeAskAgentSelection, visibleSelectionBounds } from "../src/ask-agent-selection.js";
import { mergeMessagePages, preservePrependedScrollTop, resolveUnreadScrollTarget } from "../src/message-history.js";
import { resolveScrollFollow } from "../src/scroll-follow.js";
import { CHAT_FONT_SIZE_DEFAULT, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, normalizeChatFontSize } from "../src/chat-font-size.js";
import { chooseSelectedConversation, isTerminalJob, mergeJobEvents } from "../src/recovery.js";
import { normalizeThemePreference, resolveTheme, themeCanvasColor, THEME_PREFERENCE_KEY } from "../src/theme.js";
import { fileThumbnailUrl, type Conversation, type WorkFile } from "../src/api.js";
import { buildAgentSteerPrompt, buildAgentTurnPrompt } from "../server/agent-context.js";
import { buildProcessJournal } from "../src/process-journal.js";
import { DEFAULT_OPTIONAL_AGENT_CAPABILITIES, buildOptionalCapabilityConfig, detectOptionalAgentCapabilities } from "../server/optional-capabilities.js";
import { USER_CANCELLED_TASK_MARKER, latestUserCancellationContext } from "../server/cancellation-summary.js";
import { formatContextUsage, formatRolloutBytes, ROLLOUT_WARNING_BYTES, shouldWarnAboutRollout } from "../src/rollout-capacity.js";
import { appServerNotificationBelongsToThread, normalizeCodexQuotaUsage, normalizeContextTokenUsage, summarizeAppServerItem } from "../server/app-server-turn.js";
import { recoverBrowserSession } from "../src/session-recovery.js";
import { PublicShareAssetError, resolvePublicShareAssets, rewritePublicShareDocument } from "../server/public-file-share.js";
import { buildSubagentActivity } from "../src/subagent-activity.js";

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
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const serverSource = fs.readFileSync(path.join(process.cwd(), "server", "app.ts"), "utf8");
  assert.match(appSource, /const \[username, setUsername\] = useState\(""\)/);
  assert.doesNotMatch(appSource, /useState\("owner"\)/);
  assert.match(appSource, /用户名<input autoComplete="username" autoFocus/);
  assert.match(appSource, /密码<input autoComplete="current-password" type="password"/);
  assert.match(apiSource, /login: \(username: string, password: string\)/);
  assert.match(serverSource, /api\.post\("\/auth\/login"[\s\S]*req\.body\?\.username[\s\S]*req\.body\?\.password/);
  assert.doesNotMatch(`${appSource}\n${apiSource}\n${serverSource}`, /phone|sms|手机号|短信/i);
});

test("browser session recovery retries transient failures and a briefly missing cookie", async () => {
  const authenticated = { authenticated: true, csrfToken: "csrf" };
  const outcomes: Array<Error | { authenticated: boolean; csrfToken?: string }> = [
    new TypeError("network unavailable while restoring tab"),
    { authenticated: false },
    authenticated,
  ];
  const waits: number[] = [];
  const restored = await recoverBrowserSession(async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    assert.ok(next);
    return next;
  }, {
    transientRetryDelaysMs: [10],
    unauthenticatedRetryDelaysMs: [20, 30],
    wait: async (delayMs) => { waits.push(delayMs); },
  });
  assert.deepEqual(restored, authenticated);
  assert.deepEqual(waits, [10, 20]);
});

test("browser session recovery eventually accepts a confirmed logged-out state", async () => {
  let attempts = 0;
  const restored = await recoverBrowserSession(async () => {
    attempts += 1;
    return { authenticated: false };
  }, {
    unauthenticatedRetryDelaysMs: [10, 20],
    wait: async () => {},
  });
  assert.deepEqual(restored, { authenticated: false });
  assert.equal(attempts, 3);
});

test("browser session recovery aborts and retries a stalled mobile restore request", async () => {
  let attempts = 0;
  const restored = await recoverBrowserSession((signal) => {
    attempts += 1;
    if (attempts > 1) return Promise.resolve({ authenticated: true, csrfToken: "restored" });
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  }, {
    attemptTimeoutMs: 1,
    transientRetryDelaysMs: [0],
    wait: async () => undefined,
  });
  assert.deepEqual(restored, { authenticated: true, csrfToken: "restored" });
  assert.equal(attempts, 2);
});

test("composer replaces stop with send as soon as there is sendable input", () => {
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: false, voiceActive: false }), "stop");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: true, hasAttachments: false, voiceActive: false }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: true, voiceActive: false }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: false, voiceActive: true }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: false, hasText: false, hasAttachments: false, voiceActive: false }), "send");
});

test("voice input explains the five-minute recording limit before transcription starts", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /5 \* 60 \* 1000/);
  assert.match(appSource, /已达到 5 分钟录音上限，正在识别…/);
  assert.match(appSource, /className="voice-notice" role="status" aria-live="polite"/);
});

test("empty mobile composer long-press starts voice input without changing ordinary taps", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /COMPOSER_LONG_PRESS_DELAY_MS = 650/);
  assert.match(appSource, /onPointerDown=\{beginLongPress\}/);
  assert.match(appSource, /void startRecording\(\)/);
  assert.match(styles, /\.composer textarea\.long-press-armed/);
});

test("personal settings close on outside click and Escape", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /accountAreaRef/);
  assert.match(appSource, /setAccountSettingsOpen\(false\)/);
  assert.match(appSource, /event\.key === "Escape"/);
});

test("model capacity retries continue an already-started task without replaying it", () => {
  assert.equal(capacityRetryPrompt("原始任务", false), "原始任务");
  assert.equal(capacityRetryPrompt("原始任务", true), MODEL_CAPACITY_CONTINUATION_PROMPT);
  assert.match(MODEL_CAPACITY_CONTINUATION_PROMPT, /不要重复已经完成的步骤/);
});

test("scheduled prompts use an amber clock identity instead of impersonating the user", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /const scheduledMessage = message\.role === "user" && Boolean\(message\.is_scheduled\)/);
  assert.match(appSource, /scheduledMessage \? <Clock3 size=\{15\} \/>/);
  assert.match(appSource, /scheduledMessage \? "定时任务"/);
  assert.match(styles, /\.message\.user \.message-avatar\.scheduled \{[^}]*background: linear-gradient\(145deg, #f8bb55, var\(--amber\)\);/);
});

test("uploading composer attachments expose per-file cancellation backed by AbortController", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  assert.match(appSource, /draftUploadControllersRef\.current\.get\(uploadId\)\?\.abort\(\)/);
  assert.match(appSource, /aria-label=\{`取消上传 \$\{file\.name\}`\}/);
  assert.match(apiSource, /draft\/files`, \{ method: "POST", body, signal \}/);
});

test("the tus browser client is loaded only when a resumable upload starts", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.doesNotMatch(appSource, /^import .* from ["']tus-js-client["'];$/m);
  assert.match(appSource, /startResumableComposerUpload[\s\S]*await import\("tus-js-client"\)/);
  assert.match(appSource, /file\.size >= RESUMABLE_UPLOAD_THRESHOLD_BYTES[\s\S]*if \(upload\.resumable\)[\s\S]*startResumableComposerUpload/);

  const distRoot = path.join(process.cwd(), "dist");
  const builtIndex = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
  const entryPath = builtIndex.match(/<script[^>]+src="([^"]+\.js)"/)?.[1].replace(/^\/codex-web\//, "").replace(/^\/+/, "");
  assert.ok(entryPath, "the production build should expose its JavaScript entry");
  const assetsRoot = path.join(distRoot, "assets");
  const tusChunks = fs.readdirSync(assetsRoot).filter((name) => {
    if (!name.endsWith(".js")) return false;
    const source = fs.readFileSync(path.join(assetsRoot, name), "utf8");
    return source.includes("tus-js-client") && source.includes("Tus-Resumable") && source.includes("Upload-Offset");
  });
  assert.equal(tusChunks.length, 1, "the production build should emit one isolated tus client chunk");
  const entrySource = fs.readFileSync(path.join(distRoot, entryPath), "utf8");
  assert.doesNotMatch(entrySource, /tus-js-client|Tus-Resumable|Upload-Offset/);
  assert.ok(entrySource.includes(tusChunks[0]), "the entry should reference the isolated tus chunk dynamically");
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
  assert.equal(themeCanvasColor("light"), "#fafbff");
  assert.equal(themeCanvasColor("dark"), "#17181b");

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const indexSource = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  const themeSource = fs.readFileSync(path.join(process.cwd(), "src", "theme.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /使用浅色模式[\s\S]*使用深色模式[\s\S]*外观跟随系统/);
  assert.match(appSource, /matchMedia\?\.\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(indexSource, /<meta name="theme-color" content="#fafbff" \/>/);
  assert.match(themeSource, /meta\[name="theme-color"\][\s\S]*setAttribute\("content", themeCanvasColor\(resolved\)\)/);
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

test("user messages wrap long unbroken input inside their bubble", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(styles, /\.message-body > p \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/);
});
test("switching conversations hides stale detail until the selected task loads", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /currentDetail = detail\?\.conversation\.id === selectedId \? detail : null/);
  assert.match(appSource, /loadingConversation \? <ConversationLoading restoring=\{restoringConversationSelection\} \/>/);
  assert.match(appSource, /conversationSelectionReady && \(!selectedId \|\| \(currentDetail && !currentDetail\.conversation\.archived_at\)\) && <Composer/);
  assert.match(appSource, /正在恢复上次任务…/);
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

test("sidebar task actions collapse into a stable overflow menu", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const rowActions = appSource.match(/<div className="row-actions">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.match(rowActions, /className="task-menu-trigger"[\s\S]*?<MoreHorizontal/);
  assert.doesNotMatch(rowActions, /<Pencil|<Trash2/);
  assert.match(appSource, /className="task-menu-panel"[\s\S]*?<Archive[\s\S]*?<Pencil[\s\S]*?<Trash2/);
  assert.match(styles, /\.row-actions \{[^}]*width: 30px;[^}]*flex: 0 0 30px;[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(styles, /\.conversation-row:hover \.row-actions, \.conversation-row:focus-within \.row-actions, \.conversation-row\.menu-open \.row-actions \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(styles, /@media \(hover: none\) \{\s*\.row-actions \{ opacity: 1; pointer-events: auto; \}/);
});

test("conversation search matches message bodies while retaining the selected task", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-search-body-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const bodyMatch = db.createConversation(crypto.randomUUID(), "普通标题");
  const titleMatch = db.createConversation(crypto.randomUUID(), "英雄养成分析");
  db.addMessage({ id: crypto.randomUUID(), conversation_id: bodyMatch.id, role: "user", content: "请分析英雄养成效率", created_at: new Date().toISOString() });
  assert.deepEqual(new Set(db.searchConversations(LEGACY_USER_ID, "英雄养成").map((conversation) => conversation.id)), new Set([bodyMatch.id, titleMatch.id]));
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /api\.conversations\(search\)/);
  assert.match(appSource, /if \(selected && !conversations\.some/);
});

test("mobile Safari restores the non-fixed app viewport after the software keyboard closes", () => {
  const mainSource = fs.readFileSync(path.join(process.cwd(), "src", "main.tsx"), "utf8");
  const viewportSource = fs.readFileSync(path.join(process.cwd(), "src", "mobile-viewport.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(styles, /html, body, #root \{[^}]*min-height: var\(--app-viewport-height, 100%\);[^}]*height: var\(--app-viewport-height, 100%\);[^}]*overflow: hidden;[^}]*overscroll-behavior: none;[^}]*background: var\(--canvas\);/);
  assert.doesNotMatch(styles, /body \{[^}]*100dvh/);
  assert.doesNotMatch(styles, /body \{[^}]*position: fixed;/);
  assert.match(styles, /#root \{[^}]*width: 100%;/);
  assert.match(styles, /\.login-page \{[^}]*position: relative;[^}]*height: 100%;[^}]*overflow: hidden;/);
  assert.match(styles, /\.shell \{[^}]*height: 100%;[^}]*overflow: hidden;/);
  assert.match(styles, /\.messages \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*-webkit-overflow-scrolling: touch;/);
  assert.match(mainSource, /installMobileViewportRecovery\(\);/);
  assert.match(viewportSource, /visualViewport/);
  assert.match(viewportSource, /viewport\.offsetTop/);
  assert.match(viewportSource, /height \+ validOffsetTop/);
  assert.match(viewportSource, /requestAnimationFrame\(apply\)/);
  assert.match(viewportSource, /addEventListener\("focusout", scheduleSettled\)/);
  assert.match(viewportSource, /documentElement\.scrollTop = 0/);
});

test("rollout capacity warning uses a 500 MiB threshold and readable binary units", () => {
  assert.equal(ROLLOUT_WARNING_BYTES, 524_288_000);
  assert.equal(shouldWarnAboutRollout(ROLLOUT_WARNING_BYTES - 1), false);
  assert.equal(shouldWarnAboutRollout(ROLLOUT_WARNING_BYTES), true);
  assert.equal(formatRolloutBytes(971_549_720), "926.5 MiB");
  assert.equal(formatRolloutBytes(1.25 * 1024 ** 3), "1.3 GiB");
});

test("conversation capacity tracks context tokens and remaining Codex quota", () => {
  assert.deepEqual(normalizeContextTokenUsage({
    threadId: "thread-1",
    tokenUsage: { last: { inputTokens: 202_345 }, modelContextWindow: 258_400 },
  }), { threadId: "thread-1", inputTokens: 202_345, modelContextWindow: 258_400 });
  assert.equal(normalizeContextTokenUsage({ threadId: "thread-1", tokenUsage: { last: {} } }), null);
  assert.deepEqual(normalizeCodexQuotaUsage({ rateLimits: { primary: { usedPercent: 56 } } }), { remainingPercent: 44 });
  assert.deepEqual(normalizeCodexQuotaUsage({ rateLimits: { primary: { usedPercent: 105 } } }), { remainingPercent: 0 });
  assert.equal(formatContextUsage(202_345, 258_400), "202.3K / 258.4K");

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /Rollout 文件[\s\S]*Codex 上下文[\s\S]*套餐额度/);
  assert.match(appSource, /formatContextUsage\(detail\.contextUsage\.inputTokens, detail\.contextUsage\.modelContextWindow\)/);
  assert.match(styles, /\.capacity-menu-panel \{[^}]*width: 190px;/);
});

test("completed conversations stay visibly unread until their detail is viewed", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const dbSource = fs.readFileSync(path.join(process.cwd(), "server", "db.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /conversation\.has_unread_result \? "unread" : ""/);
  assert.match(appSource, /result\.conversation\.has_unread_result[\s\S]*?api\.markConversationSeen\(id\)/);
  assert.match(appSource, /window\.setInterval\([\s\S]*?refreshList\(\)[\s\S]*?10_000/);
  assert.match(apiSource, /markConversationSeen:[\s\S]*?\/conversations\/\$\{id\}\/seen[\s\S]*?method: "POST"/);
  assert.match(styles, /\.conversation-row\.unread \.conversation-select::after \{[^}]*background: #38c976;[^}]*content: "";/);
  assert.match(appSource, /resolveUnreadScrollTarget\(result\.messages, unreadAnchorMessageId/);
  assert.match(appSource, /data-message-id=\{message\.id\}/);
  assert.match(dbSource, /unread_anchor_message_id=COALESCE\(unread_anchor_message_id,/);
  assert.equal(resolveUnreadScrollTarget([
    { id: "prompt", role: "user", created_at: "1" },
    { id: "reply", role: "assistant", created_at: "2" },
  ], "reply", false), "prompt");
});

test("mobile model menus stay inside the viewport and scroll internally", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const mobileBlock = styles.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(styles, /\.setting-menu-panel \{[^}]*max-height: min\(420px, calc\(60dvh - env\(safe-area-inset-top\)\)\);[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*-webkit-overflow-scrolling: touch;/);
  assert.match(mobileBlock, /\.setting-menu\.model \.setting-menu-panel \{[^}]*right: auto;[^}]*left: 0;[^}]*width: min\(236px, calc\(100vw - 76px\)\);/);
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
  assert.match(appSource, /messages\?\.addEventListener\("scroll", update/);
  assert.doesNotMatch(appSource, /messages\?\.addEventListener\("scroll", clear/);
  assert.match(appSource, /询问 Agent/);
  assert.match(appSource, /className="ask-agent-reference"/);
  assert.match(appSource, /setAskAgentQuote\(normalized\.slice/);
  assert.doesNotMatch(appSource, /buildAskAgentDraft/);
  assert.match(appSource, /api\.sendMessage\(id, message, useComposerDraft \? \[\] : files, askAgentQuote, useComposerDraft\)/);
  assert.match(appSource, /className="message-reference"/);
  assert.match(appSource, /focusRequest=\{composerFocusRequest\}/);
  assert.match(styles, /\.ask-agent-selection \{[^}]*position: fixed;[^}]*touch-action: manipulation/);
  assert.match(styles, /\.ask-agent-reference \{/);
  assert.match(styles, /\.message-reference \{/);
  assert.match(styles, /:root\[data-theme="dark"\] \.ask-agent-selection/);
  assert.match(styles, /:root\[data-theme="dark"\] \.ask-agent-reference/);
});

test("selected message text stays anchored only while it intersects the message viewport", () => {
  const viewport = { left: 100, top: 50, right: 500, bottom: 450 };
  assert.deepEqual(visibleSelectionBounds([
    { left: 80, top: 40, right: 220, bottom: 80 },
    { left: 140, top: 90, right: 540, bottom: 120 },
  ], viewport), { left: 100, top: 50, right: 500, bottom: 120 });
  assert.equal(visibleSelectionBounds([
    { left: 120, top: -40, right: 300, bottom: 40 },
    { left: 120, top: 460, right: 300, bottom: 490 },
  ], viewport), null);
});
test("pending queue stays translucent and vertically compact in both themes", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /className=\{`workspace \$\{currentDetail\?\.pendingPrompts\.length \? "has-pending-queue" : ""\}`\}/);
  assert.match(styles, /\.pending-queue \{[^}]*background: rgba\(255, 255, 255, \.72\);[^}]*backdrop-filter: blur\(10px\)/);
  assert.match(styles, /\.pending-queue-heading \{[^}]*min-height: 26px;[^}]*padding: 4px 9px 3px;/);
  assert.match(styles, /\.pending-queue-list \{[^}]*max-height: 174px;[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*touch-action: pan-y;/);
  assert.match(styles, /\.pending-queue-item \{[^}]*min-height: 34px;[^}]*padding: 2px 4px 2px 0;/);
  assert.match(styles, /\.workspace\.has-pending-queue \.composer-wrap \{[^}]*position: relative;[^}]*flex: 0 0 auto;[^}]*align-self: center;[^}]*transform: none;/);
  assert.match(styles, /\.workspace\.has-pending-queue \.messages \{ padding-bottom: 24px; \}/);
  assert.match(styles, /:root\[data-theme="dark"\] \.pending-queue \{[^}]*background: rgba\(40, 41, 46, \.72\);/);
  assert.match(appSource, /onPointerDown=\{\(event\) => beginTouchDrag\(event, prompt\.id\)\}/);
  assert.match(styles, /\.pending-drag-handle \{[^}]*touch-action: none;/);
  assert.match(appSource, /actionMode === "steer" \? "引导" : "插入"/);
  assert.match(appSource, /等待计划结束后依次发送/);
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

test("running work journal retains every important direction and compacts repeated actions", () => {
  const journal = buildProcessJournal([
    { seq: 1, kind: "reasoning", label: "模型思路摘要", detail: "先确认数据口径" },
    { seq: 2, kind: "command", label: "正在读取并核对资料", detail: "rg sales" },
    { seq: 3, kind: "command", label: "资料读取与核对完成", detail: "rg sales" },
    { seq: 31, kind: "command", label: "质量验证完成", detail: "npm test" },
    { seq: 4, kind: "update", label: "阶段反馈", detail: "已确认按自然月统计" },
    { seq: 5, kind: "file", label: "已更新文件", files: ["outputs/report.xlsx"] },
    { seq: 6, kind: "file", label: "已更新文件", files: ["outputs/report.xlsx"] },
    { seq: 7, kind: "reasoning", label: "模型思路摘要", detail: "再验证汇总结果" },
    { seq: 8, kind: "status", label: "工作已完成，正在整理结果" },
    { seq: 9, kind: "update", label: "阶段反馈", detail: "桌面检查通过，继续检查手机布局" },
  ]);
  assert.deepEqual(journal.map((event) => event.seq), [1, 3, 4, 5, 7, 9]);
  assert.equal(journal[1].label, "运行了 2 个本机步骤");
  assert.equal(journal[1].actionCount, 2);
  assert.deepEqual(journal[1].groupedDetails, ["rg sales", "npm test"]);
  assert.deepEqual(journal.filter((event) => ["reasoning", "update"].includes(event.kind ?? "")).map((event) => event.detail), [
    "先确认数据口径", "已确认按自然月统计", "再验证汇总结果", "桌面检查通过，继续检查手机布局",
  ]);
  assert.equal(journal.filter((event) => event.kind === "update").length, 2);
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.doesNotMatch(appSource, /compactActivitySteps\(activities\)\.slice/);
  assert.match(appSource, /journal\.map\(\(activity, index\) => isNarrativeActivity\(activity\)/);
  assert.doesNotMatch(appSource, /stageFeedback|process-journal-pinned/);
  assert.match(styles, /\.process-journal \{[^}]*position: relative;[^}]*overflow-x: hidden;[^}]*border-top:/);
  assert.doesNotMatch(styles, /\.process-journal \{[^}]*max-height:|\.process-journal \{[^}]*overflow-y: auto|\.process-journal \{[^}]*overscroll-behavior-y:/);
  assert.doesNotMatch(styles, /\.process-journal-pinned|position: sticky;/);
  assert.match(appSource, /\{sending && <article className="message assistant running"/);
  assert.match(appSource, /完成前持续保留，可随时引导/);
});

test("running activity waits for a complete snapshot and SSE replay boundary", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const serverSource = fs.readFileSync(path.join(process.cwd(), "server", "app.ts"), "utf8");
  assert.match(appSource, /正在加载运行记录/);
  assert.match(appSource, /await refreshActivity\(id\)/);
  assert.match(appSource, /data\.type === "replay_complete"/);
  assert.match(serverSource, /api\.get\("\/conversations\/:id\/activity"/);
  assert.match(serverSource, /const replayComplete = \(\) => res\.write/);
});

test("running progress expands inline without a nested vertical scroller", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /<ProcessPanel key=\{detail\.conversation\.id\} activities=\{activities\}/);
  assert.match(appSource, /<div className="process-journal">\{journal\.length/);
  assert.doesNotMatch(appSource, /journalElement|journalFollowingRef|handleJournalScroll/);
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

test("legacy structured first-turn envelopes remain readable after title generation moved out of the main turn", () => {
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

test("dedicated Codex Luna title agent uses precise short titles and keeps an auditable request", (context) => {
  assert.equal(CONVERSATION_TITLE_CODEX_MODEL, "gpt-5.6-luna");
  assert.equal(CONVERSATION_TITLE_REASONING_EFFORT, "low");
  const prompt = buildConversationTitlePrompt({
    requestText: "请帮我优化 Last War 的英雄养成分析流程",
    attachmentNames: ["英雄养成表.xlsx"],
  });
  assert.match(prompt, /只负责生成标题，不执行用户任务/);
  assert.match(prompt, /至少使用明确的动宾结构/);
  assert.match(prompt, /英雄养成表\.xlsx/);
  assert.equal(parseConversationTitleOutput('{"title":"优化英雄养成分析"}'), "优化英雄养成分析");
  assert.equal(normalizeConversationTitle("标题：修复登录保持。"), "修复登录保持");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-title-audit-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "新任务");
  const audit = db.createConversationTitleAudit({
    id: crypto.randomUUID(), conversation_id: conversationId, user_id: LEGACY_USER_ID,
    model: CONVERSATION_TITLE_CODEX_MODEL, reasoning_effort: CONVERSATION_TITLE_REASONING_EFFORT,
    prompt_version: "codex-title-v1", request_excerpt: "优化英雄养成分析", request_sha256: "a".repeat(64),
    context_json: JSON.stringify({ attachmentNames: ["英雄养成表.xlsx"] }), started_at: new Date().toISOString(),
  });
  assert.equal(audit.status, "running");
  const finished = db.finishConversationTitleAudit(audit.id, {
    status: "succeeded", outputTitle: "优化英雄养成分析", applied: true,
    completedAt: new Date().toISOString(), durationMs: 321,
  });
  assert.equal(finished?.output_title, "优化英雄养成分析");
  assert.equal(finished?.applied, 1);
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

test("model capacity retries use the infinite cancellable 10/30/60/120/180/240/300 then 5m and after 1h 30m policy", async () => {
  assert.equal(isModelCapacityError("Selected model is at capacity"), true);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => modelCapacityRetryDelayMs(attempt, 0)), [10_000, 30_000, 60_000, 120_000, 180_000, 240_000, 300_000, 300_000]);
  assert.equal(modelCapacityRetryDelayMs(99, 59 * 60_000), 300_000);
  assert.equal(modelCapacityRetryDelayMs(99, 60 * 60_000), 1_800_000);
  let calls = 0;
  const attempts: number[] = [];
  const result = await runWithTransientRetries(async () => {
    calls += 1;
    if (calls < 4) throw new Error("model is at capacity");
    return "available";
  }, { signal: new AbortController().signal, capacityDelayMs: () => 0, onRetry: ({ attempt, maxAttempts }) => { attempts.push(attempt); assert.equal(maxAttempts, undefined); } });
  assert.equal(result, "available");
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("empty conversations are reused and temporarily promoted without affecting non-empty tasks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-empty-reuse-"));
  const db = new AppDatabase(root);
  try {
    const first = db.createConversation(crypto.randomUUID(), "新任务", { model: "gpt-5", reasoningEffort: "high" });
    db.createConversation(crypto.randomUUID(), "已命名任务", { model: "gpt-5", reasoningEffort: "high" });
    const reused = db.reuseEmptyConversationForNewTask(LEGACY_USER_ID);
    assert.equal(reused?.id, first.id);
    assert.equal(db.createOrReuseEmptyConversation(crypto.randomUUID(), { model: "gpt-5", reasoningEffort: "high" }, LEGACY_USER_ID).reused, true);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("sub-agent notifications stay isolated from the parent turn and remain visible as activity", () => {
  assert.equal(appServerNotificationBelongsToThread("parent", { threadId: "child" }), false);
  const event = summarizeAppServerItem({ type: "subAgentActivity", agentThreadId: "child", agentPath: "/root/review" }, false) as { kind: string; agents: Array<{ id: string }> };
  assert.equal(event.kind, "agent");
  const summary = buildSubagentActivity([{ kind: "agent", created_at: new Date().toISOString(), agents: [{ id: "child", path: "/root/review", status: "running" }] }]);
  assert.equal(summary.active[0]?.name, "review");
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
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  };
  assert.doesNotThrow(() => validateTenantWorkerRequest(request, owner.userId, tenantRoot));
  assert.doesNotThrow(() => validateTenantWorkerRequest({ ...request, automation: { baseUrl: "http://127.0.0.1:37821/codex-web", token: "v1.payload.signature" } }, owner.userId, tenantRoot));
  assert.throws(() => validateTenantWorkerRequest({ ...request, automation: { baseUrl: "file:///tmp/socket", token: "v1.payload.signature" } }, owner.userId, tenantRoot), /automation/);
  assert.throws(() => validateTenantWorkerRequest({ ...request, automation: { baseUrl: "https://example.test", token: "not-a-signed-token" } }, owner.userId, tenantRoot), /automation/);
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

test("conversation workspaces stay concise while tenants receive the managed local spreadsheet skill", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-workspace-guidance-test-"));
  const conversationId = crypto.randomUUID();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = ensureWorkspace(root, conversationId);
  const agentsPath = path.join(workspace, "AGENTS.md");
  const initial = fs.readFileSync(agentsPath, "utf8");
  assert.doesNotMatch(initial, /artifact-tool|For local Excel work|Preserve the source workbook/);
  assert.match(initial, /`CWW_SHARED_PYTHON`/);
  assert.match(initial, /`CWW_JOB_RUNTIME`/);
  assert.match(initial, /`CWW_PYTHON_RUNNER`/);
  assert.match(initial, /Never expose absolute paths/);
  assert.match(initial, /Never read codex-home/);
  assert.match(initial, /one self-contained HTML file rather than duplicate Markdown/);
  assert.match(initial, /<meta charset="utf-8">/);
  assert.match(initial, /stack them on narrow screens/);
  fs.appendFileSync(agentsPath, "\n- Keep this custom instruction.\n", "utf8");
  ensureWorkspace(root, conversationId);
  const updated = fs.readFileSync(agentsPath, "utf8");
  assert.match(updated, /Keep this custom instruction/);
  assert.equal(updated.match(/codex-web-managed-start/g)?.length, 1);
  const tenant = ensureTenant(path.join(root, "tenants"), LEGACY_USER_ID);
  const skillPath = path.join(tenant.codexHome, "skills", "local-spreadsheets", "SKILL.md");
  assert.equal(fs.existsSync(skillPath), true);
  assert.match(fs.readFileSync(skillPath, "utf8"), /openpyxl and pandas/);
});

test("agent turn context keeps only current intent, attachments, and conditional safety", () => {
  assert.equal(buildAgentTurnPrompt({ userPrompt: "  请整理这份文件  ", attachments: [] }), "请整理这份文件");
  const withFile = buildAgentTurnPrompt({
    userPrompt: "请汇总",
    attachments: [{ name: "成绩表.xlsx", path: "uploads/abc.xlsx" }],
  });
  assert.match(withFile, /^请汇总\n\n本轮附件：/);
  assert.match(withFile, /成绩表\.xlsx: uploads\/abc\.xlsx/);
  assert.match(withFile, /\$local-spreadsheets/);
  assert.doesNotMatch(withFile, /租户边界|Python 环境策略|绝对路径|answer,title|outputs 中只能/);
  const isolated = buildAgentTurnPrompt({ userPrompt: "检查脚本", attachments: [], isolationReason: "检测到脚本" });
  assert.match(isolated, /离线隔离/);
  assert.match(isolated, /不执行不受信任/);
  assert.equal(buildAgentSteerPrompt("改成蓝色", []), "实时调整当前任务：改成蓝色");
  assert.doesNotMatch(buildAgentTurnPrompt({ userPrompt: "普通任务", attachments: [] }), /Excel attachment rules/);
  const resumed = buildAgentTurnPrompt({ userPrompt: "继续", attachments: [], interruptedContext: `> **${USER_CANCELLED_TASK_MARKER}** retained` });
  assert.match(resumed, /<interrupted_task_context>[\s\S]*retained[\s\S]*<\/interrupted_task_context>/);
});

test("optional agent capabilities stay off until the conversation explicitly asks for them", () => {
  assert.deepEqual(detectOptionalAgentCapabilities(["summarize this file"]), DEFAULT_OPTIONAL_AGENT_CAPABILITIES);
  assert.deepEqual(detectOptionalAgentCapabilities(["请使用子代理并行处理", "enable Gmail connector"]), {
    apps: true, remotePlugin: true, goals: false, multiAgent: true,
  });
  const config = buildOptionalCapabilityConfig(DEFAULT_OPTIONAL_AGENT_CAPABILITIES) as { features: Record<string, boolean>; plugins: Record<string, { enabled: boolean }> };
  assert.equal(Object.values(config.features).every((enabled) => !enabled), true);
  assert.equal(config.plugins["spreadsheets@openai-primary-runtime"].enabled, false);
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
  assert.equal(first.getConversation("legacy")?.has_unread_result, 0);
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

test("generated image snapshots stay scoped to one Codex thread", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-generated-image-test-"));
  const codexHome = path.join(root, "codex-home");
  const threadId = crypto.randomUUID();
  const otherThreadId = crypto.randomUUID();
  const threadRoot = path.join(codexHome, "generated_images", threadId);
  const otherThreadRoot = path.join(codexHome, "generated_images", otherThreadId);
  fs.mkdirSync(threadRoot, { recursive: true });
  fs.mkdirSync(otherThreadRoot, { recursive: true });
  fs.writeFileSync(path.join(threadRoot, "first.png"), "first");
  fs.writeFileSync(path.join(threadRoot, "ignore.txt"), "ignore");
  fs.writeFileSync(path.join(otherThreadRoot, "other.png"), "other");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const before = await snapshotGeneratedImages(codexHome, threadId);
  assert.deepEqual([...before.keys()], ["first.png"]);
  fs.writeFileSync(path.join(threadRoot, "second.webp"), "second");
  const after = await snapshotGeneratedImages(codexHome, threadId);
  assert.deepEqual([...after.keys()], ["first.png", "second.webp"]);
  assert.deepEqual([...after].filter(([name, fingerprint]) => before.get(name) !== fingerprint).map(([name]) => name), ["second.webp"]);
  assert.equal(resolveGeneratedImage(codexHome, threadId, "second.webp"), path.join(threadRoot, "second.webp"));
  assert.throws(() => resolveGeneratedImage(codexHome, threadId, "../other.png"), /Invalid generated image name/);
  await assert.rejects(() => snapshotGeneratedImages(codexHome, "not-a-thread"), /Invalid Codex thread id/);
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

test("authenticated image thumbnails transfer a real 56 by 32 WebP instead of the original", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-image-thumbnail-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot, basePath: "",
    username: "pp", passwordHash: bcrypt.hashSync("Thumbnail-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversationId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "thumbnail transfer");
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  const relativePath = "outputs/original.png";
  const absolutePath = resolveInside(workspace, relativePath);
  await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 29, g: 74, b: 141 } },
  }).png().toFile(absolutePath);
  const originalSize = fs.statSync(absolutePath).size;
  instance.db.addFile({
    id: fileId, conversation_id: conversationId, message_id: null,
    original_name: "original.png", relative_path: relativePath, mime_type: "image/png",
    size: originalSize, kind: "output", created_at: new Date().toISOString(),
  });

  await request(instance.app).get(`/api/files/${fileId}/thumbnail`).expect(401);
  const agent = request.agent(instance.app);
  await agent.post("/api/auth/login").send({ username: "pp", password: "Thumbnail-Password-2026!" }).expect(200);
  const thumbnail = await agent.get(`/api/files/${fileId}/thumbnail`).expect(200);
  assert.match(thumbnail.headers["content-type"], /^image\/webp/);
  assert.equal(thumbnail.headers["cache-control"], "private, no-store");
  assert.equal(thumbnail.headers["x-content-type-options"], "nosniff");
  assert.ok(Buffer.isBuffer(thumbnail.body));
  assert.equal(Number(thumbnail.headers["content-length"]), thumbnail.body.length);
  assert.ok(thumbnail.body.length < originalSize);
  const metadata = await sharp(thumbnail.body).metadata();
  assert.equal(metadata.width, IMAGE_THUMBNAIL_WIDTH);
  assert.equal(metadata.height, IMAGE_THUMBNAIL_HEIGHT);
  assert.deepEqual((await agent.get(`/api/files/${fileId}/thumbnail`).expect(200)).body, thumbnail.body);
  assert.equal((await agent.get(`/api/files/${fileId}`).expect(200)).body.length, originalSize);

  const textId = crypto.randomUUID();
  fs.writeFileSync(resolveInside(workspace, "outputs/not-image.txt"), "text", "utf8");
  instance.db.addFile({
    id: textId, conversation_id: conversationId, message_id: null,
    original_name: "not-image.txt", relative_path: "outputs/not-image.txt", mime_type: "text/plain",
    size: 4, kind: "output", created_at: new Date().toISOString(),
  });
  await agent.get(`/api/files/${textId}/thumbnail`).expect(415, { error: "该文件不是图片。" });
});

test("browser preview is limited to formats browsers can display directly", () => {
  const file = (mime_type: string, original_name = "file.bin") => ({ mime_type, original_name } as WorkFile);
  assert.equal(isBrowserPreviewable(file("image/png")), true);
  assert.equal(isBrowserPreviewable(file("application/pdf")), true);
  assert.equal(isBrowserPreviewable(file("text/plain")), true);
  assert.equal(isBrowserPreviewable(file("text/markdown")), false);
  assert.equal(isBrowserPreviewable(file("text/html")), false);
  assert.equal(isBrowserPreviewable(file("application/vnd.openxmlformats-officedocument.presentationml.presentation")), false);
  assert.equal(fileReaderKind(file("text/markdown; charset=utf-8", "report.bin")), "markdown");
  assert.equal(fileReaderKind(file("application/octet-stream", "report.markdown")), "markdown");
  assert.equal(fileReaderKind(file("text/html; charset=utf-8", "report.bin")), "html");
  assert.equal(fileReaderKind(file("application/octet-stream", "report.htm")), "html");
  assert.equal(fileReaderKind(file("text/plain", "report.txt")), null);
  assert.equal(filePreviewUrl({ id: "file id" }), "/codex-web/files/file%20id/preview");
  assert.equal(publicFilePreviewUrl({ id: "file id" }), "/codex-web/files/file%20id/preview/public");
  assert.equal(filePreviewIdFromPath("/codex-web/files/file%20id/preview"), "file id");
  assert.equal(filePreviewIdFromPath("/codex-web/files/file%20id/preview/"), "file id");
  assert.equal(filePreviewIdFromPath("/codex-web/files/file%20id/preview/public"), null);
  assert.equal(publicFilePreviewIdFromPath("/codex-web/files/file%20id/preview/public"), "file id");
  assert.equal(publicFilePreviewIdFromPath("/codex-web/files/file%20id/preview/public/"), "file id");
  assert.equal(filePreviewIdFromPath("/codex-web/files/file%2/preview"), null);
  assert.equal(filePreviewIdFromPath("/not-a-preview"), null);
});

test("public share image manifests accept only safe same-delivery images and rewrite document URLs", () => {
  const parent = { id: "report", original_name: "report.html", mime_type: "text/html", kind: "output", message_id: "message" } as FileRow;
  const chart = { id: "chart", original_name: "chart.png", mime_type: "image/png", kind: "output", message_id: "message" } as FileRow;
  const assets = resolvePublicShareAssets("html", '<img src="./chart.png"><source srcset="chart.png 1x, chart.png 2x"><img src="data:image/png;base64,AA==">', [parent, chart]);
  assert.deepEqual(assets, [{ sourceRef: "chart.png", assetFileId: "chart" }]);
  const rewritten = rewritePublicShareDocument("html", '<img src="./chart.png"><source srcset="chart.png 1x, chart.png 2x">', assets, (id) => `/public-assets/${id}`);
  assert.match(rewritten, /src="\/public-assets\/chart"/);
  assert.match(rewritten, /srcset="\/public-assets\/chart 1x, \/public-assets\/chart 2x"/);
  assert.equal(rewritePublicShareDocument("markdown", "![趋势](chart.png)", assets, (id) => `/public-assets/${id}`), "![趋势](/public-assets/chart)");
  assert.throws(() => resolvePublicShareAssets("html", '<img src="https://tracker.example/pixel.png">', [parent, chart]), PublicShareAssetError);
  assert.throws(() => resolvePublicShareAssets("html", '<img src="../secret.png">', [parent, chart]), PublicShareAssetError);
});

test("fixed public file sharing is private by default, owner-controlled, image-aware, and audited in SQLite", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-public-file-share-"));
  const dataRoot = path.join(root, "data");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), basePath: "",
    username: "pp", passwordHash: bcrypt.hashSync("Owner-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    publicBaseUrl: "https://agent.example.test", queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "public report");
  const messageId = crypto.randomUUID();
  instance.db.addMessage({ id: messageId, conversation_id: conversation.id, role: "assistant", content: "done", created_at: new Date().toISOString() });
  const parentId = crypto.randomUUID();
  const imageId = crypto.randomUUID();
  const html = '<!doctype html><meta charset="utf-8"><h1>公开报告</h1><img src="chart.png">';
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const writeDeliverable = (id: string, name: string, body: string | Buffer) => {
    const relative = path.posix.join("deliverables", id, name);
    const absolute = path.join(dataRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, body);
    return relative;
  };
  instance.db.addFile({
    id: parentId, conversation_id: conversation.id, message_id: messageId, original_name: "report.html",
    relative_path: writeDeliverable(parentId, "report.html", html), mime_type: "text/html", size: Buffer.byteLength(html), kind: "output", created_at: new Date().toISOString(),
  });
  instance.db.addFile({
    id: imageId, conversation_id: conversation.id, message_id: messageId, original_name: "chart.png",
    relative_path: writeDeliverable(imageId, "chart.png", png), mime_type: "image/png", size: png.length, kind: "output", created_at: new Date().toISOString(),
  });

  await request(instance.app).get(`/api/files/${parentId}/preview/public`).expect(404);
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login").send({ username: "pp", password: "Owner-Password-2026!" }).expect(200);
  const privatePreview = await owner.get(`/api/files/${parentId}/preview`).expect(200);
  assert.deepEqual(privatePreview.body.share, { enabled: false, publicUrl: `https://agent.example.test/files/${parentId}/preview/public` });
  await owner.post(`/api/files/${parentId}/share`).expect(403);
  const enabled = await owner.post(`/api/files/${parentId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(enabled.body.share.enabled, true);
  assert.equal(instance.db.listPublicFileShareAssets(instance.db.getPublicFileShare(parentId)!.id)[0]?.asset_file_id, imageId);

  const first = await request(instance.app).get(`/api/files/${parentId}/preview/public`)
    .set("X-Codex-Web-View-ID", "view-public-0001").set("X-Forwarded-For", "203.0.113.8").expect(200);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.headers["x-robots-tag"], "noindex, nofollow, noarchive");
  assert.equal(first.body.file.conversation_id, undefined);
  assert.match(first.body.content, new RegExp(`/api/files/${parentId}/preview/public/assets/${imageId}`));
  await request(instance.app).get(`/api/files/${parentId}/preview/public/assets/${imageId}`).expect(200).expect("Content-Type", /image\/png/);
  await request(instance.app).get(`/api/files/${parentId}/preview/public`).set("X-Codex-Web-View-ID", "view-public-0001").set("X-Forwarded-For", "203.0.113.8").expect(200);
  await request(instance.app).get(`/api/files/${parentId}/preview/public`).set("X-Codex-Web-View-ID", "view-public-0002").set("X-Forwarded-For", "203.0.113.8").expect(200);
  const access = instance.db.sqlite.prepare("SELECT ip_address,access_count FROM public_share_access_rollups").get() as { ip_address: string; access_count: number };
  assert.equal(access.ip_address, "203.0.113.8");
  assert.equal(access.access_count, 2);

  const disabled = await owner.delete(`/api/files/${parentId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(disabled.body.share.enabled, false);
  assert.equal(disabled.body.share.publicUrl, enabled.body.share.publicUrl);
  await request(instance.app).get(`/api/files/${parentId}/preview/public`).expect(404);
  const reopened = await owner.post(`/api/files/${parentId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(reopened.body.share.publicUrl, enabled.body.share.publicUrl);
});

test("ordinary multipart uploads honor the same per-user storage ceiling as resumable uploads", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-multipart-quota-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), basePath: "",
    username: "pp", passwordHash: bcrypt.hashSync("Quota-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    maxStoredBytesPerUser: 1, minimumFreeDiskBytes: 1, queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "multipart quota");
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "pp", password: "Quota-Password-2026!" }).expect(200);
  const rejected = await agent.post(`/api/conversations/${conversation.id}/draft/files`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .attach("files", Buffer.from("too large"), { filename: "quota.txt", contentType: "text/plain" })
    .expect(413);
  assert.equal(rejected.body.code, "STORAGE_QUOTA_EXCEEDED");
  assert.equal(instance.db.listFiles(conversation.id).length, 0);
  const uploadRoot = path.join(ensureTenantWorkspace(path.join(root, "tenants"), LEGACY_USER_ID, conversation.id), "uploads");
  assert.equal(fs.readdirSync(uploadRoot).length, 0);
});

test("image file cards use a compact preview without a duplicate file icon", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /const icon = image \? null : <FileIcon size=\{20\} \/>/);
  assert.match(appSource, /image && <img className="file-card-image" src=\{fileThumbnailUrl\(file\)\}/);
  assert.equal(fileThumbnailUrl({ id: "image-id" } as WorkFile), "/codex-web/api/files/image-id/thumbnail");
  assert.match(styles, /\.file-card-image \{ width: 56px; height: 32px;/);
});

test("rich document readers keep Markdown inert and HTML isolated from the app origin", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const mathSource = fs.readFileSync(path.join(process.cwd(), "src", "markdown-math.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /previewHref && <a className="preview-button"/);
  assert.match(appSource, /reader === "markdown" \|\| previewable[\s\S]*href=\{fileUrl\(file\)\}/);
  assert.match(styles, /\.preview-button,[\s\S]*\.download-button\s*\{[^}]*border-left:/);
  assert.match(appSource, /<ReactMarkdown[\s\S]*skipHtml[\s\S]*>\{math\.content\}<\/ReactMarkdown>/);
  assert.match(mathSource, /import\("remark-math"\)/);
  assert.match(mathSource, /import\("rehype-katex"\)/);
  assert.match(mathSource, /import\("katex\/dist\/katex\.min\.css"\)/);
  assert.match(appSource, /rehypePlugins=\{math\.plugins/);
  assert.match(appSource, /sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  assert.doesNotMatch(appSource, /sandbox="[^"]*allow-scripts/);
  assert.doesNotMatch(appSource, /sandbox="[^"]*allow-same-origin/);
  assert.doesNotMatch(appSource, /HTML 隔离预览|Markdown 阅读/);
  assert.match(appSource, /<div className="file-preview-title"><FileText size=\{18\} \/><strong>/);
  assert.match(appSource, /复制链接/);
  assert.match(appSource, /关闭分享/);
  assert.match(appSource, /className=\{`file-preview-share\$\{open \? " active" : ""\}`\}/);
  assert.doesNotMatch(appSource, /file-preview-share\$\{share\.enabled/);
  assert.match(appSource, /open && createPortal\(<div className="file-share-backdrop"/);
  assert.match(appSource, /role="dialog" aria-modal="true" aria-labelledby="file-share-dialog-title"/);
  assert.match(appSource, /event\.target === event\.currentTarget\) closeDialog\(\)/);
  assert.match(appSource, /aria-label="关闭分享设置" onClick=\{closeDialog\}/);
  assert.doesNotMatch(appSource, /访问记录/);
  assert.match(styles, /\.file-preview-header\s*\{[^}]*min-height:\s*48px/);
  assert.match(styles, /\.file-share-backdrop\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*100;[^}]*place-items:\s*center;/);
  assert.match(styles, /@media \(hover: hover\)\s*\{[\s\S]*?\.file-preview-share:hover/);
  assert.doesNotMatch(styles, /\.file-share-panel\s*\{[^}]*position:\s*absolute/);
  assert.match(styles, /\.file-share-actions button\.danger\s*\{[^}]*background:\s*#9b303a/);
  assert.match(appSource, /window\.setInterval\(\(\) => void verifySession\(\), 60_000\)/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.file-reader-markdown\s*\{[\s\S]*font-size:\s*15px/);
  assert.match(styles, /\.file-reader-table\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(styles, /\.file-reader-markdown \.katex-display\s*\{[^}]*overflow-x:\s*auto/);
});

test("assistant cards progressively replace raw LaTeX with asynchronous KaTeX", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const mathSource = fs.readFileSync(path.join(process.cwd(), "src", "markdown-math.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /function AssistantMarkdown/);
  assert.match(appSource, /const math = useAsyncMarkdownMath\(sanitized\)/);
  assert.match(appSource, /remarkPlugins=\{math\.plugins \? \[remarkGfm, math\.plugins\.remarkMath\]/);
  assert.match(appSource, /rehypePlugins=\{math\.plugins \? \[\[math\.plugins\.rehypeKatex/);
  assert.match(appSource, /aria-busy=\{math\.loading \|\| undefined\}/);
  assert.match(appSource, />\{math\.content\}<\/ReactMarkdown>/);
  assert.match(mathSource, /content: plugins && prepared\.hasMath \? prepared\.content : markdown/);
  assert.match(mathSource, /let markdownMathPluginsPromise:/);
  assert.match(mathSource, /MATH_LOAD_RETRY_DELAYS_MS = \[1_000, 4_000\]/);
  assert.match(mathSource, /window\.addEventListener\("online", retry\)/);
  assert.match(styles, /\.message\.assistant \.katex-display,[\s\S]*overflow-x:\s*auto/);
});

test("Markdown math preparation supports LaTeX delimiters without rewriting code", () => {
  const prepared = prepareMarkdownMath([
    "行内公式：\\(P(D\\mid +)\\)。",
    "",
    "\\[",
    "P(D\\mid +)=\\frac{P(+\\mid D)P(D)}{P(+)}",
    "\\]",
    "",
    "`\\(literal\\)`",
    "",
    "```tex",
    "\\[not rendered\\]",
    "```",
  ].join("\n"));
  assert.equal(prepared.hasMath, true);
  assert.ok(prepared.content.includes("行内公式：$P(D\\mid +)$。"));
  assert.ok(prepared.content.includes("\n$$\nP(D\\mid +)=\\frac"));
  assert.ok(prepared.content.includes("P(+)}\n$$"));
  assert.ok(prepared.content.includes("`\\(literal\\)`"));
  assert.ok(prepared.content.includes("```tex\n\\[not rendered\\]\n```"));
  assert.equal(prepareMarkdownMath("价格是 $5，代码为 `x = $y$`。").hasMath, false);
});

test("prepared assistant LaTeX produces KaTeX display markup", () => {
  const prepared = prepareMarkdownMath("\\[\ne^{ix}=\\cos x+i\\sin x\n\\]");
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath],
    rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }]],
    children: prepared.content,
  }));
  assert.match(html, /class="katex-display"/);
  assert.match(html, /annotation encoding="application\/x-tex">e\^\{ix\}=\\cos x\+i\\sin x<\/annotation>/);
});

test("downloaded text files declare UTF-8 for iOS Safari previews", () => {
  assert.equal(fileResponseContentType("text/markdown"), "text/markdown; charset=utf-8");
  assert.equal(fileResponseContentType("text/plain"), "text/plain; charset=utf-8");
  assert.equal(fileResponseContentType("application/json"), "application/json; charset=utf-8");
  assert.equal(fileResponseContentType("text/csv; charset=gb18030"), "text/csv; charset=gb18030");
  assert.equal(fileResponseContentType("application/pdf"), "application/pdf");
});

test("risky uploads and execution requests use offline isolation", () => {
  assert.deepEqual(assessTaskPolicy("整理表格", [{ original_name: "source.xlsx" }]), { isolated: false, networkAccessEnabled: true });
  const macro = assessTaskPolicy("看看这个文件", [{ original_name: "unknown.xlsm" }]);
  assert.equal(macro.isolated, true);
  assert.equal(macro.networkAccessEnabled, false);
  assert.equal(assessTaskPolicy("请分析这个恶意软件样本", []).isolated, true);
});

test("conversation archive API keeps history readable, blocks new turns, and restores the sidebar row", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-archive-api-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot,
    username: "owner",
    passwordHash: bcrypt.hashSync("Archive-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Archive-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const conversationId = created.body.conversation.id as string;
  const threadId = crypto.randomUUID();
  instance.db.updateConversation(conversationId, { codexThreadId: threadId });
  assert.equal(instance.db.setConversationContextUsage(conversationId, {
    threadId,
    inputTokens: 202_345,
    modelContextWindow: 258_400,
  }), true);
  assert.equal(instance.db.setConversationCodexQuota(conversationId, { remainingPercent: 44 }), true);
  const codexHome = ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome;
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "24");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(sessionDirectory, `rollout-2026-07-24T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(rollout, "history", "utf8");

  assert.equal(codexThreadRolloutBytes(codexHome, threadId), 7);
  const archived = await agent.post(`/codex-web/api/conversations/${conversationId}/archive`).set("X-CSRF-Token", csrf).expect(200);
  assert.ok(archived.body.conversation.archived_at);
  assert.equal((await agent.get("/codex-web/api/conversations").expect(200)).body.conversations.length, 0);
  assert.equal((await agent.get("/codex-web/api/conversations/archived").expect(200)).body.conversations[0].id, conversationId);
  const detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.conversation.id, conversationId);
  assert.equal(detail.body.rolloutBytes, 7);
  assert.deepEqual(detail.body.contextUsage, {
    inputTokens: 202_345,
    modelContextWindow: 258_400,
    updatedAt: detail.body.contextUsage.updatedAt,
  });
  assert.match(detail.body.contextUsage.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(detail.body.packageQuota, {
    remainingPercent: 44,
    updatedAt: detail.body.packageQuota.updatedAt,
  });
  await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", csrf).field("message", "不应发送").expect(409);

  const restored = await agent.post(`/codex-web/api/conversations/${conversationId}/restore`).set("X-CSRF-Token", csrf).expect(200);
  assert.equal(restored.body.conversation.archived_at, null);
  assert.equal((await agent.get("/codex-web/api/conversations").expect(200)).body.conversations[0].id, conversationId);
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
  assert.match(restoredSession.headers["cache-control"], /no-store/);
  const conditionallyRestored = await agent.get("/codex-web/api/auth/session")
    .set("If-None-Match", restoredSession.headers.etag)
    .expect(200);
  assert.equal(conditionallyRestored.body.authenticated, true);
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
  assert.equal(created.body.conversation.has_unread_result, 0);
  assert.deepEqual(created.body.agentSelection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  await agent.put(`/codex-web/api/conversations/${created.body.conversation.id}/agent-selection`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-luna", reasoningEffort: "low" }).expect(200);
  const reused = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(reused.body.reused, true);
  assert.equal(reused.body.conversation.id, created.body.conversation.id);
  const second = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).send({ reuseEmpty: false }).expect(201);
  assert.notEqual(second.body.conversation.id, created.body.conversation.id);
  assert.deepEqual(second.body.agentSelection, { model: "gpt-5.6-luna", reasoningEffort: "low" });
  const unreadJobId = crypto.randomUUID();
  instance.db.createJob(unreadJobId, created.body.conversation.id);
  instance.db.finishJob(unreadJobId, created.body.conversation.id, "completed");
  assert.equal((await agent.get("/codex-web/api/conversations").expect(200)).body.conversations.find((row: { id: string }) => row.id === created.body.conversation.id).has_unread_result, 1);
  await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/seen`).expect(403);
  const seen = await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/seen`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(seen.body.conversation.has_unread_result, 0);
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

  const markdownId = crypto.randomUUID();
  const markdownName = "在线阅读报告.md";
  const markdownPath = path.join("outputs", markdownName);
  const markdownBody = "\uFEFF# 中文报告\n\n正文";
  fs.writeFileSync(path.join(ensureTenant(tenantRoot, LEGACY_USER_ID).conversations, created.body.conversation.id, markdownPath), markdownBody, "utf8");
  instance.db.addFile({
    id: markdownId, conversation_id: created.body.conversation.id, message_id: null,
    original_name: markdownName, relative_path: markdownPath, mime_type: "text/markdown",
    size: Buffer.byteLength(markdownBody), kind: "output", created_at: new Date().toISOString(),
  });
  const markdownPreview = await agent.get(`/codex-web/api/files/${markdownId}/preview`).expect(200);
  assert.equal(markdownPreview.headers["cache-control"], "private, no-store");
  assert.equal(markdownPreview.body.file.original_name, markdownName);
  assert.equal(markdownPreview.body.file.mime_type, "text/markdown");
  assert.equal(markdownPreview.body.file.conversation_id, undefined);
  const markdownRaw = await agent.get(`/codex-web/api/files/${markdownId}`).expect(200);
  assert.match(markdownRaw.headers["content-disposition"], /^inline;/);
  assert.match(markdownRaw.headers["content-type"], /^text\/markdown; charset=utf-8/);

  const htmlId = crypto.randomUUID();
  const htmlName = "独立报告.html";
  const htmlPath = path.join("outputs", htmlName);
  const htmlBody = '<!doctype html><meta charset="utf-8"><h1>报告</h1><script>top.location="/"</script>';
  fs.writeFileSync(path.join(ensureTenant(tenantRoot, LEGACY_USER_ID).conversations, created.body.conversation.id, htmlPath), htmlBody, "utf8");
  instance.db.addFile({
    id: htmlId, conversation_id: created.body.conversation.id, message_id: null,
    original_name: htmlName, relative_path: htmlPath, mime_type: "text/html",
    size: Buffer.byteLength(htmlBody), kind: "output", created_at: new Date().toISOString(),
  });
  assert.equal((await agent.get(`/codex-web/api/files/${htmlId}/preview`).expect(200)).body.file.original_name, htmlName);
  const htmlRaw = await agent.get(`/codex-web/api/files/${htmlId}`).expect(200);
  assert.match(htmlRaw.headers["content-disposition"], /^attachment;/);
  await request(instance.app).get(`/codex-web/api/files/${markdownId}/preview`).expect(401);

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
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "pp", password: "Quote-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "这和上一段有什么关系？")
    .field("quoteExcerpt", "  被引用的第一行\r\n被引用的第二行  ")
    .expect(202);
  let detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.messages[0].content, "这和上一段有什么关系？");
  assert.equal(detail.body.messages[0].quote_excerpt, "被引用的第一行\n被引用的第二行");
  assert.doesNotMatch(detail.body.messages[0].content, /请结合以下引用|被引用的第一行/);

  const queued = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "")
    .field("quoteExcerpt", "只引用、不写正文")
    .expect(202);
  assert.equal(queued.body.pendingPrompt.content, "");
  assert.equal(queued.body.pendingPrompt.quote_excerpt, "只引用、不写正文");

  const pendingId = queued.body.pendingPrompt.id as string;
  await agent.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${pendingId}/edit`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  await agent.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${pendingId}/restore`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const materialized = instance.db.materializePendingPrompt(pendingId, crypto.randomUUID(), crypto.randomUUID());
  assert.ok(materialized?.message_id);
  const quotedMessage = instance.db.getMessage(materialized!.message_id!);
  assert.equal(quotedMessage?.content, "");
  assert.equal(quotedMessage?.quote_excerpt, "只引用、不写正文");
  detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
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
  instance.db.appendEvent(runningJobId, "progress", { kind: "update", label: "stage update", detail: "finished environment inspection" });
  instance.db.appendEvent(runningJobId, "progress", { kind: "command", label: "configuration checked", detail: "private command omitted" });

  await agent.post(`/codex-web/api/conversations/${conversationId}/cancel`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(instance.db.getJob(queuedJobId)?.status, "cancelled");
  assert.equal(instance.db.getJob(runningJobId)?.status, "cancelled");
  assert.equal(instance.db.getConversationForUser(conversationId, LEGACY_USER_ID)?.id, conversationId);
  const stoppedSummary = instance.db.listMessages(conversationId).at(-1)!;
  assert.equal(stoppedSummary.role, "assistant");
  assert.match(stoppedSummary.content, new RegExp(USER_CANCELLED_TASK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(stoppedSummary.content, /finished environment inspection/);
  assert.match(stoppedSummary.content, /configuration checked/);
  assert.doesNotMatch(stoppedSummary.content, /private command/);
  assert.equal(latestUserCancellationContext(instance.db.listMessages(conversationId)), stoppedSummary.content);

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
  assert.equal(instance.db.listMessages(conversationId).length, 2);
  assert.equal(instance.db.listFiles(conversationId).length, 1);
  assert.equal(instance.db.getJob(deletionJobId)?.status, "cancelled");
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  assert.equal(instance.db.listPendingPrompts(conversationId, "editing").length, 0);
  assert.ok(instance.db.listEvents(runningJobId).some((event) => JSON.parse(event.payload).detail === "finished environment inspection"));
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(fs.existsSync(pendingAbsolute), false);
  assert.equal(fs.existsSync(storedAbsolute), false);
  assert.equal(fs.existsSync(sessionFile), false);
  await instance.pumpQueue();
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["keep for audit", stoppedSummary.content]);
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
  await owner.post(`/codex-web/api/conversations/${memberConversation.body.conversation.id}/seen`)
    .set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(404);

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
  const memberText = await member.get(`/codex-web/api/files/${memberFileId}`).expect(200);
  assert.match(memberText.headers["content-type"], /^text\/plain;\s*charset=utf-8$/i);

  const memberJobId = crypto.randomUUID();
  instance.db.createJob(memberJobId, memberConversation.body.conversation.id, memberMessageId, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  await owner.get(`/codex-web/api/jobs/${memberJobId}/events`).expect(404);
  await owner.post(`/codex-web/api/jobs/${memberJobId}/cancel`).set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(404);
  await member.post(`/codex-web/api/jobs/${memberJobId}/cancel`).set("X-CSRF-Token", memberLogin.body.csrfToken).expect(200);
});

test("composer drafts and attachments survive browser sessions and are consumed atomically", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-composer-draft-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Draft-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const firstBrowser = request.agent(instance.app);
  const firstLogin = await firstBrowser.post("/codex-web/api/auth/login").send({ username: "owner", password: "Draft-Password-2026!" }).expect(200);
  const created = await firstBrowser.post("/codex-web/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  await firstBrowser.put(`/codex-web/api/conversations/${conversationId}/draft`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .send({ content: "unfinished draft", quoteExcerpt: "quoted context" }).expect(200);
  const uploaded = await firstBrowser.post(`/codex-web/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .attach("files", Buffer.from("draft attachment"), { filename: "draft.txt", contentType: "text/plain" })
    .expect(201);
  const draftFile = uploaded.body.composerDraft.files[0] as { id: string; relative_path: string };
  assert.deepEqual(uploaded.body.uploadedFiles.map((file: { id: string }) => file.id), [draftFile.id]);
  const uploadedPath = path.join(ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId), draftFile.relative_path);
  assert.equal(fs.existsSync(uploadedPath), true);

  const secondBrowser = request.agent(instance.app);
  const secondLogin = await secondBrowser.post("/codex-web/api/auth/login").send({ username: "owner", password: "Draft-Password-2026!" }).expect(200);
  let detail = await secondBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.composerDraft.content, "unfinished draft");
  assert.equal(detail.body.composerDraft.quote_excerpt, "quoted context");
  assert.deepEqual(detail.body.composerDraft.files.map((file: { original_name: string }) => file.original_name), ["draft.txt"]);

  await secondBrowser.put(`/codex-web/api/conversations/${conversationId}/draft`)
    .set("X-CSRF-Token", secondLogin.body.csrfToken)
    .send({ content: "continued on another device", quoteExcerpt: "" }).expect(200);
  detail = await firstBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.composerDraft.content, "continued on another device");

  await secondBrowser.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", secondLogin.body.csrfToken)
    .field("message", "continued on another device")
    .field("quoteExcerpt", "")
    .field("useComposerDraft", "true")
    .expect(202);
  assert.equal(instance.db.getComposerDraft(conversationId), undefined);
  const messages = instance.db.listMessages(conversationId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "continued on another device");
  assert.deepEqual(messages[0].files.map((file) => file.original_name), ["draft.txt"]);
  assert.equal(instance.db.getFile(draftFile.id)?.message_id, messages[0].id);
  assert.equal((await firstBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200)).body.composerDraft, null);

  const clearable = await firstBrowser.post("/codex-web/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken).expect(201);
  const clearableId = clearable.body.conversation.id as string;
  const clearUpload = await firstBrowser.post(`/codex-web/api/conversations/${clearableId}/draft/files`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .attach("files", Buffer.from("discard me"), { filename: "discard.txt", contentType: "text/plain" }).expect(201);
  const clearPath = path.join(ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, clearableId), clearUpload.body.composerDraft.files[0].relative_path);
  await firstBrowser.delete(`/codex-web/api/conversations/${clearableId}/draft`).set("X-CSRF-Token", firstLogin.body.csrfToken).expect(204);
  assert.equal(instance.db.getComposerDraft(clearableId), undefined);
  assert.equal(fs.existsSync(clearPath), false);
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

test("wake controls use muted color until their conversation is selected", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(styles, /\.conversation-wake-trigger \{[^}]*color: #9399ad;/);
  assert.match(styles, /\.conversation-row\.active \.conversation-wake-trigger \{ color: var\(--amber\); \}/);
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
  const markdown = { ...file, id: "file-3", original_name: "report.md", relative_path: "deliverables/file-3/report.md", mime_type: "text/markdown" };
  assert.deepEqual(resolveMessageFileLink("outputs/report.md", [markdown]), { kind: "raw", href: "/codex-web/api/files/file-3" });
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

test("activity recovery keeps five expired stage updates above the rolling event window", () => {
  const events = Array.from({ length: 62 }, (_, index) => {
    const seq = index + 1;
    return seq <= 6 || seq === 62
      ? { seq, type: "progress", kind: "update", label: "阶段反馈", detail: `阶段 ${seq}` }
      : { seq, type: "progress", kind: "command", label: `步骤 ${seq}`, detail: `command ${seq}` };
  });
  const retained = mergeJobEvents([], events);
  assert.deepEqual(retained.slice(0, 5).map((event) => event.seq), [2, 3, 4, 5, 6]);
  assert.deepEqual(retained.slice(5).map((event) => event.seq), Array.from({ length: 50 }, (_, index) => index + 13));
  assert.equal(retained.filter((event) => event.kind === "update").length, 6);
  assert.equal(retained.at(-1)?.seq, 62);
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
    assert.equal(db.getConversation(conversationId)?.has_unread_result, status === "completed" ? 1 : 0);
    assert.equal(db.getActiveJobForConversation(conversationId), undefined);
    assert.equal(db.listEvents(jobId).length, 1);
    if (status === "completed") assert.equal(db.listMessages(conversationId).at(-1)?.content, "result");
  }
});

test("completed jobs preserve the first unread assistant anchor until the conversation is seen", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-unread-anchor-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  db.createConversation(conversationId, "Unread anchor");
  db.addMessage({ id: userMessageId, conversation_id: conversationId, role: "user", content: "请检查结果", created_at: "2026-08-17T00:00:00.000Z" });
  db.createJob(jobId, conversationId, userMessageId);
  db.addMessage({ id: assistantMessageId, conversation_id: conversationId, role: "assistant", content: "检查完成", created_at: "2026-08-17T00:00:01.000Z" });
  db.finishJob(jobId, conversationId, "completed");
  assert.equal(db.getConversation(conversationId)?.unread_anchor_message_id, assistantMessageId);
  db.markConversationResultSeenForUser(conversationId, LEGACY_USER_ID);
  assert.equal(db.getConversation(conversationId)?.unread_anchor_message_id, null);
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
  assert.match(replay.text, /"created_at":"2026-/);
  await agent.get(`/codex-web/api/conversations/${crypto.randomUUID()}`).expect(404);
});
