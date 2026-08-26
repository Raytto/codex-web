import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
import { WebSocket } from "ws";
import type { ThreadEvent } from "@openai/codex-sdk";
import { createApp, fileResponseContentType, migrateExistingOutputFiles, projectDisplayName } from "../server/app.js";
import { IMAGE_THUMBNAIL_HEIGHT, IMAGE_THUMBNAIL_WIDTH } from "../server/image-thumbnail.js";
import { assertProductionConfig, loadConfig, loadProductionConfig } from "../server/config.js";
import { capacityRetryPrompt, extractLeakedAutoTitleAnswer, isMeaningfulExecutionProgress, isModelCapacityProgress, MODEL_CAPACITY_CONTINUATION_PROMPT, redactBrandForDisplay, retryDelayLabel, summarizeEvent } from "../server/codex-runner.js";
import { AppDatabase, LEGACY_USER_ID, type FileRow } from "../server/db.js";
import { agentOptionsFromAppServer, loadAgentOptions, repairAgentSelection, resolveAgentSelection } from "../server/model-options.js";
import { codexThreadRolloutBytes, ensureTenant, ensureTenantWorkspace, ensureWorkspace, isDeliverablePath, isPersistedDeliverablePath, LEGACY_LIBRARY_AGENTS, normalizeStoredRelativePath, normalizeUploadFileName, persistDeliverable, resolveGeneratedImage, resolveInside, safeUploadName, snapshotGeneratedImages } from "../server/paths.js";
import { buildShellEnvironment, cleanupJobRuntime, jobRuntimeRoot, prepareJobRuntime } from "../server/python-runtime.js";
import { assessTaskPolicy } from "../server/task-policy.js";
import { listTenantIdentities, tenantIdentityForUser } from "../server/tenant-identities.js";
import { consumeTenantTurnEvents, validateTenantWorkerRequest } from "../server/tenant-worker-execution.js";
import type { TenantWorkerRunRequest } from "../server/tenant-worker-protocol.js";
import { isConnectionInterruptionError, isModelCapacityError, isRetryableUpstreamError, MODEL_CAPACITY_INITIAL_RETRY_DELAYS_MS, MODEL_CAPACITY_LONG_RETRY_AFTER_MS, MODEL_CAPACITY_LONG_RETRY_DELAY_MS, MODEL_CAPACITY_STEADY_RETRY_DELAY_MS, modelCapacityRetryDelayMs, runWithTransientRetries } from "../server/retry-policy.js";
import { filePreviewIdFromPath, filePreviewUrl, fileReaderKind, isBrowserPreviewable, isLocalMarkdownUrl, publicFilePreviewIdFromPath, publicFilePreviewUrl, remoteMessageFileReferences, resolveMessageFileLink } from "../src/file-links.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { resolveAccountIdentity } from "../src/account-identity.js";
import { accountSelectionStorageKeys, chooseSelectedProject, clearLegacySelectionStorage, LEGACY_SELECTED_CONVERSATION_KEY, LEGACY_SELECTED_PROJECT_KEY, readStoredSelection, writeStoredSelection } from "../src/account-selection-storage.js";
import { chooseComposerPrimaryAction } from "../src/composer-action.js";
import { resolveScrollFollow } from "../src/scroll-follow.js";
import { mergeMessagePages, preservePrependedScrollTop, resolveUnreadScrollTarget } from "../src/message-history.js";
import { prepareMarkdownMath } from "../src/markdown-math.js";
import { ASK_AGENT_SELECTION_MAX_CHARS, buildAskAgentDraft, normalizeAskAgentSelection, visibleSelectionBounds } from "../src/ask-agent-selection.js";
import { parseResponseAnnotatedRequest } from "../src/response-annotations.js";
import { parseCodexFileMentionRequest } from "../src/codex-file-mentions.js";
import { CHAT_FONT_SIZE_DEFAULT, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, normalizeChatFontSize } from "../src/chat-font-size.js";
import { normalizeThemePreference, resolveTheme, themeCanvasColor, THEME_PREFERENCE_KEY } from "../src/theme.js";
import { chooseSelectedConversation, isTerminalJob, mergeJobEvents } from "../src/recovery.js";
import { ApiError, fileThumbnailUrl, isApiErrorStatus, type Conversation, type JobEvent, type Project, type WorkFile } from "../src/api.js";
import { buildAgentSteerPrompt, buildAgentTurnPrompt, buildHostThreadInstructions, buildTenantProjectThreadInstructions, decideImageInput, isSupportedImageAttachment } from "../server/agent-context.js";
import { containsPersonalContext, loadInitialPersonalContext, loadPersonalContext, loadPersonalContextForTurn, personalContextTokenCount, PERSONAL_CORE_TOKEN_BUDGET, PERSONAL_RETRIEVAL_TOKEN_BUDGET, stripPersonalContext } from "../server/personal-context.js";
import { isSensitivePersonalMemory, PersonalMemoryExtractor, PersonalMemoryService, renderAutoMemory } from "../server/personal-memory.js";
import { CONVERSATION_TITLE_CODEX_MODEL, CONVERSATION_TITLE_REASONING_EFFORT, ConversationTitleService, codexConversationTitleArguments, extractTitleRequestText, normalizeConversationTitle } from "../server/conversation-title.js";
import { buildProcessJournal } from "../src/process-journal.js";
import { buildSubagentActivity } from "../src/subagent-activity.js";
import { resetProjectConversationPage } from "../src/project-conversation-page.js";
import { formatContextUsage, formatRolloutBytes, ROLLOUT_WARNING_BYTES, shouldWarnAboutRollout } from "../src/rollout-capacity.js";
import { DEFAULT_PROJECT_AGENTS_TEMPLATE, installProjectInstructions } from "../server/project-instructions.js";
import { buildOptionalCapabilityConfig, buildOptionalCapabilityRoutingHint, DEFAULT_OPTIONAL_AGENT_CAPABILITIES, detectOptionalAgentCapabilities, updateOptionalAgentCapabilities } from "../server/optional-capabilities.js";
import { latestUserCancellationContext, USER_CANCELLED_TASK_MARKER } from "../server/cancellation-summary.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";
import { HostRootWorkerClient } from "../server/host-root-worker-client.js";
import { REMOTE_WORKER_PROTOCOL_VERSION } from "../server/remote-worker-protocol.js";
import { REMOTE_WORKER_TARGET_REF, REMOTE_WORKER_TARGET_VERSION } from "../server/remote-worker-release.js";
import { REMOTE_WORKER_UPDATE_TIMEOUT_MS } from "../server/remote-worker-gateway.js";
import { isValidRemoteWorkerCapacity, normalizeRemoteWorkerCapacity, remoteWorkerHasCapacity } from "../server/remote-worker-capacity.js";
import { applyCodexProxyEnvironment, CODEX_EGRESS_FALLBACK_NOTICE, resolveCodexEgressChoice, selectCodexEgress } from "../server/codex-egress.js";
import { appServerNotificationBelongsToThread, normalizeCodexQuotaUsage, normalizeContextTokenUsage, startAppServerTurn, summarizeAppServerItem } from "../server/app-server-turn.js";
import { conversationProjectMoveBlockReason } from "../src/conversation-project-move.js";
import { formatRemoteWorkerCapacity } from "../src/remote-worker-capacity.js";
import { acquireSharedCodexAuth, sharedCodexAuthPolicyFromEnv, userUsesSharedCodexAuth, validateCodexAuthPayload } from "../server/shared-codex-auth.js";
import { PublicShareAssetError, resolvePublicShareAssets, rewritePublicShareDocument } from "../server/public-file-share.js";
import { TENANT_LOCAL_EXECUTOR_ID, assertTenantProjectRoot, createTenantProjectDirectory, ensureTenantProjectLayout, listTenantProjectDirectories, tenantDefaultProjectRoot, validateTenantProjectDirectory } from "../server/tenant-projects.js";
import { recoverBrowserSession } from "../src/session-recovery.js";
import { mergeConversationMatches, removeConversationFromPage, retainSelectedConversation, sortConversationsByActivity } from "../src/conversation-search.js";
import { buildHandoffFirstTurn, CONTEXT_HANDOFF_MARKER, latestContextHandoff } from "../src/context-handoff.js";
import { callWaitDynamicTool, WAIT_DYNAMIC_TOOL_NAME } from "../server/wait-dynamic-tool.js";
import { canApplyDeferredInstanceReload } from "../src/reload-protection.js";
import { TranscriptionService } from "../server/transcription.js";
import { VOICE_DRAFT_RETENTION_MS, isVoiceDraftExpired } from "../src/conversation/voice-draft-store.js";
import { CodexAccountManager } from "../server/codex-account-manager.js";
import { HTML_READER_SCOPE, scopeReaderStyles } from "../src/file-reader-outline.js";
import { readReaderPosition, restoreReaderScrollTop, writeReaderPosition } from "../src/reader-position.js";

test("shared Codex auth policy applies globally to current and future tenant users", (context) => {
  const first = crypto.randomUUID();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-codex-policy-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policyFile = path.join(root, "policy.json");
  fs.writeFileSync(policyFile, JSON.stringify({ mode: "shared" }));
  const policy = sharedCodexAuthPolicyFromEnv({
    CWW_SHARED_CODEX_AUTH_FILE: "/state/shared/owner/auth.json",
    CWW_SHARED_CODEX_AUTH_LOCK: "/state/shared/owner/refresh.lock",
    CWW_SHARED_CODEX_AUTH_POLICY_FILE: policyFile,
  });
  assert.ok(policy);
  assert.equal(userUsesSharedCodexAuth(policy, first), true);
  assert.equal(userUsesSharedCodexAuth(policy, crypto.randomUUID()), true);
  fs.writeFileSync(policyFile, JSON.stringify({ mode: "own" }));
  const ownPolicy = sharedCodexAuthPolicyFromEnv({
    CWW_SHARED_CODEX_AUTH_FILE: "/state/shared/owner/auth.json",
    CWW_SHARED_CODEX_AUTH_LOCK: "/state/shared/owner/refresh.lock",
    CWW_SHARED_CODEX_AUTH_POLICY_FILE: policyFile,
  });
  assert.equal(userUsesSharedCodexAuth(ownPolicy, first), false);
  assert.equal(sharedCodexAuthPolicyFromEnv({}), null);
});

test("app-server notifications from sub-agent threads cannot replace the parent active turn", () => {
  assert.equal(appServerNotificationBelongsToThread("parent-thread", { threadId: "parent-thread" }), true);
  assert.equal(appServerNotificationBelongsToThread("parent-thread", { threadId: "child-thread" }), false);
  assert.equal(appServerNotificationBelongsToThread("parent-thread", {}), true);
  assert.equal(appServerNotificationBelongsToThread(null, { threadId: "child-thread" }), true);

  const source = fs.readFileSync(path.join(process.cwd(), "server", "app-server-turn.ts"), "utf8");
  assert.match(source, /if \(!appServerNotificationBelongsToThread\(this\.threadId, params\)\) \{[\s\S]{0,120}this\.handleSubagentNotification\(message\.method, params\);[\s\S]{0,40}return;/);
});

test("shared Codex auth lease serializes startup and commits only validated rotated credentials", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-codex-auth-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "shared", "auth.json");
  const firstTarget = path.join(root, "first", "auth.json");
  const secondTarget = path.join(root, "second", "auth.json");
  const lock = path.join(root, "shared", "refresh.lock");
  const auth = (access: string, refresh: string) => JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { access_token: access, refresh_token: refresh, id_token: "id", account_id: "account" },
  });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, auth("access-one", "refresh-one"), { mode: 0o600 });
  const firstLease = await acquireSharedCodexAuth({ sourceFile: source, targetFile: firstTarget, lockFile: lock });
  assert.equal(fs.readFileSync(firstTarget, "utf8"), fs.readFileSync(source, "utf8"));
  let secondAcquired = false;
  const secondPromise = acquireSharedCodexAuth({ sourceFile: source, targetFile: secondTarget, lockFile: lock, timeoutSeconds: 5 })
    .then((lease) => { secondAcquired = true; return lease; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondAcquired, false);
  fs.writeFileSync(firstTarget, auth("access-two", "refresh-two"), { mode: 0o600 });
  await firstLease.commitAndRelease();
  const secondLease = await secondPromise;
  assert.match(fs.readFileSync(secondTarget, "utf8"), /refresh-two/);
  await secondLease.releaseWithoutCommit();
  assert.throws(() => validateCodexAuthPayload("{}"), /reusable ChatGPT login/);
  validateCodexAuthPayload(JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { access_token: "access", refresh_token: "refresh", account_id: "account" },
  }));
  assert.throws(() => validateCodexAuthPayload(JSON.stringify({
    auth_mode: "apikey",
    tokens: { access_token: "access", refresh_token: "refresh" },
  })), /reusable ChatGPT login/);
});

test("shared Codex auth creates a missing target directory as the tenant identity", async (context) => {
  if (process.platform === "win32" || process.getuid?.() !== 0) {
    context.skip("requires root to launch the tenant identity");
    return;
  }
  const root = fs.mkdtempSync(path.join("/tmp", "shared-codex-auth-identity-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "shared", "auth.json");
  const tenantParent = path.join(root, "tenant");
  const target = path.join(tenantParent, "codex-home", "auth.json");
  const lock = path.join(root, "shared", "refresh.lock");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.chmodSync(root, 0o711);
  fs.writeFileSync(source, JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { access_token: "access", refresh_token: "refresh", account_id: "account" },
  }), { mode: 0o600 });
  fs.mkdirSync(tenantParent);
  fs.chownSync(tenantParent, 65_534, 65_534);
  fs.chmodSync(tenantParent, 0o700);
  const lease = await acquireSharedCodexAuth({
    sourceFile: source, targetFile: target, lockFile: lock, targetUid: 65_534, targetGid: 65_534,
  });
  assert.equal(fs.statSync(path.dirname(target)).uid, 65_534);
  assert.equal(fs.statSync(target).uid, 65_534);
  await lease.releaseWithoutCommit();
});

test("Codex account manager migrates the live login, completes device login, switches globally, and protects the active account", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-manager-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedRoot = path.join(root, "shared-codex-auth");
  const authorityFile = path.join(sharedRoot, "owner", "auth.json");
  const lockFile = path.join(sharedRoot, "owner", "refresh.lock");
  const policyFile = path.join(sharedRoot, "policy.json");
  const executable = path.join(root, "fake-codex");
  const idToken = (email: string) => `header.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.signature`;
  const auth = (accountId: string, email: string) => ({
    auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { access_token: `access-${accountId}`, refresh_token: `refresh-${accountId}`, id_token: idToken(email), account_id: accountId },
  });
  fs.mkdirSync(path.dirname(authorityFile), { recursive: true });
  fs.writeFileSync(authorityFile, JSON.stringify(auth("account-one", "one@example.com")), { mode: 0o600 });
  const secondAuth = JSON.stringify(auth("account-two", "two@example.com"));
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    "printf \"OpenAI's command-line coding agent\\nOpen https://auth.openai.com/codex/device\\nEnter ABCD-EFGHI\\n\"",
    "mkdir -p \"$CODEX_HOME\"",
    `printf '%s' '${secondAuth}' > \"$CODEX_HOME/auth.json\"`,
  ].join("\n"), { mode: 0o700 });

  let switchingAllowed = true;
  const manager = new CodexAccountManager({
    authorityFile, lockFile, policyFile, codexExecutable: executable,
    assertSwitchAllowed: () => { if (!switchingAllowed) throw new Error("jobs are running"); },
  });
  context.after(() => manager.close());

  const migrated = await manager.listAccounts();
  assert.equal(migrated.accounts.length, 1);
  assert.equal(migrated.accounts[0].active, true);
  assert.equal(migrated.accounts[0].email, "one@example.com");
  assert.match(migrated.accounts[0].accountHint, /nt-one$/);
  assert.equal(fs.statSync(path.join(sharedRoot, "accounts", migrated.activeAccountId, "auth.json")).mode & 0o777, 0o600);

  const started = await manager.beginLogin("公司账号");
  let login = started;
  const deadline = Date.now() + 5_000;
  while (!["succeeded", "failed"].includes(login.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    login = manager.loginStatus(started.id);
  }
  assert.equal(login.status, "succeeded", login.error ?? undefined);
  assert.equal(login.userCode, "ABCD-EFGHI");
  assert.equal(login.account?.label, "公司账号");
  assert.equal(login.account?.email, "two@example.com");
  assert.equal("tokens" in login, false);

  const withSecond = await manager.listAccounts();
  const second = withSecond.accounts.find((account) => account.email === "two@example.com");
  assert.ok(second);
  switchingAllowed = false;
  await assert.rejects(manager.activate(second.id), /jobs are running/);
  switchingAllowed = true;
  const activated = await manager.activate(second.id);
  assert.equal(activated.activeAccountId, second.id);
  assert.equal(JSON.parse(fs.readFileSync(authorityFile, "utf8")).tokens.account_id, "account-two");
  assert.deepEqual(JSON.parse(fs.readFileSync(policyFile, "utf8")), { mode: "shared" });
  await assert.rejects(manager.delete(second.id), /当前全局账号不能删除/);

  const first = activated.accounts.find((account) => account.email === "one@example.com");
  assert.ok(first);
  await manager.activate(first.id);
  const afterDelete = await manager.delete(second.id);
  assert.equal(afterDelete.accounts.length, 1);
  assert.equal(fs.existsSync(path.join(sharedRoot, "accounts", second.id)), false);
});

test("Codex account UI is restricted to CODEX_WEB, selects a machine, and explains the complete device-code flow", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const dialogSource = fs.readFileSync(path.join(process.cwd(), "src", "codex-account-dialog.tsx"), "utf8");
  const serverSource = fs.readFileSync(path.join(process.cwd(), "server", "app.ts"), "utf8");
  assert.match(appSource, /session\.accountId === HOST_ROOT_ACCOUNT_ID[\s\S]{0,260}Codex 账号管理/);
  assert.match(dialogSource, /目标机器[\s\S]*codexAccountManagementCapable[\s\S]*生成验证信息[\s\S]*在浏览器完成验证[\s\S]*目标机器自动确认并保存/);
  assert.match(dialogSource, /不会返回浏览器/);
  assert.match(dialogSource, /服务器、COM、home 各自保管自己的登录/);
  assert.match(serverSource, /codexAccountAdminSession[\s\S]*isHostRootUser\(session\.user_id\)/);
  assert.doesNotMatch(dialogSource, /refresh_token|access_token|id_token/);
});

test("user-visible branding uses Codex Web without explicit upstream names", () => {
  const index = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8")
    .replace(/^const SELECTED_CONVERSATION_KEY = .*$/m, "");
  assert.match(index, /<title>Codex Web<\/title>/);
  assert.match(index, /name="application-name" content="Codex Web"/);
  assert.match(appSource, /升级 Codex/);
  assert.match(appSource, /升级 Worker/);
  // Module names and the product name legitimately contain “Codex”; only an
  // upstream ChatGPT brand leak is prohibited in the public shell.
  assert.doesNotMatch(`${index}\n${appSource.replace(/Codex/g, "任务引擎")}`, /chatgpt/i);
  assert.doesNotMatch(appSource, /localStorage\.setItem\([^)]*codex-web:/);
  assert.equal(redactBrandForDisplay("Codex / CHATGPT / agent"), "Codex Web / Codex Web / agent");
});

test("the site favicon is a bundled PNG referenced through the configured base path", () => {
  const index = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  const favicon = fs.readFileSync(path.join(process.cwd(), "public", "favicon.png"));
  assert.match(index, /rel="icon"[^>]+href="%BASE_URL%favicon\.png"/);
  assert.match(index, /rel="apple-touch-icon"[^>]+href="%BASE_URL%favicon\.png"/);
  assert.deepEqual(Array.from(favicon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("login form uses username and password", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /const \[username, setUsername\] = useState\(""\)/);
  assert.match(appSource, /autoComplete="current-password"/);
  assert.doesNotMatch(appSource, /短信验证码|手机号/);
});

test("browser session recovery retries transient failures and a briefly missing cookie", async () => {
  const authenticated = { authenticated: true, accountId: "account-one", csrfToken: "csrf" };
  const outcomes: Array<Error | { authenticated: boolean; accountId?: string; csrfToken?: string }> = [
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

test("browser session recovery aborts a stalled request and retries without a page refresh", async () => {
  const authenticated = { authenticated: true, accountId: "account-one", csrfToken: "csrf" };
  let attempts = 0;
  let stalledAttemptAborted = false;
  const restored = await recoverBrowserSession(async (signal) => {
    attempts += 1;
    if (attempts > 1) return authenticated;
    return await new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        stalledAttemptAborted = true;
        reject(new DOMException("stalled session request aborted", "AbortError"));
      }, { once: true });
    });
  }, {
    attemptTimeoutMs: 5,
    transientRetryDelaysMs: [0],
    wait: async () => {},
  });
  assert.deepEqual(restored, authenticated);
  assert.equal(attempts, 2);
  assert.equal(stalledAttemptAborted, true);
});

test("composer replaces stop with send as soon as there is sendable input", () => {
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: false, voiceActive: false }), "stop");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: true, hasAttachments: false, voiceActive: false }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: true, voiceActive: false }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: false, voiceActive: true }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: false, hasText: false, hasAttachments: false, voiceActive: false }), "send");
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
  const entryPath = builtIndex.match(/<script[^>]+src="([^"]+\.js)"/)?.[1].replace(/^\/+/, "");
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

test("each Codex job pins the primary proxy or the backup after one ten-second probe", async () => {
  const controller = new AbortController();
  const primary = "http://127.0.0.1:17890";
  const backup = "http://127.0.0.1:17891";
  let observedTimeout = 0;
  const selectedPrimary = await selectCodexEgress({
    primaryProxyUrl: primary,
    backupProxyUrl: backup,
    timeoutMs: 10_000,
    signal: controller.signal,
    probe: async (proxyUrl, timeoutMs) => {
      assert.equal(proxyUrl, primary);
      observedTimeout = timeoutMs;
    },
  });
  assert.deepEqual(selectedPrimary, { kind: "primary", proxyUrl: primary });
  assert.equal(observedTimeout, 10_000);

  const selectedBackup = await selectCodexEgress({
    primaryProxyUrl: primary,
    backupProxyUrl: backup,
    timeoutMs: 10_000,
    signal: controller.signal,
    probe: async () => { throw new Error("airport unavailable"); },
  });
  assert.deepEqual(selectedBackup, { kind: "backup", proxyUrl: backup });
  assert.match(CODEX_EGRESS_FALLBACK_NOTICE, /BossLive 日本节点 10 秒内不可用/);

  assert.deepEqual(resolveCodexEgressChoice("primary", primary, backup), selectedPrimary);
  assert.deepEqual(resolveCodexEgressChoice("backup", primary, backup), selectedBackup);

  const env = applyCodexProxyEnvironment({ PATH: "/usr/bin" }, selectedBackup.proxyUrl);
  assert.equal(env.HTTPS_PROXY, backup);
  assert.equal(env.http_proxy, backup);
  assert.match(env.NO_PROXY || "", /127\.0\.0\.1/);
  assert.equal(env.PATH, "/usr/bin");
});

test("rollout capacity warning uses a 500 MiB threshold and readable binary units", () => {
  assert.equal(ROLLOUT_WARNING_BYTES, 524_288_000);
  assert.equal(shouldWarnAboutRollout(ROLLOUT_WARNING_BYTES - 1), false);
  assert.equal(shouldWarnAboutRollout(ROLLOUT_WARNING_BYTES), true);
  assert.equal(formatRolloutBytes(512), "512 B");
  assert.equal(formatRolloutBytes(191_602), "187.1 KiB");
  assert.equal(formatRolloutBytes(971_549_720), "926.5 MiB");
  assert.equal(formatRolloutBytes(1.25 * 1024 ** 3), "1.3 GiB");
  assert.equal(formatContextUsage(202_345, 258_400), "202.3K / 258.4K");
});

test("remote Worker capacity zero means unlimited and is displayed explicitly", () => {
  assert.equal(normalizeRemoteWorkerCapacity(0), 0);
  assert.equal(normalizeRemoteWorkerCapacity(99), 8);
  assert.equal(normalizeRemoteWorkerCapacity(Number.NaN), 1);
  assert.equal(remoteWorkerHasCapacity(100, 0), true);
  assert.equal(remoteWorkerHasCapacity(1, 2), true);
  assert.equal(remoteWorkerHasCapacity(2, 2), false);
  assert.equal(isValidRemoteWorkerCapacity(0), true);
  assert.equal(isValidRemoteWorkerCapacity(8), true);
  assert.equal(isValidRemoteWorkerCapacity(-1), false);
  assert.equal(isValidRemoteWorkerCapacity(1.5), false);
  assert.equal(formatRemoteWorkerCapacity(0), "不限并发");
  assert.equal(formatRemoteWorkerCapacity(6), "最多 6 个并发任务");

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /以 Worker 本机配置为准/);
  assert.match(appSource, /formatRemoteWorkerCapacity\(selectedExecutor\.capacity\)/);
  assert.doesNotMatch(appSource, /worker-capacity-control|capacityInput|updateWorkerCapacity|Worker 并发容量，0 表示不限/);
  assert.doesNotMatch(apiSource, /updateRemoteWorkerCapacity/);
  assert.doesNotMatch(styles, /worker-capacity-control/);
});

test("mobile wake plan cards give copy and actions their own responsive rows", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /pendingActionMode=\{job\?\.status === "running" \? "steer" : "insert"\}/);
  assert.match(appSource, /const actionLabel = actionMode === "steer" \? "引导" : "插入"/);
  assert.match(appSource, /会话正在等待时间或事件，待发送任务会保持排队；可选择“插入”立即发送。/);
  assert.match(appSource, /WakePlanCard[\s\S]*onEditWake/);
  assert.match(appSource, /disabled=\{Boolean\(busy\)\} onClick=\{onEdit\}>[\s\S]*编辑/);
  assert.match(appSource, /const \[editingPrompts, setEditingPrompts\] = useState\(true\)/);
  assert.match(appSource, /api\.updateWakePrompts[\s\S]*model,[\s\S]*reasoningEffort/);
  assert.match(appSource, /SettingMenu[^>]*className="model wake-plan-setting"/);
  assert.match(appSource, /SettingMenu[^>]*className="effort wake-plan-setting"/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.wake-plan-card \{[^}]*grid-template-columns: auto minmax\(0, 1fr\);[^}]*align-items: start;/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.wake-plan-copy strong \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.wake-plan-actions \{[^}]*grid-column: 1 \/ -1;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.wake-plan-actions button \{[^}]*min-height: 42px;[^}]*white-space: nowrap;/);
});

test("wake plan postpone shortcuts extend the deadline by 30 minutes", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.equal((appSource.match(/推迟 30 分钟/g) ?? []).length, 2);
  assert.doesNotMatch(appSource, /推迟 1 小时/);
  assert.equal((appSource.match(/api\.rescheduleWake\(conversation\.id, plan\.id, 30 \* 60\)/g) ?? []).length, 2);
  assert.doesNotMatch(appSource, /api\.rescheduleWake\(conversation\.id, plan\.id, 60 \* 60\)/);
});

test("wake plan card is appended after the conversation content", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const messageListSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "ConversationMessageList.tsx"), "utf8");
  const messagesStart = appSource.indexOf("<ConversationMessageList");
  const wakePlanRender = appSource.indexOf("{detail.wakePlan && <WakePlanCard", messagesStart);
  const messagesEnd = appSource.indexOf("afterMessages={<>", messagesStart);
  assert.ok(messagesStart >= 0);
  assert.ok(messagesEnd > messagesStart);
  assert.ok(wakePlanRender > messagesEnd);
  assert.match(messageListSource, /afterMessages\?: React\.ReactNode/);
  assert.match(appSource, /\[detail\?\.messages\.length, detail\?\.wakePlan\?\.id, activities, sending\]/);
});

test("main chat and reader use the shared conversation primitives", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const readerSource = fs.readFileSync(path.join(process.cwd(), "src", "reader-ask.tsx"), "utf8");
  const composerSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "ConversationComposer.tsx"), "utf8");
  const serverSource = fs.readFileSync(path.join(process.cwd(), "server", "app.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const voiceSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "ConversationVoiceInput.tsx"), "utf8");
  const voiceHookSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "useVoiceInput.ts"), "utf8");
  assert.match(appSource, /import \{ ConversationVoicePanel \} from "\.\/conversation\/ConversationVoiceInput"/);
  assert.match(appSource, /import \{ useVoiceInput \} from "\.\/conversation\/useVoiceInput"/);
  assert.match(appSource, /<ConversationMessageList[\s\S]*messageProps=/);
  assert.match(readerSource, /import \{ ConversationComposer \} from "\.\/conversation\/ConversationComposer"/);
  assert.match(readerSource, /import \{ ConversationMessageList \} from "\.\/conversation\/ConversationMessageList"/);
  assert.match(readerSource, /<ConversationComposer[\s\S]*voicePanelClassName="reader-ask-voice-panel"/);
  assert.match(readerSource, /<ConversationMessageList[\s\S]*variant="reader"/);
  assert.match(readerSource, /userInitials/);
  assert.match(readerSource, /formatConversationMessageDateTime/);
  assert.doesNotMatch(readerSource, /function ReaderVoiceInput|function ReaderMessage|function ReaderMarkdown/);
  assert.match(composerSource, /<SettingMenu[^>]*className="model"/);
  assert.match(composerSource, /<ConversationVoiceInput[\s\S]*panelClassName=\{voicePanelClassName\}/);
  assert.match(composerSource, /export function ConversationComposerReference/);
  assert.match(composerSource, /data-reference-kind=\{reference\.kind \?\? "conversation"\}/);
  assert.match(composerSource, /quote\?\.trim\(\) \? \{ excerpt: quote \} : undefined/);
  assert.match(appSource, /<ConversationComposerReference[\s\S]*kind: "conversation"/);
  assert.match(readerSource, /<ConversationComposer[\s\S]*reference=\{quote\.trim\(\) \? \{/);
  assert.match(readerSource, /quoteLabel/);
  assert.match(readerSource, /if \(!message \|\| submitting \|\| !selection\) return/);
  assert.match(readerSource, /canSend=\{Boolean\(input\.trim\(\) && selection\)\}/);
  assert.doesNotMatch(readerSource, /if \(!message \|\| !quote\.trim\(\)/);
  assert.doesNotMatch(readerSource, /canSend=\{Boolean\(input\.trim\(\) && quote\.trim\(\)/);
  assert.match(serverSource, /limits: \{ files: 12, fields: 8, fileSize: config\.maxUploadFileBytes \}/);
  assert.match(styles, /\.ask-agent-reference\.reader-ask-reference \{[^}]*width: fit-content;[^}]*max-width: min\(460px, 100%\);/);
  assert.doesNotMatch(styles, /\.ask-agent-reference\.reader-ask-reference \{[^}]*width: 100%;/);
  assert.match(voiceHookSource, /getUserMedia/);
  assert.match(voiceHookSource, /analyserRef/);
  assert.match(voiceHookSource, /state !== "recording" \|\| !analyserRef\.current/);
  assert.match(voiceSource, /useVoiceInput/);
});

test("reader conversation keeps main chat identity and adjacent voice/send actions", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const messageSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "ConversationMessageList.tsx"), "utf8");
  const readerSource = fs.readFileSync(path.join(process.cwd(), "src", "reader-ask.tsx"), "utf8");
  assert.match(messageSource, /message \$\{message\.role\}/);
  assert.match(messageSource, /userAvatar/);
  assert.match(styles, /\.reader-ask-voice-wrap \{ position: relative; display: grid; margin-left: auto; \}/);
  assert.match(styles, /\.reader-ask-bottom-row\.is-voice-active[\s\S]*\.reader-ask-voice-panel \{ grid-column: 1 \/ -1/);
  assert.match(styles, /\.file-reader-ask-launcher \{[^}]*background: transparent;/);
  assert.match(styles, /\.file-reader-ask-launcher\.active \{ background: var\(--indigo-pale\); \}/);
  assert.match(readerSource, /const READER_SELECTION_MOUSE_DELAY_MS = 180/);
  assert.match(readerSource, /const READER_SELECTION_TOUCH_DELAY_MS = 1_000/);
  assert.match(readerSource, /let lastTouchEndAt = 0/);
  assert.match(readerSource, /synthetic mouse boundary shorten the touch settle/);
  assert.match(readerSource, /stableRangeRef\.current = range\.cloneRange\(\)/);
  assert.match(readerSource, /document\.addEventListener\("selectionchange", handleSelectionChange\)/);
  assert.match(readerSource, /window\.addEventListener\("pointerup", handleSelectionEnd, \{ passive: true \}\)/);
  assert.match(readerSource, /window\.addEventListener\("touchend", handleSelectionEnd, \{ passive: true \}\)/);
  assert.match(readerSource, /window\.addEventListener\("mouseup", handleSelectionEnd, \{ passive: true \}\)/);
  assert.match(readerSource, /window\.addEventListener\("scroll", handleViewportChange, \{ passive: true \}\)/);
  assert.doesNotMatch(readerSource, /addEventListener\("selectstart"/);
  assert.doesNotMatch(readerSource, /addEventListener\("pointerdown"/);
  assert.doesNotMatch(readerSource, /addEventListener\("touchstart"/);
  assert.doesNotMatch(readerSource, /addEventListener\("mousedown"/);
  assert.doesNotMatch(readerSource, /addEventListener\("touchmove"/);
  assert.doesNotMatch(readerSource, /addEventListener\("mousemove"/);
  assert.doesNotMatch(readerSource, /lostpointercapture/);
  assert.doesNotMatch(readerSource, /nativeSelection\.removeAllRanges|nativeSelection\.addRange/);
  assert.doesNotMatch(readerSource, /onAsk\(selection\.text\)[\s\S]*removeAllRanges/);
  assert.match(readerSource, /createPortal\(action, document\.body\)/);
  assert.match(readerSource, /READER_SELECTION_HANDLE_IDLE_DELAY_MS = 2_000/);
  assert.match(readerSource, /const READER_SELECTION_GRACE_MS = 2_000/);
  assert.match(readerSource, /lastSelectionEndDelay = touch \? READER_SELECTION_TOUCH_DELAY_MS : READER_SELECTION_MOUSE_DELAY_MS/);
  assert.match(readerSource, /cancelClear\(\);\s*setSelection\(\{ text:/);
  assert.match(readerSource, /rememberRange\(current\);[\s\S]*?clear\(\);[\s\S]*?const releaseWindow/);
  assert.match(readerSource, /never calls preventDefault/);
  const selectionHookSource = readerSource.slice(0, readerSource.indexOf("export function ReaderSelectionAction"));
  assert.doesNotMatch(selectionHookSource, /preventDefault\(\)/);
  assert.match(styles, /\.file-reader-markdown,[\s\S]*-webkit-user-select: text !important/);
  assert.match(styles, /\.file-reader-markdown svg,[\s\S]*\.file-reader-html \.codex-web-reader-body canvas[\s\S]*-webkit-user-select: none !important/);
  assert.match(styles, /\.file-preview-scroll \{[^}]*overflow-y: auto/);
  assert.match(styles, /\.file-reader-html \{[^}]*overflow-y: auto/);
  assert.doesNotMatch(styles, /\.file-preview-scroll \{[^}]*-webkit-overflow-scrolling/);
  assert.doesNotMatch(styles, /\.file-reader-html \{[^}]*-webkit-overflow-scrolling/);
});

test("main voice transcription is pinned to its recording conversation across switches", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const voiceSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "useVoiceInput.ts"), "utf8");
  assert.doesNotMatch(appSource, /<Composer key=\{selectedId/);
  assert.match(appSource, /if \(voice\.state === "recording"\) voice\.finish\(false\)/);
  assert.match(appSource, /onVoiceSendAfterTranscription=\{\(conversationId, content, quoteExcerpt, voiceTranscriptionIds\)/);
  assert.match(appSource, /async function sendVoiceTranscription\(conversationId: string \| null/);
  assert.match(appSource, /await api\.sendMessage\(conversationId, content, \[\], quoteExcerpt, true, voiceTranscriptionIds\)/);
  assert.match(voiceSource, /sessionRef\.current = \{/);
  assert.match(voiceSource, /sessionCallbacksRef\.current\?\.onSendAfterTranscription/);
  assert.match(voiceSource, /conversationId: session\.conversationId/);
});

test("voice transcription retries are idempotent for the same client recording", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-voice-idempotency-test-"));
  const originalTranscribe = TranscriptionService.prototype.transcribe;
  let calls = 0;
  TranscriptionService.prototype.transcribe = async function () { calls += 1; return "电梯断网后仍可重试"; };
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
  });
  context.after(() => {
    TranscriptionService.prototype.transcribe = originalTranscribe;
    instance.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "语音幂等测试");
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const clientRecordingId = crypto.randomUUID();
  const audio = Buffer.from("fake-webm-audio");
  const first = await agent.post("/api/transcriptions").set("X-CSRF-Token", login.body.csrfToken)
    .field("conversationId", conversation.id).field("clientRecordingId", clientRecordingId)
    .attach("audio", audio, { filename: "recording.webm", contentType: "audio/webm" }).expect(200);
  const second = await agent.post("/api/transcriptions").set("X-CSRF-Token", login.body.csrfToken)
    .field("conversationId", conversation.id).field("clientRecordingId", clientRecordingId)
    .attach("audio", audio, { filename: "recording.webm", contentType: "audio/webm" }).expect(200);
  assert.equal(first.body.transcriptionId, second.body.transcriptionId);
  assert.equal(first.body.text, "电梯断网后仍可重试");
  assert.equal(calls, 1);
  await agent.post("/api/transcriptions").set("X-CSRF-Token", login.body.csrfToken)
    .field("conversationId", conversation.id).field("clientRecordingId", clientRecordingId)
    .attach("audio", Buffer.from("different-audio"), { filename: "recording.webm", contentType: "audio/webm" }).expect(409);
});

test("voice draft retention expires malformed and older local records", () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  assert.equal(isVoiceDraftExpired({ updatedAt: new Date(now - VOICE_DRAFT_RETENTION_MS + 1).toISOString() }, now), false);
  assert.equal(isVoiceDraftExpired({ updatedAt: new Date(now - VOICE_DRAFT_RETENTION_MS - 1).toISOString() }, now), true);
  assert.equal(isVoiceDraftExpired({ updatedAt: "not-a-date" }, now), true);
});

test("Codex context usage keeps only the latest input size and model window", () => {
  assert.deepEqual(normalizeContextTokenUsage({
    threadId: "019f9480-c808-7ad3-8347-e2c9f7e3fe8b",
    tokenUsage: {
      total: { inputTokens: 999_999 },
      last: { inputTokens: 202_345, cachedInputTokens: 180_000 },
      modelContextWindow: 258_400,
    },
  }), {
    threadId: "019f9480-c808-7ad3-8347-e2c9f7e3fe8b",
    inputTokens: 202_345,
    modelContextWindow: 258_400,
  });
  assert.equal(normalizeContextTokenUsage({ threadId: "thread", tokenUsage: { last: {} } }), null);
});

test("Codex quota reports the tightest general Codex package window", () => {
  assert.deepEqual(normalizeCodexQuotaUsage({
    rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300 },
      secondary: { usedPercent: 56, windowDurationMins: 10_080 },
    },
  }), { remainingPercent: 44 });
  assert.deepEqual(normalizeCodexQuotaUsage({
    rateLimits: { primary: { usedPercent: 105 } },
  }), { remainingPercent: 0 });
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

test("package quota is shared by Codex account but isolated between executors", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-quota-scope-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.createUser({
    id: HOST_ROOT_USER_ID,
    username: "quota-owner",
    display_name: "Quota Owner",
    password_hash: "",
    role: "owner",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  const localProject = db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "local-a", "/tmp/codex-web-a", "local-host");
  const secondLocalProject = db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "local-b", "/tmp/codex-web-b", "local-host");
  const remoteProject = db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "remote", "E:\\work", "remote:worker-a");
  const localConversation = db.createConversation(crypto.randomUUID(), "local-a", undefined, HOST_ROOT_USER_ID, localProject.id);
  const secondLocalConversation = db.createConversation(crypto.randomUUID(), "local-b", undefined, HOST_ROOT_USER_ID, secondLocalProject.id);
  const remoteConversation = db.createConversation(crypto.randomUUID(), "remote", undefined, HOST_ROOT_USER_ID, remoteProject.id);

  assert.equal(db.setConversationCodexQuota(localConversation.id, { remainingPercent: 44 }), true);
  assert.equal(db.getConversationCodexQuota(secondLocalConversation.id)?.remainingPercent, 44);
  assert.equal(db.getConversationCodexQuota(remoteConversation.id), null);
  assert.equal(db.setConversationCodexQuota(remoteConversation.id, { remainingPercent: 81 }), true);
  assert.equal(db.getConversationCodexQuota(localConversation.id)?.remainingPercent, 44);
  assert.equal(db.getConversationCodexQuota(remoteConversation.id)?.remainingPercent, 81);
  assert.equal(db.setExecutorCodexQuota("remote:worker-a", { remainingPercent: 63 }), true);
  assert.equal(db.getConversationCodexQuota(remoteConversation.id)?.remainingPercent, 63);
  assert.equal(db.getConversationCodexQuota(localConversation.id)?.remainingPercent, 44);
  const remoteAccountA = crypto.randomUUID();
  const remoteAccountB = crypto.randomUUID();
  db.setExecutorCodexQuota("remote:worker-a", { remainingPercent: 62 }, remoteAccountA);
  assert.equal(db.getConversationCodexQuota(remoteConversation.id)?.remainingPercent, 62);
  db.setExecutorActiveCodexAccount("remote:worker-a", remoteAccountB);
  assert.equal(db.getConversationCodexQuota(remoteConversation.id), null);
  db.setExecutorCodexQuota("remote:worker-a", { remainingPercent: 27 }, remoteAccountB);
  assert.equal(db.getConversationCodexQuota(remoteConversation.id)?.remainingPercent, 27);
  db.setExecutorActiveCodexAccount("remote:worker-a", remoteAccountA);
  assert.equal(db.getConversationCodexQuota(remoteConversation.id)?.remainingPercent, 62);
});

test("conversation menu separates actions from read-only capacity and quota information", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /conversation-menu-actions[\s\S]*conversation-menu-separator[\s\S]*conversation-menu-info/);
  assert.match(appSource, /Rollout 文件[\s\S]*Codex 上下文[\s\S]*套餐额度/);
  assert.match(appSource, /formatContextUsage\(currentDetail\.contextUsage\.inputTokens, currentDetail\.contextUsage\.modelContextWindow\)/);
  assert.match(appSource, /Math\.round\(currentDetail\.packageQuota\.remainingPercent\).*%/);
  assert.match(appSource, /executor_quota[\s\S]*codex-web-executor-quota-changed/);
  assert.match(appSource, /codex-web-executor-quota-changed[\s\S]*refreshDetail\(selected\)/);
  assert.match(appSource, /已安排的任务[\s\S]*wakeMenuDescription/);
  assert.match(appSource, /WakePlanDetailsDialog[\s\S]*activeWake/);
  assert.match(appSource, /Promise\.all\(\[api\.activeWake\(conversation\.id\), api\.agentOptions\(\{ conversationId: conversation\.id \}\)\]\)/);
  assert.match(appSource, /type=\"datetime-local\"/);
  assert.match(appSource, /api\.rescheduleWakeAt\(conversation\.id, plan\.id, deadlineAt\)/);
  assert.match(appSource, /早于当前时间时，保存后立即继续/);
  assert.match(appSource, /wakeDeadlineInputValue/);
  assert.match(appSource, /\}, \[conversation\.id\]\);/);
  assert.match(appSource, /beforeunload[\s\S]*warnBeforeUnload/);
  assert.match(appSource, /className="conversation-wake-trigger"[\s\S]*openWakeDetails\(conversation\)/);
  assert.match(styles, /\.conversation-menu-separator \{[^}]*height: 1px;/);
  assert.match(styles, /\.conversation-menu-panel \{[^}]*width: 220px;/);
  assert.match(styles, /\.conversation-menu-actions button \{[^}]*min-height: 48px;[^}]*font-size: 13px;/);
  assert.match(styles, /\.conversation-menu-info-row \{[^}]*min-height: 48px;/);
});

test("logout is the final item inside personal settings", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /className="account-settings-heading"[\s\S]*显示设置[\s\S]*className="account-settings-logout"[\s\S]*退出登录[\s\S]*<\/section>/);
  assert.match(appSource, /DisplaySettingsDialog[\s\S]*displaySettingsDialogOpen/);
  assert.doesNotMatch(appSource, /className="account-row"[\s\S]{0,600}title="退出登录"/);
  assert.match(styles, /\.account-row \{ display: block;/);
  assert.match(styles, /\.account-settings-logout \{[^}]*border-top:/);
});

test("personal settings close when clicking outside the account area", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /const accountAreaRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(appSource, /accountSettingsOpen && event\.target instanceof Node && !accountAreaRef\.current\?\.contains\(event\.target\)[\s\S]{0,80}setAccountSettingsOpen\(false\)/);
  assert.match(appSource, /className="account-area" ref=\{accountAreaRef\}/);
});

test("personal settings expose public share management for active Markdown and HTML shares", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const dialogSource = fs.readFileSync(path.join(process.cwd(), "src", "public-shares-dialog.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  assert.match(appSource, /公开分享管理/);
  assert.match(appSource, /publicSharesDialogOpen/);
  assert.match(appSource, /PublicSharesDialog/);
  assert.match(dialogSource, /api\.publicShares\(\)/);
  assert.match(dialogSource, /api\.disableFileShare\(share\.fileId\)/);
  assert.match(dialogSource, /share\.publicUrl/);
  assert.match(apiSource, /publicShares: \(\) => request[\s\S]*\/public-shares/);
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

test("workspace uses one compact top bar with new-conversation and pin actions", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /className="workspace-header"/);
  assert.match(appSource, /className="maintenance-state"[\s\S]*maintenanceStatusLabel\(maintenancePhase, maintenanceStatus\)[\s\S]*LoaderCircle/);
  assert.match(appSource, /serverInstanceIdRef\.current !== status\.instanceId[\s\S]*voiceInputActiveRef\.current \|\| instanceReloadDeferredRef\.current[\s\S]*setInstanceReloadDeferred\(true\)[\s\S]*source\.close\(\)[\s\S]*window\.location\.reload\(\)/);
  assert.match(appSource, /canApplyDeferredInstanceReload\([\s\S]*syncedDraftSignature[\s\S]*window\.location\.reload\(\)/);
  assert.match(appSource, /onVoiceActivityChange=\{\(active\) => \{ voiceInputActiveRef\.current = active; setVoiceInputActive\(active\); \}\}/);
  assert.match(appSource, /new EventSource\(`\$\{BASE_PATH\}\/api\/system\/events`\)/);
  assert.match(appSource, /source\.onerror = \(\) => \{ void refreshSystemStatus\(\); \}/);
  assert.match(appSource, /maintenancePhaseRef\.current !== "idle" \|\| deploymentPhaseIsActive\(deploymentPhaseRef\.current\) \|\| source\.readyState !== EventSource\.OPEN[\s\S]*refreshSystemStatus/);
  assert.match(appSource, /window\.addEventListener\("focus", reconcileWhenVisible\)[\s\S]*document\.addEventListener\("visibilitychange", reconcileWhenVisible\)/);
  assert.match(appSource, /aria-label="新建会话"/);
  assert.doesNotMatch(appSource, /className="new-task"/);
  assert.match(appSource, /取消置顶/);
  assert.doesNotMatch(appSource, /className="chat-header"/);
  assert.match(styles, /\.messages \{[\s\S]*?padding: 24px/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.messages \{ padding: 14px/);
});

test("voice input defers an instance reload until its result is durable", () => {
  const base = {
    voiceActive: false,
    submitting: false,
    conversationId: "conversation-one",
    editingPending: false,
    input: "转写后的内容",
    quoteExcerpt: "",
    looseFileCount: 0,
    uploadCount: 0,
    draftLoaded: true,
    currentDraftSignature: "saved-signature",
    syncedDraftSignature: "saved-signature",
  };
  assert.equal(canApplyDeferredInstanceReload({ ...base, voiceActive: true }), false);
  assert.equal(canApplyDeferredInstanceReload({ ...base, submitting: true }), false);
  assert.equal(canApplyDeferredInstanceReload({ ...base, syncedDraftSignature: "older-signature" }), false);
  assert.equal(canApplyDeferredInstanceReload({ ...base, conversationId: null }), false);
  assert.equal(canApplyDeferredInstanceReload({ ...base, editingPending: true }), false);
  assert.equal(canApplyDeferredInstanceReload(base), true);
  assert.equal(canApplyDeferredInstanceReload({ ...base, input: "", currentDraftSignature: "", syncedDraftSignature: undefined }), true);
});

test("voice input explains the five-minute recording limit before transcription starts", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const voiceSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "useVoiceInput.ts"), "utf8");
  const voiceViewSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "ConversationVoiceInput.tsx"), "utf8");
  assert.match(appSource, /maxDurationMs: 5 \* 60 \* 1000/);
  assert.match(voiceSource, /已达到 5 分钟录音上限，正在识别…/);
  assert.match(voiceViewSource, /className="voice-notice" role="status"/);
});

test("task search renders the voice input with project context and long-press behavior", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /<SearchVoiceInput query=\{query\} projectId=\{activeProjectId\}/);
  assert.match(appSource, /onTranscript=\{\(text\) => setQuery\(\(current\) => current \? `\$\{current\} \$\{text\}` : text\)\}/);
  assert.match(appSource, /onPointerDown=\{beginPress\}[^\n]*onPointerUp=\{endPress\}/);
  assert.match(appSource, /purpose: "search"/);
});

test("empty composer supports a touch long-press voice shortcut without replacing the mic button", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /COMPOSER_LONG_PRESS_DELAY_MS = 650/);
  assert.match(appSource, /event\.pointerType !== "touch"[\s\S]*canArmLongPress\(\)/);
  assert.match(appSource, /!inputRef\.current\.trim\(\)[\s\S]*!askAgentQuote[\s\S]*!editingPendingRef\.current/);
  assert.match(appSource, /onPointerDown=\{beginLongPress\}[\s\S]*onPointerMove=\{moveLongPress\}[\s\S]*onPointerUp=\{endLongPress\}[\s\S]*onPointerCancel=/);
  assert.match(appSource, /onClick=\{\(\) => void startRecording\(\)\}/);
  assert.match(appSource, /window\.addEventListener\("blur", cancel\)[\s\S]*document\.addEventListener\("visibilitychange", cancel\)/);
  assert.match(styles, /\.composer\.compact textarea \{ touch-action: manipulation; -webkit-touch-callout: none; \}/);
  assert.match(styles, /\.composer textarea\.long-press-armed \{ background: var\(--indigo-pale\)/);
});

test("workspace header identifies the selected task and its project", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /const workspaceTitle = selectedConversation\?\.title \|\| "Codex Web"/);
  assert.match(appSource, /const workspaceSubtitle = selectedProject\?\.display_name \|\| selectedProject\?\.name \|\| "PERSONAL AI WORKSTATION"/);
  assert.match(appSource, /className="wordmark workspace-context"[\s\S]*selectedProject\?\.executor_id\.startsWith\("remote:"\) \? <Monitor size=\{15\} \/> : selectedProject \? <Folder size=\{15\} \/> : <Zap size=\{14\} \/>/);
  assert.match(appSource, /className="brand-copy workspace-context-copy"><strong>\{workspaceTitle\}/);
  assert.match(appSource, /<small>\{workspaceSubtitle\}<\/small>/);
  assert.match(appSource, /deploymentStatusTone\(maintenanceStatus\.deployment\)/);
  assert.match(appSource, /发布 \{deploymentStageNumber\(maintenanceStatus\.deployment\.phase\)\}\/\{DEPLOYMENT_STAGES\.length\}/);
  assert.match(appSource, /候选构建|候选就绪/);
  assert.match(styles, /\.deployment-status-panel \{/);
  assert.match(styles, /\.deployment-status-panel li\.current/);
  assert.match(styles, /\.workspace-header-start \{ min-width: 0; \}/);
  assert.match(styles, /\.workspace-header \.workspace-context-copy strong, \.workspace-header \.workspace-context-copy small \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
});

test("user messages wrap long unbroken input inside their bubble", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(styles, /\.message-body > p \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/);
});

test("scheduled prompts use an amber clock identity instead of impersonating the user", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /const scheduledMessage = message\.role === "user" && Boolean\(message\.is_scheduled\)/);
  assert.match(appSource, /scheduledMessage \? <Clock size=\{15\} \/>/);
  assert.match(appSource, /scheduledMessage \? "定时任务" : message\.role === "assistant" \? "Codex Web" : "你"/);
  assert.match(styles, /\.message\.user \.message-avatar\.scheduled \{[^}]*color: var\(--navy\);[^}]*background: linear-gradient\(145deg, #f8bb55, var\(--amber\)\);/);
  assert.match(styles, /:root\[data-theme="dark"\] \.message\.user \.message-avatar\.scheduled \{[^}]*background: linear-gradient\(145deg, #f8bb55, var\(--amber\)\);/);
});

test("terminal task errors use a distinct inline error bubble instead of a normal assistant reply", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const messageSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "ConversationMessageList.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /function ErrorBubble\(\{ content \}: \{ content: string \}\)/);
  assert.match(messageSource, /const className = `\$\{reader \? "reader-ask-message " : ""\}message \$\{message\.role\}`/);
  assert.match(messageSource, /message-avatar/);
  assert.match(messageSource, /message-meta/);
  assert.match(appSource, /className: errorNotice \? "error" : undefined/);
  assert.match(appSource, /latestJobError && !hasPersistedErrorNotice/);
  assert.match(styles, /\.error-bubble \{[^}]*border: 1px solid #[0-9a-f]+;[^}]*border-radius: 12px;/);
  assert.match(styles, /\.message\.system \.message-avatar, \.message\.assistant\.error \.message-avatar/);
});

test("sidebar task actions collapse into a hover-revealed overflow menu", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const rowActions = appSource.match(/<div className="row-actions">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.match(rowActions, /className="task-menu-trigger"[\s\S]*?<MoreHorizontal/);
  assert.doesNotMatch(rowActions, /<Pin|<PinOff|<Pencil|<Trash2/);
  assert.match(appSource, /className="task-menu-panel"[\s\S]*?<Pin[\s\S]*?<Pencil[\s\S]*?<Trash2/);
  assert.match(styles, /\.row-actions \{[^}]*width: 30px;[^}]*flex: 0 0 30px;[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(styles, /\.conversation-row:hover \.row-actions, \.conversation-row:focus-within \.row-actions, \.conversation-row\.menu-open \.row-actions \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(styles, /\.task-menu-panel \{ position: fixed;[^}]*z-index: 80;[^}]*width: 210px;/);
  assert.match(appSource, /function toggleTaskMenu[\s\S]*const width = 210;/);
  assert.doesNotMatch(styles, /@media \(hover: none\)[\s\S]*?\.row-actions \{ opacity: 1; pointer-events: auto; \}/);
});

test("project display names prefix only remote workers", () => {
  assert.equal(projectDisplayName("owner-manage", { kind: "owner_host", machineName: "CODEX_WEB服务器" }), "owner-manage");
  assert.equal(projectDisplayName("默认项目", { kind: "tenant_container", machineName: "个人受限工作区" }), "默认项目");
    assert.equal(projectDisplayName("work", { kind: "remote_worker", machineName: "worker-host" }), "[worker-host]work");
  assert.equal(projectDisplayName("unknown", undefined), "unknown");
});

test("conversation project dragging exposes local targets and explains blocked targets", () => {
  const project = (id: string, executorId: string) => ({
    id,
    name: id,
    display_name: id,
    executor_id: executorId,
  }) as Project;
  const localA = project("local-a", "local-host");
  const localB = project("local-b", "local-host");
  const remote = project("remote", "remote:worker-a");
  const projects = [localA, localB, remote];
  const source = { id: "conversation", projectId: localA.id, title: "Task", projectMoveBlocked: false };

  assert.equal(conversationProjectMoveBlockReason(source, localB, projects), null);
  assert.equal(conversationProjectMoveBlockReason(source, localA, projects), "任务已经在这个项目中。");
  assert.equal(conversationProjectMoveBlockReason(source, remote, projects), "任务只能在同一个本地工作区的项目之间移动。");
  assert.equal(conversationProjectMoveBlockReason({ ...source, projectId: remote.id }, localB, projects), "任务只能在同一个本地工作区的项目之间移动。");
  assert.equal(
    conversationProjectMoveBlockReason({ ...source, projectMoveBlocked: true }, localB, projects),
    "会话仍在运行或有排队、待发送内容，暂时不能移动。",
  );
});

test("project mode exposes project-local task dragging and persistent project dragging", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /draggable=\{Boolean\(projectId && !query\)\}/);
  assert.match(appSource, /source\.projectId !== projectId \|\| source\.pinned !== Boolean\(target\.pinned_at\)/);
  assert.match(appSource, /api\.reorderProjects\(reordered\.map\(\(project\) => project\.id\)\)/);
  assert.match(appSource, /Boolean\(project\.sidebar_collapsed\)/);
  assert.match(appSource, /api\.updateProjectSidebarCollapsed\(projectId, collapsing\)/);
  assert.match(appSource, /function projectDropPlacement[\s\S]*querySelector<HTMLElement>\("\.project-row"\)[\s\S]*elementDropPlacement\(projectRow, event\.clientY\)/);
  assert.match(appSource, /setProjectDropTarget\(\{ id: projectId, placement: projectDropPlacement\(event\) \}\)/);
  assert.match(appSource, /function dropProjectInList[\s\S]*persistProjectDrop\(draggedProjectId, projectDropTarget\.id, projectDropTarget\.placement\)/);
  assert.match(appSource, /className="project-list" onScroll=\{\(\) => \{ setProjectMenu\(null\); setProjectSectionMenu\(null\); setTaskMenu\(null\); \}\} onDragOver=\{projectListDragOver\} onDrop=\{\(event\) => void dropProjectInList\(event\)\}/);
  assert.match(appSource, /async function dropProject[\s\S]*event\.stopPropagation\(\)/);
  assert.match(appSource, /function projectDisplayName[\s\S]*executorKind === "remote_worker" \? `\[\$\{machineName\}\]\$\{name\}` : name/);
  assert.match(appSource, /projectDisplayName\(name\.trim\(\), selectedExecutor\.machineName, selectedExecutor\.kind\)/);
  assert.match(appSource, /className="touch-drag-handle"[\s\S]*onPointerDown/);
  assert.match(apiSource, /\/projects\/order[\s\S]*method: "PUT"/);
  assert.match(apiSource, /\/projects\/\$\{id\}\/sidebar-collapsed[\s\S]*method: "PUT"/);
  assert.match(apiSource, /\/projects\/\$\{id\}\/archive[\s\S]*method: "POST"/);
  assert.match(apiSource, /\/conversations\/\$\{id\}\/sidebar-position/);
  assert.match(apiSource, /\/conversations\/\$\{id\}\/project[\s\S]*method: "PUT"/);
  assert.match(appSource, /conversationProjectMoveBlockReason\(draggedConversation, project, projects\)/);
  assert.match(appSource, />\{conversationMoveReason \? "不可移动" : "移到这里"\}<\/small>/);
  assert.match(appSource, /api\.moveConversationToProject\(source\.id, targetProject\.id\)/);
  assert.match(styles, /\.project-group\.dragging \{ opacity: \.34; \}/);
  assert.match(styles, /\.project-group\.drop-before::before, \.project-group\.drop-after::after/);
  assert.match(styles, /\.project-group\.conversation-drop-allowed > \.project-row/);
  assert.match(styles, /\.project-group\.conversation-drop-blocked > \.project-row/);
  assert.match(styles, /\.conversation-row\.drop-before \{ box-shadow: 0 -2px 0 #62a9ff; \}/);
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*touch-action: none;/);
});

test("project actions keep only overflow and new-task buttons at the first level", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const projectLabel = appSource.match(/<div className="section-label project-label">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.match(projectLabel, /data-project-menu/);
  assert.match(projectLabel, /<MoreHorizontal/);
  assert.doesNotMatch(projectLabel, /<Plus/);
  assert.match(appSource, /className="project-menu-panel project-section-menu"[\s\S]*?role="menuitem"[\s\S]*?新建项目/);
  assert.match(appSource, /function toggleProjectSectionMenu[\s\S]*?setProjectDialogOpen\(true\)/);
  const actions = appSource.match(/<div className="project-actions">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.match(actions, /<MoreHorizontal/);
  assert.match(actions, /<SquarePen/);
  assert.doesNotMatch(actions, /<Pencil|<RefreshCw|<Archive/);
  assert.match(appSource, /className="project-menu-panel"[\s\S]*?<RefreshCw[\s\S]*?<Pencil[\s\S]*?<Archive/);
  assert.match(appSource, /window\.confirm\(`[\s\S]*项目和历史任务不会被删除/);
  assert.match(styles, /\.project-menu-panel \{ position: fixed;[^}]*z-index: 80;/);
});

test("project sidebar aligns task content under project names with readable type", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(styles, /\.project-group \{ --project-content-left: 34px;/);
  assert.match(styles, /\.project-select > span \{[^}]*font-size: 14px;/);
  assert.match(styles, /\.project-conversations \.conversation-select \{ padding: 7px 6px 7px var\(--project-content-left\); \}/);
  assert.match(styles, /\.project-conversations \.conversation-select span \{ font-size: 13\.5px;/);
  assert.match(styles, /\.project-show-more \{[^}]*padding: 4px 7px 4px var\(--project-content-left\);[^}]*font-size: 13px;/);
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*\.project-show-more, \.project-empty \{ padding-left: 54px; \}/);
  assert.match(appSource, /<button type="button" className="project-show-more"[\s\S]{0,300}>展开显示<\/button>/);
  assert.doesNotMatch(appSource, /className="project-show-more"[\s\S]{0,300}<ChevronDown/);
});

test("completed tasks show a green unread marker until their detail is viewed", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const messageSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "ConversationMessageList.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /conversation\.has_unread_result \? "unread" : ""/);
  assert.match(appSource, /result\.conversation\.has_unread_result[\s\S]*?api\.markConversationSeen\(id\)/);
  assert.match(appSource, /unread_anchor_message_id[\s\S]*?resolveUnreadScrollTarget[\s\S]*?api\.conversationMessages\(id, result\.messagePage\.nextCursor\)/);
  assert.match(messageSource, /data-message-id=\{message\.id\}/);
  assert.match(appSource, /messages\.scrollTop = Math\.max\(0, messages\.scrollTop \+ targetTop - messagesTop - 12\)/);
  assert.match(appSource, /window\.setInterval\([\s\S]*?refreshList\(false, project\.id\)[\s\S]*?10_000/);
  assert.match(apiSource, /markConversationSeen:[\s\S]*?\/conversations\/\$\{id\}\/seen[\s\S]*?method: "POST"/);
  assert.match(styles, /\.conversation-row\.unread \.conversation-select::after \{[^}]*background: #38c976;[^}]*content: "";/);
});

test("unread replies open at the preceding user prompt for context", () => {
  const messages = [
    { id: "user-1", role: "user" as const, created_at: "2026-08-17T00:00:01.000Z" },
    { id: "assistant-1", role: "assistant" as const, created_at: "2026-08-17T00:00:02.000Z" },
    { id: "user-2", role: "user" as const, created_at: "2026-08-17T00:00:03.000Z" },
    { id: "assistant-progress", role: "assistant" as const, created_at: "2026-08-17T00:00:04.000Z" },
    { id: "assistant-unread", role: "assistant" as const, created_at: "2026-08-17T00:00:05.000Z" },
    { id: "user-after", role: "user" as const, created_at: "2026-08-17T00:00:06.000Z" },
  ];
  assert.equal(resolveUnreadScrollTarget(messages, "assistant-unread", false), "user-2");
  assert.equal(resolveUnreadScrollTarget(messages.slice(3), "assistant-unread", true), null);
  assert.equal(resolveUnreadScrollTarget(messages.slice(3), "assistant-unread", false), "assistant-unread");
  assert.equal(resolveUnreadScrollTarget(messages, "missing", false), null);
});

test("completed remote turns hide live progress and leave the final reply as the last result", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /\{sending && <article className="message assistant running">/);
  assert.doesNotMatch(appSource, /completedRemoteWorkRecord|本轮工作记录|本轮处理已完成|阶段反馈和本机步骤已保留/);
});

test("switching conversations hides stale detail until the selected task loads", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /currentDetail = detail\?\.conversation\.id === selectedId \? detail : null/);
  assert.match(appSource, /restoringConversationSelection = !conversationSelectionReady/);
  assert.match(appSource, /loadingConversation = restoringConversationSelection \|\| Boolean\(selectedId && !currentDetail\)/);
  assert.match(appSource, /loadingConversation \? <ConversationLoading restoring=\{restoringConversationSelection\} \/>/);
  assert.match(appSource, /conversationSelectionReady && \(!selectedId \|\| !selectedConversation\?\.archived_at\) && <Composer/);
  assert.match(appSource, /restoring \? "正在恢复上次任务…" : "正在加载任务…"/);
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
  assert.match(viewportSource, /const handleViewportScroll = \(\) => \{/);
  assert.match(viewportSource, /resetRootScrollOnNextApply = false;/);
  assert.match(viewportSource, /viewport\.addEventListener\("scroll", handleViewportScroll\)/);
  assert.match(viewportSource, /const nativeSelection = doc\.getSelection\(\)/);
  assert.match(viewportSource, /TEXT_SELECTION_RESET_GRACE_MS/);
  assert.match(viewportSource, /addEventListener\("selectionchange", handleSelectionChange\)/);
  assert.match(viewportSource, /documentElement\.scrollTop = 0/);
});

test("the create-project dialog keeps its actions visible while its body scrolls", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const dialogSource = appSource.match(/function ProjectDialog\([\s\S]*?\n\}\n\nfunction Welcome/)?.[0] ?? "";
  assert.match(dialogSource, /<div className="project-dialog-body">[\s\S]*?<\/div>\s*<footer>/);
  assert.match(styles, /\.project-dialog-body \{[^}]*min-height: 0;[^}]*flex: 1 1 auto;[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*-webkit-overflow-scrolling: touch;/);
  assert.match(styles, /\.project-dialog > footer \{[^}]*flex: 0 0 auto;/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.project-dialog \{[^}]*max-height: 92dvh;[^}]*env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(dialogSource, /executor-boundary-card/);
  assert.match(styles, /\.directory-toolbar input \{[^}]*font-size: 12px;[^}]*line-height: 1\.35;/);
  assert.match(styles, /\.directory-list > button \{[^}]*font-size: 12px;[^}]*line-height: 1\.35;/);
  assert.match(styles, /\.project-dialog > footer button \{[^}]*font-size: 12px;[^}]*line-height: 1\.35;/);
  assert.match(dialogSource, /selectedRuntimeBusy\?\.action === "worker"/);
  assert.match(dialogSource, /setExecutorId\(nextExecutorId\);[\s\S]*setRuntimeBusy\(null\)/);
  assert.match(dialogSource, /当前版本 \{selectedWorker\.installedVersion\}[\s\S]*最新版本 \{selectedWorker\.targetVersion\}/);
});

test("the mobile personal-memory editor cannot widen its dialog beyond the viewport", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const mobileBlock = styles.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(styles, /\.personal-memory-dialog \{[^}]*min-width:0;[^}]*overflow:hidden;/);
  assert.match(styles, /\.personal-memory-tabs, \.personal-memory-body \{[^}]*width:100%;[^}]*min-width:0;[^}]*max-width:100%;/);
  assert.match(styles, /\.personal-memory-files \{[^}]*width:100%;[^}]*min-width:0;[^}]*max-width:100%;/);
  assert.match(styles, /\.personal-memory-file-editor textarea, \.personal-memory-file-editor pre \{[^}]*white-space:pre-wrap;[^}]*overflow-wrap:anywhere;/);
  assert.match(mobileBlock, /\.personal-memory-dialog \{[^}]*width:100%;[^}]*min-width:0;[^}]*max-width:100%;[^}]*overflow:hidden;/);
  assert.match(mobileBlock, /\.personal-memory-files > aside \{[^}]*width:100%;[^}]*min-width:0;[^}]*max-width:100%;[^}]*overflow-x:auto;[^}]*overflow-y:hidden;[^}]*overscroll-behavior-x:contain;/);
  assert.match(mobileBlock, /\.personal-memory-file-editor textarea, \.personal-memory-file-editor pre \{[^}]*overflow-x:hidden;[^}]*overflow-wrap:anywhere;/);
  assert.match(mobileBlock, /\.personal-memory-file-editor > footer button \{[^}]*width:100%;[^}]*min-width:0;[^}]*max-width:100%;/);
});

test("tenant project creation is name-only while CODEX_WEB keeps directory controls", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const dialogSource = appSource.match(/function ProjectDialog\([\s\S]*?\n\}\n\nfunction Welcome/)?.[0] ?? "";
  assert.match(dialogSource, /tenantLocal \? "输入项目名称即可创建。"/);
  assert.doesNotMatch(dialogSource, /在个人知识库根目录下创建或选择一个项目文件夹/);
  assert.doesNotMatch(dialogSource, /executor-boundary-card/);
  assert.match(dialogSource, /selectedExecutor && !tenantLocal && <>[\s\S]*className="directory-toolbar"[\s\S]*className="directory-list"/);
  assert.match(dialogSource, /selectedExecutor && !tenantLocal \? <button type="button" className="create-folder-button"/);
  assert.match(dialogSource, /if \(tenantLocal && !page\.parent\)[\s\S]*api\.createProjectDirectory\(executorId, page\.directory, name\.trim\(\)\)[\s\S]*api\.createProject\(name\.trim\(\), directory, executorId\)/);
});

test("desktop sidebar width is resizable and its scrollbars use a trackless subtle thumb", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /const SIDEBAR_WIDTH_KEY = "cww:sidebar-width"/);
  assert.match(appSource, /className="shell" style=\{\{ "--sidebar-width": `\$\{sidebarWidth\}px` \} as CSSProperties\}/);
  assert.match(appSource, /className="sidebar-resizer"[\s\S]*aria-label="调整侧边栏宽度"[\s\S]*onPointerDown=\{beginSidebarResize\}[\s\S]*onPointerMove=\{moveSidebarResize\}/);
  assert.match(appSource, /window\.localStorage\.setItem\(SIDEBAR_WIDTH_KEY, String\(sidebarWidth\)\)/);
  assert.match(appSource, /className="sidebar-scroll-region"><div className="project-list"/);
  assert.match(appSource, /className="sidebar-scroll-region"><div className="conversation-list"/);
  assert.match(styles, /\.sidebar \{[^}]*width: var\(--sidebar-width, 280px\);[^}]*flex: 0 0 var\(--sidebar-width, 280px\);/);
  assert.match(styles, /\.sidebar-resizer \{[^}]*cursor: col-resize;[^}]*touch-action: none;/);
  assert.match(styles, /\.sidebar-scroll-region \{[^}]*width: calc\(100% \+ 26px\);[^}]*flex: 1;[^}]*margin: 0 -13px;/);
  assert.match(styles, /\.project-list \{[^}]*overflow-y: auto;[^}]*padding: 0 13px 8px;[^}]*scrollbar-color: rgba\(255, 255, 255, \.16\) transparent;[^}]*scrollbar-width: thin;/);
  assert.match(styles, /\.conversation-list \{[^}]*flex: 1;[^}]*overflow-y: auto;[^}]*padding: 0 13px;[^}]*scrollbar-color: rgba\(255, 255, 255, \.16\) transparent;[^}]*scrollbar-width: thin;/);
  assert.match(styles, /\.project-list::\-webkit-scrollbar \{ width: 4px; \}/);
  assert.match(styles, /\.project-list::\-webkit-scrollbar-track \{ background: transparent; \}/);
  assert.match(styles, /\.project-list::\-webkit-scrollbar-thumb \{ border-radius: 99px; background: rgba\(255, 255, 255, \.16\); \}/);
  assert.match(styles, /\.sidebar-resizer \{[^}]*right: -8px;[^}]*width: 8px;/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.sidebar-resizer \{ display: none; \}/);
});

test("composer collapses to one row until the user begins editing", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const settingMenuSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "SettingMenu.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /const \[inputFocused, setInputFocused\] = useState\(false\)/);
  assert.match(appSource, /className=\{`composer \$\{composerExpanded \? "expanded" : "compact"\}`\}/);
  assert.match(appSource, /onFocus=\{\(\) => setInputFocused\(true\)\}/);
  assert.match(appSource, /const \[openSettingMenu, setOpenSettingMenu\] = useState<"model" \| "effort" \| null>\(null\)/);
  assert.match(appSource, /const composerExpanded = inputFocused[\s\S]*?\|\| settingMenuIntent[\s\S]*?\|\| Boolean\(openSettingMenu\)/);
  assert.match(settingMenuSource, /onPointerDown=\{onOpenIntent\}[\s\S]*?onPointerCancel=\{onOpenIntentCancel\}[\s\S]*?onClick=\{\(\) => \{ onOpenIntentCancel\(\); onOpenChange\(!open\); \}\}/);
  assert.match(appSource, /aria-label="添加文件"/);
  assert.match(styles, /\.composer\.compact \{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.composer\.compact \.setting-menu \{ display: none; \}/);
  assert.match(styles, /\.composer\.compact \.send-button:disabled \{ display: none; \}/);
  assert.match(styles, /\.workspace:has\(\.composer-wrap\.compact\) \.messages \{ padding-bottom: 110px; \}/);
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
  assert.match(appSource, /api\.sendMessage\(id, message, useComposerDraft \? \[\] : files, askAgentQuote, useComposerDraft, voiceTranscriptionIds\)/);
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

test("Codex response-annotation transport wrappers become a native quote and user request", () => {
  const single = [
    "# Response annotations:",
    "Each item contains text selected from an earlier Codex response and may include a user comment.",
    "<response-annotations>",
    JSON.stringify([{ text: "  被引用的方案\r\n第二行  " }]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "这套方案不错，执行",
  ].join("\n");
  assert.deepEqual(parseResponseAnnotatedRequest(single), {
    content: "这套方案不错，执行",
    quoteExcerpt: "被引用的方案\n第二行",
  });

  const multiple = single.replace(
    JSON.stringify([{ text: "  被引用的方案\r\n第二行  " }]),
    JSON.stringify([{ text: "第一段", comment: "这里需要补测试" }, { text: "第二段", comment: "这里保持兼容" }]),
  );
  assert.deepEqual(parseResponseAnnotatedRequest(multiple), {
    content: "对引用 1 的批注：\n这里需要补测试\n\n对引用 2 的批注：\n这里保持兼容\n\n这套方案不错，执行",
    quoteExcerpt: "引用 1：\n第一段\n\n引用 2：\n第二段",
  });
  assert.equal(parseResponseAnnotatedRequest(single.replace("[{", "not-json[{")), null);
  assert.equal(parseResponseAnnotatedRequest("# Response annotations:\n只是普通正文"), null);
});

test("Codex file-mention wrappers become native attachment references and user text", () => {
  const wrapped = [
    "# Files mentioned by the user:",
    "",
    "## codex-clipboard-first.png: C:/Users/Codex/AppData/Local/Temp/codex-clipboard-first.png",
    "",
    "## 照片 2.jpg: C:\\Users\\Codex\\AppData\\Local\\Temp\\照片 2.jpg",
    "",
    "## My request for Codex:",
    "去这个目录找一下车的图，配到车型表。",
  ].join("\n");
  assert.deepEqual(parseCodexFileMentionRequest(wrapped), {
    content: "去这个目录找一下车的图，配到车型表。",
    fileNames: ["codex-clipboard-first.png", "照片 2.jpg"],
  });
  assert.deepEqual(parseCodexFileMentionRequest([
    "# Files mentioned by the user:",
    "",
    "## 图一.png: C:\\Temp\\图一.png",
    "## 图二.png: C:\\Temp\\图二.png",
    "",
    "## My request for Codex:",
  ].join("\n")), {
    content: "",
    fileNames: ["图一.png", "图二.png"],
  });
  assert.equal(parseCodexFileMentionRequest(wrapped.replace("## My request for Codex:", "## 普通标题:")), null);
  assert.equal(parseCodexFileMentionRequest("# Files mentioned by the user:\n\n只是普通正文"), null);

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /message\.attachment_references\.length > 0/);
  assert.match(appSource, /<Paperclip size=\{14\} \/>/);
  assert.match(appSource, /className="message-reference"/);
});

test("composer chips expose visible cancellable attachment and quote actions", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const composerSource = fs.readFileSync(path.join(process.cwd(), "src", "conversation", "ConversationComposer.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /aria-label={`移除附件 \$\{file\.name\}`}/);
  assert.match(composerSource, /aria-label="移除引用"/);
  assert.match(appSource, /className="attachment-chip-name"/);
  assert.match(styles, /\.attachment-chip-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(styles, /\.pending-files button[^}]*flex:\s*0 0 23px/);
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
});

test("pending queue supports touch drag reordering without invoking mobile text selection", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /function beginTouchDrag\(event: ReactPointerEvent<HTMLButtonElement>, sourceId: string\)/);
  assert.match(appSource, /setPointerCapture\(event\.pointerId\)/);
  assert.match(appSource, /document\.elementFromPoint\(event\.clientX, event\.clientY\)[\s\S]*data-pending-prompt-id/);
  assert.match(appSource, /onPointerDown=\{\(event\) => beginTouchDrag\(event, prompt\.id\)\}[\s\S]*onPointerUp=\{endTouchDrag\}[\s\S]*onPointerCancel=\{cancelTouchDrag\}/);
  assert.match(styles, /\.pending-drag-handle \{[^}]*touch-action: none;[^}]*-webkit-touch-callout: none;[^}]*user-select: none;/);
  assert.match(styles, /\.pending-queue\.drag-active, \.pending-queue\.drag-active \* \{[^}]*user-select: none;/);
});

test("project groups use five-task expansion with a legacy flat-list fallback", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /const CONVERSATION_PAGE_SIZE = 20/);
  assert.match(appSource, /const PROJECT_CONVERSATION_PAGE_SIZE = 5/);
  assert.match(appSource, /session\.projectMode && <div className="project-section">/);
  assert.match(appSource, /project\.executor_id\.startsWith\("remote:"\)/);
  assert.match(appSource, /collapsed \? <Monitor size=\{16\} \/> : <MonitorUp size=\{16\} \/>/);
  assert.match(appSource, /collapsed \? <Folder size=\{16\} \/> : <FolderOpen size=\{16\} \/>/);
  assert.match(appSource, /aria-label={`在项目 \$\{project\.name\} 中新建对话`}/);
  assert.match(appSource, /className="project-show-more"/);
  assert.match(appSource, /offset: current\.nextOffset \?\? current\.conversations\.length/);
  assert.doesNotMatch(appSource, /<span>项目任务<\/span>/);
  assert.doesNotMatch(appSource, /<FolderOpen size=\{16\} \/><span>\{conversation\.title\}/);
  assert.match(appSource, /onScroll={handleConversationListScroll}/);
  assert.match(appSource, /offset: current\.length/);
});

test("project search keeps five-item pages and appends body matches after title matches", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /type ProjectSearchState = \{/);
  assert.match(appSource, /loadProjectSearchBatch\(project\.id, query, PROJECT_CONVERSATION_PAGE_SIZE\)/);
  assert.match(appSource, /if \(state\.titleHasMore\)[\s\S]*api\.conversations\([\s\S]*state\.titleOffset/);
  assert.match(appSource, /else if \(state\.bodyHasMore\)[\s\S]*api\.conversationBodyMatches\([\s\S]*state\.bodyOffset/);
  assert.match(appSource, /loadProjectSearchBatch\(projectId, queryRef\.current, PROJECT_CONVERSATION_PAGE_SIZE, current\.conversations\)/);
  assert.doesNotMatch(appSource, /limit: query \? 100 : PROJECT_CONVERSATION_PAGE_SIZE/);
});

test("collapsing a project resets its task page to the first five conversations", () => {
  const conversations = Array.from({ length: 12 }, (_, index) => ({ id: `conversation-${index}` })) as Conversation[];
  const reset = resetProjectConversationPage({ conversations, total: 12, hasMore: false, nextOffset: null }, 5);
  assert.deepEqual(reset.conversations.map((conversation) => conversation.id), conversations.slice(0, 5).map((conversation) => conversation.id));
  assert.equal(reset.total, 12);
  assert.equal(reset.hasMore, true);
  assert.equal(reset.nextOffset, 5);

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /if \(collapsing\) \{[\s\S]*?resetProjectExpansion\(projectId\);/);
});

test("live updates follow only while the reader remains at the bottom", () => {
  assert.equal(resolveScrollFollow({ previousScrollTop: 500, scrollTop: 496, scrollHeight: 1000, clientHeight: 500, following: true }), false);
  assert.equal(resolveScrollFollow({ previousScrollTop: 420, scrollTop: 420, scrollHeight: 1080, clientHeight: 500, following: true }), true);
  assert.equal(resolveScrollFollow({ previousScrollTop: 420, scrollTop: 430, scrollHeight: 1080, clientHeight: 500, following: false }), false);
  assert.equal(resolveScrollFollow({ previousScrollTop: 500, scrollTop: 510, scrollHeight: 1080, clientHeight: 500, following: false }), true);
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.doesNotMatch(appSource, /scrollIntoView/);
  assert.match(appSource, /onScroll=\{onMessagesScroll\}/);
});

test("older message pages merge chronologically without moving the reader", () => {
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
  assert.equal(preservePrependedScrollTop(0, 900, 700), 0);
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /messages\.scrollTop <= 80/);
  assert.match(appSource, /prependScrollRestoreRef/);
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
  assert.deepEqual(summarizeEvent({
    type: "error",
    message: "Selected model is at capacity. Please try a different model.",
  } as never), {
    kind: "error", label: "Selected model is at capacity. Please try a different model.",
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
    { seq: 10, kind: "error", label: "Selected model is at capacity. Please try a different model." },
    { seq: 11, kind: "retry", label: "容量不足，将在 10 秒后进行第 1/7 次重试", detail: "本次没有检测到新进展" },
  ]);
  assert.deepEqual(journal.map((event) => event.seq), [1, 3, 4, 5, 7, 9, 10, 11]);
  assert.equal(journal[1].label, "运行了 2 个本机步骤");
  assert.equal(journal[1].actionCount, 2);
  assert.deepEqual(journal[1].groupedDetails, ["rg sales", "npm test"]);
  assert.deepEqual(journal.filter((event) => ["reasoning", "update"].includes(event.kind ?? "")).map((event) => event.detail), [
    "先确认数据口径", "已确认按自然月统计", "再验证汇总结果", "桌面检查通过，继续检查手机布局",
  ]);
  assert.equal(journal.filter((event) => event.kind === "update").length, 2);
  assert.equal(journal.find((event) => event.kind === "error")?.label, "Selected model is at capacity. Please try a different model.");
  assert.equal(journal.find((event) => event.kind === "retry")?.detail, "本次没有检测到新进展");
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.doesNotMatch(appSource, /compactActivitySteps\(activities\)\.slice/);
  assert.match(appSource, /journal\.map\(\(activity, index\) => isNarrativeActivity\(activity\)/);
  assert.doesNotMatch(appSource, /stageFeedback|process-journal-pinned/);
  assert.match(styles, /\.process-journal \{[^}]*position: relative;[^}]*overflow-x: hidden;[^}]*border-top:/);
  assert.doesNotMatch(styles, /\.process-journal \{[^}]*max-height:|\.process-journal \{[^}]*overflow-y: auto|\.process-journal \{[^}]*overscroll-behavior-y:/);
  assert.doesNotMatch(styles, /\.process-journal-pinned|position: sticky;/);
  assert.match(appSource, /\{sending && <article className="message assistant running">/);
  assert.match(appSource, /<ProcessPanel key=\{`\$\{detail\.conversation\.id\}:\$\{detail\.remoteTurnId \?\? "job"\}`\} activities=\{activities\} loading=\{activitiesLoading\}/);
  assert.match(appSource, /<div className="process-journal">\{journal\.length/);
  assert.doesNotMatch(appSource, /journalElement|journalFollowingRef|handleJournalScroll/);
  assert.match(appSource, /完成前持续保留，可随时引导/);
  assert.match(appSource, /正在加载运行记录/);
  assert.match(appSource, /data\.type === "replay_complete"[\s\S]*setActivitiesLoading\(false\)/);
  assert.match(appSource, /refreshActivity\(selectedId\)[\s\S]*window\.setInterval\(\(\) => void poll\(\), 2_000\)/);
});

test("sub-agent activity is merged into compact Active and Done state without entering the work journal", () => {
  const events: JobEvent[] = [
    { seq: 1, created_at: "2026-08-19T01:00:00.000Z", kind: "agent", label: "协作 Agent 状态更新", agents: [{ id: "agent-a", path: "/root/ui_audit", status: "running" as const }] },
    { seq: 2, created_at: "2026-08-19T01:00:01.000Z", kind: "agent", label: "协作 Agent 状态更新", agents: [{ id: "agent-b", path: "/root/event_audit", status: "running" as const }] },
    { seq: 3, created_at: "2026-08-19T01:00:02.000Z", kind: "agent", label: "协作 Agent 状态更新", agents: [{ id: "agent-a", status: "completed" as const, summary: "界面检查完成。" }] },
  ];
  const summary = buildSubagentActivity(events);
  assert.deepEqual(summary.agents.map((agent) => [agent.name, agent.status]), [["event_audit", "running"], ["ui_audit", "completed"]]);
  assert.equal(summary.active.length, 1);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.failedCount, 0);
  assert.equal(summary.done[0].summary, "界面检查完成。");
  assert.deepEqual(buildProcessJournal(events), []);

  const retained = mergeJobEvents([], [
    ...events.slice(0, 2),
    ...Array.from({ length: 70 }, (_, index) => ({ seq: index + 3, kind: "command", label: `步骤 ${index}`, detail: `command ${index}` })),
  ]);
  assert.ok(retained.some((event) => event.seq === 1));
  assert.ok(retained.some((event) => event.seq === 2));

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /<details className="subagent-panel">/);
  assert.match(appSource, /label="Active"/);
  assert.match(appSource, /label="Done"/);
  assert.match(styles, /\.subagent-panel > summary/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.subagent-row-title/);
});

test("App Server maps root sub-agent metadata and completion summaries into structured agent events", () => {
  assert.deepEqual(summarizeAppServerItem({
    type: "subAgentActivity", kind: "started", agentThreadId: "agent-a", agentPath: "/root/ui_audit",
  }, true), {
    kind: "agent", label: "协作 Agent 状态更新", agents: [{ id: "agent-a", path: "/root/ui_audit", status: "running" }],
  });
  assert.deepEqual(summarizeAppServerItem({
    type: "collabAgentToolCall", status: "completed", receiverThreadIds: ["agent-a", "agent-b"],
    agentsStates: {
      "agent-a": { status: "completed", message: "UI audit complete" },
      "agent-b": { status: "errored", message: "test failed" },
    },
  }, true), {
    kind: "agent", label: "协作 Agent 状态更新", agents: [
      { id: "agent-a", status: "completed", summary: "UI audit complete" },
      { id: "agent-b", status: "failed", summary: "test failed" },
    ],
  });
});

test("App Server folds a tracked child lifecycle into agent progress without replacing the root answer", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-app-server-subagent-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeAppServer = path.join(root, "fake-app-server");
  fs.writeFileSync(fakeAppServer, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "root-thread" } } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "root-turn" } } });
    setTimeout(() => {
      send({ method: "item/completed", params: { threadId: "root-thread", item: { type: "subAgentActivity", kind: "started", agentThreadId: "child-thread", agentPath: "/root/check_ui" } } });
      send({ method: "item/completed", params: { threadId: "child-thread", item: { type: "agentMessage", phase: "final_answer", text: "检查完成。" } } });
      send({ method: "turn/completed", params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } } });
      send({ method: "item/completed", params: { threadId: "root-thread", item: { type: "agentMessage", phase: "final_answer", text: "根任务完成。" } } });
      send({ method: "turn/completed", params: { threadId: "root-thread", turn: { id: "root-turn", status: "completed" } } });
    }, 10);
  } else if (typeof message.id === "number") send({ id: message.id, result: {} });
});
`, "utf8");
  fs.chmodSync(fakeAppServer, 0o755);
  const progress: unknown[] = [];
  const controller = new AbortController();
  const execution = startAppServerTurn({
    executablePath: fakeAppServer,
    cwd: root,
    env: process.env,
    threadId: null,
    prompt: "test",
    imagePaths: [],
    model: "gpt-test",
    reasoningEffort: "low",
    library: root,
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
    codexEgressKind: "unchanged",
  }, {
    signal: controller.signal,
    onThreadStarted: () => undefined,
    onProgress: (payload) => progress.push(payload),
  });
  assert.equal(await execution.result, "根任务完成。");
  assert.equal(progress.some((item) => (item as { kind?: string; detail?: string }).kind === "update" && (item as { detail?: string }).detail === "检查完成。"), false);
  assert.ok(progress.some((item) => (item as { agents?: Array<{ path?: string; status?: string; summary?: string }> }).agents?.[0]?.path === "/root/check_ui"));
  assert.ok(progress.some((item) => {
    const agent = (item as { agents?: Array<{ status?: string; summary?: string }> }).agents?.[0];
    return agent?.status === "completed" && agent.summary === "检查完成。";
  }));
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

test("legacy Codex title envelopes remain readable without driving new task naming", () => {
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"已收到：asdf。未生成任何文件。","title":"输入测试"}'), "已收到：asdf。未生成任何文件。");
  assert.equal(extractLeakedAutoTitleAnswer('```json\n{"answer":"正常回复","title":"后续测试"}\n```'), "正常回复");
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"用户要求的 JSON","title":"标题","extra":true}'), null);
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"用户要求的 JSON","title":"这是一个明显超过十个字符的普通字段值"}'), null);
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"正常回复","title":"NAS 双出口抖动已停止"}', true), "正常回复");
});

test("Codex title agent is Luna low, ephemeral, schema-constrained, and receives bounded project context", async () => {
  let captured: { userId: string; executorId: string; prompt: string; timeoutMs: number } | undefined;
  const service = new ConversationTitleService(async (userId, executorId, prompt, timeoutMs) => {
    captured = { userId, executorId, prompt, timeoutMs };
    return JSON.stringify({ title: "优化任务命名" });
  });
  const title = await service.generate({
    userId: crypto.randomUUID(), executorId: "remote:test", projectName: "Codex Web", projectDirectory: "codex-web",
    attachmentNames: ["命名规则.txt"], trigger: "first_message", requestText: [
    "请结合以下引用回答我的问题：",
    "> 这部分只是被引用的背景",
    "我的问题：请帮我优化任务命名逻辑 https://example.com/private",
    "```ts\nconst secret = 'not a requirement';\n```",
    ].join("\n"),
  });
  assert.equal(title, "优化任务命名");
  assert.ok(captured);
  assert.match(captured.prompt, /动宾结构|动宾/);
  assert.match(captured.prompt, /Codex Web|codex-web|命名规则\.txt|优化任务命名逻辑/);
  assert.doesNotMatch(captured.prompt, /引用的背景|https?:|secret/);
  assert.equal(CONVERSATION_TITLE_CODEX_MODEL, "gpt-5.6-luna");
  assert.equal(CONVERSATION_TITLE_REASONING_EFFORT, "low");
  const args = codexConversationTitleArguments("schema.json", "output.json");
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("gpt-5.6-luna"));
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(args.includes('history.persistence="none"'));
  assert.ok(args.includes("--output-schema"));
  assert.equal(extractTitleRequestText("我的问题：整理销售数据"), "整理销售数据");
  assert.equal(normalizeConversationTitle("《分析季度销售数据报告》"), "分析季度销售数据报告".slice(0, 10));
  const runnerSource = fs.readFileSync(path.join(process.cwd(), "server", "codex-runner.ts"), "utf8");
  assert.doesNotMatch(runnerSource, /outputSchema:/);
});

test("transient upstream failures stay bounded while model capacity retries until cancellation", async () => {
  assert.equal(isMeaningfulExecutionProgress({ kind: "status", label: "已开始分析" }), false);
  assert.equal(isMeaningfulExecutionProgress({ kind: "error", label: "Selected model is at capacity" }), false);
  assert.equal(isMeaningfulExecutionProgress({ kind: "reasoning", label: "模型思路摘要" }), true);
  assert.equal(isMeaningfulExecutionProgress({ kind: "command", label: "正在执行命令" }), true);
  assert.equal(isModelCapacityProgress({ kind: "error", label: "Selected model is at capacity. Please try a different model." }), true);
  assert.equal(isModelCapacityProgress({ kind: "status", label: "Selected model is at capacity. Please try a different model." }), false);
  assert.deepEqual(MODEL_CAPACITY_INITIAL_RETRY_DELAYS_MS, [10_000, 30_000, 60_000, 120_000, 180_000, 240_000, 300_000]);
  assert.deepEqual(MODEL_CAPACITY_INITIAL_RETRY_DELAYS_MS.map(retryDelayLabel), ["10 秒", "30 秒", "1 分钟", "2 分钟", "3 分钟", "4 分钟", "5 分钟"]);
  assert.equal(MODEL_CAPACITY_STEADY_RETRY_DELAY_MS, 300_000);
  assert.equal(MODEL_CAPACITY_LONG_RETRY_AFTER_MS, 3_600_000);
  assert.equal(MODEL_CAPACITY_LONG_RETRY_DELAY_MS, 1_800_000);
  assert.deepEqual(Array.from({ length: 10 }, (_, attempt) => modelCapacityRetryDelayMs(attempt, 3_599_999)), [
    10_000, 30_000, 60_000, 120_000, 180_000, 240_000, 300_000, 300_000, 300_000, 300_000,
  ]);
  assert.equal(modelCapacityRetryDelayMs(0, 3_600_000), 1_800_000);
  assert.equal(modelCapacityRetryDelayMs(100, 7_200_000), 1_800_000);
  assert.equal(isRetryableUpstreamError("websocket closed by server before response.completed"), true);
  assert.equal(isRetryableUpstreamError("HTTP 503 server overload"), true);
  assert.equal(isModelCapacityError("Selected model is at capacity. Please try a different model."), true);
  assert.equal(isModelCapacityError("model at capacity"), true);
  assert.equal(isModelCapacityError("authentication failed"), false);
  assert.equal(isRetryableUpstreamError("authentication failed"), false);
  assert.equal(isRetryableUpstreamError("permission denied"), false);
  assert.equal(isConnectionInterruptionError("Selected model is at capacity. Please try a different model."), false);
  assert.equal(isConnectionInterruptionError("websocket closed by server before response.completed"), true);
  assert.equal(capacityRetryPrompt("原始用户指令", false), "原始用户指令");
  assert.equal(capacityRetryPrompt("原始用户指令", true), MODEL_CAPACITY_CONTINUATION_PROMPT);
  assert.match(MODEL_CAPACITY_CONTINUATION_PROMPT, /继续刚才.*未完成的任务/);
  assert.match(MODEL_CAPACITY_CONTINUATION_PROMPT, /不要重复已经完成的步骤或外部操作/);

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

  let capacityCalls = 0;
  const capacityNotices: Array<{ attempt: number; maxAttempts?: number; delayMs: number }> = [];
  const capacityValue = await runWithTransientRetries(async () => {
    capacityCalls += 1;
    if (capacityCalls > 12) return "capacity recovered";
    throw new Error("Selected model is at capacity. Please try a different model.");
  }, {
    signal: new AbortController().signal,
    capacityDelayMs: () => 0,
    onRetry: ({ attempt, maxAttempts, delayMs }) => capacityNotices.push({ attempt, maxAttempts, delayMs }),
  });
  assert.equal(capacityValue, "capacity recovered");
  assert.equal(capacityCalls, 13, "capacity failures continue beyond the former seven-retry limit");
  assert.deepEqual(capacityNotices, Array.from({ length: 12 }, (_, index) => ({
    attempt: index + 1, maxAttempts: undefined, delayMs: 0,
  })));

  const capacityAbort = new AbortController();
  let cancelledCapacityCalls = 0;
  await assert.rejects(() => runWithTransientRetries(async () => {
    cancelledCapacityCalls += 1;
    throw new Error("Selected model is at capacity. Please try a different model.");
  }, {
    signal: capacityAbort.signal,
    capacityDelayMs: () => 30 * 60_000,
    onRetry: () => capacityAbort.abort(),
  }), (error) => error instanceof Error && error.name === "AbortError" && error.message === "任务已停止");
  assert.equal(cancelledCapacityCalls, 1, "stopping a Job aborts a long capacity wait immediately");

  let continuationRequired = false;
  const retryPrompts: string[] = [];
  const continuedValue = await runWithTransientRetries(async () => {
    retryPrompts.push(capacityRetryPrompt("原始用户指令", continuationRequired));
    if (retryPrompts.length === 1) {
      continuationRequired = true;
      throw new Error("Selected model is at capacity. Please try a different model.");
    }
    return "continued";
  }, {
    signal: new AbortController().signal,
    capacityDelayMs: () => 0,
    canRetry: (error) => isModelCapacityError(error),
  });
  assert.equal(continuedValue, "continued");
  assert.deepEqual(retryPrompts, ["原始用户指令", MODEL_CAPACITY_CONTINUATION_PROMPT]);

  const runnerSource = fs.readFileSync(path.join(process.cwd(), "server", "codex-runner.ts"), "utf8");
  assert.match(runnerSource, /canRetry: \(error\) => isModelCapacityError\(error\) \|\| !executionObserved/);
  assert.match(runnerSource, /capacityContinuationRequired = continueExistingWork/);

  let permanentCalls = 0;
  await assert.rejects(() => runWithTransientRetries(async () => {
    permanentCalls += 1;
    throw new Error("authentication failed");
  }, { signal: new AbortController().signal, delaysMs: [0, 0, 0] }), /authentication failed/);
  assert.equal(permanentCalls, 1);

  let startedCalls = 0;
  await assert.rejects(() => runWithTransientRetries(async () => {
    startedCalls += 1;
    throw new Error("stream disconnected before completion");
  }, {
    signal: new AbortController().signal,
    delaysMs: [0, 0, 0],
    canRetry: () => false,
  }), /stream disconnected/);
  assert.equal(startedCalls, 1, "a caller that observed execution must be able to forbid whole-turn replay");
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

test("tenant knowledge migration creates an idempotent direct-child project boundary", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-tenant-project-layout-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tenant = ensureTenant(path.join(root, "tenants"), LEGACY_USER_ID);
  fs.writeFileSync(path.join(tenant.library, "AGENTS.md"), LEGACY_LIBRARY_AGENTS, "utf8");
  fs.writeFileSync(path.join(tenant.library, "PROFILE.md"), "profile", "utf8");
  fs.mkdirSync(path.join(tenant.library, "projects"));
  fs.writeFileSync(path.join(tenant.library, "projects", "facts.md"), "facts", "utf8");

  const defaultRoot = ensureTenantProjectLayout(tenant);
  assert.equal(defaultRoot, tenantDefaultProjectRoot(tenant));
  assert.deepEqual(fs.readdirSync(tenant.library), ["default"]);
  assert.equal(fs.readFileSync(path.join(defaultRoot, "PROFILE.md"), "utf8"), "profile");
  assert.equal(fs.readFileSync(path.join(defaultRoot, "projects", "facts.md"), "utf8"), "facts");
  assert.match(fs.readFileSync(path.join(defaultRoot, "AGENTS.md"), "utf8"), /Codex Web project rules/);
  assert.equal(ensureTenantProjectLayout(tenant), defaultRoot);

  const rootPage = listTenantProjectDirectories(tenant);
  assert.equal(rootPage.directory, tenant.library);
  assert.equal(rootPage.parent, null);
  assert.deepEqual(rootPage.directories.map((entry) => entry.name), ["default"]);
  assert.equal(validateTenantProjectDirectory(tenant, defaultRoot).directory, defaultRoot);
  assert.equal(assertTenantProjectRoot(tenant, defaultRoot), defaultRoot);
  assert.throws(() => validateTenantProjectDirectory(tenant, tenant.library), /只是项目容器/);

  const created = createTenantProjectDirectory(tenant, tenant.library, "第二项目");
  assert.equal(created.directory, path.join(tenant.library, "第二项目"));
  assert.equal(ensureTenantProjectLayout(tenant), defaultRoot);
  assert.equal(fs.existsSync(created.directory), true, "a completed migration must never absorb later sibling projects");
  fs.mkdirSync(path.join(created.directory, "nested"));
  assert.throws(() => validateTenantProjectDirectory(tenant, path.join(created.directory, "nested")), /一级文件夹/);
  fs.symlinkSync(defaultRoot, path.join(tenant.library, "shortcut"), "dir");
  assert.throws(() => validateTenantProjectDirectory(tenant, path.join(tenant.library, "shortcut")), /符号链接/);
  assert.throws(() => createTenantProjectDirectory(tenant, created.directory, "nested-project"), /知识库根目录/);
});

test("configured tenants have distinct Unix identities and workers reject cross-tenant paths", (context) => {
  const identities = listTenantIdentities();
  assert.deepEqual(identities.map((identity) => identity.label), ["owner", "member-a", "member-b"]);
  assert.equal(new Set(identities.map((identity) => identity.uid)).size, identities.length);
  assert.equal(new Set(identities.map((identity) => identity.gid)).size, identities.length);
  const ownerIdentity = tenantIdentityForUser(LEGACY_USER_ID)!;
  const jobId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const testTenantBase = fs.mkdtempSync(path.join(os.tmpdir(), "cww-tenants-"));
  context.after(() => fs.rmSync(testTenantBase, { recursive: true, force: true }));
  const tenantRoot = path.join(testTenantBase, ownerIdentity.userId);
  const workspace = path.join(tenantRoot, "conversations", conversationId);
  const projectDirectory = path.join(tenantRoot, "library", "default");
  fs.mkdirSync(projectDirectory, { recursive: true });
  const request: TenantWorkerRunRequest = {
    jobId,
    userId: ownerIdentity.userId,
    conversationId,
    projectRoot: process.cwd(),
    projectDirectory,
    pythonRuntimeRoot: path.join(process.cwd(), "python-runtime"),
    tenantRoot,
    workspace,
    runtimeRoot: path.join(workspace, ".runtime", "jobs", jobId),
    codexHome: path.join(tenantRoot, "codex-home"),
    codexThreadId: null,
    effectivePrompt: "test",
    imagePaths: [path.join(workspace, "uploads", "image.png")],
    selection: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    networkAccessEnabled: false,
    webSearchMode: "cached",
    codexWindowsSandbox: "elevated",
    optionalCapabilities: { ...DEFAULT_OPTIONAL_AGENT_CAPABILITIES },
  };
  assert.doesNotThrow(() => validateTenantWorkerRequest(request, ownerIdentity.userId, tenantRoot));
  assert.doesNotThrow(() => validateTenantWorkerRequest({ ...request, projectDirectory: path.join(tenantRoot, "library", "not-created") }, ownerIdentity.userId, tenantRoot, false));
  assert.throws(() => validateTenantWorkerRequest({ ...request, projectDirectory: path.join(tenantRoot, "library", "not-created") }, ownerIdentity.userId, tenantRoot), /普通文件夹/);
  assert.throws(() => validateTenantWorkerRequest({ ...request, tenantRoot: path.join(os.tmpdir(), "other") }, ownerIdentity.userId, tenantRoot), /path mismatch/);
  assert.throws(() => validateTenantWorkerRequest({ ...request, imagePaths: [path.join(tenantRoot, "..", "secret.png")] }, ownerIdentity.userId, tenantRoot), /escapes workspace/);
  const siblingProject = path.join(tenantRoot, "library", "other");
  fs.mkdirSync(siblingProject);
  assert.doesNotThrow(() => validateTenantWorkerRequest({ ...request, projectDirectory: siblingProject }, ownerIdentity.userId, tenantRoot));
  assert.throws(() => validateTenantWorkerRequest({ ...request, projectDirectory: path.join(tenantRoot, "library") }, ownerIdentity.userId, tenantRoot), /项目容器|escapes tenant project container/);
  const executionSource = fs.readFileSync(path.join(process.cwd(), "server", "tenant-worker-execution.ts"), "utf8");
  const composeSource = fs.readFileSync(path.join(process.cwd(), "compose.yaml"), "utf8");
  assert.match(executionSource, /executablePath: process\.env\.CODEX_RUNTIME_PATH/);
  const appServerSource = fs.readFileSync(path.join(process.cwd(), "server", "app-server-turn.ts"), "utf8");
  assert.match(appServerSource, /"turn\/steer"/);
  assert.match(appServerSource, /expectedTurnId: this\.activeTurnId/);
  assert.match(appServerSource, /this\.request\("thread\/resume", \{ threadId: this\.options\.threadId, \.\.\.common, excludeTurns: true \}\)/);
  assert.match(appServerSource, /this\.request\("thread\/start", \{[\s\S]{0,240}developerInstructions/);
  assert.match(appServerSource, /model_reasoning_summary: "auto"/);
  assert.match(appServerSource, /show_raw_agent_reasoning: false/);
  assert.match(composeSource, /codex-runtime\}:\/opt\/codex-runtime/);
  assert.match(composeSource, /CODEX_WEB_DEPLOY_STATUS_FILE: \/app\/deploy-status\/status\.json/);
  assert.match(composeSource, /CODEX_WEB_DEPLOY_STATUS_HOST_ROOT:-\.\/\.state\/deploy-status\}:\/app\/deploy-status:ro/);
  assert.match(executionSource, /cwd: request\.projectDirectory/);
  assert.match(executionSource, /CWW_OUTPUTS_DIR: path\.join\(request\.workspace, "outputs"\)/);
  const supervisorSource = fs.readFileSync(path.join(process.cwd(), "server", "supervisor.ts"), "utf8");
  assert.match(supervisorSource, /validateTenantWorkerRequest\(message\.request, identity\.userId, tenantRoot, false\)/);
});

test("multi-agent stays available by default while other optional capabilities require explicit intent", () => {
  assert.deepEqual(
    detectOptionalAgentCapabilities(["完成项目目标，并优化应用页面，然后运行测试。"]),
    DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  );
  assert.deepEqual(
    detectOptionalAgentCapabilities(["Use the sandbox for this application and read the code."]),
    DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  );
  assert.deepEqual(
    detectOptionalAgentCapabilities(["Apps、连接器、Goals、子代理及游戏分析 MCP 默认关闭、按需启用。"]),
    DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  );

  const enabled = detectOptionalAgentCapabilities([
    "请连接 Gmail 查找邮件。",
    "后续请使用子代理并行核对。",
    "创建一个长期目标持续跟踪。",
    "调用游戏分析 MCP 批量处理百度游戏视频。",
  ]);
  assert.deepEqual(enabled, {
    apps: true,
    remotePlugin: true,
    goals: true,
    multiAgent: true,
    gameAnalysisMcp: true,
  });
  assert.equal(detectOptionalAgentCapabilities(["请通过 app://example 打开资料"]).apps, true);
  assert.equal(detectOptionalAgentCapabilities(["请安装 Slack 插件"]).remotePlugin, true);
  assert.equal(detectOptionalAgentCapabilities(["请查看 GitHub PR"]).remotePlugin, true);
  assert.equal(detectOptionalAgentCapabilities(["请使用子代理", "后续关闭子代理"]).multiAgent, true);
  assert.equal(updateOptionalAgentCapabilities({ ...enabled, multiAgent: false }, ["普通代码修改"]).multiAgent, true);
  assert.equal(updateOptionalAgentCapabilities(enabled, ["普通代码修改"]).apps, true);
  const defaultConfig = buildOptionalCapabilityConfig(DEFAULT_OPTIONAL_AGENT_CAPABILITIES) as any;
  assert.deepEqual(defaultConfig.features, { apps: false, remote_plugin: false, plugins: false, tool_suggest: false, goals: false, multi_agent: true });
  assert.deepEqual(defaultConfig.plugins, { "spreadsheets@openai-primary-runtime": { enabled: false } });
  assert.ok(defaultConfig.skills.config.every((skill: { enabled: boolean }) => skill.enabled === false));
  assert.equal(buildOptionalCapabilityRoutingHint("请查看 GitHub PR"), "可用技能组入口：GitHub：仓库、PR、Issue 与 CI");
  const ciConfig = buildOptionalCapabilityConfig(enabled, "请修复 GitHub Actions CI 失败") as any;
  assert.equal(ciConfig.skills.config.find((skill: { name: string }) => skill.name === "github:github")?.enabled, false);
  assert.equal(ciConfig.skills.config.find((skill: { name: string }) => skill.name === "github:gh-fix-ci")?.enabled, true);
  assert.equal(ciConfig.skills.config.find((skill: { name: string }) => skill.name === "github:gh-address-comments")?.enabled, false);
});

test("conversation workspace and Codex home receive managed runtime guidance and local skills", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-workspace-guidance-test-"));
  const conversationId = crypto.randomUUID();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = ensureWorkspace(root, conversationId);
  const agentsPath = path.join(workspace, "AGENTS.md");
  const initial = fs.readFileSync(agentsPath, "utf8");
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
  assert.doesNotMatch(updated, /artifact-tool|desktop Excel|openpyxl/);

  const tenant = ensureTenant(path.join(root, "tenants"), LEGACY_USER_ID);
  const localSpreadsheetSkill = fs.readFileSync(path.join(tenant.codexHome, "skills", "local-spreadsheets", "SKILL.md"), "utf8");
  assert.match(localSpreadsheetSkill, /^name: local-spreadsheets$/m);
  assert.match(localSpreadsheetSkill, /openpyxl and pandas/);
});

test("agent turn context keeps only current intent, attachments, and conditional safety", () => {
  const plain = buildAgentTurnPrompt({ userPrompt: "  请整理这份文件  ", attachments: [] });
  assert.equal(plain, "请整理这份文件");
  assert.doesNotMatch(plain, /Excel 附件规则|local-spreadsheets|openpyxl|artifact-tool/);
  const withFile = buildAgentTurnPrompt({
    userPrompt: "请汇总",
    attachments: [{
      name: "成绩表.xlsx",
      path: "uploads/abc.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }],
  });
  assert.match(withFile, /^本轮附件：/);
  assert.match(withFile, /请汇总$/);
  assert.match(withFile, /成绩表\.xlsx: uploads\/abc\.xlsx/);
  assert.match(withFile, /Excel 附件规则（仅因本轮命中 Excel 附件）/);
  assert.match(withFile, /\$local-spreadsheets（openpyxl\/pandas）/);
  assert.match(withFile, /绝不执行宏/);
  assert.doesNotMatch(withFile, /租户边界|Python 环境策略|绝对路径|answer,title|outputs 中只能/);
  const csv = buildAgentTurnPrompt({
    userPrompt: "请汇总",
    attachments: [{ name: "成绩.csv", path: "uploads/abc.csv", mimeType: "text/csv" }],
  });
  assert.doesNotMatch(csv, /Excel 附件规则|local-spreadsheets|openpyxl|artifact-tool/);
  const mimeOnly = buildAgentTurnPrompt({
    userPrompt: "请检查",
    attachments: [{ name: "无扩展名", path: "uploads/abc", mimeType: "application/vnd.ms-excel" }],
  });
  assert.match(mimeOnly, /Excel 附件规则/);
  const isolated = buildAgentTurnPrompt({ userPrompt: "检查脚本", attachments: [], isolationReason: "检测到脚本" });
  assert.match(isolated, /离线隔离/);
  assert.match(isolated, /不执行不受信任/);
  const resumed = buildAgentTurnPrompt({ userPrompt: "继续完成", attachments: [], interruptedContext: "> 用户主动终止了任务。\n- 已完成环境检查" });
  assert.match(resumed, /^上一次任务由用户主动终止/);
  assert.match(resumed, /继续完成$/);
  assert.match(resumed, /<interrupted_task_context>[\s\S]*已完成环境检查[\s\S]*<\/interrupted_task_context>/);
  assert.equal(buildAgentTurnPrompt({ userPrompt: "普通任务", attachments: [] }), "普通任务");
  const personalContext = "<codex_web_personal_context>\n偏好简洁中文。\n</codex_web_personal_context>";
  const personalized = buildAgentTurnPrompt({ userPrompt: "普通任务", attachments: [], personalContext });
  assert.match(personalized, /^<codex_web_personal_context>/);
  assert.match(personalized, /偏好简洁中文/);
  assert.match(personalized, /<\/codex_web_personal_context>\n\n普通任务$/);
  assert.equal(buildAgentSteerPrompt("改成蓝色", []), "实时调整当前任务：改成蓝色");
  assert.match(buildAgentSteerPrompt("继续处理", [{ name: "追加.xlsm", path: "uploads/add.xlsm" }]), /Excel 附件规则/);
  const image = { name: "screen.png", path: "uploads/screen.png", mimeType: "image/png" };
  assert.deepEqual(decideImageInput([image]), { preload: true, reason: "image" });
  assert.deepEqual(decideImageInput([]), { preload: false, reason: "no_images" });
  assert.equal(isSupportedImageAttachment("screen.png", "application/octet-stream"), true);
  assert.equal(isSupportedImageAttachment("screen.gif", "image/gif"), false);
  const imageManagementPrompt = buildAgentTurnPrompt({ userPrompt: "重命名图片", attachments: [image], imageInputDecision: decideImageInput([image]) });
  assert.match(imageManagementPrompt, /形成简短、可复用的文字摘要/);
  assert.match(imageManagementPrompt, /view_image/);
  const hostInstructions = buildHostThreadInstructions();
  assert.match(hostInstructions, /宿主 root/);
  assert.match(hostInstructions, /AGENTS\.md/);
  assert.match(hostInstructions, /source locator 是权威文件路径/);
  assert.match(hostInstructions, /不要把账号级技能改写到 \.system/);
  const tenantInstructions = buildTenantProjectThreadInstructions();
  assert.match(tenantInstructions, /受限租户项目线程/);
  assert.match(tenantInstructions, /CWW_UPLOADS_DIR/);
  assert.match(tenantInstructions, /CWW_OUTPUTS_DIR/);
  assert.match(tenantInstructions, /source locator 是权威文件路径/);
  assert.match(hostInstructions, /当前工作目录是用户选定的项目根/);
  assert.match(hostInstructions, /CWW_UPLOADS_DIR/);
  assert.match(hostInstructions, /交付写入 CWW_OUTPUTS_DIR/);
  assert.match(hostInstructions, /过程文件写入 CWW_JOB_RUNTIME/);
  assert.match(hostInstructions, /不要把网页交付物写到项目根 outputs\//);
  assert.match(hostInstructions, /Markdown 文件链接明确指向一个可读取的服务器本地普通文件/);
  assert.match(hostInstructions, /需要用户下载的本机文件可以直接链接绝对路径或当前项目相对路径/);
  assert.match(tenantInstructions, /CWW_OUTPUTS_DIR，使 Codex Web 把它登记为当前消息的附件卡片/);
  assert.match(tenantInstructions, /不要输出项目源文件或其他本机路径的 Markdown 下载链接/);
  assert.match(hostInstructions, /交付格式、编码与视觉细则以项目 AGENTS\.md 为准/);
  assert.match(hostInstructions, /大日志、表格和机器可读结果/);
  assert.doesNotMatch(hostInstructions, /桌面正文 16px|正文最大宽度约 820px|内嵌 data URI/);
  assert.doesNotMatch(hostInstructions, /默认只生成 Markdown/);
  assert.match(hostInstructions, /回复只提最终文件名/);
  assert.doesNotMatch(hostInstructions, /[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  assert.doesNotMatch(hostInstructions, /\/(?:srv|app|opt|home|root)\//);
});

test("personal context requires an enabled per-user library and stays bounded", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-personal-context-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const personal = path.join(root, "personal");
  fs.mkdirSync(personal);
  fs.writeFileSync(path.join(personal, "PROFILE.md"), "# 用户画像\n\n## 稳定背景\n\n稳定事实\n\n## 游戏产品\n\n游戏领域事实", "utf8");
  assert.equal(loadPersonalContext(root), undefined);
  fs.writeFileSync(path.join(personal, "ENABLED"), "schema=v1\n", "utf8");
  fs.writeFileSync(path.join(personal, "PREFERENCES.md"), `# 偏好\n\n## 沟通与解释\n\n默认中文。${"甲".repeat(8_000)}`, "utf8");
  fs.symlinkSync(path.join(personal, "PROFILE.md"), path.join(personal, "NOW.md"));
  const loaded = loadPersonalContext(root);
  assert.match(loaded ?? "", /稳定事实/);
  assert.match(loaded ?? "", /本节其余内容未注入/);
  assert.doesNotMatch(loaded ?? "", /游戏领域事实/);
  assert.ok(personalContextTokenCount(loaded ?? "") <= PERSONAL_CORE_TOKEN_BUDGET + 220);
  const gameContext = loadPersonalContext(root, "分析游戏产品的活动设计") ?? "";
  assert.match(gameContext, /游戏领域事实/);
  assert.ok(personalContextTokenCount(gameContext) <= PERSONAL_CORE_TOKEN_BUDGET + PERSONAL_RETRIEVAL_TOKEN_BUDGET + 240);
  assert.match(loadInitialPersonalContext(root) ?? "", /稳定事实/);
  assert.equal(loadInitialPersonalContext(root, "existing-codex-thread"), undefined);
  fs.writeFileSync(path.join(personal, "AUTO.md"), "---\nrevision: 2\n---\n\n# 自动更新\n\n- 新偏好", "utf8");
  assert.equal(loadPersonalContextForTurn(root, "existing-codex-thread", 2), undefined);
  assert.match(loadPersonalContextForTurn(root, "existing-codex-thread", 1, undefined, "新偏好")?.content ?? "", /新偏好/);
  assert.equal(loadPersonalContextForTurn(root, "existing-codex-thread", 1)?.revision, 2);
  assert.equal(loadPersonalContextForTurn(root, "existing-codex-thread", 2, 3)?.revision, 3);
  const leaked = `阶段说明\n<codex_web_personal_context>\n内部画像\n</codex_web_personal_context>\n继续`;
  assert.equal(containsPersonalContext({ detail: leaked }), true);
  assert.equal(containsPersonalContext({ detail: "正在分析\n## PROFILE.md\n内部摘要" }), true);
  assert.equal(stripPersonalContext(leaked), "阶段说明\n继续");
});

test("personal memory outbox, confidence promotion, rendering, and isolation are deterministic", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-personal-memory-test-"));
  const db = new AppDatabase(root, { username: "demo-owner", passwordHash: "", displayName: "Codex" }, false);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const selection = { model: "gpt-test", reasoningEffort: "high" };
  const conversations = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const messages = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const dates = ["2026-08-15T01:00:00.000Z", "2026-08-15T02:00:00.000Z", "2026-08-16T03:00:00.000Z"];
  conversations.forEach((conversationId, index) => {
    db.createConversation(conversationId, `任务${index}`, selection);
    db.addMessage({
      id: messages[index], conversation_id: conversationId, role: "user",
      content: "处理复杂问题时倾向先了解实际证据", created_at: dates[index],
    });
  });
  const queued = db.listPendingPersonalMemoryMessages(LEGACY_USER_ID, "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:00.000Z", 10);
  assert.deepEqual(queued.map((item) => item.id), messages);
  for (const messageId of messages) db.applyPersonalMemoryCandidates(LEGACY_USER_ID, [{
    kind: "preference", canonicalKey: "decision.evidence_first", statement: "复杂问题优先核对实际证据",
    scope: "user_global", evidenceKind: "inferred", sensitivity: "normal", messageIds: [messageId], ttlDays: null,
  }]);
  const promoted = db.listPersonalMemoryEntries(LEGACY_USER_ID).find((entry) => entry.canonical_key === "decision.evidence_first");
  assert.equal(promoted?.status, "active");
  assert.equal(promoted?.confidence, "high");
  assert.equal(promoted?.evidence_count, 3);
  assert.equal(promoted?.conversation_count, 3);
  assert.equal(promoted?.evidence_date_count, 2);
  db.applyPersonalMemoryCandidates(LEGACY_USER_ID, [{
    kind: "preference", canonicalKey: "communication.answer_order", statement: "默认先给结论，再解释依据",
    scope: "user_global", evidenceKind: "direct", sensitivity: "normal", messageIds: [messages[0]], ttlDays: null,
  }]);
  const direct = db.listPersonalMemoryEntries(LEGACY_USER_ID, "active").find((entry) => entry.canonical_key === "communication.answer_order");
  assert.equal(direct?.confidence, "explicit");
  assert.ok(direct);
  const rejected = db.reviewPersonalMemoryEntry(LEGACY_USER_ID, direct.id, "reject");
  assert.equal(rejected?.review_state, "rejected");
  assert.equal(rejected?.status, "candidate");
  const corrected = db.reviewPersonalMemoryEntry(LEGACY_USER_ID, direct.id, "correct", "默认用中文先给结论");
  assert.equal(corrected?.review_state, "corrected");
  assert.equal(corrected?.status, "active");
  assert.equal(corrected?.statement, "默认用中文先给结论");
  const evidence = db.listPersonalMemoryEvidence(LEGACY_USER_ID, direct.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].conversation_title, "任务0");
  assert.match(evidence[0].source_excerpt, /实际证据/);
  assert.equal(db.commitPersonalMemoryManualRevision({
    userId: LEGACY_USER_ID, expectedRevision: 0, publishedFile: "personal/PROFILE.md", publishedAt: "2026-08-16T05:00:00.000Z",
  }), 1);
  assert.throws(() => db.commitPersonalMemoryManualRevision({
    userId: LEGACY_USER_ID, expectedRevision: 0, publishedFile: "personal/NOW.md", publishedAt: "2026-08-16T05:01:00.000Z",
  }), /PERSONAL_MEMORY_REVISION_CONFLICT/);
  const rendered = renderAutoMemory(db.listPersonalMemoryEntries(LEGACY_USER_ID, "active"), 3, "2026-08-16T04:00:00.000Z");
  assert.match(rendered, /revision: 3/);
  assert.match(rendered, /默认用中文先给结论/);
  assert.doesNotMatch(rendered, /canonical_key|message_id/);
  assert.equal(isSensitivePersonalMemory("我的 API key 是 example-secret-value"), true);
  assert.equal(isSensitivePersonalMemory("对金融与投资问题使用情景分析"), false);
});

test("personal memory service processes a durable batch and atomically publishes a revision", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-personal-memory-service-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const db = new AppDatabase(dataRoot, { username: "demo-owner", passwordHash: "", displayName: "Codex" }, false);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const tenant = ensureTenant(tenantRoot, LEGACY_USER_ID);
  const personal = path.join(tenant.library, "personal");
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, "ENABLED"), "schema=v1\n", "utf8");
  fs.writeFileSync(path.join(personal, "PROFILE.md"), "# 用户画像\n", "utf8");
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  db.createConversation(conversationId, "偏好测试", { model: "gpt-test", reasoningEffort: "high" });
  db.addMessage({
    id: messageId, conversation_id: conversationId, role: "user",
    content: "我希望以后默认先给结论。", created_at: "2026-08-14T01:00:00.000Z",
  });
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [{
    kind: "preference", canonical_key: "communication.conclusion_first", statement: "默认先给结论",
    scope: "user_global", evidence_kind: "direct", sensitivity: "normal", message_ids: [messageId], ttl_days: null,
  }] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  const service = new PersonalMemoryService(loadConfig({
    projectRoot: root, dataRoot, tenantRoot, personalMemoryApiKey: "test-key",
    personalMemoryBaseUrl: "https://memory.invalid/v1", personalMemoryModel: "test-memory",
    personalMemoryDelayMs: 0, personalMemoryPollMs: 60_000, personalMemoryBatchSize: 12,
  }), db, fakeFetch);
  await service.pump();
  const status = db.getPersonalMemoryStatus(LEGACY_USER_ID);
  assert.equal(status.revision, 1);
  assert.equal(status.pending, 0);
  assert.equal(status.processed, 1);
  assert.equal(status.active, 1);
  const published = fs.readFileSync(path.join(personal, "AUTO.md"), "utf8");
  assert.match(published, /revision: 1/);
  assert.match(published, /默认先给结论/);
  await service.pump();
  assert.equal(db.getPersonalMemoryStatus(LEGACY_USER_ID).revision, 1);
});

test("personal memory extraction rejects local skill/project/task rules and keeps portable preferences", async () => {
  const messageId = crypto.randomUUID();
  const source = {
    id: messageId,
    user_id: LEGACY_USER_ID,
    conversation_id: crypto.randomUUID(),
    conversation_title: "局部规则测试",
    project_id: crypto.randomUUID(),
    content: "用户说明偏好与项目局部要求。",
    quote_excerpt: null,
    created_at: "2026-08-22T04:00:00.000Z",
    attempts: 0,
  };
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [
    {
      kind: "preference", canonical_key: "game.last_war.knowledge_integration",
      statement: "在 Last War 这个项目中，遇到新系统时截图并保存到项目素材库",
      scope: "user_global", evidence_kind: "direct", sensitivity: "normal", message_ids: [messageId], ttl_days: null,
    },
    {
      kind: "current_focus", canonical_key: "focus.last_war", statement: "最近关注 Last War 活动",
      scope: "recent", evidence_kind: "inferred", sensitivity: "normal", message_ids: [messageId], ttl_days: 30,
    },
    {
      kind: "preference", canonical_key: "project.last_war.response_style",
      statement: "默认在该项目中先截图再分析", scope: "user_global", evidence_kind: "direct",
      sensitivity: "normal", message_ids: [messageId], ttl_days: null,
    },
    {
      kind: "preference", canonical_key: "communication.temporary_detail",
      statement: "默认先给结论，再解释依据", scope: "user_global", evidence_kind: "direct",
      sensitivity: "normal", message_ids: [messageId], ttl_days: 30,
    },
    {
      kind: "preference", canonical_key: "communication.conclusion_first", statement: "默认先给结论，再解释依据",
      scope: "user_global", evidence_kind: "direct", sensitivity: "normal", message_ids: [messageId], ttl_days: null,
    },
  ] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  const extractor = new PersonalMemoryExtractor(loadConfig({
    personalMemoryApiKey: "test-key", personalMemoryBaseUrl: "https://memory.invalid/v1", personalMemoryModel: "test-memory",
  }), fakeFetch);
  const candidates = await extractor.extract([source], "");
  assert.deepEqual(candidates.map((candidate) => candidate.canonicalKey), ["communication.conclusion_first"]);
});

test("personal memory management API reviews entries and bumps manual file revisions", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-personal-memory-management-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const personal = path.join(ensureTenant(tenantRoot, LEGACY_USER_ID).library, "personal");
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, "ENABLED"), "schema=v1\n", "utf8");
  for (const file of ["PROFILE.md", "PREFERENCES.md", "KNOWLEDGE.md", "NOW.md"]) {
    fs.writeFileSync(path.join(personal, file), `# ${file}\n`, "utf8");
  }
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "个人知识来源", { model: "gpt-test", reasoningEffort: "high" });
  instance.db.addMessage({
    id: messageId, conversation_id: conversationId, role: "user",
    content: "我希望默认用中文回答。", created_at: "2026-08-16T08:00:00.000Z",
  });
  instance.db.applyPersonalMemoryCandidates(LEGACY_USER_ID, [{
    kind: "preference", canonicalKey: "communication.language", statement: "默认使用中文回答",
    scope: "user_global", evidenceKind: "direct", sensitivity: "normal", messageIds: [messageId], ttlDays: null,
  }]);

  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const first = await agent.get("/api/personal-memory").expect(200);
  assert.equal(first.body.enabled, true);
  assert.equal(first.body.entries.length, 1);
  assert.equal(first.body.entries[0].evidence[0].conversation_title, "个人知识来源");
  assert.match(first.body.entries[0].evidence[0].source_excerpt, /中文回答/);

  const accepted = await agent.post(`/api/personal-memory/entries/${first.body.entries[0].id}/review`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ action: "accept" }).expect(200);
  assert.equal(accepted.body.entries[0].review_state, "accepted");
  assert.equal(accepted.body.revision, 1);
  assert.match(fs.readFileSync(path.join(personal, "AUTO.md"), "utf8"), /默认使用中文回答/);

  const saved = await agent.put("/api/personal-memory/files/PROFILE.md")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ content: "# 用户画像\n\n人工更新。\n", expectedRevision: 1 }).expect(200);
  assert.equal(saved.body.revision, 2);
  assert.match(fs.readFileSync(path.join(personal, "PROFILE.md"), "utf8"), /人工更新/);
  await agent.put("/api/personal-memory/files/NOW.md")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ content: "# 旧 revision\n", expectedRevision: 1 }).expect(409);
  assert.doesNotMatch(fs.readFileSync(path.join(personal, "NOW.md"), "utf8"), /旧 revision/);
  assert.equal(loadPersonalContextForTurn(ensureTenant(tenantRoot, LEGACY_USER_ID).library, "existing-thread", 1, saved.body.revision)?.revision, 2);
});

test("voice lexicon management API exposes the ranked top one hundred and every candidate only to its owner", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-voice-lexicon-management-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false, voiceLexiconMaxTerms: 500,
  });
  context.after(async () => {
    instance.beginShutdown();
    await instance.waitForBackgroundTasks();
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = instance.db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "语音项目", path.join(root, "voice-project"));
  const insert = instance.db.sqlite.prepare(`
    INSERT INTO voice_lexicon_terms(
      id,user_id,project_id,canonical_key,canonical_text,aliases_json,term_kind,status,
      usage_score,voice_opportunities,weighted_errors,reliable_error_rate,rank_index,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const now = "2026-08-16T14:30:00.000Z";
  for (let index = 0; index < 105; index += 1) {
    insert.run(
      crypto.randomUUID(), LEGACY_USER_ID, project.id, `term-${index}`, `Term ${index}`,
      index === 104 ? '["听错词"]' : "[]", "product_name", "active",
      index / 105, index + 1, index / 10, index / 200, index, now, now,
    );
  }
  for (let index = 0; index < 2; index += 1) {
    insert.run(crypto.randomUUID(), LEGACY_USER_ID, project.id, `candidate-${index}`, `候选词 ${index}`, "[]", "game_name", "candidate", 0.1, 1, 0, 0.04, index, now, now);
  }
  const otherUser = {
    id: crypto.randomUUID(), username: "voice-other", display_name: "Voice Other", password_hash: "",
    role: "member" as const, status: "active" as const, created_at: now, updated_at: now,
  };
  instance.db.createUser(otherUser);
  insert.run(crypto.randomUUID(), otherUser.id, null, "private-term", "其他账号私有词", "[]", "private", "candidate", 1, 1, 1, 1, 100, now, now);

  const agent = request.agent(instance.app);
  await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const response = await agent.get("/api/voice-lexicon").expect(200);
  assert.match(response.headers["cache-control"], /no-store/);
  assert.equal(response.body.maxSelectedTerms, 100);
  assert.equal(response.body.activeCount, 105);
  assert.equal(response.body.selectedTerms.length, 100);
  assert.equal(response.body.selectedTerms[0].canonical_text, "Term 104");
  assert.deepEqual(response.body.selectedTerms[0].aliases, ["听错词"]);
  assert.equal(response.body.selectedTerms.at(-1).canonical_text, "Term 5");
  assert.equal(response.body.candidateCount, 2);
  assert.equal(response.body.candidateTerms.length, 2);
  assert.equal(response.body.candidateTerms.some((term: { canonical_text: string }) => term.canonical_text === "其他账号私有词"), false);
  assert.equal("user_id" in response.body.selectedTerms[0], false);
});

test("context handoff requires a completed marked summary and bounds the new first turn", () => {
  const messages = [
    { id: "u1", role: "user", content: `${CONTEXT_HANDOFF_MARKER}\n生成摘要` },
    { id: "a1", role: "assistant", content: "目标：继续验证。" },
  ] as Parameters<typeof latestContextHandoff>[0];
  const handoff = latestContextHandoff(messages);
  assert.equal(handoff?.summary, "目标：继续验证。");
  assert.match(buildHandoffFirstTurn(handoff!.summary), /<handoff_summary>/);
  assert.equal(latestContextHandoff(messages.slice(0, 1)), null);
});

test("dynamic wait tool stores event credentials only in a protected receipt", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wait-tool-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventToken = "event-secret-must-not-be-returned";
  const planId = crypto.randomUUID();
  const targetConversationId = crypto.randomUUID();
  let submittedBody: Record<string, unknown> | null = null;
  const server = http.createServer((request_, response) => {
    if (request_.url?.endsWith("/wake-plans") && request_.method === "POST") {
      const chunks: Buffer[] = [];
      request_.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request_.on("end", () => {
        submittedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          wakePlan: { id: planId, deadline_at: "2026-08-13T00:00:00.000Z", new_conversation: 1, target_conversation_id: targetConversationId, agent_model: "gpt-5.6-sol", reasoning_effort: "xhigh" },
          targetConversation: { id: targetConversationId, title: "检查外部任务" },
          signal: { url: "https://signal.invalid", token: eventToken },
        }));
      });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }); response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const receiptDirectory = path.join(root, "receipts");
  const result = await callWaitDynamicTool({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "job-token",
    jobId: crypto.randomUUID(),
    receiptDirectory,
  }, { mode: "event_or_deadline", delaySeconds: 60, successPrompt: "继续", failurePrompt: "检查失败", timeoutPrompt: "检查超时", newConversation: true, model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  assert.equal(WAIT_DYNAMIC_TOOL_NAME, "codex_web_schedule_wait");
  assert.match(result, /"scheduled":true/);
  assert.match(result, /"newConversation":true/);
  assert.match(result, new RegExp(targetConversationId));
  assert.match(result, /"检查外部任务"/);
  assert.equal(submittedBody?.newConversation, true);
  assert.equal(submittedBody?.model, "gpt-5.6-sol");
  assert.equal(submittedBody?.reasoningEffort, "xhigh");
  assert.match(result, /"model":"gpt-5\.6-sol"/);
  assert.match(result, /"reasoningEffort":"xhigh"/);
  assert.doesNotMatch(result, new RegExp(eventToken));
  const receiptPath = path.join(receiptDirectory, `${planId}.json`);
  assert.equal(fs.statSync(receiptDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(receiptPath, "utf8"), new RegExp(eventToken));
});

test("host root jobs expose conversation file directories separately from the selected project", () => {
  const hostJobSource = fs.readFileSync(path.join(process.cwd(), "server", "host-root-job.ts"), "utf8");
  assert.match(hostJobSource, /CWW_WORKSPACE_ROOT:\s*message\.request\.workspace/);
  assert.match(hostJobSource, /CWW_UPLOADS_DIR:\s*path\.join\(message\.request\.workspace,\s*"uploads"\)/);
  assert.match(hostJobSource, /CWW_OUTPUTS_DIR:\s*path\.join\(message\.request\.workspace,\s*"outputs"\)/);
  assert.match(hostJobSource, /CWW_JOB_RUNTIME:\s*message\.request\.runtimeRoot/);
});

test("host root bridge connection failures reject one request without escaping through readline", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-missing-host-bridge-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = new HostRootWorkerClient(path.join(root, "missing.sock"));
  await assert.rejects(client.runtimeStatus(HOST_ROOT_USER_ID), /ENOENT|connect/i);
});

test("host root Codex upgrade returns the verified runtime after the managed service finishes", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-upgrade-result-"));
  const socketPath = path.join(root, "bridge.sock");
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(input.slice(0, newline)) as { type: string; requestId: string; userId: string; version: string };
      assert.deepEqual({ type: message.type, userId: message.userId, version: message.version }, {
        type: "codex_upgrade", userId: HOST_ROOT_USER_ID, version: "0.147.0",
      });
      setTimeout(() => socket.end(`${JSON.stringify({
        type: "codex_upgrade_result", requestId: message.requestId, accepted: true,
        installedVersion: "0.147.0", latestVersion: "0.147.0",
        versionCheckedAt: "2026-08-16T00:00:00.000Z", catalogUpdatedAt: "2026-08-16T00:00:01.000Z",
        updateState: "idle", updateError: null,
        agentOptions: { models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", reasoningEfforts: ["high"] }], reasoningEfforts: [{ id: "high", label: "高" }], defaults: { model: "gpt-5.6-sol", reasoningEffort: "high" } },
      })}\n`), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  context.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const runtime = await new HostRootWorkerClient(socketPath).upgradeCodex(HOST_ROOT_USER_ID, "0.147.0");
  assert.equal(runtime.installedVersion, "0.147.0");
  assert.equal(runtime.latestVersion, "0.147.0");
  assert.equal(runtime.updateState, "idle");
});

test("generated project instructions are preserved and ignored by Git", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-project-agents-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = installProjectInstructions(root, DEFAULT_PROJECT_AGENTS_TEMPLATE);
  assert.equal(first.created, true);
  assert.equal(first.ignored, true);
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /Codex Web project rules/);
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^\/AGENTS\.md$/m);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Existing project rules\n", "utf8");
  const second = installProjectInstructions(root, "# Replacement must not win\n");
  assert.equal(second.created, false);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# Existing project rules\n");
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
  assert.equal(cleanupJobRuntime(runtimeRoot).status, "removed");
  assert.equal(fs.existsSync(runtimeRoot), false);
  assert.throws(() => prepareJobRuntime(workspace, "../escape"), /Invalid job id/);
});

test("job runtime cleanup reports failures and derives only exact UUID paths", (context) => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cww-job-runtime-cleanup-test-"));
  context.after(() => fs.rmSync(tenantRoot, { recursive: true, force: true }));
  const target = {
    userId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
  };
  const runtimeRoot = jobRuntimeRoot(tenantRoot, target);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const messages: string[] = [];
  const result = cleanupJobRuntime(runtimeRoot, {
    remove: () => { throw new Error("permission denied"); },
    log: (message) => messages.push(message),
  });
  assert.equal(result.status, "failed");
  assert.equal(fs.existsSync(runtimeRoot), true);
  assert.match(messages.join("\n"), /permission denied/);
  assert.match(messages.join("\n"), new RegExp(target.jobId));
  assert.throws(
    () => jobRuntimeRoot(tenantRoot, { ...target, jobId: "../escape" }),
    /Invalid job runtime identifier/,
  );
  assert.equal(cleanupJobRuntime(runtimeRoot).status, "removed");
});

test("database startup cleanup candidates contain terminal jobs only", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-terminal-runtime-test-"));
  const db = new AppDatabase(root);
  context.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const conversation = db.createConversation(crypto.randomUUID(), "runtime cleanup");
  const statuses = ["queued", "running", "completed", "failed", "cancelled", "interrupted"] as const;
  const jobs = statuses.map((status) => {
    const job = db.createJob(crypto.randomUUID(), conversation.id);
    db.updateJob(job.id, status);
    return { ...job, status };
  });
  const candidates = db.listTerminalJobRuntimes();
  assert.deepEqual(
    new Set(candidates.map((candidate) => candidate.job_id)),
    new Set(jobs.filter((job) => !["queued", "running"].includes(job.status)).map((job) => job.id)),
  );
  assert.ok(candidates.every((candidate) => candidate.conversation_id === conversation.id && candidate.user_id === LEGACY_USER_ID));
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-production-config-test-"));
  const dataRoot = path.join(root, "must-not-be-created");
  assert.throws(() => loadProductionConfig({ ...base, dataRoot, sessionSecret: "short" }), /at least 32/);
  assert.equal(fs.existsSync(dataRoot), false, "configuration validation itself must not create state");
  fs.rmSync(root, { recursive: true, force: true });
});

test("password reset atomically revokes existing user sessions", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-password-reset-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.createSession("old-session", "old-csrf", new Date(Date.now() + 60_000).toISOString(), LEGACY_USER_ID);
  assert.ok(db.getSession("old-session"));
  db.setUserPassword(LEGACY_USER_ID, bcrypt.hashSync("replacement", 4));
  assert.equal(db.getSession("old-session"), undefined);
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
    CREATE TABLE files (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT,
      original_name TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL,
      size INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO conversations(id,title,status,created_at,updated_at) VALUES('legacy','Legacy','idle','now','now');
  `);
  legacy.close();

  const first = new AppDatabase(root);
  assert.equal(first.getConversation("legacy")?.agent_model, null);
  assert.equal(first.getConversation("legacy")?.title_source, "legacy");
  assert.equal(first.getConversation("legacy")?.pinned_at, null);
  assert.equal(first.getConversation("legacy")?.has_unread_result, 0);
  const migratedFileColumns = first.sqlite.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
  assert.equal(migratedFileColumns.some((column) => column.name === "composer_draft_id"), true);
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

test("conversation pinning is durable, user-scoped, and sorts pinned rows first", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-conversation-pin-test-"));
  let reopened: AppDatabase | undefined;
  context.after(() => { reopened?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const first = new AppDatabase(root);
  const olderId = crypto.randomUUID();
  const newerId = crypto.randomUUID();
  first.createConversation(olderId, "older");
  first.createConversation(newerId, "newer");
  assert.ok(first.setConversationPinnedForUser(olderId, LEGACY_USER_ID, true)?.pinned_at);
  assert.equal(first.listConversations(LEGACY_USER_ID)[0].id, olderId);
  assert.equal(first.setConversationPinnedForUser(olderId, "another-user", false), undefined);
  first.close();

  reopened = new AppDatabase(root);
  assert.ok(reopened.getConversation(olderId)?.pinned_at);
  assert.equal(reopened.listConversations(LEGACY_USER_ID)[0].id, olderId);
  assert.equal(reopened.setConversationPinnedForUser(olderId, LEGACY_USER_ID, false)?.pinned_at, null);
});

test("a new prompt refreshes task order while starting the run does not pin or reorder again", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-conversation-run-order-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const earlier = db.createConversation(crypto.randomUUID(), "earlier");
  const starting = db.createConversation(crypto.randomUUID(), "starting");
  const newer = db.createConversation(crypto.randomUUID(), "newer");
  assert.equal(starting.pinned_at, null);

  db.setConversationPinnedForUser(earlier.id, LEGACY_USER_ID, true);
  db.addMessage({
    id: crypto.randomUUID(), conversation_id: starting.id, role: "user", content: "start",
    created_at: new Date().toISOString(),
  });
  const promptOrder = db.getConversation(starting.id)?.sidebar_order;
  db.updateConversation(starting.id, { status: "running" });

  assert.equal(db.getConversation(starting.id)?.pinned_at, null);
  assert.equal(db.getConversation(starting.id)?.sidebar_order, promptOrder);
  assert.deepEqual(db.listConversations(LEGACY_USER_ID).slice(0, 3).map((item) => item.id), [earlier.id, starting.id, newer.id]);
  db.updateConversation(starting.id, { status: "idle" });
  assert.equal(db.getConversation(starting.id)?.pinned_at, null);
});

test("client activity sorting follows persistent and manual sidebar events", () => {
  const base = { project_id: "project", title: "task", updated_at: "2026-08-16T00:00:00.000Z" } as Conversation;
  const rows = [
    { ...base, id: "older", pinned_at: null, sidebar_order: 4 },
    { ...base, id: "newer", pinned_at: null, sidebar_order: 8 },
    { ...base, id: "pinned-low", pinned_at: "2026-08-14T00:00:00.000Z", sidebar_order: 3 },
    { ...base, id: "pinned-high", pinned_at: "2026-08-13T00:00:00.000Z", sidebar_order: 9 },
  ] as Conversation[];
  assert.deepEqual(sortConversationsByActivity(rows).map((row) => row.id), ["pinned-high", "pinned-low", "newer", "older"]);
});

test("conversation archiving hides without deleting and can be restored", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-conversation-archive-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = db.createConversation(crypto.randomUUID(), "保留历史");
  assert.ok(db.archiveConversationForUser(conversation.id, LEGACY_USER_ID)?.archived_at);
  assert.equal(db.listConversations(LEGACY_USER_ID).some((item) => item.id === conversation.id), false);
  assert.equal(db.listConversationPage(LEGACY_USER_ID).total, 0);
  assert.equal(db.listArchivedConversationPage(LEGACY_USER_ID).conversations[0].id, conversation.id);
  assert.equal(db.getConversationForUser(conversation.id, LEGACY_USER_ID)?.title, "保留历史");
  assert.equal(db.restoreConversationForUser(conversation.id, "another-user"), undefined);
  assert.equal(db.restoreConversationForUser(conversation.id, LEGACY_USER_ID)?.archived_at, null);
  assert.equal(db.listConversationPage(LEGACY_USER_ID).conversations[0].id, conversation.id);
});

test("rollout size lookup reads the current Codex session without loading its contents", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-rollout-size-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = crypto.randomUUID();
  const sessionDirectory = path.join(root, "sessions", "2026", "07", "23");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(sessionDirectory, `rollout-2026-07-23T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(rollout, "rollout", "utf8");
  fs.truncateSync(rollout, ROLLOUT_WARNING_BYTES + 123);
  assert.equal(codexThreadRolloutBytes(root, threadId), ROLLOUT_WARNING_BYTES + 123);
  assert.equal(codexThreadRolloutBytes(root, crypto.randomUUID()), null);
});

test("completed results stay unread across restarts and can only be acknowledged by their owner", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-conversation-unread-test-"));
  let reopened: AppDatabase | undefined;
  context.after(() => { reopened?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const first = new AppDatabase(root);
  const completedId = crypto.randomUUID();
  const failedId = crypto.randomUUID();
  first.createConversation(completedId, "completed");
  first.createConversation(failedId, "failed");
  const completedJobId = crypto.randomUUID();
  const failedJobId = crypto.randomUUID();
  first.createJob(completedJobId, completedId);
  first.createJob(failedJobId, failedId);
  first.finishJob(completedJobId, completedId, "completed", null, "first unread result");
  first.finishJob(failedJobId, failedId, "failed", "boom");
  const firstUnreadMessageId = first.listMessages(completedId).at(-1)!.id;
  assert.equal(first.getConversation(completedId)?.has_unread_result, 1);
  assert.equal(first.getConversation(completedId)?.unread_anchor_message_id, firstUnreadMessageId);
  const laterJobId = crypto.randomUUID();
  first.createJob(laterJobId, completedId);
  first.finishJob(laterJobId, completedId, "completed", null, "later unread result");
  assert.equal(first.getConversation(completedId)?.unread_anchor_message_id, firstUnreadMessageId);
  assert.equal(first.getConversation(failedId)?.has_unread_result, 0);
  assert.equal(first.markConversationResultSeenForUser(completedId, "another-user"), undefined);
  assert.equal(first.getConversation(completedId)?.has_unread_result, 1);
  first.close();

  reopened = new AppDatabase(root);
  assert.equal(reopened.getConversation(completedId)?.has_unread_result, 1);
  assert.equal(reopened.getConversation(completedId)?.unread_anchor_message_id, firstUnreadMessageId);
  assert.equal(reopened.markConversationResultSeenForUser(completedId, LEGACY_USER_ID)?.has_unread_result, 0);
  assert.equal(reopened.getConversation(completedId)?.has_unread_result, 0);
  assert.equal(reopened.getConversation(completedId)?.unread_anchor_message_id, null);
});

test("projects assign legacy tasks and conversation pages load in blocks of twenty", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-project-page-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const defaultProject = db.ensureDefaultProject(crypto.randomUUID(), LEGACY_USER_ID, "个人知识库", path.join(root, "library"));
  const secondProject = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "第二项目", path.join(root, "second"));
  const remoteProject = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "远端项目", path.join(root, "second"), "remote:worker-a");
  for (let index = 0; index < 45; index += 1) {
    db.createConversation(crypto.randomUUID(), `分页任务 ${String(index).padStart(2, "0")}`, undefined, LEGACY_USER_ID, secondProject.id);
  }
  const first = db.listConversationPage(LEGACY_USER_ID, { projectId: secondProject.id, limit: 20 });
  const second = db.listConversationPage(LEGACY_USER_ID, { projectId: secondProject.id, limit: 20, offset: 20 });
  const last = db.listConversationPage(LEGACY_USER_ID, { projectId: secondProject.id, limit: 20, offset: 40 });
  assert.equal(defaultProject.is_default, 1);
  assert.equal(secondProject.executor_id, "local-host");
  assert.equal(remoteProject.executor_id, "remote:worker-a");
  assert.equal(db.getProjectByRootForUser(path.join(root, "second"), LEGACY_USER_ID, "remote:worker-a")?.id, remoteProject.id);
  assert.equal(first.conversations.length, 20);
  assert.equal(first.total, 45);
  assert.equal(first.nextOffset, 20);
  assert.equal(second.conversations.length, 20);
  assert.equal(last.conversations.length, 5);
  assert.equal(last.hasMore, false);
  assert.equal(new Set([...first.conversations, ...second.conversations, ...last.conversations].map((row) => row.id)).size, 45);
  assert.equal(db.listConversationPage(LEGACY_USER_ID, { projectId: secondProject.id, query: "任务 04" }).total, 1);
});

test("conversation search returns title matches first and pages unique body matches progressively", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-conversation-body-search-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = db.ensureDefaultProject(crypto.randomUUID(), LEGACY_USER_ID, "搜索项目", path.join(root, "search"));
  const titleMatch = db.createConversation(crypto.randomUUID(), "火星标题", undefined, LEGACY_USER_ID, project.id);
  const bodyMatchOne = db.createConversation(crypto.randomUUID(), "第一段正文", undefined, LEGACY_USER_ID, project.id);
  const bodyMatchTwo = db.createConversation(crypto.randomUUID(), "第二段正文", undefined, LEGACY_USER_ID, project.id);
  const noMatch = db.createConversation(crypto.randomUUID(), "普通任务", undefined, LEGACY_USER_ID, project.id);
  const now = new Date().toISOString();
  db.addMessage({ id: crypto.randomUUID(), conversation_id: titleMatch.id, role: "user", content: "火星也出现在标题命中的正文里", created_at: now });
  db.addMessage({ id: crypto.randomUUID(), conversation_id: bodyMatchOne.id, role: "assistant", content: "正文包含火星探索计划", created_at: now });
  db.addMessage({ id: crypto.randomUUID(), conversation_id: bodyMatchTwo.id, role: "user", content: "另一条火星正文", created_at: now });
  db.addMessage({ id: crypto.randomUUID(), conversation_id: noMatch.id, role: "user", content: "百分号 % 需要按字面匹配", created_at: now });

  assert.deepEqual(db.listConversationPage(LEGACY_USER_ID, { projectId: project.id, query: "火星" }).conversations.map((row) => row.id), [titleMatch.id]);
  const firstBody = db.listConversationBodySearchPage(LEGACY_USER_ID, { projectId: project.id, query: "火星", limit: 1 });
  assert.equal(firstBody.conversations.length, 1);
  assert.equal(firstBody.hasMore, true);
  const secondBody = db.listConversationBodySearchPage(LEGACY_USER_ID, { projectId: project.id, query: "火星", limit: 1, offset: firstBody.nextOffset! });
  assert.equal(secondBody.conversations.length, 1);
  assert.equal(secondBody.hasMore, false);
  assert.deepEqual(new Set([...firstBody.conversations, ...secondBody.conversations].map((row) => row.id)), new Set([bodyMatchOne.id, bodyMatchTwo.id]));
  assert.equal(db.listConversationBodySearchPage(LEGACY_USER_ID, { projectId: project.id, query: "%" }).conversations[0]?.id, noMatch.id);
});

test("selected conversations keep their sidebar position while search matches merge without duplicates", () => {
  const conversations = ["selected", "title", "body"].map((id) => ({ id, project_id: "project", title: id })) as Conversation[];
  assert.deepEqual(mergeConversationMatches([conversations[1]], [conversations[1], conversations[2]]).map((row) => row.id), ["title", "body"]);
  const retained = retainSelectedConversation({
    conversations: [conversations[1], conversations[0], conversations[2]], total: 12, hasMore: true, nextOffset: 5,
  }, conversations[0], "project");
  assert.deepEqual(retained.conversations.map((row) => row.id), ["title", "selected", "body"]);
  assert.equal(retained.nextOffset, 5);
  const paginatedAway = retainSelectedConversation({
    conversations: [conversations[1], conversations[2]], total: 12, hasMore: true, nextOffset: 5,
  }, conversations[0], "project");
  assert.deepEqual(paginatedAway.conversations.map((row) => row.id), ["title", "body", "selected"]);
  assert.deepEqual(retainSelectedConversation(retained, conversations[0], "another-project").conversations.map((row) => row.id), ["title", "selected", "body"]);
  const withoutSelected = removeConversationFromPage(retained, "selected");
  assert.deepEqual(withoutSelected.conversations.map((row) => row.id), ["title", "body"]);
  assert.equal(withoutSelected.total, 11);
  assert.equal(removeConversationFromPage(withoutSelected, "selected"), withoutSelected);

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const selectionFlow = appSource.match(/function selectProjectConversation[\s\S]*?function selectConversation[\s\S]*?\n  }/)?.[0] ?? "";
  assert.match(selectionFlow, /retainSelectedConversation\(page, conversation, projectId\)/);
  assert.match(selectionFlow, /selectedIdRef\.current = conversationId/);
  assert.doesNotMatch(selectionFlow, /setQuery\(|selectProject\(projectId\)/);
  assert.doesNotMatch(selectionFlow, /\[conversation,[\s\S]*?filter/);
  const syncFlow = appSource.match(/const syncConversation = useCallback\([\s\S]*?\n  }, \[\]\);/)?.[0] ?? "";
  assert.doesNotMatch(syncFlow, /selected\s*\?[\s\S]*?\[conversation,/);
  assert.match(appSource, /conversationBodyMatches\(\{ query, limit: 1, offset \}\)/);
  assert.match(appSource, /正在搜索正文/);
});

test("project archiving hides without deleting and restoring the same folder preserves tasks", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-project-archive-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "旧名称", path.join(root, "work"), "remote:worker-a");
  const conversation = db.createConversation(crypto.randomUUID(), "历史任务", undefined, LEGACY_USER_ID, project.id);

  const archived = db.archiveProjectForUser(project.id, LEGACY_USER_ID);
  assert.ok(archived?.archived_at);
  assert.equal(db.listProjects(LEGACY_USER_ID).some((candidate) => candidate.id === project.id), false);
  assert.equal(db.getActiveProjectForUser(project.id, LEGACY_USER_ID), undefined);
  assert.equal(db.getProjectByRootForUser(project.root_path, LEGACY_USER_ID, project.executor_id)?.id, project.id);
  assert.equal(db.renameProjectForUser(project.id, LEGACY_USER_ID, "归档期间不可改名"), undefined);
  assert.equal(db.getConversation(conversation.id)?.project_id, project.id);

  const restored = db.restoreProjectForUser(project.id, LEGACY_USER_ID, "新名称");
  assert.equal(restored?.id, project.id);
  assert.equal(restored?.name, "新名称");
  assert.equal(restored?.archived_at, null);
  assert.equal(db.listConversationPage(LEGACY_USER_ID, { projectId: project.id }).conversations[0].id, conversation.id);
});

test("app-server model list becomes an executor-specific model and reasoning catalog", () => {
  const options = agentOptionsFromAppServer({ data: [
    {
      id: "display-id", model: "gpt-target-a", displayName: "Target A", description: "from target",
      hidden: false, isDefault: false, defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    },
    {
      id: "display-default", model: "gpt-target-b", displayName: "Target B", hidden: false, isDefault: true,
      defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "xhigh" }],
    },
    { id: "hidden", model: "hidden", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  ] });
  assert.deepEqual(options?.models.map((model) => model.id), ["gpt-target-a", "gpt-target-b"]);
  assert.deepEqual(options?.defaults, { model: "gpt-target-b", reasoningEffort: "medium" });
  assert.deepEqual(options?.reasoningEfforts.map((effort) => effort.id), ["low", "medium", "high", "xhigh"]);
});

test("executor runtime catalogs and update state persist across database restarts", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-executor-runtime-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new AppDatabase(root);
  const options = agentOptionsFromAppServer({ data: [{
    id: "gpt-runtime", model: "gpt-runtime", displayName: "Runtime", hidden: false, isDefault: true,
    defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  }] })!;
  db.upsertExecutorRuntime("remote:test", {
    installedVersion: "1.2.3", latestVersion: "1.2.4", versionCheckedAt: "2026-07-22T00:00:00.000Z",
    catalogUpdatedAt: "2026-07-22T00:00:01.000Z", updateState: "failed", updateError: "network", agentOptions: options,
  });
  db.close();
  const reopened = new AppDatabase(root);
  assert.deepEqual(reopened.getExecutorRuntime("remote:test"), {
    installedVersion: "1.2.3", latestVersion: "1.2.4", versionCheckedAt: "2026-07-22T00:00:00.000Z",
    catalogUpdatedAt: "2026-07-22T00:00:01.000Z", updateState: "failed", updateError: "network", agentOptions: options,
  });
  reopened.close();
});

test("queued jobs keep their own executor-specific model and reasoning selections at dispatch", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-executor-selection-dispatch-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
  });
  context.after(async () => {
    instance.beginShutdown();
    await instance.waitForBackgroundTasks();
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });
  const executorId = "remote:selection-worker";
  const executorOptions = agentOptionsFromAppServer({ data: [
    {
      model: "gpt-remote-a", displayName: "Remote A", hidden: false, isDefault: true,
      defaultReasoningEffort: "max", supportedReasoningEfforts: [{ reasoningEffort: "max" }],
    },
    {
      model: "gpt-remote-b", displayName: "Remote B", hidden: false,
      defaultReasoningEffort: "ultra", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
    },
  ] })!;
  instance.db.upsertExecutorRuntime(executorId, { agentOptions: executorOptions });
  const project = instance.db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "remote", "E:\\work", executorId);
  const firstSelection = { model: "gpt-remote-a", reasoningEffort: "max" };
  const secondSelection = { model: "gpt-remote-b", reasoningEffort: "ultra" };
  const conversation = instance.db.createConversation(crypto.randomUUID(), "remote selections", firstSelection, HOST_ROOT_USER_ID, project.id);
  const firstMessageId = crypto.randomUUID();
  instance.db.addMessage({
    id: firstMessageId, conversation_id: conversation.id, role: "user", content: "first",
    created_at: now,
  });
  const firstJob = instance.db.createJob(crypto.randomUUID(), conversation.id, firstMessageId, firstSelection);
  instance.db.createPendingPrompt(crypto.randomUUID(), conversation.id, "second", secondSelection);

  const dispatched: Array<{ prompt: string; selection: { model: string; reasoningEffort: string } }> = [];
  instance.runner.canDispatchConversation = () => true;
  instance.runner.run = async (jobId, conversationId, prompt, _uploads, selection) => {
    dispatched.push({ prompt, selection });
    instance.db.finishJob(jobId, conversationId, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 30 && dispatched.length < 2; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(dispatched, [
    { prompt: "first", selection: firstSelection },
    { prompt: "second", selection: secondSelection },
  ]);
  const completedFirstJob = instance.db.getJob(firstJob.id)!;
  assert.equal(completedFirstJob.agent_model, firstSelection.model);
  assert.equal(completedFirstJob.reasoning_effort, firstSelection.reasoningEffort);
  assert.equal(completedFirstJob.status, "completed");
  const secondJob = instance.db.getLatestJobForConversation(conversation.id)!;
  assert.notEqual(secondJob.id, firstJob.id);
  assert.equal(secondJob.agent_model, secondSelection.model);
  assert.equal(secondJob.reasoning_effort, secondSelection.reasoningEffort);
  assert.equal(secondJob.status, "completed");
});

test("remote Codex refresh imports App threads idempotently and pauses queued work while the App turn is active", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-thread-sync-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "E:\\workspace\\work", "remote:worker-a");
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" };
  const existing = db.createConversation(crypto.randomUUID(), "Codex task", selection, LEGACY_USER_ID, project.id);
  db.updateConversation(existing.id, { codexThreadId: "thread-demo" });
  db.addMessage({ id: crypto.randomUUID(), conversation_id: existing.id, role: "user", content: "first", created_at: "2026-07-22T10:00:00.000Z" });
  db.addMessage({ id: crypto.randomUUID(), conversation_id: existing.id, role: "assistant", content: "first reply", created_at: "2026-07-22T10:00:01.000Z" });

  const ppSnapshot = {
    id: "thread-demo", name: "Codex task renamed in Codex", nameSource: "explicit" as const,
    createdAt: 1784714400, updatedAt: 1784714460, status: "idle" as const,
    messages: [
      { turnId: "turn-1", itemId: "user-1", role: "user" as const, content: "first", createdAt: "2026-07-22T10:00:00.000Z" },
      { turnId: "turn-1", itemId: "agent-1", role: "assistant" as const, content: "first reply", createdAt: "2026-07-22T10:00:01.000Z" },
      { turnId: "turn-2", itemId: "user-2", role: "user" as const, content: "continued in App", createdAt: "2026-07-22T10:00:30.000Z" },
      { turnId: "turn-2", itemId: "agent-2", role: "assistant" as const, content: "App reply", createdAt: "2026-07-22T10:01:00.000Z" },
    ],
  };
  const firstImport = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, ppSnapshot, selection);
  assert.equal(firstImport.created, false);
  assert.equal(firstImport.importedMessages, 2);
  assert.equal(db.listMessages(existing.id).length, 4);
  assert.equal(db.getConversation(existing.id)?.title, "Codex task renamed in Codex");
  assert.equal(db.getConversation(existing.id)?.title_source, "manual");
  const repeated = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, ppSnapshot, selection);
  assert.equal(repeated.importedMessages, 0);
  assert.equal(repeated.changed, false);
  assert.equal(db.listMessages(existing.id).length, 4);

  const appSnapshot = {
    id: "thread-app", name: "Run test", nameSource: "preview" as const,
    createdAt: 1784714500, updatedAt: 1784714510, status: "running" as const,
    messages: [
      { turnId: "turn-app", itemId: "user-app", role: "user" as const, content: "test", createdAt: "2026-07-22T10:01:40.000Z" },
      { turnId: "turn-app", itemId: "agent-app", role: "assistant" as const, content: "working", createdAt: "2026-07-22T10:01:50.000Z" },
    ],
    activities: [
      {
        turnId: "turn-app", itemId: "plan-app", kind: "update" as const, label: "正在运行测试",
        detail: "已完成编译，开始执行测试。", createdAt: "2026-07-22T10:01:45.000Z",
      },
      {
        turnId: "turn-app", itemId: "agent-start", kind: "agent" as const, label: "协作 Agent 状态更新",
        agents: [{ id: "agent-a", path: "/root/ui_audit", status: "running" as const }], createdAt: "2026-07-22T10:01:46.000Z",
      },
      {
        turnId: "turn-app", itemId: "agent-done", kind: "agent" as const, label: "协作 Agent 状态更新",
        agents: [{ id: "agent-a", status: "completed" as const, summary: "UI audit complete" }], createdAt: "2026-07-22T10:01:47.000Z",
      },
    ],
  };
  const importedApp = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, appSnapshot, selection);
  assert.equal(importedApp.created, true);
  assert.equal(importedApp.conversation.sync_origin, "codex_app");
  assert.equal(importedApp.conversation.external_status, "running");
  assert.equal(importedApp.conversation.title_source, "default");
  assert.equal(importedApp.importedMessages, 2);
  assert.equal(importedApp.importedActivities, 3);
  const importedAgentActivities = db.listRemoteThreadActivities(importedApp.conversation.id).filter((activity) => activity.kind === "agent");
  assert.deepEqual(importedAgentActivities.map((activity) => activity.agents), [
    [{ id: "agent-a", path: "/root/ui_audit", status: "running" }],
    [{ id: "agent-a", status: "completed", summary: "UI audit complete" }],
  ]);
  assert.equal(importedApp.conversation.has_unread_result, 0);
  assert.deepEqual(db.listRemoteThreadActivities(importedApp.conversation.id).filter((activity) => activity.kind === "update"), [{
    seq: 1, type: "progress", kind: "update", label: "正在运行测试",
    detail: "已完成编译，开始执行测试。", created_at: "2026-07-22T10:01:45.000Z",
  }]);
  const repeatedApp = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, appSnapshot, selection);
  assert.equal(repeatedApp.importedActivities, 0);
  assert.equal(repeatedApp.changed, false);
  const queued = db.createJob(crypto.randomUUID(), importedApp.conversation.id);
  assert.equal(db.listRunnableQueuedJobs().some((job) => job.id === queued.id), false);
  const newerConversation = db.createConversation(crypto.randomUUID(), "newer task", selection, LEGACY_USER_ID, project.id);
  const runningSidebarOrder = db.getConversation(importedApp.conversation.id)!.sidebar_order;
  const progressOnly = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...appSnapshot,
    updatedAt: appSnapshot.updatedAt + 5,
  }, selection);
  assert.equal(progressOnly.conversation.external_status, "running");
  assert.equal(progressOnly.conversation.has_unread_result, 0);
  assert.equal(progressOnly.conversation.sidebar_order, runningSidebarOrder);
  assert.equal(db.listConversationPage(LEGACY_USER_ID, { projectId: project.id }).conversations[0].id, newerConversation.id);

  const completedApp = {
    ...appSnapshot,
    updatedAt: appSnapshot.updatedAt + 10,
    status: "idle" as const,
    activities: [
      ...appSnapshot.activities,
      {
        turnId: "turn-app", itemId: "file-app", kind: "file" as const, label: "修改了 2 个文件",
        files: ["src/App.tsx", "server/app.ts"], createdAt: "2026-07-22T10:02:00.000Z",
      },
    ],
  };
  const completedImport = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, completedApp, selection);
  assert.equal(completedImport.importedActivities, 1);
  assert.deepEqual(db.listRemoteThreadActivities(importedApp.conversation.id).map((activity) => activity.label), [
    "正在运行测试", "协作 Agent 状态更新", "协作 Agent 状态更新", "修改了 2 个文件",
  ]);
  assert.equal(db.getConversation(importedApp.conversation.id)?.external_status, "idle");
  assert.equal(db.getConversation(importedApp.conversation.id)?.has_unread_result, 1);
  assert.equal(db.listConversationPage(LEGACY_USER_ID, { projectId: project.id }).conversations[0].id, importedApp.conversation.id);
  assert.equal(db.listRunnableQueuedJobs().some((job) => job.id === queued.id), true);

  assert.equal(db.setAiConversationTitleIfDefault(importedApp.conversation.id, "运行项目测试"), true);
  const previewAfterAi = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...completedApp, name: "test", updatedAt: completedApp.updatedAt + 10,
  }, selection);
  assert.equal(previewAfterAi.conversation.title, "运行项目测试");
  assert.equal(previewAfterAi.conversation.title_source, "ai");
  const matchingExplicit = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...completedApp, name: "运行项目测试", nameSource: "explicit", updatedAt: completedApp.updatedAt + 20,
  }, selection);
  assert.equal(matchingExplicit.conversation.title_source, "ai");
  const renamedExplicit = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...completedApp, name: "桌面自定义标题", nameSource: "explicit", updatedAt: completedApp.updatedAt + 30,
  }, selection);
  assert.equal(renamedExplicit.conversation.title, "桌面自定义标题");
  assert.equal(renamedExplicit.conversation.title_source, "manual");
});

test("remote desktop assistant candidates converge to one bubble while prior candidates become turn activities", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-turn-presentation-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "E:\\workspace\\work", "remote:worker-a");
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" };
  const base = {
    id: "thread-presentation", name: "录屏入库", nameSource: "explicit" as const,
    createdAt: 1_785_000_000, updatedAt: 1_785_000_010, status: "idle" as const,
  };
  const first = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...base,
    messages: [
      { turnId: "turn-presentation", itemId: "user-presentation", role: "user", content: "入库录屏", createdAt: "2026-07-30T13:39:47.000Z" },
      { turnId: "turn-presentation", itemId: "agent-stage-a", role: "assistant", content: "正在确认候选片段。", createdAt: "2026-07-30T13:39:47.001Z" },
    ],
    activities: [],
  }, selection);
  assert.deepEqual(db.listMessages(first.conversation.id).map((message) => message.content), ["入库录屏", "正在确认候选片段。"]);

  db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...base,
    updatedAt: base.updatedAt + 10,
    messages: [
      { turnId: "turn-presentation", itemId: "agent-stage-b", role: "assistant", content: "正在执行完整解码。", createdAt: "2026-07-30T13:41:00.003Z" },
    ],
    activities: [{
      turnId: "turn-presentation", itemId: "agent-stage-a", kind: "update", label: "阶段反馈",
      detail: "正在确认候选片段。", createdAt: "2026-07-30T13:39:47.001Z",
    }],
  }, selection);
  assert.deepEqual(db.listMessages(first.conversation.id).map((message) => message.content), ["入库录屏", "正在执行完整解码。"]);
  assert.deepEqual(db.listRemoteThreadActivities(first.conversation.id).map((activity) => activity.detail), ["正在确认候选片段。"]);

  db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...base,
    updatedAt: base.updatedAt + 20,
    messages: [
      { turnId: "turn-presentation", itemId: "agent-final", role: "assistant", content: "录屏已完成入库。", createdAt: "2026-07-30T13:50:06.000Z" },
    ],
    activities: [{
      turnId: "turn-presentation", itemId: "agent-stage-b", kind: "update", label: "阶段反馈",
      detail: "正在执行完整解码。", createdAt: "2026-07-30T13:41:00.003Z",
    }],
  }, selection);
  assert.deepEqual(db.listMessages(first.conversation.id).map((message) => message.content), ["入库录屏", "录屏已完成入库。"]);
  assert.deepEqual(db.listRemoteThreadActivities(first.conversation.id).map((activity) => activity.detail), [
    "正在确认候选片段。", "正在执行完整解码。",
  ]);

  db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...base,
    updatedAt: base.updatedAt + 30,
    status: "running",
    messages: [{
      turnId: "turn-next", itemId: "user-next", role: "user", content: "继续处理下一段", createdAt: "2026-07-30T14:00:00.000Z",
    }],
    activities: [{
      turnId: "turn-next", itemId: "plan-next", kind: "update", label: "任务计划已更新",
      detail: "正在读取下一段录屏。", createdAt: "2026-07-30T14:00:01.000Z",
    }],
  }, selection);
  const latestTurnId = db.getLatestRemoteTurnId(first.conversation.id);
  assert.equal(latestTurnId, "turn-next");
  assert.deepEqual(db.listRemoteThreadActivities(first.conversation.id, 50, latestTurnId).map((activity) => activity.detail), [
    "正在读取下一段录屏。",
  ]);
});

test("a live remote commentary snapshot withdraws a premature reply and its unread marker before the final answer", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-live-commentary-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "E:\\workspace\\work", "remote:worker-a");
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" };
  const base = {
    id: "thread-live-commentary", name: "后台分析", nameSource: "explicit" as const,
    createdAt: 1_786_000_000, updatedAt: 1_786_000_010,
  };
  const premature = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...base,
    status: "idle" as const,
    messages: [
      { turnId: "turn-live", itemId: "user-live", role: "user" as const, content: "分析录屏", createdAt: "2026-08-08T05:15:09.000Z" },
      { turnId: "turn-live", itemId: "agent-commentary", role: "assistant" as const, content: "低优先级解码仍在运行。", createdAt: "2026-08-08T05:15:09.001Z" },
    ],
    activities: [],
  }, selection);
  assert.equal(premature.conversation.has_unread_result, 1);
  assert.deepEqual(db.listMessages(premature.conversation.id).map((message) => message.content), ["分析录屏", "低优先级解码仍在运行。"]);

  const live = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...base,
    updatedAt: base.updatedAt + 10,
    status: "running" as const,
    messages: [],
    activities: [{
      turnId: "turn-live", itemId: "agent-commentary", kind: "update" as const, label: "阶段反馈",
      detail: "低优先级解码仍在运行。", createdAt: "2026-08-08T05:15:09.001Z",
    }],
  }, selection);
  assert.equal(live.conversation.external_status, "running");
  assert.equal(live.conversation.has_unread_result, 0);
  assert.deepEqual(db.listMessages(premature.conversation.id).map((message) => message.content), ["分析录屏"]);
  assert.deepEqual(db.listRemoteThreadActivities(premature.conversation.id).map((activity) => activity.detail), ["低优先级解码仍在运行。"]);

  const completed = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...base,
    updatedAt: base.updatedAt + 20,
    status: "idle" as const,
    messages: [{
      turnId: "turn-live", itemId: "agent-final", role: "assistant" as const,
      content: "录屏分析完成。", createdAt: "2026-08-08T05:30:00.000Z",
    }],
    activities: [],
  }, selection);
  assert.equal(completed.conversation.external_status, "idle");
  assert.equal(completed.conversation.has_unread_result, 1);
  assert.deepEqual(db.listMessages(premature.conversation.id).map((message) => message.content), ["分析录屏", "录屏分析完成。"]);
});

test("database startup converges historical desktop commentary and moves its files to the final reply", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-turn-startup-repair-test-"));
  let db: AppDatabase | undefined = new AppDatabase(root);
  context.after(() => {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "E:\\workspace\\work", "remote:worker-a");
  const conversation = db.createConversation(crypto.randomUUID(), "录屏入库", undefined, LEGACY_USER_ID, project.id);
  db.updateConversation(conversation.id, { codexThreadId: "thread-startup-repair" });
  const userMessageId = crypto.randomUUID();
  const stageMessageId = crypto.randomUUID();
  const finalMessageId = crypto.randomUUID();
  db.addMessage({ id: userMessageId, conversation_id: conversation.id, role: "user", content: "入库录屏", created_at: "2026-07-30T13:39:47.000Z" });
  db.addMessage({ id: stageMessageId, conversation_id: conversation.id, role: "assistant", content: "正在完整解码。", created_at: "2026-07-30T13:39:47.001Z" });
  db.addMessage({ id: finalMessageId, conversation_id: conversation.id, role: "assistant", content: "录屏已完成入库。", created_at: "2026-07-30T13:50:06.000Z" });
  db.addFile({
    id: "stage-file", conversation_id: conversation.id, message_id: stageMessageId,
    original_name: "结果.txt", relative_path: "outputs/result.txt", mime_type: "text/plain",
    size: 12, kind: "output", created_at: "2026-07-30T13:49:00.000Z",
  });
  for (const [role, itemId, messageId, createdAt] of [
    ["user", "user-startup", userMessageId, "2026-07-30T13:39:47.000Z"],
    ["assistant", "agent-stage", stageMessageId, "2026-07-30T13:39:47.001Z"],
    ["assistant", "agent-final", finalMessageId, "2026-07-30T13:50:06.000Z"],
  ] as const) {
    db.sqlite.prepare(`
      INSERT INTO remote_thread_items(executor_id,thread_id,turn_id,item_id,conversation_id,message_id,role,created_at)
      VALUES('remote:worker-a','thread-startup-repair','turn-startup-repair',?,?,?,?,?)
    `).run(itemId, conversation.id, messageId, role, createdAt);
  }
  db.sqlite.prepare(`
    INSERT INTO remote_thread_events(executor_id,thread_id,turn_id,item_id,conversation_id,payload,created_at)
    VALUES('remote:worker-a','thread-startup-repair','turn-startup-repair','agent-stage',?,?,?)
  `).run(
    conversation.id,
    JSON.stringify({ kind: "update", label: "阶段反馈", detail: "正在完整解码。" }),
    "2026-07-30T13:39:47.001Z",
  );
  db.close();
  db = new AppDatabase(root);

  assert.deepEqual(db.listMessages(conversation.id).map((message) => message.content), ["入库录屏", "录屏已完成入库。"]);
  assert.equal(db.getFile("stage-file")?.message_id, finalMessageId);
  assert.deepEqual(db.listRemoteThreadActivities(conversation.id).map((activity) => activity.detail), ["正在完整解码。"]);
});

test("remote activity observation does not replay Codex Web controlled turns as chat messages", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-codex-web-turn-filter-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "E:\\workspace\\work", "remote:worker-a");
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" };
  const conversation = db.createConversation(crypto.randomUUID(), "连接测试", selection, LEGACY_USER_ID, project.id);
  db.updateConversation(conversation.id, { codexThreadId: "thread-controlled" });
  db.sqlite.prepare("UPDATE conversations SET sync_origin='codex_app' WHERE id=?").run(conversation.id);
  const userMessageId = crypto.randomUUID();
  db.addMessage({
    id: userMessageId, conversation_id: conversation.id, role: "user",
    content: "测试一下连接情况", quote_excerpt: "推荐的新结构\nDay64 → ready_unmerged",
    created_at: "2026-07-24T09:10:57.000Z",
  });
  const job = db.createJob(crypto.randomUUID(), conversation.id, userMessageId, selection);
  db.updateJob(job.id, "running");

  const controlledSnapshot = {
    id: "thread-controlled", name: "连接测试", createdAt: 1_785_000_000, updatedAt: 1_785_000_010, status: "running" as const,
    messages: [
      {
        turnId: "turn-controlled", itemId: "user-controlled", role: "user" as const,
        content: `本轮附件：\n- 连接截图.png: C:\\Users\\owner\\AppData\\Local\\CodexWebWorker\\runs\\job-controlled\\uploads\\连接截图.png\n\n处理图片时先形成简短、可复用的文字摘要；后续优先引用摘要与原文件路径，只有细节不足时再调用 \`view_image\` 重读原图。\n\n${buildAskAgentDraft("测试一下连接情况", "推荐的新结构\nDay64 → ready_unmerged")}\n\n<codex_web_wait_automation>\n仅供 Worker 使用的等待说明\n</codex_web_wait_automation>`,
        createdAt: "2026-07-24T09:10:57.000Z",
      },
      {
        turnId: "turn-controlled", itemId: "agent-progress", role: "assistant" as const,
        content: "我先检查连接约定。", createdAt: "2026-07-24T09:11:08.000Z",
      },
      {
        turnId: "turn-controlled", itemId: "agent-final", role: "assistant" as const,
        content: "连接正常。", createdAt: "2026-07-24T09:11:41.000Z",
      },
    ],
    activities: [{
      turnId: "turn-controlled", itemId: "command-controlled", kind: "command" as const,
      label: "本机处理步骤完成", detail: "ssh owner-root hostname", createdAt: "2026-07-24T09:11:33.000Z",
    }],
  };
  const runningImport = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, controlledSnapshot, selection);
  assert.equal(runningImport.importedMessages, 0);
  assert.equal(runningImport.importedActivities, 0);
  assert.equal(runningImport.changed, false);
  assert.equal(db.getConversation(conversation.id)?.sync_origin, "codex_app");
  assert.equal(db.getConversation(conversation.id)?.external_status, "idle");
  assert.deepEqual(db.listMessages(conversation.id).map((message) => message.content), ["测试一下连接情况"]);
  assert.deepEqual(db.listRemoteThreadActivities(conversation.id), []);

  db.addMessage({
    id: crypto.randomUUID(), conversation_id: conversation.id, role: "assistant",
    content: "连接正常。", created_at: "2026-07-24T09:11:41.100Z",
  });
  db.finishJob(job.id, conversation.id, "completed");
  const completedImport = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...controlledSnapshot, updatedAt: controlledSnapshot.updatedAt + 10, status: "idle",
  }, selection);
  assert.equal(completedImport.importedMessages, 0);
  assert.equal(completedImport.importedActivities, 0);
  assert.deepEqual(db.listMessages(conversation.id).map((message) => message.content), ["测试一下连接情况", "连接正常。"]);
  assert.deepEqual(db.listRemoteThreadActivities(conversation.id), []);

  const desktopContinuation = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...controlledSnapshot,
    updatedAt: controlledSnapshot.updatedAt + 20,
    status: "idle",
    messages: [
      ...controlledSnapshot.messages,
      {
        turnId: "turn-desktop", itemId: "user-desktop", role: "user",
        content: "再检查一次", createdAt: "2026-07-24T09:12:00.000Z",
      },
      {
        turnId: "turn-desktop", itemId: "agent-desktop", role: "assistant",
        content: "第二次也正常。", createdAt: "2026-07-24T09:12:05.000Z",
      },
    ],
    activities: [
      ...controlledSnapshot.activities,
      {
        turnId: "turn-desktop", itemId: "command-desktop", kind: "command",
        label: "桌面检查完成", createdAt: "2026-07-24T09:12:04.000Z",
      },
    ],
  }, selection);
  assert.equal(desktopContinuation.importedMessages, 2);
  assert.equal(desktopContinuation.importedActivities, 1);
  assert.deepEqual(db.listMessages(conversation.id).map((message) => message.content), [
    "测试一下连接情况", "连接正常。", "再检查一次", "第二次也正常。",
  ]);
  assert.deepEqual(db.listRemoteThreadActivities(conversation.id).map((activity) => activity.label), ["桌面检查完成"]);
});

test("thread_started atomically claims an observer placeholder for a controlled Remote job", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-thread-claim-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "E:\\workspace\\work", "remote:worker-a");
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" };
  const conversation = db.createConversation(crypto.randomUUID(), "新任务", selection, LEGACY_USER_ID, project.id);
  const messageId = crypto.randomUUID();
  const itemTime = new Date().toISOString();
  db.addMessage({
    id: messageId, conversation_id: conversation.id, role: "user", content: "读取验收附件", created_at: itemTime,
  });
  const job = db.createJob(crypto.randomUUID(), conversation.id, messageId, selection);
  db.updateJob(job.id, "running");
  const snapshot = {
    id: "thread-observer-race", name: "读取验收附件", nameSource: "preview" as const,
    createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, status: "running" as const,
    messages: [
      { turnId: "turn-race", itemId: "user-race", role: "user" as const, content: "读取验收附件", createdAt: itemTime },
      { turnId: "turn-race", itemId: "assistant-race", role: "assistant" as const, content: "阶段回复不应成为气泡", createdAt: itemTime },
    ],
    activities: [{
      turnId: "turn-race", itemId: "command-race", kind: "command" as const,
      label: "只读附件", createdAt: itemTime,
    }],
  };
  const observed = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, snapshot, selection);
  assert.notEqual(observed.conversation.id, conversation.id);
  assert.equal(observed.created, true);

  const claimed = db.claimCodexThreadForConversation(conversation.id, snapshot.id);
  assert.deepEqual(claimed?.mergedConversationIds, [observed.conversation.id]);
  assert.equal(db.getConversation(observed.conversation.id), undefined);
  assert.equal(db.getConversationByCodexThread(project.id, snapshot.id)?.id, conversation.id);
  assert.equal(db.getConversation(conversation.id)?.codex_thread_id, snapshot.id);
  assert.deepEqual(db.listMessages(conversation.id).map((message) => message.content), ["读取验收附件"]);
  assert.deepEqual(db.listRemoteThreadActivities(conversation.id), []);
  const mapping = db.sqlite.prepare(`
    SELECT message_id FROM remote_thread_items
    WHERE executor_id=? AND thread_id=? AND turn_id='turn-race' AND item_id='user-race'
  `).get(project.executor_id, snapshot.id) as { message_id: string };
  assert.equal(mapping.message_id, messageId);
  assert.throws(() => db.sqlite.prepare(`
    INSERT INTO conversations(id,user_id,project_id,title,codex_thread_id,status,created_at,updated_at)
    VALUES(?,?,?,?,?,'idle',?,?)
  `).run(crypto.randomUUID(), LEGACY_USER_ID, project.id, "duplicate", snapshot.id, itemTime, itemTime), /UNIQUE constraint/);

  const finalTime = new Date(Date.parse(itemTime) + 1_000).toISOString();
  db.addMessage({
    id: crypto.randomUUID(), conversation_id: conversation.id, role: "assistant", content: "最终回复", created_at: finalTime,
  });
  db.finishJob(job.id, conversation.id, "completed");
  const completed = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, {
    ...snapshot, status: "idle", updatedAt: snapshot.updatedAt + 1,
    messages: [...snapshot.messages, {
      turnId: "turn-race", itemId: "assistant-final", role: "assistant" as const, content: "最终回复", createdAt: finalTime,
    }],
  }, selection);
  assert.equal(completed.importedMessages, 0);
  assert.deepEqual(db.listMessages(conversation.id).map((message) => message.content), ["读取验收附件", "最终回复"]);
});

test("database startup removes previously replayed Codex Web commentary and keeps the canonical final report", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-codex-web-turn-repair-test-"));
  let db: AppDatabase | undefined = new AppDatabase(root);
  context.after(() => {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "E:\\workspace\\work", "remote:worker-a");
  const conversation = db.createConversation(crypto.randomUUID(), "连接测试", undefined, LEGACY_USER_ID, project.id);
  db.updateConversation(conversation.id, { codexThreadId: "thread-repair" });
  const userMessageId = crypto.randomUUID();
  const remoteUserMessageId = crypto.randomUUID();
  const progressMessageId = crypto.randomUUID();
  const remoteFinalMessageId = crypto.randomUUID();
  const canonicalFinalMessageId = crypto.randomUUID();
  db.addMessage({
    id: userMessageId, conversation_id: conversation.id, role: "user",
    content: "测试一下连接情况", quote_excerpt: "推荐的新结构\nDay64 → ready_unmerged",
    created_at: "2026-07-24T09:10:57.000Z",
  });
  db.addMessage({
    id: remoteUserMessageId, conversation_id: conversation.id, role: "user",
    content: `本轮附件：\n- 连接截图.png: C:\\Users\\owner\\AppData\\Local\\CodexWebWorker\\runs\\job-repair\\uploads\\连接截图.png\n\n处理图片时先形成简短、可复用的文字摘要；后续优先引用摘要与原文件路径，只有细节不足时再调用 \`view_image\` 重读原图。\n\n${buildAskAgentDraft("测试一下连接情况", "推荐的新结构\nDay64 → ready_unmerged")}\n\n<codex_web_wait_automation>\n仅供 Worker 使用的等待说明\n</codex_web_wait_automation>`,
    created_at: "2026-07-24T09:10:59.000Z",
  });
  db.addMessage({
    id: progressMessageId, conversation_id: conversation.id, role: "assistant",
    content: "我先检查连接约定。", created_at: "2026-07-24T09:11:08.000Z",
  });
  db.addMessage({
    id: remoteFinalMessageId, conversation_id: conversation.id, role: "assistant",
    content: "连接正常。", created_at: "2026-07-24T09:11:08.001Z",
  });
  db.addMessage({
    id: canonicalFinalMessageId, conversation_id: conversation.id, role: "assistant",
    content: "连接正常。", created_at: "2026-07-24T09:11:41.000Z",
  });
  const job = db.createJob(crypto.randomUUID(), conversation.id, userMessageId);
  db.updateJob(job.id, "completed");
  db.sqlite.prepare("UPDATE conversations SET sync_origin='codex_app' WHERE id=?").run(conversation.id);
  db.sqlite.prepare("UPDATE jobs SET created_at=?,updated_at=? WHERE id=?")
    .run("2026-07-24T09:10:57.000Z", "2026-07-24T09:11:41.000Z", job.id);
  const mappings = [
    ["user", "user-repair", remoteUserMessageId],
    ["assistant", "agent-progress-repair", progressMessageId],
    ["assistant", "agent-final-repair", remoteFinalMessageId],
  ] as const;
  for (const [role, itemId, messageId] of mappings) {
    db.sqlite.prepare(`
      INSERT INTO remote_thread_items(executor_id,thread_id,turn_id,item_id,conversation_id,message_id,role,created_at)
      VALUES('remote:worker-a','thread-repair','turn-repair',?,?,?,?,?)
    `).run(itemId, conversation.id, messageId, role, "2026-07-24T09:11:08.000Z");
  }
  db.sqlite.prepare(`
    INSERT INTO remote_thread_events(executor_id,thread_id,turn_id,item_id,conversation_id,payload,created_at)
    VALUES('remote:worker-a','thread-repair','turn-repair','command-repair',?,?,?)
  `).run(
    conversation.id,
    JSON.stringify({ kind: "command", label: "本机处理步骤完成", detail: "ssh owner-root hostname" }),
    "2026-07-24T09:11:33.000Z",
  );
  db.close();
  db = new AppDatabase(root);

  assert.deepEqual(db.listMessages(conversation.id).map((message) => message.content), ["测试一下连接情况", "连接正常。"]);
  assert.equal(db.listMessages(conversation.id).at(-1)?.id, canonicalFinalMessageId);
  assert.deepEqual(db.listRemoteThreadActivities(conversation.id), []);
});

test("remote refresh and startup repair response-annotation wrappers without a Worker update", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-annotation-test-"));
  let db: AppDatabase | undefined = new AppDatabase(root);
  let reopened: AppDatabase | undefined;
  context.after(() => {
    db?.close();
    reopened?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "E:\\workspace\\work", "remote:worker-a");
  const wrapped = [
    "# Response annotations:",
    "Each item contains text selected from an earlier Codex response and may include a user comment. Use every selection as context and address every comment in your response.",
    "<response-annotations>",
    JSON.stringify([{ text: "原方案内容" }]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "按这个方案执行",
  ].join("\n");
  const snapshot = {
    id: "thread-annotation", name: "Annotation", createdAt: 1784714500, updatedAt: 1784714510, status: "idle" as const,
    messages: [{ turnId: "turn-annotation", itemId: "user-annotation", role: "user" as const, content: wrapped, createdAt: "2026-07-22T10:01:40.000Z" }],
  };

  const imported = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, snapshot, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  const conversationId = imported.conversation.id;
  const message = db.listMessages(conversationId)[0];
  assert.equal(message.content, "按这个方案执行");
  assert.equal(message.quote_excerpt, "原方案内容");

  db.sqlite.prepare("UPDATE messages SET content=?,quote_excerpt=NULL WHERE id=?").run(wrapped, message.id);
  const refreshed = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, snapshot, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  assert.equal(refreshed.importedMessages, 0);
  assert.equal(refreshed.changed, true);
  assert.equal(db.getMessage(message.id)?.content, "按这个方案执行");
  assert.equal(db.getMessage(message.id)?.quote_excerpt, "原方案内容");

  db.sqlite.prepare("UPDATE messages SET content=?,quote_excerpt=NULL WHERE id=?").run(wrapped, message.id);
  db.close();
  db = undefined;
  reopened = new AppDatabase(root);
  assert.equal(reopened.getMessage(message.id)?.content, "按这个方案执行");
  assert.equal(reopened.getMessage(message.id)?.quote_excerpt, "原方案内容");
});

test("remote project refresh restores newest-first task order across an existing import", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-thread-order-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "E:\\workspace\\work", "remote:worker-a");
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" };
  const snapshots = [
    { id: "newest", name: "Newest", createdAt: 300, updatedAt: 330, status: "idle" as const, messages: [] },
    { id: "middle", name: "Middle", createdAt: 200, updatedAt: 220, status: "idle" as const, messages: [] },
    { id: "oldest", name: "Oldest", createdAt: 100, updatedAt: 110, status: "idle" as const, messages: [] },
  ];
  for (const snapshot of snapshots) db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, snapshot, selection);

  assert.deepEqual(db.listConversationPage(LEGACY_USER_ID, { projectId: project.id }).conversations.map((row) => row.title), ["Oldest", "Middle", "Newest"]);
  assert.equal(db.applyRemoteThreadOrderForUser(LEGACY_USER_ID, project.id, [snapshots[2], snapshots[0], snapshots[1]]), 3);
  assert.deepEqual(db.listConversationPage(LEGACY_USER_ID, { projectId: project.id }).conversations.map((row) => row.title), ["Newest", "Middle", "Oldest"]);
});

test("sidebar ordering persists manual moves and later activity returns a task to the top", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-sidebar-order-test-"));
  let reopened: AppDatabase | undefined;
  context.after(() => { reopened?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const db = new AppDatabase(root);
  const firstProject = db.ensureDefaultProject(crypto.randomUUID(), LEGACY_USER_ID, "第一项目", path.join(root, "first"));
  const secondProject = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "第二项目", path.join(root, "second"));
  const thirdProject = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "第三项目", path.join(root, "third"));
  const first = db.createConversation(crypto.randomUUID(), "first", undefined, LEGACY_USER_ID, firstProject.id);
  const second = db.createConversation(crypto.randomUUID(), "second", undefined, LEGACY_USER_ID, firstProject.id);
  const third = db.createConversation(crypto.randomUUID(), "third", undefined, LEGACY_USER_ID, firstProject.id);
  const otherProjectTask = db.createConversation(crypto.randomUUID(), "other", undefined, LEGACY_USER_ID, secondProject.id);

  assert.deepEqual(db.listProjects(LEGACY_USER_ID).map((project) => project.id), [firstProject.id, secondProject.id, thirdProject.id]);
  assert.equal(db.reorderProjectsForUser(LEGACY_USER_ID, [thirdProject.id, firstProject.id, secondProject.id]), true);
  assert.equal(db.reorderProjectsForUser(LEGACY_USER_ID, [firstProject.id]), false);
  assert.deepEqual(db.listProjects(LEGACY_USER_ID).map((project) => project.id), [thirdProject.id, firstProject.id, secondProject.id]);

  assert.deepEqual(db.listConversationPage(LEGACY_USER_ID, { projectId: firstProject.id }).conversations.map((row) => row.id), [third.id, second.id, first.id]);
  assert.equal(db.moveConversationForUser(LEGACY_USER_ID, first.id, third.id, "before"), true);
  assert.equal(db.moveConversationForUser(LEGACY_USER_ID, first.id, otherProjectTask.id, "before"), false);
  assert.deepEqual(db.listConversationPage(LEGACY_USER_ID, { projectId: firstProject.id }).conversations.map((row) => row.id), [first.id, third.id, second.id]);
  db.createPendingPrompt(crypto.randomUUID(), second.id, "second prompt", { model: "gpt-5.6-sol", reasoningEffort: "high" });
  assert.deepEqual(db.listConversationPage(LEGACY_USER_ID, { projectId: firstProject.id }).conversations.map((row) => row.id), [second.id, first.id, third.id]);
  db.createPendingPrompt(crypto.randomUUID(), first.id, "first prompt", { model: "gpt-5.6-sol", reasoningEffort: "high" });
  assert.deepEqual(db.listConversationPage(LEGACY_USER_ID, { projectId: firstProject.id }).conversations.map((row) => row.id), [first.id, second.id, third.id]);
  assert.ok(db.setConversationPinnedForUser(third.id, LEGACY_USER_ID, true));
  assert.equal(db.moveConversationForUser(LEGACY_USER_ID, first.id, third.id, "before"), false);
  db.close();

  reopened = new AppDatabase(root);
  assert.deepEqual(reopened.listProjects(LEGACY_USER_ID).map((project) => project.id), [thirdProject.id, firstProject.id, secondProject.id]);
  assert.deepEqual(reopened.listConversationPage(LEGACY_USER_ID, { projectId: firstProject.id }).conversations.map((row) => row.id), [third.id, first.id, second.id]);
});

test("local project moves preserve conversation data and reject unsafe destinations or active work", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-conversation-project-move-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.createUser({
    id: HOST_ROOT_USER_ID,
    username: "owner-move",
    display_name: "CODEX_WEB Move",
    password_hash: "",
    role: "owner",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  const sourceProject = db.ensureDefaultProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "source", path.join(root, "source"));
  const targetProject = db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "target", path.join(root, "target"));
  const remoteProject = db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "remote", "E:\\remote", "remote:worker-a");
  const otherUserProject = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "other", path.join(root, "other"));
  const existingTarget = db.createConversation(crypto.randomUUID(), "existing target", undefined, HOST_ROOT_USER_ID, targetProject.id);
  const movable = db.createConversation(crypto.randomUUID(), "movable", undefined, HOST_ROOT_USER_ID, sourceProject.id);
  const messageId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  db.updateConversation(movable.id, { codexThreadId: "thread-preserved" });
  db.setConversationPinnedForUser(movable.id, HOST_ROOT_USER_ID, true);
  db.addMessage({ id: messageId, conversation_id: movable.id, role: "user", content: "preserved message", created_at: now });
  db.addFile({
    id: fileId,
    conversation_id: movable.id,
    message_id: messageId,
    original_name: "preserved.txt",
    relative_path: "uploads/preserved.txt",
    mime_type: "text/plain",
    size: 9,
    kind: "upload",
    created_at: now,
  });
  db.saveComposerDraft(movable.id, "preserved draft", "preserved quote");

  const moved = db.moveConversationToProjectForUser(HOST_ROOT_USER_ID, movable.id, targetProject.id, "local-host");
  assert.equal(moved.status, "moved");
  if (moved.status !== "moved") assert.fail("conversation should move");
  assert.equal(moved.fromProjectId, sourceProject.id);
  assert.equal(moved.toProjectId, targetProject.id);
  assert.equal(moved.conversation.project_id, targetProject.id);
  assert.equal(moved.conversation.codex_thread_id, "thread-preserved");
  assert.ok(moved.conversation.pinned_at);
  assert.equal(db.listMessages(movable.id)[0].content, "preserved message");
  assert.equal(db.listFiles(movable.id)[0].id, fileId);
  assert.equal(db.getComposerDraft(movable.id)?.content, "preserved draft");
  assert.deepEqual(
    db.listConversationPage(HOST_ROOT_USER_ID, { projectId: targetProject.id }).conversations.map((conversation) => conversation.id),
    [movable.id, existingTarget.id],
  );
  const unchanged = db.moveConversationToProjectForUser(HOST_ROOT_USER_ID, movable.id, targetProject.id, "local-host");
  assert.equal(unchanged.status, "unchanged");

  assert.equal(
    db.moveConversationToProjectForUser(HOST_ROOT_USER_ID, movable.id, remoteProject.id, "local-host").status,
    "unsupported_executor",
  );
  assert.equal(
    db.moveConversationToProjectForUser(HOST_ROOT_USER_ID, movable.id, otherUserProject.id, "local-host").status,
    "project_unavailable",
  );

  const queued = db.createConversation(crypto.randomUUID(), "queued", undefined, HOST_ROOT_USER_ID, sourceProject.id);
  db.createJob(crypto.randomUUID(), queued.id);
  assert.equal(
    db.moveConversationToProjectForUser(HOST_ROOT_USER_ID, queued.id, targetProject.id, "local-host").status,
    "busy",
  );
  assert.equal(db.getConversation(queued.id)?.project_id, sourceProject.id);

  const pending = db.createConversation(crypto.randomUUID(), "pending", undefined, HOST_ROOT_USER_ID, sourceProject.id);
  const pendingPrompt = db.createPendingPrompt(
    crypto.randomUUID(),
    pending.id,
    "pending prompt",
    { model: "gpt-5.6-sol", reasoningEffort: "high" },
  );
  db.beginEditingPendingPrompt(pendingPrompt.id);
  assert.equal(
    db.moveConversationToProjectForUser(HOST_ROOT_USER_ID, pending.id, targetProject.id, "local-host").status,
    "busy",
  );

  const running = db.createConversation(crypto.randomUUID(), "running", undefined, HOST_ROOT_USER_ID, sourceProject.id);
  db.updateConversation(running.id, { status: "running" });
  assert.equal(
    db.moveConversationToProjectForUser(HOST_ROOT_USER_ID, running.id, targetProject.id, "local-host").status,
    "busy",
  );
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
    projectRoot: process.cwd(), dataRoot, tenantRoot,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
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
  await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
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
  assert.equal(filePreviewUrl({ id: "file id" }), "/files/file%20id/preview");
  assert.equal(publicFilePreviewUrl({ id: "file id" }), "/files/file%20id/preview/public");
  assert.equal(filePreviewIdFromPath("/files/file%20id/preview"), "file id");
  assert.equal(filePreviewIdFromPath("/files/file%20id/preview/"), "file id");
  assert.equal(filePreviewIdFromPath("/files/file%20id/preview/public"), null);
  assert.equal(publicFilePreviewIdFromPath("/files/file%20id/preview/public"), "file id");
  assert.equal(publicFilePreviewIdFromPath("/files/file%20id/preview/public/"), "file id");
  assert.equal(filePreviewIdFromPath("/files/file%2/preview"), null);
  assert.equal(filePreviewIdFromPath("/not-a-preview"), null);
});

test("reader position is persisted per file and rebased when the viewport changes", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as unknown as Storage;
  writeReaderPosition(storage, "file-a", { scrollTop: 420, scrollHeight: 2_000, clientHeight: 500, updatedAt: 1 });
  assert.deepEqual(readReaderPosition(storage, "file-a"), { scrollTop: 420, scrollHeight: 2_000, clientHeight: 500, updatedAt: 1 });
  assert.equal(readReaderPosition(storage, "file-b"), null);
  assert.ok(Math.abs(restoreReaderScrollTop({ scrollTop: 420, scrollHeight: 2_000, clientHeight: 500, updatedAt: 1 }, 4_000, 1_000) - 840) < 0.001);
});

test("public share image manifests resolve only safe same-delivery images and rewrite the document", () => {
  const parent = { id: "report", original_name: "report.html", mime_type: "text/html", kind: "output", message_id: "message" } as FileRow;
  const chart = { id: "chart", original_name: "chart.png", source_path: null, mime_type: "image/png", kind: "output", message_id: "message" } as FileRow;
  const assets = resolvePublicShareAssets("html", '<img src="./chart.png"><picture><source srcset="chart.png 1x, chart.png 2x"></picture><img src="data:image/png;base64,AA==">', [parent, chart]);
  assert.deepEqual(assets, [{ sourceRef: "chart.png", assetFileId: "chart" }]);
  const rewritten = rewritePublicShareDocument("html", '<img src="./chart.png"><source srcset="chart.png 1x, chart.png 2x">', assets, (id) => `/public-assets/${id}`);
  assert.match(rewritten, /src="\/public-assets\/chart"/);
  assert.match(rewritten, /srcset="\/public-assets\/chart 1x, \/public-assets\/chart 2x"/);
  const markdown = rewritePublicShareDocument("markdown", "![趋势](chart.png)", assets, (id) => `/public-assets/${id}`);
  assert.equal(markdown, "![趋势](/public-assets/chart)");
  assert.throws(() => resolvePublicShareAssets("html", '<img src="https://tracker.example/pixel.png">', [parent, chart]), PublicShareAssetError);
  assert.throws(() => resolvePublicShareAssets("html", '<img src="../secret.png">', [parent, chart]), PublicShareAssetError);
});

test("fixed public file sharing is private by default, owner-controlled, image-aware, and audited only in SQLite", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-public-file-share-"));
  const dataRoot = path.join(root, "data");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
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

  await request(instance.app).head(`/api/files/${parentId}/preview/public`).expect(404);
  await request(instance.app).get(`/api/files/${parentId}/preview/public`).expect(404);
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const privatePreview = await owner.get(`/api/files/${parentId}/preview`).expect(200);
  assert.deepEqual(privatePreview.body.share, { enabled: false, publicUrl: `https://agent.example.test/files/${parentId}/preview/public` });
  await owner.post(`/api/files/${parentId}/share`).expect(403);
  const enabled = await owner.post(`/api/files/${parentId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.deepEqual(enabled.body.share, { enabled: true, publicUrl: `https://agent.example.test/files/${parentId}/preview/public` });
  assert.equal(instance.db.listPublicFileShareAssets(instance.db.getPublicFileShare(parentId)!.id)[0]?.asset_file_id, imageId);
  const listed = await owner.get("/api/public-shares").expect(200);
  assert.equal(listed.body.shares.length, 1);
  assert.deepEqual(listed.body.shares[0], {
    id: instance.db.getPublicFileShare(parentId)!.id,
    fileId: parentId,
    fileName: "report.html",
    documentKind: "html",
    mimeType: "text/html",
    size: Buffer.byteLength(html),
    conversationId: conversation.id,
    conversationTitle: "public report",
    enabledAt: listed.body.shares[0].enabledAt,
    publicUrl: `https://agent.example.test/files/${parentId}/preview/public`,
  });

  const first = await request(instance.app).get(`/api/files/${parentId}/preview/public`)
    .set("X-Codex-View-ID", "view-public-0001").set("X-Forwarded-For", "203.0.113.8").expect(200);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.headers["x-robots-tag"], "noindex, nofollow, noarchive");
  assert.equal(first.body.file.conversation_id, undefined);
  assert.match(first.body.content, new RegExp(`/api/files/${parentId}/preview/public/assets/${imageId}`));
  await request(instance.app).get(`/api/files/${parentId}/preview/public/assets/${imageId}`).expect(200).expect("Content-Type", /image\/png/);
  await request(instance.app).get(`/api/files/${parentId}/preview/public`)
    .set("X-Codex-View-ID", "view-public-0001").set("X-Forwarded-For", "203.0.113.8").expect(200);
  await request(instance.app).get(`/api/files/${parentId}/preview/public`)
    .set("X-Codex-View-ID", "view-public-0002").set("X-Forwarded-For", "203.0.113.8").expect(200);
  const access = instance.db.sqlite.prepare("SELECT ip_address,access_count FROM public_share_access_rollups").get() as { ip_address: string; access_count: number };
  assert.equal(access.ip_address, "203.0.113.8");
  assert.equal(access.access_count, 2);
  assert.equal((instance.db.sqlite.prepare("SELECT count(*) AS count FROM public_share_access_events").get() as { count: number }).count, 2);

  const memberId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.createUser({ id: memberId, username: "member", display_name: "Member", password_hash: bcrypt.hashSync("fixture", 8), role: "member", status: "active", created_at: now, updated_at: now });
  const member = request.agent(instance.app);
  const memberLogin = await member.post("/api/auth/login").send({ username: "member", password: "fixture" }).expect(200);
  assert.equal((await member.get("/api/public-shares").expect(200)).body.shares.length, 0);
  await member.delete(`/api/files/${parentId}/share`).set("X-CSRF-Token", memberLogin.body.csrfToken).expect(404);

  const disabled = await owner.delete(`/api/files/${parentId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(disabled.body.share.enabled, false);
  assert.equal(disabled.body.share.publicUrl, enabled.body.share.publicUrl);
  assert.equal((await owner.get("/api/public-shares").expect(200)).body.shares.length, 0);
  assert.equal(instance.db.listPublicFileShareAssets(instance.db.getPublicFileShare(parentId)!.id).length, 0);
  await request(instance.app).get(`/api/files/${parentId}/preview/public`).expect(404);
  await request(instance.app).get(`/api/files/${parentId}/preview/public/assets/${imageId}`).expect(404);
  const reopened = await owner.post(`/api/files/${parentId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(reopened.body.share.publicUrl, enabled.body.share.publicUrl);
  assert.equal(instance.db.listPublicFileShareAssets(instance.db.getPublicFileShare(parentId)!.id)[0]?.asset_file_id, imageId);
  await request(instance.app).get(`/api/files/${parentId}/preview/public/assets/${imageId}`).expect(200);
});

test("image file cards use a compact thumbnail without a duplicate file icon", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /const icon = image \? null : <FileIcon size=\{20\} \/>/);
  assert.match(appSource, /image && <img className="file-card-image" src=\{fileThumbnailUrl\(file\)\}/);
  assert.equal(fileThumbnailUrl({ id: "image-id" } as WorkFile), "/api/files/image-id/thumbnail");
  assert.match(styles, /\.file-card-image \{ width: 56px; height: 32px;/);
});

test("previewable file cards use one eye action while rich document readers stay isolated", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const mathSource = fs.readFileSync(path.join(process.cwd(), "src", "markdown-math.ts"), "utf8");
  const readerAskSource = fs.readFileSync(path.join(process.cwd(), "src", "reader-ask.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /const previewHref = reader \? filePreviewUrl\(file\) : previewable \? fileUrl\(file\) : ""/);
  assert.match(appSource, /previewHref && <a className="preview-button"[\s\S]*<Eye size=\{16\}/);
  assert.match(appSource, /reader === "markdown" \|\| previewable[\s\S]*href=\{fileUrl\(file\)\}/);
  assert.match(styles, /\.preview-button,[\s\S]*\.download-button\s*\{[^}]*border-left:/);
  assert.match(appSource, /<ReactMarkdown[\s\S]*skipHtml[\s\S]*>\{math\.content\}<\/ReactMarkdown>/);
  assert.match(mathSource, /import\("remark-math"\)/);
  assert.match(mathSource, /import\("rehype-katex"\)/);
  assert.match(mathSource, /import\("katex\/dist\/katex\.min\.css"\)/);
  assert.match(appSource, /rehypePlugins=\{math\.plugins/);
  assert.match(appSource, /className="file-reader-html file-preview-scroll"/);
  assert.match(appSource, /dangerouslySetInnerHTML=\{\{ __html: content \}\}/);
  assert.match(appSource, /onActiveAnchorChange/);
  assert.doesNotMatch(appSource, /closeOutsideOutline|onCloseOutline/);
  assert.match(appSource, /getBoundingClientRect\(\)/);
  assert.match(appSource, /function readerNativeSelectionActive\(container: HTMLElement\)/);
  assert.match(appSource, /Leave the document[\s\S]*while WebKit owns a native selection/);
  assert.match(appSource, /function ReaderSelectionLayer\([\s\S]*useReaderSelection\(rootRef\)[\s\S]*<ReaderSelectionAction/);
  assert.match(appSource, /<ReaderSelectionLayer rootRef=\{readerBodyRef\} onAsk=\{openReaderAsk\} \/>/);
  assert.doesNotMatch(appSource, /const readerSelection = useReaderSelection\(readerBodyRef\)/);
  assert.match(appSource, /const FileReaderLayout = memo\(function FileReaderLayout/);
  assert.match(appSource, /const visibleHeadings = headings\.filter\(\(heading\) => heading\.getClientRects\(\)\.length > 0\)/);
  assert.match(appSource, /if \(!scrollRoot\.current \|\| prepared\.outline\.length < 2\) return/);
  assert.doesNotMatch(appSource, /function HtmlFileReader[\s\S]*root\.addEventListener\("scroll", updateCurrentHeading/);
  assert.match(appSource, /if \(!saved\)[\s\S]*container\.scrollTop = 0/);
  assert.match(appSource, /window\.requestAnimationFrame\(syncActiveHeading\)/);
  assert.match(appSource, /navigationToken === 0/);
  assert.match(appSource, /Scroll-driven active-anchor changes must not trigger another smooth scroll/);
  assert.match(appSource, /window\.cancelAnimationFrame\(frame\)/);
  assert.match(appSource, /prepared\.outline\[0\]\?\.id/);
  assert.doesNotMatch(appSource, /sandbox=/);
  assert.doesNotMatch(appSource, /new Blob\(\[content\]/);
  assert.doesNotMatch(appSource, /HTML 隔离预览|Markdown 阅读/);
  assert.match(appSource, /<div className="file-preview-header-start">[\s\S]*file-preview-title"><strong>/);
  assert.doesNotMatch(appSource, /className="file-preview-title"><FileText/);
  assert.match(appSource, /复制链接/);
  assert.match(appSource, /关闭分享/);
  assert.match(appSource, /function ReaderSettingsMenu/);
  assert.match(appSource, /<details ref=\{menu\} className="file-reader-settings-menu">/);
  assert.match(appSource, /<summary className="file-reader-settings-button"/);
  assert.match(appSource, /menu\.current\.open = false/);
  assert.match(appSource, /file && <ReaderSettingsMenu file=\{file\} share=\{share\}/);
  assert.match(appSource, /浅色/);
  assert.match(appSource, /深色/);
  assert.match(appSource, /跟随系统|系统/);
  assert.match(appSource, /return open \? createPortal\(<div className="file-share-backdrop"/);
  assert.match(appSource, /role="dialog" aria-modal="true" aria-labelledby="file-share-dialog-title"/);
  assert.match(appSource, /event\.target === event\.currentTarget\) closeDialog\(\)/);
  assert.match(appSource, /aria-label="关闭分享设置" onClick=\{closeDialog\}/);
  assert.doesNotMatch(appSource, /访问记录/);
  assert.doesNotMatch(readerAskSource, /nativeSelection\.removeAllRanges|nativeSelection\.addRange/);
  assert.match(readerAskSource, /window\.addEventListener\("pointerup", handleSelectionEnd, \{ passive: true \}\)/);
  assert.doesNotMatch(readerAskSource, /window\.addEventListener\("pointercancel"/);
  assert.doesNotMatch(readerAskSource, /window\.addEventListener\("touchcancel"/);
  assert.doesNotMatch(readerAskSource, /window\.addEventListener\("blur"/);
  assert.doesNotMatch(readerAskSource, /addEventListener\("touchstart"/);
  assert.doesNotMatch(readerAskSource, /addEventListener\("pointerdown"/);
  assert.match(readerAskSource, /createPortal\(action, document\.body\)/);
  assert.match(styles, /\.file-preview-header\s*\{[^}]*min-height:\s*48px[^}]*z-index:\s*12/);
  assert.match(styles, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /--file-preview-header-gap:\s*8px/);
  assert.match(styles, /\.file-preview-header-start\s*\{[^}]*gap:\s*var\(--file-preview-header-gap\)/);
  assert.match(styles, /\.file-preview-actions\s*\{[^}]*gap:\s*var\(--file-preview-header-gap\)/);
  assert.doesNotMatch(styles, /\.file-preview-title\s*>\s*svg/);
  assert.match(styles, /\.file-share-backdrop\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*100;[^}]*place-items:\s*center;/);
  assert.match(styles, /\.file-reader-settings-popover\s*\{/);
  assert.match(styles, /\.file-reader-settings-menu\s*> summary/);
  assert.match(styles, /\.file-reader-settings-menu\[open\]\s*> summary/);
  assert.match(styles, /\.file-reader-html \{[^}]*display: block;[^}]*overflow-y:\s*auto;[^}]*padding:\s*0;/);
  assert.match(styles, /\.file-reader-outline a\s*\{[^}]*padding:\s*6px 8px;[^}]*line-height:\s*1\.4;/);
  assert.match(styles, /\.file-reader-outline a\[aria-current="location"\]\s*\{[^}]*background:/);
  assert.match(styles, /\.file-reader-outline a:focus-visible\s*\{[^}]*outline:/);
  assert.doesNotMatch(styles, /\.file-share-panel\s*\{[^}]*position:\s*absolute/);
  assert.match(styles, /\.file-share-actions button\.danger\s*\{[^}]*background:\s*#9b303a/);
  assert.match(appSource, /window\.setInterval\(\(\) => void verifySession\(\), 60_000\)/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.file-reader-markdown\s*\{[\s\S]*font-size:\s*15px/);
  assert.match(styles, /\.file-reader-table\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(styles, /\.file-reader-markdown \.katex-display\s*\{[^}]*overflow-x:\s*auto/);
  const outlineSource = fs.readFileSync(path.join(process.cwd(), "src", "file-reader-outline.ts"), "utf8");
  assert.match(outlineSource, /scopeReaderStyles\(style\.textContent/);
  assert.match(outlineSource, /script, noscript, form, iframe, object, embed, base, link, meta, title/);
  assert.match(outlineSource, /codex-web-reader-content/);
  assert.match(outlineSource, /codex-web-reader-shell/);
  assert.match(outlineSource, /codex-web-reader-body/);
  assert.match(outlineSource, /@media \(max-width:852px\)/);
  assert.match(outlineSource, /padding-top:24px !important/);
});

test("HTML reader scopes author styles before stitching the report into Codex Web", () => {
  const scoped = scopeReaderStyles(`
    /* legacy report reset */
    :root { --paper: white; }
    html, body { margin: 0; }
    * { box-sizing: border-box; }
    main, button:hover { color: red; }
    @import url("https://example.com/leaky.css");
    @media (max-width: 760px) { body { font-size: 15px; } main { width: 100%; } }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    .animated { animation: fade 1s ease; }
  `);
  assert.doesNotMatch(scoped, /@import/);
  assert.match(scoped, new RegExp(`${HTML_READER_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} main`));
  assert.match(scoped, /@media \(max-width: 760px\)/);
  assert.match(scoped, /@keyframes codex-web-reader-kf-\d+-fade/);
  assert.match(scoped, /animation: codex-web-reader-kf-\d+-fade 1s ease/);
  assert.doesNotMatch(scoped, /(^|})\s*(?:html|body|main|button|\*)\s*[{,:]/m);
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
  assert.match(mathSource, /document\.addEventListener\("visibilitychange", retryWhenVisible\)/);
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
  const prepared = prepareMarkdownMath([
    "设 \\(f\\) 在圆盘内复可导，边界为 \\(\\Gamma\\)。",
    "",
    "\\[",
    "f(z)=\\frac{1}{2\\pi i}\\int_\\Gamma \\frac{f(\\zeta)}{\\zeta-z}\\,d\\zeta.",
    "\\]",
  ].join("\n"));
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath],
    rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }]],
    children: prepared.content,
  }));
  assert.match(html, /class="katex-display"/);
  assert.match(html, /annotation encoding="application\/x-tex">f\(z\)=\\frac\{1\}\{2\\pi i\}\\int_\\Gamma/);
  assert.match(html, /annotation encoding="application\/x-tex">\\Gamma<\/annotation>/);
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

test("new conversation requests atomically reuse only a completely empty task in the same project", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-empty-conversation-reuse-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const create = (reuseEmpty = true) => agent.post("/api/conversations")
    .set("X-CSRF-Token", csrf).send({ reuseEmpty });

  const [first, duplicate] = await Promise.all([create(), create()]);
  assert.deepEqual([first.status, duplicate.status].sort(), [200, 201]);
  assert.equal(first.body.conversation.id, duplicate.body.conversation.id);
  assert.deepEqual([first.body.reused, duplicate.body.reused].sort(), [false, true]);
  assert.equal((await agent.get("/api/conversations").expect(200)).body.total, 1);
  const conversationsRoot = ensureTenant(tenantRoot, LEGACY_USER_ID).conversations;
  assert.deepEqual(fs.readdirSync(conversationsRoot), [first.body.conversation.id]);

  instance.db.saveComposerDraft(first.body.conversation.id, "已经输入但尚未发送", null);
  const afterDraft = await create().expect(201);
  assert.notEqual(afterDraft.body.conversation.id, first.body.conversation.id);
  instance.db.createJob(crypto.randomUUID(), afterDraft.body.conversation.id);
  const afterJob = await create().expect(201);
  assert.notEqual(afterJob.body.conversation.id, afterDraft.body.conversation.id);
  instance.db.updateConversation(afterJob.body.conversation.id, { title: "新任务", titleSource: "manual" });
  const afterManualTitle = await create().expect(201);
  assert.notEqual(afterManualTitle.body.conversation.id, afterJob.body.conversation.id);

  instance.db.ensureComposerDraft(afterManualTitle.body.conversation.id);
  const emptyDraftStillReusable = await create().expect(200);
  assert.equal(emptyDraftStillReusable.body.conversation.id, afterManualTitle.body.conversation.id);
  assert.equal(emptyDraftStillReusable.body.reused, true);

  const forced = await create(false).expect(201);
  assert.notEqual(forced.body.conversation.id, afterManualTitle.body.conversation.id);

  const newerActiveTask = await create(false).expect(201);
  instance.db.addMessage({
    id: crypto.randomUUID(), conversation_id: newerActiveTask.body.conversation.id, role: "user", content: "newer activity",
    created_at: new Date().toISOString(),
  });
  assert.equal(instance.db.listConversations(LEGACY_USER_ID)[0].id, newerActiveTask.body.conversation.id);

  const promoted = await create().expect(200);
  assert.equal(promoted.body.reused, true);
  assert.equal(promoted.body.conversation.id, forced.body.conversation.id);
  assert.equal(promoted.body.conversation.pinned_at, null);
  assert.equal(instance.db.listConversations(LEGACY_USER_ID)[0].id, forced.body.conversation.id);

  instance.db.addMessage({
    id: crypto.randomUUID(), conversation_id: newerActiveTask.body.conversation.id, role: "user", content: "later activity",
    created_at: new Date().toISOString(),
  });
  assert.equal(instance.db.listConversations(LEGACY_USER_ID)[0].id, newerActiveTask.body.conversation.id);
  await create("invalid" as unknown as boolean).expect(400);
});

test("new-task UI refreshes the promoted row before retaining and selecting the server conversation", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(source, /await refreshList\(false, projectId \?\? null\);\s*retainedConversationRef\.current = result\.conversation;\s*selectedIdRef\.current = result\.conversation\.id;\s*setSelectedId\(result\.conversation\.id\);/);
});

test("conversation archive API keeps history readable, blocks new turns, and restores the sidebar row", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-archive-api-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot,
    username: "demo-owner",
    passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const conversationId = created.body.conversation.id as string;
  const threadId = crypto.randomUUID();
  instance.db.updateConversation(conversationId, { codexThreadId: threadId });
  assert.equal(instance.db.setConversationContextUsage(conversationId, {
    threadId,
    inputTokens: 202_345,
    modelContextWindow: 258_400,
  }), true);
  assert.equal(instance.db.setConversationContextUsage(conversationId, {
    threadId: crypto.randomUUID(),
    inputTokens: 1,
    modelContextWindow: 2,
  }), false);
  assert.equal(instance.db.setConversationCodexQuota(conversationId, { remainingPercent: 44 }), true);
  const codexHome = ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome;
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "23");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(sessionDirectory, `rollout-2026-07-23T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(rollout, "history", "utf8");

  const archived = await agent.post(`/api/conversations/${conversationId}/archive`).set("X-CSRF-Token", csrf).expect(200);
  assert.ok(archived.body.conversation.archived_at);
  assert.equal((await agent.get("/api/conversations").expect(200)).body.total, 0);
  assert.equal((await agent.get("/api/conversations/archived").expect(200)).body.conversations[0].id, conversationId);
  const detail = await agent.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.conversation.id, conversationId);
  assert.equal(detail.body.rolloutBytes, 7);
  assert.deepEqual(detail.body.contextUsage, {
    inputTokens: 202_345,
    modelContextWindow: 258_400,
    updatedAt: detail.body.contextUsage.updatedAt,
  });
  assert.deepEqual(detail.body.packageQuota, {
    remainingPercent: 44,
    updatedAt: detail.body.packageQuota.updatedAt,
  });
  assert.match(detail.body.contextUsage.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", csrf).field("message", "不应发送").expect(409);

  const restored = await agent.post(`/api/conversations/${conversationId}/restore`).set("X-CSRF-Token", csrf).expect(200);
  assert.equal(restored.body.conversation.archived_at, null);
  assert.equal((await agent.get("/api/conversations").expect(200)).body.conversations[0].id, conversationId);
});

test("single-user login and CSRF protection", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot,
    username: "demo-owner",
    passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);

  const malformed = await agent.post("/api/auth/login")
    .set("Content-Type", "application/json")
    .set("X-Request-ID", "malformed-json-test")
    .send("{")
    .expect(400);
  assert.equal(malformed.headers["x-request-id"], "malformed-json-test");
  assert.deepEqual(malformed.body, { code: "INVALID_JSON", requestId: "malformed-json-test", error: "请求 JSON 格式无效。" });
  await agent.post("/api/auth/login").send({ username: "wrong", password: "fixture" }).expect(401);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  assert.equal(login.body.authenticated, true);
  assert.equal(login.body.accountId, LEGACY_USER_ID);
  assert.equal(login.body.projectMode, true);
  assert.ok(login.body.csrfToken);
  assert.equal(login.body.chatFontSize, CHAT_FONT_SIZE_DEFAULT);
  await agent.put("/api/user-settings/chat-font-size")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ chatFontSize: 19 }).expect(200, { chatFontSize: 19 });
  const restoredSession = await agent.get("/api/auth/session").expect(200);
  assert.equal(restoredSession.body.accountId, LEGACY_USER_ID);
  assert.equal(restoredSession.body.chatFontSize, 19);
  assert.match(restoredSession.headers["cache-control"], /no-store/);
  const conditionallyRestored = await agent.get("/api/auth/session")
    .set("If-None-Match", restoredSession.headers.etag)
    .expect(200);
  assert.equal(conditionallyRestored.body.accountId, LEGACY_USER_ID);
  await agent.put("/api/user-settings/chat-font-size")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ chatFontSize: "large" }).expect(400);

  const options = await agent.get("/api/agent-options").expect(200);
  assert.equal(options.body.defaults.model, "gpt-5.6-sol");
  assert.equal(options.body.defaults.reasoningEffort, "xhigh");
  assert.deepEqual(options.body.selection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  const projects = await agent.get("/api/projects").expect(200);
  assert.equal(projects.body.canManageProjects, true);
  assert.equal(projects.body.projects.length, 1);
  assert.equal(projects.body.projects[0].executor_id, TENANT_LOCAL_EXECUTOR_ID);
  assert.match(projects.body.projects[0].root_path, /\/library\/default$/);
  const executors = await agent.get("/api/executors").expect(200);
  assert.deepEqual(executors.body.executors.map((executor: { id: string }) => executor.id), [TENANT_LOCAL_EXECUTOR_ID]);
  await agent.post("/api/executors/local-host/runtime/refresh").set("X-CSRF-Token", login.body.csrfToken).expect(403);
  await agent.post("/api/executors/local-host/codex/upgrade").set("X-CSRF-Token", login.body.csrfToken).expect(403);
  await agent.post("/api/projects").set("X-CSRF-Token", login.body.csrfToken)
    .send({ name: "越界项目", rootPath: root, executorId: TENANT_LOCAL_EXECUTOR_ID }).expect(400);
  const projectRootPage = await agent.get(`/api/executors/${TENANT_LOCAL_EXECUTOR_ID}/project-directories`).expect(200);
  const createdDirectory = await agent.post(`/api/executors/${TENANT_LOCAL_EXECUTOR_ID}/project-directories`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ parent: projectRootPage.body.directory, name: "第二项目" }).expect(201);
  const secondProject = (await agent.post("/api/projects").set("X-CSRF-Token", login.body.csrfToken)
    .send({ name: "第二项目", rootPath: createdDirectory.body.directory, executorId: TENANT_LOCAL_EXECUTOR_ID }).expect(201)).body.project;
  await agent.put("/api/projects/order").set("X-CSRF-Token", login.body.csrfToken)
    .send({ projectIds: [secondProject.id, projects.body.projects[0].id] }).expect(200);
  await agent.put(`/api/projects/${projects.body.projects[0].id}/sidebar-collapsed`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ collapsed: true }).expect(200);
  await agent.post(`/api/projects/${projects.body.projects[0].id}/archive`).set("X-CSRF-Token", login.body.csrfToken).expect(409);
  await agent.post(`/api/projects/${secondProject.id}/sync`).set("X-CSRF-Token", login.body.csrfToken).expect(403);

  await agent.post("/api/conversations").expect(403);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  assert.equal(created.body.conversation.title, "新任务");
  assert.equal(created.body.conversation.title_source, "default");
  assert.equal(created.body.conversation.pinned_at, null);
  assert.equal(created.body.conversation.has_unread_result, 0);
  assert.deepEqual(created.body.agentSelection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  await agent.put(`/api/conversations/${created.body.conversation.id}/agent-selection`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-luna", reasoningEffort: "low" }).expect(200);
  const second = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken)
    .send({ reuseEmpty: false }).expect(201);
  await agent.put(`/api/conversations/${created.body.conversation.id}/sidebar-position`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ targetId: second.body.conversation.id, placement: "after" }).expect(200);
  const moved = await agent.put(`/api/conversations/${created.body.conversation.id}/project`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ projectId: secondProject.id }).expect(200);
  assert.equal(moved.body.conversation.project_id, secondProject.id);
  assert.deepEqual(second.body.agentSelection, { model: "gpt-5.6-luna", reasoningEffort: "low" });
  await agent.put(`/api/conversations/${created.body.conversation.id}/pin`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ pinned: "yes" }).expect(400);
  const pinned = await agent.put(`/api/conversations/${created.body.conversation.id}/pin`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ pinned: true }).expect(200);
  assert.ok(pinned.body.conversation.pinned_at);
  assert.equal((await agent.get("/api/conversations").expect(200)).body.conversations[0].id, created.body.conversation.id);
  const unreadJobId = crypto.randomUUID();
  instance.db.createJob(unreadJobId, created.body.conversation.id);
  instance.db.finishJob(unreadJobId, created.body.conversation.id, "completed");
  assert.equal((await agent.get("/api/conversations").expect(200)).body.conversations[0].has_unread_result, 1);
  await agent.post(`/api/conversations/${created.body.conversation.id}/seen`).expect(403);
  const seen = await agent.post(`/api/conversations/${created.body.conversation.id}/seen`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(seen.body.conversation.has_unread_result, 0);
  const renamed = await agent.patch(`/api/conversations/${second.body.conversation.id}`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ title: "我的自定义标题" }).expect(200);
  assert.equal(renamed.body.conversation.title_source, "manual");
  assert.equal(instance.db.setAiConversationTitleIfDefault(second.body.conversation.id, "AI 不应覆盖"), false);
  assert.equal(instance.db.getConversation(second.body.conversation.id)?.title, "我的自定义标题");
  await agent.put(`/api/conversations/${second.body.conversation.id}/agent-selection`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-terra", reasoningEffort: "high" }).expect(200);
  const firstDetail = await agent.get(`/api/conversations/${created.body.conversation.id}`).expect(200);
  assert.deepEqual(firstDetail.body.agentSelection, { model: "gpt-5.6-luna", reasoningEffort: "low" });

  const codexHome = ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome;
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{
    slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", description: "frontier", priority: 0,
    visibility: "list", input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }],
  }] }), "utf8");
  const repaired = await agent.get(`/api/conversations/${created.body.conversation.id}`).expect(200);
  assert.deepEqual(repaired.body.agentSelection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.agent_model, "gpt-5.6-sol");
  await agent.get("/api/conversations").expect(200);

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
  const download = await agent.get(`/api/files/${fileId}?download=1`).expect(200);
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
  const markdownPreview = await agent.get(`/api/files/${markdownId}/preview`).expect(200);
  assert.equal(markdownPreview.headers["cache-control"], "private, no-store");
  assert.equal(markdownPreview.body.file.original_name, markdownName);
  assert.equal(markdownPreview.body.file.mime_type, "text/markdown");
  assert.equal(markdownPreview.body.file.conversation_id, undefined);
  const markdownRaw = await agent.get(`/api/files/${markdownId}`).expect(200);
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
  assert.equal((await agent.get(`/api/files/${htmlId}/preview`).expect(200)).body.file.original_name, htmlName);
  const htmlRaw = await agent.get(`/api/files/${htmlId}`).expect(200);
  assert.match(htmlRaw.headers["content-disposition"], /^attachment;/);
  await request(instance.app).get(`/api/files/${markdownId}/preview`).expect(401);

  await agent.post(`/api/conversations/${created.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "请制作一份很长很长的家长会成绩分析演示文稿").expect(202);
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.title, "新任务");
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.title_source, "default");
});

test("owner preserves project expansion and project-local task order alongside remote executors", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-sidebar-order-api-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });
  const firstProject = instance.db.ensureDefaultProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "first-project", path.join(root, "first"));
  const secondProject = instance.db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "second-project", path.join(root, "second"));
  const first = instance.db.createConversation(crypto.randomUUID(), "first", undefined, HOST_ROOT_USER_ID, firstProject.id);
  const second = instance.db.createConversation(crypto.randomUUID(), "second", undefined, HOST_ROOT_USER_ID, firstProject.id);
  const archivedConversation = instance.db.createConversation(crypto.randomUUID(), "preserved", undefined, HOST_ROOT_USER_ID, secondProject.id);
  const host = request.agent(instance.app);
  const login = await host.post("/api/auth/login").send({ username: "owner", password: "fixture" }).expect(200);
  assert.equal(login.body.projectMode, true);

  await host.put("/api/projects/order").set("X-CSRF-Token", login.body.csrfToken)
    .send({ projectIds: [secondProject.id, firstProject.id] }).expect(200, { ok: true });
  const orderedProjects = (await host.get("/api/projects").expect(200)).body.projects as Array<{ id: string; display_name: string }>;
  assert.deepEqual(orderedProjects.map((project) => project.id), [secondProject.id, firstProject.id]);
  assert.deepEqual(orderedProjects.map((project) => project.display_name), ["second-project", "first-project"]);
  await host.put(`/api/projects/${firstProject.id}/sidebar-collapsed`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ collapsed: "yes" }).expect(400);
  await host.put(`/api/projects/${firstProject.id}/sidebar-collapsed`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ collapsed: true }).expect(200);
  const persistedProjects = (await host.get("/api/projects").expect(200)).body.projects as Array<{ id: string; sidebar_collapsed: number }>;
  assert.equal(persistedProjects.find((project) => project.id === firstProject.id)?.sidebar_collapsed, 1);
  assert.equal(instance.db.getProject(firstProject.id)?.sidebar_collapsed, 1);
  await host.post(`/api/projects/${firstProject.id}/sync`).set("X-CSRF-Token", login.body.csrfToken).expect(400);

  await host.put(`/api/conversations/${first.id}/sidebar-position`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ targetId: second.id, placement: "before" }).expect(200, { ok: true });
  assert.deepEqual((await host.get(`/api/conversations?projectId=${firstProject.id}`).expect(200)).body.conversations.map((conversation: { id: string }) => conversation.id), [first.id, second.id]);
  await host.patch(`/api/conversations/${second.id}`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ title: "second active" }).expect(200);
  assert.deepEqual((await host.get(`/api/conversations?projectId=${firstProject.id}`).expect(200)).body.conversations.map((conversation: { id: string }) => conversation.id), [first.id, second.id]);
  instance.db.createPendingPrompt(crypto.randomUUID(), second.id, "new prompt", { model: "gpt-5.6-sol", reasoningEffort: "high" });
  assert.deepEqual((await host.get(`/api/conversations?projectId=${firstProject.id}`).expect(200)).body.conversations.map((conversation: { id: string }) => conversation.id), [second.id, first.id]);

  await host.put(`/api/conversations/${first.id}/project`).set("X-CSRF-Token", login.body.csrfToken)
    .send({}).expect(400);
  const moved = await host.put(`/api/conversations/${first.id}/project`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ projectId: secondProject.id }).expect(200);
  assert.equal(moved.body.moved, true);
  assert.equal(moved.body.fromProjectId, firstProject.id);
  assert.equal(moved.body.toProjectId, secondProject.id);
  assert.equal(moved.body.conversation.project_id, secondProject.id);
  assert.deepEqual(
    (await host.get(`/api/conversations?projectId=${secondProject.id}`).expect(200)).body.conversations.map((conversation: { id: string }) => conversation.id),
    [first.id, archivedConversation.id],
  );
  const unchanged = await host.put(`/api/conversations/${first.id}/project`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ projectId: secondProject.id }).expect(200);
  assert.equal(unchanged.body.moved, false);

  const remoteProject = instance.db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "remote-project", "E:\\remote", "remote:worker-a");
  await host.put(`/api/conversations/${second.id}/project`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ projectId: remoteProject.id }).expect(409, { error: "任务只能在同一个本地工作区的项目之间移动。" });
  const busy = instance.db.createConversation(crypto.randomUUID(), "busy", undefined, HOST_ROOT_USER_ID, firstProject.id);
  instance.db.createJob(crypto.randomUUID(), busy.id);
  await host.put(`/api/conversations/${busy.id}/project`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ projectId: secondProject.id }).expect(409, { error: "会话仍在运行或有排队、待发送内容，暂时不能移动。" });

  const archived = await host.post(`/api/projects/${secondProject.id}/archive`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.ok(archived.body.project.archived_at);
  assert.deepEqual(
    (await host.get("/api/projects").expect(200)).body.projects.map((project: { id: string }) => project.id),
    [firstProject.id, remoteProject.id],
  );
  await host.get(`/api/conversations?projectId=${secondProject.id}`).expect(404);
  await host.post(`/api/projects/${secondProject.id}/sync`).set("X-CSRF-Token", login.body.csrfToken).expect(404);
  assert.equal(instance.db.getConversation(archivedConversation.id)?.project_id, secondProject.id);
  assert.equal(instance.db.getConversation(first.id)?.project_id, secondProject.id);
});

test("owner can fetch any readable remote file into the normal deliverable download flow", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-file-fetch-test-"));
  const enrollmentToken = "test-remote-worker-enrollment-token";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    remoteWorkerEnrollmentToken: enrollmentToken,
  });
  const server = http.createServer(instance.app);
  instance.remoteWorkers.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const workerId = crypto.randomUUID();
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/remote-workers/connect`);
  let fetchRequests = 0;
  const fetchPaths: Array<{ projectRoot: string; path: string }> = [];
  const authenticated = new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({
      type: "hello", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, workerId, machineName: "TEST-PC",
      enrollmentToken, platform: "win32-x64", workerVersion: "test", codexVersion: "test", capacity: 1,
    })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; requestId?: string; transferToken?: string; action?: string; projectRoot?: string; path?: string };
      if (message.type === "authenticated") resolve();
      if (message.type === "project_fs" && message.requestId && message.path) {
        socket.send(JSON.stringify({
          type: "project_fs_result", requestId: message.requestId, directory: message.path,
          parent: "E:\\workspace", directories: [],
        }));
      }
      if (message.type === "file_fetch" && message.requestId && message.transferToken) {
        fetchRequests += 1;
        fetchPaths.push({ projectRoot: message.projectRoot ?? "", path: message.path ?? "" });
        void fetch(`${origin}/api/remote-worker-files/fetch/${message.requestId}`, {
          method: "PUT", headers: { authorization: `Bearer ${message.transferToken}`, "content-type": "text/html", "x-file-name": encodeURIComponent("index.html") }, body: "remote-file-body",
        }).then((response) => {
          socket.send(JSON.stringify({ type: "file_fetch_result", requestId: message.requestId, ok: response.ok, message: response.ok ? undefined : `upload ${response.status}` }));
        }).catch((error) => socket.send(JSON.stringify({ type: "file_fetch_result", requestId: message.requestId, ok: false, message: String(error) })));
      }
    });
  });
  await authenticated;
  context.after(async () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); });
    }
    instance.remoteWorkers.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });
    const project = instance.db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "work", "C:\\workspace\\work", `remote:${workerId}`);
  const conversation = instance.db.createConversation(crypto.randomUUID(), "send file", undefined, HOST_ROOT_USER_ID, project.id);
  const messageId = crypto.randomUUID();
  instance.db.addMessage({ id: messageId, conversation_id: conversation.id, role: "assistant", content: "[index.html](E:/dobe/shared/index.html)", created_at: now });

  const agent = request.agent(server);
  const login = await agent.post("/api/auth/login").send({ username: "owner", password: "fixture" }).expect(200);
  await agent.post(`/api/projects/${project.id}/archive`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const restored = await agent.post("/api/projects").set("X-CSRF-Token", login.body.csrfToken)
    .send({ name: "restored-work", rootPath: project.root_path, executorId: project.executor_id }).expect(201);
  assert.equal(restored.body.restored, true);
  assert.equal(restored.body.project.id, project.id);
  assert.equal(restored.body.project.name, "restored-work");
  assert.equal(instance.db.getConversation(conversation.id)?.project_id, project.id);
  const first = await agent.post(`/api/conversations/${conversation.id}/messages/${messageId}/remote-file`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ path: "E:/dobe/shared/index.html" }).expect(201);
  assert.equal(first.body.file.original_name, "index.html");
  assert.equal(first.body.file.source_path, "E:/dobe/shared/index.html");
  assert.match(first.body.file.relative_path, /^deliverables\//);
  assert.equal(fetchRequests, 1);
  assert.deepEqual(fetchPaths, [{ projectRoot: "C:\\workspace\\work", path: "E:/dobe/shared/index.html" }]);
  const downloaded = await agent.get(`/api/files/${first.body.file.id}?download=1`).expect(200);
  assert.equal(downloaded.text, "remote-file-body");

  const second = await agent.post(`/api/conversations/${conversation.id}/messages/${messageId}/remote-file`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ path: "E:/dobe/shared/index.html" }).expect(200);
  assert.equal(second.body.alreadyFetched, true);
  assert.equal(second.body.file.id, first.body.file.id);
  assert.equal(fetchRequests, 1);
});

test("remote Worker output uploads keep large JSON files on the raw 100 MiB path", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-json-output-test-"));
  const enrollmentToken = "test-remote-worker-enrollment-token";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    remoteWorkerEnrollmentToken: enrollmentToken,
  });
  const server = http.createServer(instance.app);
  instance.remoteWorkers.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const workerId = crypto.randomUUID();
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/remote-workers/connect`);
  const authenticated = new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({
      type: "hello", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, workerId, machineName: "JSON-PC",
      enrollmentToken, platform: "win32-x64", workerVersion: "test", codexVersion: "test", capacity: 1,
    })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; request?: { jobId: string; transferToken: string } };
      if (message.type === "authenticated") resolve();
      if (message.type !== "run" || !message.request) return;
      const body = JSON.stringify({ data: "x".repeat(1024 * 1024) });
      void (async () => {
        const rejected = await fetch(`${origin}/api/remote-worker-files/${message.request!.jobId}/output`, {
          method: "PUT", headers: { authorization: "Bearer invalid", "content-type": "application/json" }, body: "{",
        });
        assert.equal(rejected.status, 404);
        assert.equal((await rejected.json() as { code: string }).code, "REMOTE_TRANSFER_UNAUTHORIZED");
        const response = await fetch(`${origin}/api/remote-worker-files/${message.request!.jobId}/output`, {
          method: "PUT", headers: { authorization: `Bearer ${message.request!.transferToken}`, "content-type": "application/json", "x-file-name": "analysis.json" }, body,
        });
        assert.equal(response.status, 201);
        const uploaded = await response.json() as { artifact: { sha256: string } };
        assert.equal(uploaded.artifact.sha256, crypto.createHash("sha256").update(body).digest("hex"));
        socket.send(JSON.stringify({ type: "event", jobId: message.request?.jobId, event: { type: "completed", finalResponse: "done" } }));
      })().catch(reject);
    });
  });
  await authenticated;
  context.after(async () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); });
    }
    instance.remoteWorkers.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const project = instance.db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "remote-json", "E:\\workspace\\work", `remote:${workerId}`);
  const conversation = instance.db.createConversation(crypto.randomUUID(), "remote JSON", undefined, LEGACY_USER_ID, project.id);
  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  instance.db.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: "test", created_at: new Date().toISOString() });
  instance.db.createJob(jobId, conversation.id, messageId, { model: "gpt-5", reasoningEffort: "medium" });
  instance.db.updateJob(jobId, "running");
  instance.db.updateConversation(conversation.id, { status: "running" });
  const result = await instance.remoteWorkers.run(workerId, {
    jobId, conversationId: conversation.id, projectRoot: "E:\\workspace\\work", codexThreadId: null, prompt: "test",
    selection: { model: "gpt-5", reasoningEffort: "medium" }, optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  }, [], { onThreadStarted: () => {}, onProgress: () => {}, onContextUsage: () => {}, onQuotaUsage: () => {} });
  assert.equal(result.finalResponse, "done");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.name, "analysis.json");
  assert.ok(result.artifacts[0]?.size > 1024 * 1024);
  assert.match(result.artifacts[0]!.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(result.artifacts[0]!.tempPath).size, result.artifacts[0]!.size);
  const recoveryPath = path.join(root, "data", "remote-worker-recovery", `${jobId}.json`);
  assert.equal(fs.existsSync(recoveryPath), true);
  const resumed = await instance.remoteWorkers.resume(jobId, workerId, {
    onThreadStarted: () => {}, onProgress: () => {}, onContextUsage: () => {}, onQuotaUsage: () => {},
  });
  assert.equal(resumed.finalResponse, "done");
  assert.equal(resumed.artifacts[0]?.sha256, result.artifacts[0]?.sha256);
  instance.remoteWorkers.release(jobId);
  assert.equal(fs.existsSync(recoveryPath), false);
});

test("remote Worker behavior updates import automatically without duplicating messages or activities", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-live-sync-test-"));
  const enrollmentToken = "test-remote-worker-enrollment-token";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    remoteWorkerEnrollmentToken: enrollmentToken,
  });
  const server = http.createServer(instance.app);
  instance.remoteWorkers.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const workerId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });
    const project = instance.db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "work", "C:\\workspace\\work", `remote:${workerId}`);
  const remoteAccountA = crypto.randomUUID();
  const remoteAccountB = crypto.randomUUID();
  let currentRemoteAccount = remoteAccountA;
  const remoteAccountState = () => ({
    activeAccountId: currentRemoteAccount,
    accounts: [
      { id: remoteAccountA, label: "home A", email: "a@example.com", accountHint: "••••••ount-a", active: currentRemoteAccount === remoteAccountA, createdAt: now, lastUsedAt: now },
      { id: remoteAccountB, label: "home B", email: "b@example.com", accountHint: "••••••ount-b", active: currentRemoteAccount === remoteAccountB, createdAt: now, lastUsedAt: null },
    ],
  });
  const ppThreadId = crypto.randomUUID();
  const ppConversation = instance.db.createConversation(crypto.randomUUID(), "Codex-created thread", undefined, HOST_ROOT_USER_ID, project.id);
  instance.db.updateConversation(ppConversation.id, { codexThreadId: ppThreadId });
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/remote-workers/connect`);
  context.after(async () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
    instance.remoteWorkers.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const watched = new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({
      type: "hello", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, workerId, machineName: "LIVE-PC",
      enrollmentToken, platform: "win32-x64", workerVersion: "1.7.0", codexVersion: "test", capacity: 1,
      capabilities: { codexAccounts: true },
    })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type: string;
        requestId?: string;
        action?: string;
        accountId?: string;
        projects?: Array<{ id: string; rootPath: string }>;
      };
      if (message.type === "codex_accounts" && message.requestId) {
        if (message.action === "activate" && message.accountId) currentRemoteAccount = message.accountId;
        socket.send(JSON.stringify({ type: "codex_accounts_result", requestId: message.requestId, ok: true, state: remoteAccountState(), restart: false }));
        return;
      }
      if (message.type === "thread_rename" && message.requestId) {
        socket.send(JSON.stringify({ type: "thread_rename_result", requestId: message.requestId, ok: true }));
        return;
      }
      if (message.type !== "project_watch") return;
      assert.deepEqual(message.projects, [{ id: project.id, rootPath: project.root_path }]);
      resolve();
    });
  });
  await watched;
  instance.conversationTitles.generate = async (input) => input.requestText === "检查项目" ? "检查远端项目" : null;

  socket.send(JSON.stringify({ type: "quota_usage", usage: { remainingPercent: "invalid" } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(instance.db.getConversationCodexQuota(ppConversation.id), null);
  socket.send(JSON.stringify({ type: "quota_usage", usage: { remainingPercent: 63 }, accountId: remoteAccountA }));
  for (let attempt = 0; attempt < 50 && instance.db.getConversationCodexQuota(ppConversation.id)?.remainingPercent !== 63; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(instance.db.getConversationCodexQuota(ppConversation.id)?.remainingPercent, 63);

  socket.send(JSON.stringify({
    type: "thread_activity",
    projectId: project.id,
    thread: {
      id: ppThreadId, name: "Codex-created thread", nameSource: "explicit",
      createdAt: 1_785_000_000, updatedAt: 1_785_000_005, status: "idle",
      messages: [],
      activities: [{
        turnId: "turn-demo", itemId: "command-demo", kind: "command", label: "本机处理步骤完成",
        detail: "npm test", createdAt: "2026-07-24T09:59:00.000Z",
      }],
    },
  }));
  for (let attempt = 0; attempt < 50 && instance.db.listRemoteThreadActivities(ppConversation.id).length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(instance.db.listRemoteThreadActivities(ppConversation.id).length, 1);

  const threadId = crypto.randomUUID();
  const running = {
    id: threadId, name: "检查项目", nameSource: "preview",
    createdAt: 1_785_000_000, updatedAt: 1_785_000_010, status: "running",
    messages: [{ turnId: "turn-1", itemId: "user-1", role: "user", content: "检查项目", createdAt: "2026-07-24T10:00:00.000Z" }],
    activities: [{
      turnId: "turn-1", itemId: "plan-1", kind: "update", label: "任务计划已更新",
      detail: "检查代码并运行测试", createdAt: "2026-07-24T10:00:01.000Z",
    }],
  };
  socket.send(JSON.stringify({ type: "thread_activity", projectId: project.id, thread: running }));
  let imported = instance.db.getConversationByCodexThread(project.id, threadId);
  for (let attempt = 0; attempt < 50 && !imported; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    imported = instance.db.getConversationByCodexThread(project.id, threadId);
  }
  assert.ok(imported);
  assert.equal(imported.external_status, "running");
  for (let attempt = 0; attempt < 50 && instance.db.getConversation(imported.id)?.title_source !== "ai"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(instance.db.getConversation(imported.id)?.title, "检查远端项目");
  assert.equal(instance.db.getConversation(imported.id)?.title_source, "ai");
  assert.equal(instance.db.getConversation(imported.id)?.has_unread_result, 0);
  assert.equal(instance.db.listMessages(imported.id).length, 1);
  assert.equal(instance.db.listRemoteThreadActivities(imported.id).length, 1);

  socket.send(JSON.stringify({ type: "thread_activity", projectId: project.id, thread: running }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(instance.db.listMessages(imported.id).length, 1);
  assert.equal(instance.db.listRemoteThreadActivities(imported.id).length, 1);

  socket.send(JSON.stringify({
    type: "thread_activity",
    projectId: project.id,
    thread: {
      ...running,
      updatedAt: running.updatedAt + 10,
      status: "idle",
      messages: [{
        turnId: "turn-1", itemId: "agent-1", role: "assistant", content: "检查完成，测试通过。",
        createdAt: "2026-07-24T10:00:10.000Z",
      }],
      activities: [{
        turnId: "turn-1", itemId: "file-1", kind: "file", label: "已更新文件",
        files: ["src/App.tsx"], createdAt: "2026-07-24T10:00:09.000Z",
      }],
    },
  }));
  for (let attempt = 0; attempt < 50 && instance.db.getConversation(imported.id)?.external_status !== "idle"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(instance.db.getConversation(imported.id)?.external_status, "idle");
  assert.equal(instance.db.getConversation(imported.id)?.has_unread_result, 1);
  assert.equal(instance.db.getConversation(imported.id)?.title, "检查远端项目");
  assert.deepEqual(instance.db.listMessages(imported.id).map((message) => message.content), ["检查项目", "检查完成，测试通过。"]);
  assert.deepEqual(instance.db.listRemoteThreadActivities(imported.id).map((activity) => activity.label), ["任务计划已更新", "已更新文件"]);

  const agent = request.agent(server);
  const login = await agent.post("/api/auth/login").send({ username: "owner", password: "fixture" }).expect(200);
  const ppDetail = await agent.get(`/api/conversations/${ppConversation.id}`).expect(200);
  assert.deepEqual(ppDetail.body.remoteActivities.map((activity: { label: string }) => activity.label), ["本机处理步骤完成"]);
  const detail = await agent.get(`/api/conversations/${imported.id}`).expect(200);
  assert.equal(detail.body.conversation.external_status, "idle");
  assert.deepEqual(detail.body.remoteActivities.map((activity: { label: string }) => activity.label), ["任务计划已更新", "已更新文件"]);

  const accounts = await agent.get(`/api/codex-accounts?executorId=${encodeURIComponent(`remote:${workerId}`)}`).expect(200);
  assert.equal(accounts.body.activeAccountId, remoteAccountA);
  await agent.post(`/api/codex-accounts/${remoteAccountB}/activate`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ executorId: `remote:${workerId}` }).expect(200);
  const afterSwitch = await agent.get(`/api/conversations/${ppConversation.id}`).expect(200);
  assert.equal(afterSwitch.body.packageQuota, null);
  socket.send(JSON.stringify({ type: "quota_usage", usage: { remainingPercent: 27 }, accountId: remoteAccountB }));
  for (let attempt = 0; attempt < 50 && instance.db.getConversationCodexQuota(ppConversation.id)?.remainingPercent !== 27; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(instance.db.getConversationCodexQuota(ppConversation.id)?.remainingPercent, 27);
  await agent.post(`/api/codex-accounts/${remoteAccountA}/activate`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ executorId: `remote:${workerId}` }).expect(200);
  const switchedBack = await agent.get(`/api/conversations/${ppConversation.id}`).expect(200);
  assert.equal(switchedBack.body.packageQuota.remainingPercent, 63);
});

test("remote Worker capacity can be changed to unlimited through the managed protocol", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-capacity-test-"));
  const enrollmentToken = "test-remote-worker-enrollment-token";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    remoteWorkerEnrollmentToken: enrollmentToken,
  });
  const server = http.createServer(instance.app);
  instance.remoteWorkers.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const workerId = crypto.randomUUID();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/remote-workers/connect`);
  context.after(async () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
    instance.remoteWorkers.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });

  const authenticated = new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({
      type: "hello", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, workerId, machineName: "CAPACITY-PC",
      enrollmentToken, platform: "win32-x64", workerVersion: "1.14.0", codexVersion: "test", capacity: 2,
      capabilities: { workerUpdate: true, waitAutomation: true, capacityConfig: true },
    })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; requestId?: string; capacity?: number };
      if (message.type === "authenticated") resolve();
      if (message.type === "worker_config" && message.requestId && message.capacity === 0) {
        socket.send(JSON.stringify({ type: "worker_config_result", requestId: message.requestId, ok: true, capacity: 0 }));
      }
    });
  });
  await authenticated;
  socket.send(JSON.stringify({ type: "heartbeat", activeJobs: ["one", "two"] }));
  for (let attempt = 0; attempt < 30 && instance.db.getRemoteWorker(workerId)?.active_jobs !== 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instance.remoteWorkers.canRun(`remote:${workerId}`), false);

  const agent = request.agent(server);
  const login = await agent.post("/api/auth/login").send({ username: "owner", password: "fixture" }).expect(200);
  await agent.put(`/api/executors/remote%3A${workerId}/capacity`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ capacity: 9 }).expect(409);
  const changed = await agent.put(`/api/executors/remote%3A${workerId}/capacity`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ capacity: 0 }).expect(200);
  assert.equal(changed.body.executor.capacity, 0);
  assert.equal(changed.body.executor.worker.capacityConfigurable, true);
  assert.equal(instance.db.getRemoteWorker(workerId)?.capacity, 0);
  assert.equal(instance.remoteWorkers.canRun(`remote:${workerId}`), true);
});

test("remote Worker update waits for an idle heartbeat and succeeds only after version-verified reconnect", async (context) => {
  assert.equal(REMOTE_WORKER_UPDATE_TIMEOUT_MS, 15 * 60_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-worker-update-test-"));
  const enrollmentToken = "test-remote-worker-enrollment-token";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    remoteWorkerEnrollmentToken: enrollmentToken,
  });
  const server = http.createServer(instance.app);
  instance.remoteWorkers.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const workerId = crypto.randomUUID();
  const sockets: WebSocket[] = [];

  const connectWorker = (version: string, release: string | null, commit: string | null) => new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/remote-workers/connect`);
    sockets.push(socket);
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({
      type: "hello", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, workerId, machineName: "UPDATE-PC",
      enrollmentToken, platform: "win32-x64", workerVersion: version, workerRelease: release, workerCommit: commit,
      capabilities: { workerUpdate: true }, codexVersion: "0.145.0", capacity: 1,
    })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type === "authenticated") resolve(socket);
    });
  });

  context.after(async () => {
    instance.remoteWorkers.close();
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });
  const first = await connectWorker("1.3.1", "remote-worker-v1.3.1", "1".repeat(40));
  first.send(JSON.stringify({ type: "heartbeat", activeJobs: ["worker-local-job"] }));
  for (let attempt = 0; attempt < 30 && instance.db.getRemoteWorker(workerId)?.active_jobs !== 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instance.remoteWorkers.canRun(`remote:${workerId}`), false);

  let dispatchedUpdate: { requestId: string; targetVersion: string; targetRef: string } | null = null;
  let resolveDispatch!: () => void;
  const dispatchSeen = new Promise<void>((resolve) => { resolveDispatch = resolve; });
  first.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { type: string; requestId?: string; targetVersion?: string; targetRef?: string };
    if (message.type !== "worker_update" || !message.requestId || !message.targetVersion || !message.targetRef) return;
    dispatchedUpdate = { requestId: message.requestId, targetVersion: message.targetVersion, targetRef: message.targetRef };
    resolveDispatch();
  });

  const agent = request.agent(server);
  const login = await agent.post("/api/auth/login").send({ username: "owner", password: "fixture" }).expect(200);
  const queued = await agent.post(`/api/executors/remote%3A${workerId}/worker/upgrade`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(202);
  assert.equal(queued.body.executor.worker.update.state, "queued");
  assert.equal(instance.remoteWorkers.canRun(`remote:${workerId}`), false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(dispatchedUpdate, null);

  first.send(JSON.stringify({ type: "heartbeat", activeJobs: [] }));
  await Promise.race([dispatchSeen, new Promise((_, reject) => setTimeout(() => reject(new Error("worker update was not dispatched")), 2_000))]);
  assert.deepEqual(dispatchedUpdate && { targetVersion: dispatchedUpdate.targetVersion, targetRef: dispatchedUpdate.targetRef }, {
    targetVersion: REMOTE_WORKER_TARGET_VERSION, targetRef: REMOTE_WORKER_TARGET_REF,
  });
  first.send(JSON.stringify({ type: "worker_update_ack", requestId: dispatchedUpdate!.requestId, accepted: true }));
  for (let attempt = 0; attempt < 30 && instance.db.getRemoteWorkerUpdate(workerId)?.state !== "updating"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instance.db.getRemoteWorkerUpdate(workerId)?.state, "updating");

  const replacement = await connectWorker(REMOTE_WORKER_TARGET_VERSION, REMOTE_WORKER_TARGET_REF, "2".repeat(40));
  replacement.send(JSON.stringify({ type: "heartbeat", activeJobs: [] }));
  for (let attempt = 0; attempt < 30 && instance.db.getRemoteWorker(workerId)?.active_jobs !== 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instance.db.getRemoteWorkerUpdate(workerId)?.state, "succeeded");
  const resultAck = new Promise<void>((resolve) => replacement.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { type: string; requestId?: string };
    if (message.type === "worker_update_result_ack" && message.requestId === dispatchedUpdate!.requestId) resolve();
  }));
  replacement.send(JSON.stringify({
    type: "worker_update_result", requestId: dispatchedUpdate!.requestId,
    targetVersion: REMOTE_WORKER_TARGET_VERSION, targetRef: REMOTE_WORKER_TARGET_REF, ok: true,
    installedVersion: REMOTE_WORKER_TARGET_VERSION, installedRef: REMOTE_WORKER_TARGET_REF, installedCommit: "2".repeat(40),
  }));
  await Promise.race([resultAck, new Promise((_, reject) => setTimeout(() => reject(new Error("worker update result was not acknowledged")), 2_000))]);
  const executors = await agent.get("/api/executors").expect(200);
  const updated = executors.body.executors.find((executor: { id: string }) => executor.id === `remote:${workerId}`);
  assert.equal(updated.worker.installedVersion, REMOTE_WORKER_TARGET_VERSION);
  assert.equal(updated.worker.installedRef, REMOTE_WORKER_TARGET_REF);
  assert.equal(updated.worker.update.state, "succeeded");
  assert.equal(instance.remoteWorkers.canRun(`remote:${workerId}`), true);
});

test("production automatically queues an outdated capable Worker after deployment", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-worker-auto-update-test-"));
  const releaseRoot = path.join(root, "release");
  const enrollmentToken = "test-remote-worker-auto-update-enrollment-token";
  const commit = "9".repeat(40);
  const archive = Buffer.from("worker-package");
  const fileName = `codex-web-remote-worker-${REMOTE_WORKER_TARGET_VERSION}-win-x64.zip`;
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, fileName), archive);
  const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  fs.writeFileSync(path.join(releaseRoot, "manifest.json"), JSON.stringify({
    format: "codex-web-remote-worker-release-manifest-v1", version: REMOTE_WORKER_TARGET_VERSION,
    ref: REMOTE_WORKER_TARGET_REF, commit, platform: "win32-x64",
    archive: { fileName, sha256, size: archive.length },
  }));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    remoteWorkerEnrollmentToken: enrollmentToken, remoteWorkerReleaseRoot: releaseRoot, containerized: true,
  });
  const server = http.createServer(instance.app);
  instance.remoteWorkers.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const workerId = crypto.randomUUID();
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/remote-workers/connect`);
  context.after(async () => {
    instance.remoteWorkers.close();
    socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dispatched = new Promise<{ targetVersion: string; targetRef: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("automatic Worker update was not dispatched")), 2_000);
    socket.once("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; targetVersion?: string; targetRef?: string };
      if (message.type === "authenticated") socket.send(JSON.stringify({ type: "heartbeat", activeJobs: [] }));
      if (message.type === "worker_update" && message.targetVersion && message.targetRef) {
        clearTimeout(timer);
        resolve({ targetVersion: message.targetVersion, targetRef: message.targetRef });
      }
    });
  });
  socket.once("open", () => socket.send(JSON.stringify({
    type: "hello", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, workerId, machineName: "AUTO-UPDATE-PC",
    enrollmentToken, platform: "win32-x64", workerVersion: "1.18.0", workerRelease: "remote-worker-v1.18.0",
    workerCommit: "1".repeat(40), codexVersion: "test", capacity: 1, capabilities: { workerUpdate: true },
  })));
  assert.deepEqual(await dispatched, { targetVersion: REMOTE_WORKER_TARGET_VERSION, targetRef: REMOTE_WORKER_TARGET_REF });
  assert.equal(instance.db.getRemoteWorkerUpdate(workerId)?.state, "dispatching");
});

test("versioned Remote Worker release downloads require the enrollment credential and preserve the pinned checksum", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-worker-release-test-"));
  const releaseRoot = path.join(root, "release");
  const enrollmentToken = "test-remote-worker-release-enrollment-token";
  const commit = "3".repeat(40);
  const archive = Buffer.from("versioned-worker-package");
  const macArchive = Buffer.from("versioned-worker-package-mac");
  const fileName = `codex-web-remote-worker-${REMOTE_WORKER_TARGET_VERSION}-win-x64.zip`;
  const macFileName = `codex-web-remote-worker-${REMOTE_WORKER_TARGET_VERSION}-macos-universal.tar.gz`;
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, fileName), archive);
  fs.writeFileSync(path.join(releaseRoot, macFileName), macArchive);
  const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const macSha256 = crypto.createHash("sha256").update(macArchive).digest("hex");
  fs.writeFileSync(path.join(releaseRoot, "manifest.json"), JSON.stringify({
    format: "codex-web-remote-worker-release-manifest-v1",
    version: REMOTE_WORKER_TARGET_VERSION,
    ref: REMOTE_WORKER_TARGET_REF,
    commit,
    platform: "win32-x64",
    archive: { fileName, sha256, size: archive.length },
    platforms: {
      "win32-x64": { fileName, sha256, size: archive.length, format: "zip" },
      "darwin-universal": { fileName: macFileName, sha256: macSha256, size: macArchive.length, format: "tar.gz" },
    },
  }));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    remoteWorkerEnrollmentToken: enrollmentToken, remoteWorkerReleaseRoot: releaseRoot,
  });
  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });
  context.after(() => {
    instance.remoteWorkers.close();
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await request(instance.app).get(`/api/remote-worker-release/${REMOTE_WORKER_TARGET_VERSION}/manifest.json`).expect(404);
  const manifest = await request(instance.app)
    .get(`/api/remote-worker-release/${REMOTE_WORKER_TARGET_VERSION}/manifest.json`)
    .set("Authorization", `Bearer ${enrollmentToken}`).expect(200);
  assert.equal(manifest.body.commit, commit);
  assert.equal(manifest.body.archive.sha256, sha256);
  const downloaded = await request(instance.app)
    .get(`/api/remote-worker-release/${REMOTE_WORKER_TARGET_VERSION}/archive`)
    .set("Authorization", `Bearer ${enrollmentToken}`).expect(200);
  assert.equal(downloaded.headers["x-checksum-sha256"], sha256);
  assert.equal(downloaded.headers["content-length"], String(archive.length));
  const macDownloaded = await request(instance.app)
    .get(`/api/remote-worker-release/${REMOTE_WORKER_TARGET_VERSION}/archive?platform=darwin-universal`)
    .set("Authorization", `Bearer ${enrollmentToken}`).expect(200);
  assert.equal(macDownloaded.headers["x-checksum-sha256"], macSha256);
  assert.equal(macDownloaded.headers["content-length"], String(macArchive.length));
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "owner", password: "fixture" }).expect(200);
  const bootstrap = await agent.post("/api/remote-worker-bootstrap").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  assert.deepEqual(bootstrap.body.platforms.map((platform: { platform: string }) => platform.platform), ["win32-x64", "darwin-universal"]);
  const windowsLink = bootstrap.body.platforms[0].url as string;
  const script = await request(instance.app).get(new URL(windowsLink).pathname).expect(200);
  assert.match(script.text, /remote-worker-bootstrap\/exchange/);
  const exchangeToken = windowsLink.split("/").at(-1)!;
  const exchanged = await request(instance.app).post("/api/remote-worker-bootstrap/exchange").send({ token: exchangeToken, platform: "win32-x64" }).expect(200);
  assert.equal(exchanged.body.enrollmentToken, enrollmentToken);
  await request(instance.app).post("/api/remote-worker-bootstrap/exchange").send({ token: exchangeToken, platform: "win32-x64" }).expect(410);
});

test("a replacement remote worker fails an observed job that it did not resume", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-reconcile-test-"));
  const enrollmentToken = "test-remote-worker-enrollment-token";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    remoteWorkerEnrollmentToken: enrollmentToken,
  });
  const server = http.createServer(instance.app);
  instance.remoteWorkers.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const workerId = crypto.randomUUID();
  const sockets: WebSocket[] = [];
  const connectWorker = (machineName: string): Promise<WebSocket> => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/remote-workers/connect`);
    sockets.push(socket);
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({
      type: "hello", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, workerId, machineName,
      enrollmentToken, platform: "win32-x64", workerVersion: "test", codexVersion: "test", capacity: 1,
    })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type === "authenticated") resolve(socket);
    });
  });
  context.after(async () => {
    instance.remoteWorkers.close();
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = await connectWorker("worker-host");
  const jobId = crypto.randomUUID();
  let resolveProgress!: () => void;
  const progressSeen = new Promise<void>((resolve) => { resolveProgress = resolve; });
  let resolveDispatch!: () => void;
  const dispatched = new Promise<void>((resolve) => { resolveDispatch = resolve; });
  first.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { type: string; request?: { jobId: string } };
    if (message.type === "run" && message.request?.jobId === jobId) resolveDispatch();
  });
  const result = instance.remoteWorkers.run(workerId, {
    jobId, conversationId: crypto.randomUUID(), projectRoot: "E:\\workspace\\work", codexThreadId: null,
    prompt: "rename this worker", selection: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  }, [], { onThreadStarted: () => undefined, onProgress: () => resolveProgress() });
  await dispatched;
  first.send(JSON.stringify({ type: "heartbeat", activeJobs: [jobId] }));
  first.send(JSON.stringify({ type: "event", jobId, event: { type: "progress", payload: { kind: "update", label: "started" } } }));
  await progressSeen;

  const replacement = await connectWorker("COM");
  replacement.send(JSON.stringify({ type: "heartbeat", activeJobs: [] }));
  await assert.rejects(result, /远程电脑重连后未恢复该任务/);
  assert.equal(instance.remoteWorkers.executor(`remote:${workerId}`)?.activeJobs, 0);
});

test("first-message Codex naming is audited independently and never overwrites a manual title", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-codex-title-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);

  let releaseTitle!: (title: string | null) => void;
  instance.conversationTitles.generate = async () => new Promise((resolve) => { releaseTitle = resolve; });
  const manualConversation = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const manualId = manualConversation.body.conversation.id as string;
  const manualSubmitted = await agent.post(`/api/conversations/${manualId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).field("message", "请整理销售数据").expect(202);
  await agent.patch(`/api/conversations/${manualId}`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ title: "我的标题" }).expect(200);
  releaseTitle("整理销售数据");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(instance.db.getConversation(manualId)?.title, "我的标题");
  assert.equal(instance.db.getConversation(manualId)?.title_source, "manual");
  assert.equal(instance.db.listEvents(manualSubmitted.body.job.id).some((event) => event.event_type === "conversation_title"), false);

  let receivedRequest: Parameters<typeof instance.conversationTitles.generate>[0] | undefined;
  instance.conversationTitles.generate = async (input) => { receivedRequest = input; return "优化任务命名"; };
  const automaticConversation = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const automaticId = automaticConversation.body.conversation.id as string;
  const submitted = await agent.post(`/api/conversations/${automaticId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).field("message", "请优化任务命名逻辑 api_key=example-test-secret").expect(202);
  for (let attempt = 0; attempt < 10 && instance.db.getConversation(automaticId)?.title_source !== "ai"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(receivedRequest?.requestText, "请优化任务命名逻辑 api_key=example-test-secret");
  assert.equal(receivedRequest?.projectName, "默认项目");
  assert.equal(receivedRequest?.executorId, "tenant-local");
  assert.equal(instance.db.getConversation(automaticId)?.title, "优化任务命名");
  assert.equal(instance.db.getConversation(automaticId)?.title_source, "ai");
  assert.ok(instance.db.listEvents(submitted.body.job.id).some((event) => event.event_type === "conversation_title"));
  const audits = instance.db.listConversationTitleAudits(automaticId);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].model, "gpt-5.6-luna");
  assert.equal(audits[0].reasoning_effort, "low");
  assert.equal(audits[0].status, "succeeded");
  assert.equal(audits[0].applied, 1);
  assert.equal(audits[0].output_title, "优化任务命名");
  assert.equal(audits[0].request_excerpt, "请优化任务命名逻辑 api_key=[REDACTED]");
  assert.match(audits[0].request_sha256, /^[0-9a-f]{64}$/);
});

test("quoted selections stay outside the visible message body and survive the pending queue", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-message-quote-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "这和上一段有什么关系？")
    .field("quoteExcerpt", "  被引用的第一行\r\n被引用的第二行  ")
    .field("voiceTranscriptionIds", "[]")
    .field("model", "gpt-5.6-sol")
    .field("reasoningEffort", "high")
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

test("conversation stop cancels every active job and tombstone deletion removes physical state and associated rows", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-soft-delete-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot, queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
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
  instance.db.appendEvent(runningJobId, "progress", { kind: "update", label: "阶段反馈", detail: "已完成环境检查并定位关键配置" });
  instance.db.appendEvent(runningJobId, "progress", { kind: "command", label: "资料读取与核对完成", detail: "private command is intentionally omitted from summary" });

  await agent.post(`/api/conversations/${conversationId}/cancel`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(instance.db.getJob(queuedJobId)?.status, "cancelled");
  assert.equal(instance.db.getJob(runningJobId)?.status, "cancelled");
  assert.equal(instance.db.getConversationForUser(conversationId, LEGACY_USER_ID)?.id, conversationId);
  const stoppedSummary = instance.db.listMessages(conversationId).at(-1)!;
  assert.equal(stoppedSummary.role, "assistant");
  assert.match(stoppedSummary.content, new RegExp(USER_CANCELLED_TASK_MARKER));
  assert.match(stoppedSummary.content, /已完成环境检查并定位关键配置/);
  assert.match(stoppedSummary.content, /资料读取与核对完成/);
  assert.doesNotMatch(stoppedSummary.content, /private command/);
  assert.equal(latestUserCancellationContext(instance.db.listMessages(conversationId)), stoppedSummary.content);

  const deletionJobId = crypto.randomUUID();
  instance.db.createJob(deletionJobId, conversationId, messageId);
  instance.db.updateJob(deletionJobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  fs.writeFileSync(path.join(workspace, "uploads", "input.txt"), "physical input", "utf8");
  const pending = await agent.post(`/api/conversations/${conversationId}/messages`)
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

  const originalDeletePending = instance.db.deletePendingPromptsForConversation.bind(instance.db);
  let observedDrainBeforeFileGc = false;
  instance.db.deletePendingPromptsForConversation = (id: string) => {
    observedDrainBeforeFileGc = true;
    assert.equal(instance.db.listActiveJobsForConversation(id).length, 0, "GC must drain active jobs before deleting file metadata");
    return originalDeletePending(id);
  };

  await agent.delete(`/api/conversations/${conversationId}`).set("X-CSRF-Token", login.body.csrfToken).expect(204);
  assert.equal(observedDrainBeforeFileGc, true);
  assert.equal(instance.db.getConversation(conversationId), undefined);
  assert.equal(instance.db.listConversations(LEGACY_USER_ID).some((row) => row.id === conversationId), false);
  assert.equal(instance.db.listMessages(conversationId).length, 0);
  assert.equal(instance.db.listFiles(conversationId).length, 0);
  assert.equal(instance.db.getJob(deletionJobId), undefined);
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  assert.equal(instance.db.listPendingPrompts(conversationId, "editing").length, 0);
  assert.equal(instance.db.listEvents(runningJobId).length, 0);
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(fs.existsSync(pendingAbsolute), false);
  assert.equal(fs.existsSync(storedAbsolute), false);
  assert.equal(fs.existsSync(sessionFile), false);
  await instance.pumpQueue();
  assert.deepEqual(instance.db.listMessages(conversationId), []);
  await agent.get(`/api/conversations/${conversationId}`).expect(404);
  await agent.get(`/api/files/${fileId}`).expect(404);
  await agent.get(`/api/jobs/${deletionJobId}/events`).expect(404);
});

test("failed conversation GC remains tombstoned and can be retried idempotently", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-delete-saga-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const id = created.body.conversation.id as string;
  instance.db.updateConversation(id, { codexThreadId: crypto.randomUUID() });
  const originalDeleteThread = instance.runner.deleteCodexThread.bind(instance.runner);
  instance.runner.deleteCodexThread = async () => { throw new Error("simulated remote cleanup outage"); };
  const failed = await agent.delete(`/api/conversations/${id}`).set("X-CSRF-Token", login.body.csrfToken).expect(503);
  assert.equal(failed.body.cleanupState, "cleanup_failed");
  assert.equal(failed.body.retryable, true);
  assert.equal(instance.db.getConversationForUser(id, LEGACY_USER_ID), undefined);
  assert.equal(instance.db.getConversation(id)?.deletion_state, "cleanup_failed");
  await agent.post(`/api/conversations/${id}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "must not re-enter" }).expect(404);
  instance.runner.deleteCodexThread = originalDeleteThread;
  await agent.delete(`/api/conversations/${id}`).set("X-CSRF-Token", login.body.csrfToken).expect(204);
  assert.equal(instance.db.getConversation(id), undefined);
});

test("web users have isolated conversations, files, jobs, settings, and tenant directories", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-multi-user-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  const friendId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.createUser({
    id: friendId, username: "friend", display_name: "朋友", password_hash: bcrypt.hashSync("fixture", 8),
    role: "member", status: "active", created_at: now, updated_at: now,
  });
  const friendTenant = ensureTenant(tenantRoot, friendId);
  const ownerTenant = ensureTenant(tenantRoot, LEGACY_USER_ID);
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  assert.notEqual(friendTenant.codexHome, ownerTenant.codexHome);

  const owner = request.agent(instance.app);
  const friend = request.agent(instance.app);
  const ownerLogin = await owner.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const friendLogin = await friend.post("/api/auth/login").send({ username: "friend", password: "fixture" }).expect(200);
  assert.equal(ownerLogin.body.accountId, LEGACY_USER_ID);
  assert.equal(friendLogin.body.accountId, friendId);
  assert.ok(fs.existsSync(path.join(friendTenant.library, "default", "PROFILE.md")));
  assert.ok(fs.existsSync(path.join(friendTenant.library, "default", "projects")));
  const ownerConversation = await owner.post("/api/conversations").set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(201);
  const friendConversation = await friend.post("/api/conversations").set("X-CSRF-Token", friendLogin.body.csrfToken).expect(201);

  assert.deepEqual((await owner.get("/api/conversation-selection").query({
    conversationId: ownerConversation.body.conversation.id,
    projectId: ownerConversation.body.conversation.project_id,
  }).expect(200)).body, {
    valid: true,
    conversationId: ownerConversation.body.conversation.id,
    projectId: ownerConversation.body.conversation.project_id,
  });
  assert.deepEqual((await friend.get("/api/conversation-selection").query({
    conversationId: ownerConversation.body.conversation.id,
    projectId: ownerConversation.body.conversation.project_id,
  }).expect(200)).body, { valid: false, conversationId: null, projectId: null });

  const ownerList = await owner.get("/api/conversations").expect(200);
  const friendList = await friend.get("/api/conversations").expect(200);
  assert.deepEqual(ownerList.body.conversations.map((row: { id: string }) => row.id), [ownerConversation.body.conversation.id]);
  assert.deepEqual(friendList.body.conversations.map((row: { id: string }) => row.id), [friendConversation.body.conversation.id]);
  await owner.get(`/api/conversations/${friendConversation.body.conversation.id}`).expect(404);
  await friend.get(`/api/conversations/${ownerConversation.body.conversation.id}`).expect(404);
  await owner.put(`/api/conversations/${friendConversation.body.conversation.id}/pin`)
    .set("X-CSRF-Token", ownerLogin.body.csrfToken).send({ pinned: true }).expect(404);
  await owner.post(`/api/conversations/${friendConversation.body.conversation.id}/seen`)
    .set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(404);

  instance.db.setAgentSelectionPreference({ model: "gpt-5.6-terra", reasoningEffort: "high" }, friendId);
  assert.notDeepEqual(instance.db.getAgentSelectionPreference(LEGACY_USER_ID), instance.db.getAgentSelectionPreference(friendId));
  await friend.put("/api/user-settings/chat-font-size")
    .set("X-CSRF-Token", friendLogin.body.csrfToken).send({ chatFontSize: 20 }).expect(200);
  assert.equal(instance.db.getChatFontSize(friendId), 20);
  assert.equal(instance.db.getChatFontSize(LEGACY_USER_ID), CHAT_FONT_SIZE_DEFAULT);
  assert.equal((await owner.get("/api/auth/session").expect(200)).body.chatFontSize, CHAT_FONT_SIZE_DEFAULT);
  assert.equal((await friend.get("/api/auth/session").expect(200)).body.chatFontSize, 20);

  const friendMessageId = crypto.randomUUID();
  instance.db.addMessage({ id: friendMessageId, conversation_id: friendConversation.body.conversation.id, role: "user", content: "private", created_at: now });
  const friendFileId = crypto.randomUUID();
  const friendWorkspace = ensureTenantWorkspace(tenantRoot, friendId, friendConversation.body.conversation.id);
  fs.writeFileSync(path.join(friendWorkspace, "uploads", "private.txt"), "private", "utf8");
  instance.db.addFile({
    id: friendFileId, conversation_id: friendConversation.body.conversation.id, message_id: friendMessageId,
    original_name: "private.txt", relative_path: "uploads/private.txt", mime_type: "text/plain", size: 7, kind: "upload", created_at: now,
  });
  await owner.get(`/api/files/${friendFileId}`).expect(404);
  const friendText = await friend.get(`/api/files/${friendFileId}`).expect(200);
  assert.match(friendText.headers["content-type"], /^text\/plain;\s*charset=utf-8$/i);

  const friendJobId = crypto.randomUUID();
  instance.db.createJob(friendJobId, friendConversation.body.conversation.id, friendMessageId, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  await owner.get(`/api/jobs/${friendJobId}/events`).expect(404);
  await owner.post(`/api/jobs/${friendJobId}/cancel`).set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(404);
  await friend.post(`/api/jobs/${friendJobId}/cancel`).set("X-CSRF-Token", friendLogin.body.csrfToken).expect(200);
});

test("composer drafts and attachments survive browser sessions and are consumed atomically", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-composer-draft-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const firstBrowser = request.agent(instance.app);
  const firstLogin = await firstBrowser.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await firstBrowser.post("/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  const saved = await firstBrowser.put(`/api/conversations/${conversationId}/draft`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .send({ content: "  尚未写完\n第二行  ", quoteExcerpt: "引用片段" }).expect(200);
  assert.equal(saved.body.composerDraft.content, "  尚未写完\n第二行  ");
  assert.equal(saved.body.composerDraft.quote_excerpt, "引用片段");
  const draftOnlyList = await firstBrowser.get("/api/conversations").expect(200);
  assert.equal(draftOnlyList.body.conversations.find((conversation: { id: string }) => conversation.id === conversationId).has_pending_work, 0);

  const uploaded = await firstBrowser.post(`/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .attach("files", Buffer.from("draft attachment"), { filename: "草稿附件.txt", contentType: "text/plain" })
    .expect(201);
  const uploadedFile = uploaded.body.composerDraft.files[0] as { id: string; relative_path: string; original_name: string };
  assert.equal(uploadedFile.original_name, "草稿附件.txt");
  assert.deepEqual(uploaded.body.uploadedFiles.map((file: { id: string }) => file.id), [uploadedFile.id]);
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  const uploadedPath = path.join(workspace, uploadedFile.relative_path);
  assert.equal(fs.existsSync(uploadedPath), true);

  // A fresh HTTP session represents another browser or device; no client-side
  // storage is involved in recovering either text or files.
  const secondBrowser = request.agent(instance.app);
  const secondLogin = await secondBrowser.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  let detail = await secondBrowser.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.composerDraft.content, "  尚未写完\n第二行  ");
  assert.equal(detail.body.composerDraft.quote_excerpt, "引用片段");
  assert.deepEqual(detail.body.composerDraft.files.map((file: { original_name: string }) => file.original_name), ["草稿附件.txt"]);

  await secondBrowser.put(`/api/conversations/${conversationId}/draft`)
    .set("X-CSRF-Token", secondLogin.body.csrfToken)
    .send({ content: "另一台设备继续写", quoteExcerpt: "" }).expect(200);
  detail = await firstBrowser.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.composerDraft.content, "另一台设备继续写");

  await firstBrowser.delete(`/api/conversations/${conversationId}/draft/files/${uploadedFile.id}`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken).expect(200);
  assert.equal(fs.existsSync(uploadedPath), false);

  const finalUpload = await secondBrowser.post(`/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", secondLogin.body.csrfToken)
    .attach("files", Buffer.from("final attachment"), { filename: "final.txt", contentType: "text/plain" })
    .expect(201);
  const finalFileId = finalUpload.body.composerDraft.files[0].id as string;
  await secondBrowser.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", secondLogin.body.csrfToken)
    .field("message", "另一台设备继续写")
    .field("quoteExcerpt", "")
    .field("useComposerDraft", "true")
    .expect(202);

  assert.equal(instance.db.getComposerDraft(conversationId), undefined);
  const messages = instance.db.listMessages(conversationId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "另一台设备继续写");
  assert.deepEqual(messages[0].files.map((file) => file.original_name), ["final.txt"]);
  const materializedFile = instance.db.getFile(finalFileId)!;
  assert.equal(materializedFile.message_id, messages[0].id);
  assert.equal(materializedFile.pending_prompt_id, null);
  assert.equal(materializedFile.composer_draft_id, null);
  assert.equal((await firstBrowser.get(`/api/conversations/${conversationId}`).expect(200)).body.composerDraft, null);

  await firstBrowser.put(`/api/conversations/${conversationId}/draft`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken).send({ content: "排队的后续任务", quoteExcerpt: "" }).expect(200);
  const queuedUpload = await firstBrowser.post(`/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .attach("files", Buffer.from("queued attachment"), { filename: "queued.txt", contentType: "text/plain" }).expect(201);
  const queued = await firstBrowser.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .field("message", "排队的后续任务").field("useComposerDraft", "true").expect(202);
  assert.equal(queued.body.pendingPrompt.content, "排队的后续任务");
  assert.deepEqual(queued.body.pendingPrompt.files.map((file: { original_name: string }) => file.original_name), ["queued.txt"]);
  assert.equal(instance.db.getFile(queuedUpload.body.composerDraft.files[0].id)?.pending_prompt_id, queued.body.pendingPrompt.id);
  assert.equal(instance.db.getComposerDraft(conversationId), undefined);

  const clearable = await firstBrowser.post("/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken).expect(201);
  const clearableId = clearable.body.conversation.id as string;
  const clearUpload = await firstBrowser.post(`/api/conversations/${clearableId}/draft/files`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .attach("files", Buffer.from("discard me"), { filename: "discard.txt", contentType: "text/plain" })
    .expect(201);
  const clearPath = path.join(ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, clearableId), clearUpload.body.composerDraft.files[0].relative_path);
  assert.equal(fs.existsSync(clearPath), true);
  await firstBrowser.delete(`/api/conversations/${clearableId}/draft`).set("X-CSRF-Token", firstLogin.body.csrfToken).expect(204);
  assert.equal(instance.db.getComposerDraft(clearableId), undefined);
  assert.equal(fs.existsSync(clearPath), false);

  const fileOnly = await firstBrowser.post("/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken)
    .send({ reuseEmpty: false }).expect(201);
  const fileOnlyId = fileOnly.body.conversation.id as string;
  await firstBrowser.post(`/api/conversations/${fileOnlyId}/draft/files`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .attach("files", Buffer.from("needs instruction"), { filename: "needs-instruction.txt", contentType: "text/plain" }).expect(201);
  const awaitingInstruction = await firstBrowser.post(`/api/conversations/${fileOnlyId}/messages`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .field("message", "").field("useComposerDraft", "true").expect(202);
  assert.equal(awaitingInstruction.body.needsInstruction, true);
  assert.equal(awaitingInstruction.body.editingPrompt.status, "editing");
  assert.deepEqual(awaitingInstruction.body.editingPrompt.files.map((file: { original_name: string }) => file.original_name), ["needs-instruction.txt"]);
  assert.equal(instance.db.getComposerDraft(fileOnlyId), undefined);
});

test("file-only submissions persist on the server and wait for a real instruction", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-awaiting-instruction-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const firstBrowser = request.agent(instance.app);
  const firstLogin = await firstBrowser.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await firstBrowser.post("/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  const uploadedOnly = await firstBrowser.post(`/api/conversations/${conversationId}/messages`)
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
  const reopenedLogin = await reopenedBrowser.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  let detail = await reopenedBrowser.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.editingPrompt.id, awaitingId);
  assert.deepEqual(detail.body.editingPrompt.files.map((file: { original_name: string }) => file.original_name), ["first.png"]);
  await reopenedBrowser.post(`/api/conversations/${conversationId}/pending-prompts/${awaitingId}/restore`)
    .set("X-CSRF-Token", reopenedLogin.body.csrfToken)
    .expect(409);
  assert.equal(instance.db.listQueuedJobs().length, 0);

  const moreFiles = await reopenedBrowser.put(`/api/conversations/${conversationId}/pending-prompts/${awaitingId}`)
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

  await reopenedBrowser.put(`/api/conversations/${conversationId}/pending-prompts/${awaitingId}`)
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
  detail = await reopenedBrowser.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.editingPrompt, null);
  assert.equal(detail.body.pendingPrompts.length, 0);
});

test("later submissions stay out of chat as drafts and materialize one at a time", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-queue-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const first = await agent.post(`/api/conversations/${conversationId}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "first" }).expect(202);
  const second = await agent.post(`/api/conversations/${conversationId}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "second" }).expect(202);
  const third = await agent.post(`/api/conversations/${conversationId}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "third" }).expect(202);
  assert.equal(first.body.job.queuePosition, 1);
  assert.equal(second.body.queued, true);
  assert.equal(second.body.pendingPrompt.content, "second");
  assert.equal(instance.db.getJob(first.body.job.id)?.status, "queued");
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 2);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first"]);
  await agent.put(`/api/conversations/${conversationId}/pending-prompts/order`)
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
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const first = await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "first" }).expect(202);
  const alpha = await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).field("message", "alpha").attach("files", Buffer.from("old"), { filename: "old.txt", contentType: "text/plain" }).expect(202);
  const beta = await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "beta" }).expect(202);
  const gamma = await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "gamma" }).expect(202);
  const alphaId = alpha.body.pendingPrompt.id as string;
  const betaId = beta.body.pendingPrompt.id as string;
  const gammaId = gamma.body.pendingPrompt.id as string;
  const oldFile = instance.db.getPendingPrompt(alphaId)!.files[0];
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  assert.equal(fs.existsSync(path.join(workspace, oldFile.relative_path)), true);
  let detail = await agent.get(`/api/conversations/${conversationId}`).expect(200);
  assert.deepEqual(detail.body.messages.map((message: { content: string }) => message.content), ["first"]);
  assert.deepEqual(detail.body.pendingPrompts.map((prompt: { id: string }) => prompt.id), [alphaId, betaId, gammaId]);

  await agent.put(`/api/conversations/${conversationId}/pending-prompts/order`)
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
  await agent.post(`/api/conversations/${conversationId}/pending-prompts/${gammaId}/steer`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(steeredPrompt, "gamma");
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "gamma"]);

  await agent.delete(`/api/conversations/${conversationId}/pending-prompts/${betaId}`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(204);
  await agent.post(`/api/conversations/${conversationId}/pending-prompts/${alphaId}/edit`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  assert.equal(instance.db.listPendingPrompts(conversationId, "editing")[0].id, alphaId);

  releases.get(first.body.job.id)!();
  for (let attempt = 0; attempt < 30 && instance.db.getJob(first.body.job.id)?.status !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(instance.db.listActiveJobsForConversation(conversationId).length, 0);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "gamma"]);

  await agent.put(`/api/conversations/${conversationId}/pending-prompts/${alphaId}`)
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
  detail = await agent.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.pendingPrompts.length, 0);
  assert.equal(detail.body.editingPrompt, null);
});

test("maintenance status is pushed to every connected client and clears automatically", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-maintenance-status-test-"));
  const dataRoot = path.join(root, "data");
  const marker = path.join(dataRoot, ".codex-update-maintenance");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  const server = instance.app.listen(0, "127.0.0.1");
  const controllers: AbortController[] = [];
  context.after(async () => {
    controllers.forEach((controller) => controller.abort());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "demo-owner", password: "fixture" }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.clone().json().then((value) => {
    const status = value as { maintenance: boolean; maintenancePhase: string };
    return { maintenance: status.maintenance, maintenancePhase: status.maintenancePhase };
  }), { maintenance: false, maintenancePhase: "idle" });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  type SseClient = { reader: ReadableStreamDefaultReader<Uint8Array>; buffer: string };
  async function connect(): Promise<SseClient> {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}/api/system/events`, { headers: { Cookie: cookie! }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    return { reader: response.body!.getReader(), buffer: "" };
  }
  async function nextStatus(client: SseClient): Promise<string> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const boundary = client.buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const block = client.buffer.slice(0, boundary);
        client.buffer = client.buffer.slice(boundary + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (!data) continue;
        const parsed = JSON.parse(data) as { type?: string; maintenancePhase?: string };
        if (parsed.type === "system_status") return parsed.maintenancePhase ?? "missing";
        continue;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for maintenance status event");
      const result = await client.reader.read();
      if (result.done) throw new Error("maintenance status stream closed unexpectedly");
      client.buffer += new TextDecoder().decode(result.value, { stream: true }).replace(/\r\n/g, "\n");
    }
  }

  const clients = await Promise.all([connect(), connect()]);
  assert.deepEqual(await Promise.all(clients.map(nextStatus)), ["idle", "idle"]);
  fs.writeFileSync(marker, "preparing\n", "utf8");
  const preparingStatus = await fetch(`${origin}/api/system/status`, { headers: { Cookie: cookie! } }).then((response) => response.json()) as { maintenance: boolean; maintenancePhase: string; message: string };
  assert.equal(preparingStatus.maintenance, true);
  assert.equal(preparingStatus.maintenancePhase, "preparing");
  assert.match(preparingStatus.message, /准备维护/);
  assert.deepEqual(await Promise.all(clients.map(nextStatus)), ["preparing", "preparing"]);

  fs.writeFileSync(marker, "active\n", "utf8");
  const activeStatus = await fetch(`${origin}/api/system/status`, { headers: { Cookie: cookie! } }).then((response) => response.json()) as { maintenance: boolean; maintenancePhase: string; message: string };
  assert.equal(activeStatus.maintenance, true);
  assert.equal(activeStatus.maintenancePhase, "active");
  assert.match(activeStatus.message, /正在维护/);
  assert.deepEqual(await Promise.all(clients.map(nextStatus)), ["active", "active"]);

  fs.writeFileSync(marker, "legacy marker content", "utf8");
  const legacyStatus = await fetch(`${origin}/api/system/status`, { headers: { Cookie: cookie! } }).then((response) => response.json()) as { instanceId: string; maintenance: boolean; maintenancePhase: string; message: string; maintenanceWait: null };
  const { instanceId, ...legacyPayload } = legacyStatus;
  assert.match(instanceId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(legacyPayload, { maintenance: true, maintenancePhase: "active", message: "Codex Web 正在维护，已提交的任务会安全排队并在维护结束后继续。", maintenanceWait: null, deployment: null });
  fs.rmSync(marker);
  assert.deepEqual(await Promise.all(clients.map(nextStatus)), ["idle", "idle"]);
});

test("maintenance preparation exposes safe wait progress and flags stale activity", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-maintenance-wait-test-"));
  const dataRoot = path.join(root, "data");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "内部维护任务");
  const messageId = crypto.randomUUID();
  instance.db.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: "long task", created_at: now });
  const job = instance.db.createJob(crypto.randomUUID(), conversation.id, messageId);
  instance.db.updateJob(job.id, "running");
  instance.db.updateConversation(conversation.id, { status: "running" });
  const staleAt = new Date(Date.now() - 6 * 60_000).toISOString();
  instance.db.sqlite.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(staleAt, job.id);
  fs.writeFileSync(path.join(dataRoot, ".codex-update-maintenance"), "preparing\n", "utf8");

  const member = request.agent(instance.app);
  const memberLogin = await member.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const memberStatus = await member.get("/api/system/status").expect(200);
  assert.equal(memberStatus.body.maintenanceWait.runningJobs, 1);
  assert.equal(memberStatus.body.maintenanceWait.taskTitle, null);
  assert.equal(memberStatus.body.maintenanceWait.lastActivityAt, staleAt);
  assert.equal(memberStatus.body.maintenanceWait.stalled, true);
  assert.match(memberStatus.body.message, /超过 5 分钟/);
  assert.ok(memberLogin.body.authenticated);

  const host = request.agent(instance.app);
  await host.post("/api/auth/login").send({ username: "owner", password: "fixture" }).expect(200);
  const hostStatus = await host.get("/api/system/status").expect(200);
  assert.equal(hostStatus.body.maintenanceWait.taskTitle, "内部维护任务");
  assert.match(hostStatus.body.message, /等待“内部维护任务”完成/);
});

test("system status keeps the latest deployment phase after maintenance ends", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-deployment-status-test-"));
  const dataRoot = path.join(root, "data");
  const deployStatusFile = path.join(root, "deploy-status.json");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), deployStatusFile, queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  fs.writeFileSync(deployStatusFile, JSON.stringify({
    requestId: 29, targetSha: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    status: "promoting", phase: "health_check", message: "正在进行生产健康检查。", requestedAt: new Date().toISOString(),
    errorCode: null, errorSummary: null,
    phaseHistory: [
      { phase: "queued", at: "2026-08-26T00:00:00Z" },
      { phase: "building", at: "2026-08-26T00:00:01Z" },
      { phase: "candidate_ready", at: "2026-08-26T00:01:00Z" },
      { phase: "health_check", at: "2026-08-26T00:02:00Z" },
      { phase: "not-a-phase", at: "2026-08-26T00:03:00Z" },
    ],
  }));
  const status = await agent.get("/api/system/status").expect(200);
  assert.equal(status.body.maintenance, false);
  assert.equal(status.body.deployment.requestId, 29);
  assert.equal(status.body.deployment.phase, "health_check");
  assert.equal(status.body.deployment.targetSha.length, 64);
  assert.equal(status.body.deployment.errorSummary, null);
  assert.deepEqual(status.body.deployment.phaseHistory, [
    { phase: "queued", at: "2026-08-26T00:00:00Z" },
    { phase: "building", at: "2026-08-26T00:00:01Z" },
    { phase: "candidate_ready", at: "2026-08-26T00:01:00Z" },
    { phase: "health_check", at: "2026-08-26T00:02:00Z" },
  ]);
});

test("maintenance gate pauses dispatch while submissions, edits, and steering remain available", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-update-gate-test-"));
  const dataRoot = path.join(root, "data");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;
  const first = await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "already running" }).expect(202);

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

  fs.writeFileSync(path.join(dataRoot, ".codex-update-maintenance"), "preparing\n");
  const oldMarkerTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dataRoot, ".codex-update-maintenance"), oldMarkerTime, oldMarkerTime);
  const steering = await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "guide during maintenance" }).expect(202);
  const queued = await agent.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "wait during maintenance" }).expect(202);
  assert.equal(steering.body.queued, true);
  assert.equal(queued.body.queued, true);
  assert.equal(steering.body.maintenance, true);
  assert.equal(queued.body.maintenance, true);
  assert.equal(steering.body.maintenancePhase, "preparing");
  assert.equal(queued.body.maintenancePhase, "preparing");
  assert.match(queued.body.guidance, /任务已保存到等待队列/);

  await agent.post(`/api/conversations/${conversationId}/pending-prompts/${queued.body.pendingPrompt.id}/edit`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  await agent.put(`/api/conversations/${conversationId}/pending-prompts/${queued.body.pendingPrompt.id}`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "edited while maintenance is active")
    .field("removedFileIds", "[]")
    .expect(200);
  await agent.post(`/api/conversations/${conversationId}/pending-prompts/${steering.body.pendingPrompt.id}/steer`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(steeredPrompt, "guide during maintenance");

  releases.get(first.body.job.id)!();
  for (let attempt = 0; attempt < 30 && instance.db.getJob(first.body.job.id)?.status !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  await instance.pumpQueue();
  assert.equal(instance.db.listActiveJobsForConversation(conversationId).length, 0);
  assert.deepEqual(instance.db.listPendingPrompts(conversationId).map((prompt) => prompt.content), ["edited while maintenance is active"]);
  const maintenanceList = await agent.get("/api/conversations").expect(200);
  const maintenanceConversation = maintenanceList.body.conversations.find((conversation: { id: string }) => conversation.id === conversationId);
  assert.equal(maintenanceConversation.status, "idle");
  assert.equal(maintenanceConversation.has_pending_work, 1);

  fs.rmSync(path.join(dataRoot, ".codex-update-maintenance"));
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 20 && instance.db.listActiveJobsForConversation(conversationId).length === 0; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const resumed = instance.db.listActiveJobsForConversation(conversationId)[0];
  assert.ok(resumed);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["already running", "guide during maintenance", "edited while maintenance is active"]);
  releases.get(resumed.id)!();
  for (let attempt = 0; attempt < 20 && instance.db.getJob(resumed.id)?.status !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
});

test("maintenance deployment templates queue, verify, and publish a clean commit", () => {
  const rebuild = fs.readFileSync(path.join(process.cwd(), "deploy", "codex-web-rebuild"), "utf8");
  const requestRebuild = fs.readFileSync(path.join(process.cwd(), "deploy", "codex-web-request-rebuild"), "utf8");
  const coordinator = fs.readFileSync(path.join(process.cwd(), "deploy", "codex-web-rebuild-coordinator"), "utf8");
  const stateHelper = fs.readFileSync(path.join(process.cwd(), "deploy", "codex-web-deploy-state.py"), "utf8");
  const selfMaintain = fs.readFileSync(path.join(process.cwd(), "deploy", "codex-web-self-maintain.service"), "utf8");
  const pathUnit = fs.readFileSync(path.join(process.cwd(), "deploy", "codex-web-self-maintain.path"), "utf8");
  assert.match(requestRebuild, /PENDING_FILE|pending-commit/);
  assert.match(requestRebuild, /status|enqueue|clean/i);
  assert.match(coordinator, /STATE_HELPER|state claim|queue paused/);
  assert.match(stateHelper, /deployment_requests|target_sha|phase_history/);
  assert.match(rebuild, /docker compose|CODEX_WEB_EXPECTED_COMMIT|previous-commit/);
  assert.match(rebuild, /npm run verify/);
  assert.match(selfMaintain, /ExecStart=.*codex-web-rebuild-coordinator/);
  assert.match(pathUnit, /PathExists=.*pending-commit/);
  const dockerfile = fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY deploy \.\/deploy/);
  assert.match(dockerfile, /COPY skills \.\/skills/);
  assert.match(dockerfile, /COPY account-resources \.\/account-resources/);
});

test("persisted rebuild coordinator records conflict queue progress and pauses terminal failures", (context) => {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    context.skip("deployment coordinator requires root");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-deploy-coordinator-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requestRoot = path.join(root, "state");
  fs.mkdirSync(requestRoot, { recursive: true });
  const fakeGit = path.join(root, "git");
  const fakeRebuild = path.join(root, "rebuild");
  const calls = path.join(root, "calls");
  const stateHelper = path.join(process.cwd(), "deploy", "codex-web-deploy-state.py");
  const stateDb = path.join(requestRoot, "state.sqlite");
  const firstCommit = "1111111111111111111111111111111111111111";
  const secondCommit = "2222222222222222222222222222222222222222";
  fs.writeFileSync(fakeGit, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(fakeRebuild, `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$CODEX_WEB_EXPECTED_COMMIT" >>"$TEST_CALLS"
if [[ "$CODEX_WEB_EXPECTED_COMMIT" == "$TEST_FIRST_COMMIT" ]]; then
  python3 "$TEST_STATE_HELPER" --db "$TEST_STATE_DB" enqueue --target "$TEST_SECOND_COMMIT" --base "$TEST_FIRST_COMMIT" --source test >/dev/null
  exit 75
fi
`, { mode: 0o755 });
  const statusFile = path.join(requestRoot, "status.json");
  const helperArgs = ["--db", stateDb, "--status-file", statusFile];
  spawnSync("python3", [stateHelper, ...helperArgs, "init"], { encoding: "utf8" });
  spawnSync("python3", [stateHelper, ...helperArgs, "enqueue", "--target", firstCommit, "--base", firstCommit, "--source", "test"], { encoding: "utf8" });
  fs.writeFileSync(path.join(requestRoot, "pending-commit"), "queued\n");
  const coordinator = path.join(process.cwd(), "deploy", "codex-web-rebuild-coordinator");
  const baseEnv = {
    ...process.env,
    CODEX_WEB_PROJECT_DIR: root,
    CODEX_WEB_DEPLOY_REQUEST_ROOT: requestRoot,
    CODEX_WEB_DEPLOY_CONTROLLER_LOCK: path.join(root, "controller.lock"),
    CODEX_WEB_REBUILD_COMMAND: fakeRebuild,
    CODEX_WEB_DEPLOY_STATE_DB: stateDb,
    CODEX_WEB_DEPLOY_STATUS_FILE: statusFile,
    CODEX_WEB_DEPLOY_STATE_HELPER: stateHelper,
    TEST_CALLS: calls,
    TEST_REQUEST_ROOT: requestRoot,
    TEST_STATE_HELPER: stateHelper,
    TEST_STATE_DB: stateDb,
    TEST_FIRST_COMMIT: firstCommit,
    TEST_SECOND_COMMIT: secondCommit,
  };
  const reconciled = spawnSync("bash", [coordinator], { env: baseEnv, encoding: "utf8" });
  assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
  assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), [firstCommit, secondCommit]);
  assert.equal(fs.existsSync(path.join(requestRoot, "pending-commit")), false);
  const queueRows = JSON.parse(spawnSync("python3", [stateHelper, "--db", stateDb, "list"], { encoding: "utf8" }).stdout);
  assert.deepEqual(queueRows.map((row: { status: string }) => row.status), ["conflict", "deployed"]);
  assert.equal(fs.readFileSync(path.join(requestRoot, "deployed-commit"), "utf8").trim(), secondCommit);

  fs.rmSync(calls);
  spawnSync("python3", [stateHelper, ...helperArgs, "enqueue", "--target", firstCommit, "--base", firstCommit, "--source", "test-retry"], { encoding: "utf8" });
  fs.writeFileSync(path.join(requestRoot, "pending-commit"), "queued\n");
  fs.writeFileSync(fakeRebuild, "#!/usr/bin/env bash\nexit 23\n", { mode: 0o755 });
  const failed = spawnSync("bash", [coordinator], {
    env: { ...baseEnv, CODEX_WEB_DEPLOY_CONTROLLER_LOCK: path.join(root, "controller-failure.lock") },
    encoding: "utf8",
  });
  assert.equal(failed.status, 23, failed.stderr || failed.stdout);
  assert.equal(fs.existsSync(path.join(requestRoot, "pending-commit")), false);
  const failedRows = JSON.parse(spawnSync("python3", [stateHelper, "--db", stateDb, "list"], { encoding: "utf8" }).stdout);
  assert.equal(failedRows.at(-1).status, "failed");
  assert.equal(fs.readFileSync(path.join(requestRoot, "failed-commit"), "utf8").trim(), firstCommit);
});

test("maintenance queue wakes automatically after the gate is removed", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-update-wake-test-"));
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, ".codex-update-maintenance"), "preparing\n");
  const oldMarkerTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dataRoot, ".codex-update-maintenance"), oldMarkerTime, oldMarkerTime);
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), queueAutoStart: true,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const started: string[] = [];
  instance.runner.run = async (jobId, conversationId) => {
    started.push(jobId);
    instance.db.finishJob(jobId, conversationId, "completed");
  };
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const submitted = await agent.post(`/api/conversations/${created.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "resume automatically" }).expect(202);
  assert.equal(submitted.body.maintenance, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(instance.db.getJob(submitted.body.job.id)?.status, "queued");
  assert.deepEqual(started, []);
  const queuedList = await agent.get("/api/conversations").expect(200);
  assert.equal(queuedList.body.conversations.find((conversation: { id: string }) => conversation.id === created.body.conversation.id).has_pending_work, 1);

  fs.rmSync(path.join(dataRoot, ".codex-update-maintenance"));
  for (let attempt = 0; attempt < 30 && started.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(started, [submitted.body.job.id]);
  assert.equal(instance.db.getJob(submitted.body.job.id)?.status, "completed");
  const completedList = await agent.get("/api/conversations").expect(200);
  assert.equal(completedList.body.conversations.find((conversation: { id: string }) => conversation.id === created.body.conversation.id).has_pending_work, 0);
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /queueStatus\?\.label/);
  assert.match(appSource, /任务已保存到等待队列，维护完成后将自动开始/);
  assert.match(appSource, /data\.status === "running"[^\n]*setNotice/);
  assert.match(appSource, /latestQueueStatus\?\.label !== MAINTENANCE_QUEUE_GUIDANCE/);
});

test("sidebar distinguishes running work from queued work with animated and static indicators", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /conversation\.pinned_at && <Pin className="conversation-pin-icon"[^>]*aria-label="已置顶"/);
  assert.match(styles, /\.conversation-select > svg\.conversation-pin-icon \{ color: #b9bdcc; \}/);
  assert.match(styles, /\.conversation-row\.active \.conversation-select > svg \{ color: var\(--amber\); \}/);
  assert.match(appSource, /conversation\.status === "running" \|\| conversation\.external_status === "running"[\s\S]*LoaderCircle[\s\S]*Boolean\(conversation\.has_pending_work\) && !conversation\.active_wake_count[\s\S]*CircleDashed/);
  assert.match(appSource, /Boolean\(conversation\.active_wake_count\) && conversation\.status !== "running" && conversation\.external_status !== "running" && <button[\s\S]*className="conversation-wake-trigger"/);
  assert.doesNotMatch(appSource, /conversation\.external_status !== "running" && !conversation\.has_pending_work && <button/);
  assert.match(appSource, /maintenancePhase === "idle" \? "等待发送" : "等待维护结束后发送"/);
  assert.match(styles, /\.conversation-select > svg\.conversation-waiting \{ color: #9399ad; \}/);
  assert.match(styles, /\.conversation-wake-trigger \{[^}]*color: #9399ad;/);
  assert.match(styles, /\.conversation-row\.active \.conversation-wake-trigger \{ color: var\(--amber\); \}/);
});

test("account identity uses the signed-in display name for the label and avatar", () => {
  assert.deepEqual(resolveAccountIdentity({ username: "member", displayName: "WH" }), { displayName: "WH", initials: "WH" });
  assert.deepEqual(resolveAccountIdentity({ username: "wenhao", displayName: "Wen Hao" }), { displayName: "Wen Hao", initials: "WH" });
  assert.deepEqual(resolveAccountIdentity({ username: "friend", displayName: "文豪" }), { displayName: "文豪", initials: "文豪" });
});

test("account selection storage isolates users, removes unsafe legacy values, and resolves valid fallbacks", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const ownerKeys = accountSelectionStorageKeys("00000000-0000-4000-8000-000000000001");
  const friendKeys = accountSelectionStorageKeys("22222222-2222-4222-8222-222222222222");
  assert.notDeepEqual(ownerKeys, friendKeys);

  writeStoredSelection(storage, ownerKeys.project, "owner-project");
  writeStoredSelection(storage, ownerKeys.conversation, "owner-conversation");
  writeStoredSelection(storage, friendKeys.project, "friend-project");
  assert.equal(readStoredSelection(storage, ownerKeys.project), "owner-project");
  assert.equal(readStoredSelection(storage, ownerKeys.conversation), "owner-conversation");
  assert.equal(readStoredSelection(storage, friendKeys.project), "friend-project");
  assert.equal(readStoredSelection(storage, friendKeys.conversation), null);

  values.set(LEGACY_SELECTED_PROJECT_KEY, "unsafe-project");
  values.set(LEGACY_SELECTED_CONVERSATION_KEY, "unsafe-conversation");
  clearLegacySelectionStorage(storage);
  assert.equal(values.has(LEGACY_SELECTED_PROJECT_KEY), false);
  assert.equal(values.has(LEGACY_SELECTED_CONVERSATION_KEY), false);
  assert.equal(readStoredSelection(storage, ownerKeys.project), "owner-project");

  const projects = [{ id: "default" }, { id: "saved" }] as Project[];
  assert.equal(chooseSelectedProject("saved", projects, "default"), "saved");
  assert.equal(chooseSelectedProject("deleted", projects, "default"), "default");
  assert.equal(chooseSelectedProject("deleted", projects, "also-deleted"), "default");
  assert.equal(chooseSelectedProject("deleted", [], "default"), null);
});

test("workspace gates account selections until project and conversation validation complete", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /<Workspace key=\{session\.accountId\}/);
  assert.match(appSource, /const \[activeProjectId, setActiveProjectId\] = useState<string \| null>\(null\)/);
  assert.match(appSource, /const \[selectedId, setSelectedId\] = useState<string \| null>\(null\)/);
  assert.match(appSource, /if \(!projectsLoaded\) return;[\s\S]{0,300}api\.agentOptions/);
  assert.match(appSource, /if \(!conversationSelectionReady\) return;[\s\S]{0,2000}void reconcile\(selectedId(?:, true)?\)/);
  assert.doesNotMatch(appSource, /localStorage\.getItem\((?:SELECTED_PROJECT_KEY|SELECTED_CONVERSATION_KEY)\)/);
});

test("cold-storage activation and sidebar state are explicit and non-activating for background refresh", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "server", "app.ts"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const uiSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /api\.post\("\/conversations\/:id\/activate"/);
  assert.match(appSource, /res\.status\(202\)\.json\(\{ restoring: true, state: conversation\.cold_storage_state/);
  assert.match(appSource, /COLD_STORAGE_RESTORE_REQUIRED/);
  assert.match(apiSource, /activateConversation:\s*\(id: string\)/);
  assert.match(uiSource, /FolderArchive/);
  assert.match(uiSource, /title="已冷存储"/);
  assert.match(uiSource, /aria-label="正在恢复历史"/);
  assert.match(uiSource, /void reconcile\(selectedId, true\)/);
  assert.doesNotMatch(uiSource, /setInterval\([\s\S]{0,300}reconcile\([^,)]*,\s*true\)/);
});

test("manual wake scheduling exposes conversation placement and an explicit continuation selection", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const toolSource = fs.readFileSync(path.join(process.cwd(), "server", "wait-dynamic-tool.ts"), "utf8");
  assert.match(appSource, /type="checkbox" checked=\{newConversation\}/);
  assert.match(appSource, /续跑模型/);
  assert.match(appSource, /思考深度/);
  assert.match(appSource, /newConversation,[\s\S]{0,160}model,[\s\S]{0,80}reasoningEffort/);
  assert.match(appSource, /plan\.agent_model/);
  assert.match(appSource, /plan\.reasoning_effort/);
  assert.match(apiSource, /conversationId\?: string/);
  assert.match(toolSource, /only pass model or reasoningEffort when the user explicitly requested an override/);
});

test("different conversations start concurrently within configured safety limits", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-parallel-conversations-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const jobIds: string[] = [];
  for (const message of ["alpha", "beta", "gamma"]) {
    const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
    const submitted = await agent.post(`/api/conversations/${created.body.conversation.id}/messages`)
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
  assert.equal(reopened.getJob(runningId)?.finalization_state, "published");
  assert.equal(reopened.getJob(runningId)?.finalization_payload, null);
  assert.equal(reopened.getNextQueuedJob()?.id, queuedId);
  const messages = reopened.listMessages(conversationId);
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.match(messages.at(-1)?.content ?? "", /服务重启而中断.*没有自动重试/);
  assert.equal(reopened.getConversation(conversationId)?.has_unread_result, 1);
  assert.equal(reopened.getConversation(conversationId)?.unread_anchor_message_id, messages.at(-1)?.id);
  const events = reopened.listEvents(runningId);
  assert.equal(events.at(-1)?.event_type, "failed");
  assert.match(events.at(-1)?.payload ?? "", /interrupted/);
});

test("database restart preserves a leased remote Worker job for exact-turn recovery", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-recovery-db-test-"));
  const first = new AppDatabase(root);
  const project = first.createProject(crypto.randomUUID(), LEGACY_USER_ID, "remote", "E:\\work", `remote:${crypto.randomUUID()}`);
  const conversation = first.createConversation(crypto.randomUUID(), "remote recovery", undefined, LEGACY_USER_ID, project.id);
  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  first.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: "continue exactly once", created_at: new Date().toISOString() });
  first.createJob(jobId, conversation.id, messageId, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  first.updateJob(jobId, "running");
  first.updateConversation(conversation.id, { status: "running" });
  const recoveryRoot = path.join(root, "remote-worker-recovery");
  fs.mkdirSync(recoveryRoot, { recursive: true });
  fs.writeFileSync(path.join(recoveryRoot, `${jobId}.json`), "{}\n", { mode: 0o600 });
  first.close();

  const reopened = new AppDatabase(root);
  context.after(() => { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(reopened.getJob(jobId)?.status, "running");
  assert.equal(reopened.getConversation(conversation.id)?.status, "running");
  assert.equal(reopened.listMessages(conversation.id).length, 1);
});

test("shutdown gate retains queued jobs without dispatching them", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-shutdown-gate-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(async () => {
    await instance.waitForBackgroundTasks();
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "shutdown gate");
  instance.db.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "wait", created_at: new Date().toISOString() });
  instance.db.createJob(jobId, conversationId, messageId, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  let dispatched = false;
  instance.runner.run = async () => { dispatched = true; };
  instance.beginShutdown();
  await instance.pumpQueue();
  assert.equal(dispatched, false);
  assert.equal(instance.db.getJob(jobId)?.status, "queued");
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
  const expected = "/api/files/file-1?download=1";
  assert.equal(isLocalMarkdownUrl("sandbox:/mnt/data/ConditionType 统计结果.xlsx"), true);
  assert.deepEqual(resolveMessageFileLink("sandbox:/mnt/data/ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("D:\\workspace\\codex-web-web\\workspaces\\abc\\outputs\\ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("/home/owner/app/workspaces/abc/outputs/ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("outputs/ConditionType 统计结果.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("sandbox:/mnt/data/not-registered.xlsx", [file]), { kind: "unavailable", path: "sandbox:/mnt/data/not-registered.xlsx" });
  assert.deepEqual(resolveMessageFileLink("D:\\secret\\not-registered.xlsx", [file]), { kind: "unavailable", path: "D:/secret/not-registered.xlsx" });
  assert.deepEqual(resolveMessageFileLink("file:///E:/workspace/work/not-registered.xlsx", [file]), { kind: "unavailable", path: "E:/workspace/work/not-registered.xlsx" });
  assert.deepEqual(resolveMessageFileLink("outputs/../secret.xlsx", [file]), { kind: "unavailable" });
  assert.deepEqual(resolveMessageFileLink("../shared/secret.xlsx", [file], true), { kind: "unavailable", path: "../shared/secret.xlsx" });
  assert.deepEqual(resolveMessageFileLink("public/index.html", [file], true), { kind: "unavailable", path: "public/index.html" });
  const fetched = { ...file, id: "file-2", original_name: "index.html", relative_path: "deliverables/file-2/index.html", source_path: "E:/workspace/work/public/index.html", mime_type: "text/html" };
  assert.deepEqual(resolveMessageFileLink("E:\\workspace\\work\\public\\index.html", [fetched], true), { kind: "preview", href: "/files/file-2/preview" });
  const markdown = { ...file, id: "file-3", original_name: "report.md", relative_path: "deliverables/file-3/report.md", mime_type: "text/markdown" };
  assert.deepEqual(resolveMessageFileLink("outputs/report.md", [markdown]), { kind: "raw", href: "/api/files/file-3" });
  assert.deepEqual(resolveMessageFileLink("https://example.com/help", [file]), { kind: "regular", href: "https://example.com/help" });
  assert.deepEqual(remoteMessageFileReferences("给你：[public/index.html](E:/workspace/work/public/index.html)", [file], true), [
    { sourcePath: "E:/workspace/work/public/index.html", label: "public/index.html" },
  ]);
  assert.deepEqual(remoteMessageFileReferences("[重复](E:/workspace/work/public/index.html) [重复](E:/workspace/work/public/index.html)", [file], true).length, 1);
  assert.deepEqual(remoteMessageFileReferences("![截图](E:/workspace/work/public/image.png)", [file], true), []);
  assert.deepEqual(remoteMessageFileReferences("[已取回](E:/workspace/work/public/index.html)", [fetched], true), []);
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
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);

  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const diskName = `${crypto.randomUUID()}.pptx`;
  const raw = `结论。 :codex-file-citation{path="/app/workspaces/${conversationId}/uploads/${diskName}" artifact_kind="presentation" slide_number="2"}`;
  const wrappedUserMessage = [
    "# Files mentioned by the user:",
    "",
    "## codex-clipboard-car.png: C:/Users/Codex/AppData/Local/Temp/codex-clipboard-car.png",
    "",
    "## My request for Codex:",
    "读一下",
  ].join("\n");
  instance.db.createConversation(conversationId, "citation");
  instance.db.addMessage({ id: userMessageId, conversation_id: conversationId, role: "user", content: wrappedUserMessage, created_at: new Date().toISOString() });
  instance.db.addFile({
    id: crypto.randomUUID(), conversation_id: conversationId, message_id: userMessageId,
    original_name: "班级复盘.pptx", relative_path: `uploads/${diskName}`,
    mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 10, kind: "upload", created_at: new Date().toISOString(),
  });
  instance.db.addMessage({ id: assistantMessageId, conversation_id: conversationId, role: "assistant", content: raw, created_at: new Date().toISOString() });

  const response = await agent.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(response.body.messages[0].content, "读一下");
  assert.deepEqual(response.body.messages[0].attachment_references, ["codex-clipboard-car.png"]);
  assert.doesNotMatch(JSON.stringify(response.body.messages[0]), /C:\/Users\/Codex/);
  assert.equal(response.body.messages.at(-1).content, "结论。 （引用：班级复盘.pptx，第 2 页）");
  assert.deepEqual(response.body.messages.at(-1).attachment_references, []);
  assert.equal(instance.db.listMessages(conversationId)[0].content, wrappedUserMessage);
  assert.equal(instance.db.listMessages(conversationId).at(-1)?.content, raw);
});

test("AI-titled conversations hide repeated title envelopes without rewriting audit rows", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-title-envelope-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);

  const conversationId = crypto.randomUUID();
  const raw = '{"answer":"已确认：双出口抖动已经停止。\\n\\n连续检查均正常。","title":"NAS 双出口抖动已停止"}';
  instance.db.createConversation(conversationId, "新任务");
  assert.equal(instance.db.setAiConversationTitleIfDefault(conversationId, "会话测试"), true);
  instance.db.addMessage({ id: crypto.randomUUID(), conversation_id: conversationId, role: "assistant", content: raw, created_at: new Date().toISOString() });

  const response = await agent.get(`/api/conversations/${conversationId}`).expect(200);
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
  assert.equal(isApiErrorStatus(new ApiError("会话不存在。", 404), 404), true);
  assert.equal(isApiErrorStatus(new ApiError("服务异常", 500), 404), false);
  assert.equal(isApiErrorStatus(new Error("会话不存在。"), 404), false);

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const recoveryFlow = appSource.match(/async function recoverMissingConversation[\s\S]*?\n  }\n\n  async function reconcile/)?.[0] ?? "";
  assert.match(recoveryFlow, /removeConversationFromPage\(page, id\)/);
  assert.match(recoveryFlow, /refreshList\(false, missingProjectId \?\? activeProjectIdRef\.current, false\)/);
  assert.match(recoveryFlow, /setError\(""\)/);
  const reconcileFlow = appSource.match(/async function reconcile[\s\S]*?\n  }\n\n  useEffect/)?.[0] ?? "";
  assert.match(reconcileFlow, /isApiErrorStatus\(reason, 404\)/);
  assert.match(reconcileFlow, /await recoverMissingConversation\(id\)/);
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

test("conversation history is returned newest-first by page and can load older messages", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-message-pages-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);

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

  const first = await agent.get(`/api/conversations/${conversationId}`).expect(200);
  assert.deepEqual(first.body.messages.map((message: { id: string }) => message.id), ids.slice(35));
  assert.deepEqual(first.body.messagePage, { hasMore: true, nextCursor: ids[35] });

  const second = await agent.get(`/api/conversations/${conversationId}/messages?before=${ids[35]}`).expect(200);
  assert.deepEqual(second.body.messages.map((message: { id: string }) => message.id), ids.slice(5, 35));
  assert.deepEqual(second.body.messagePage, { hasMore: true, nextCursor: ids[5] });

  const third = await agent.get(`/api/conversations/${conversationId}/messages?before=${ids[5]}`).expect(200);
  assert.deepEqual(third.body.messages.map((message: { id: string }) => message.id), ids.slice(0, 5));
  assert.deepEqual(third.body.messagePage, { hasMore: false, nextCursor: null });
  await agent.get(`/api/conversations/${conversationId}/messages`).expect(400);
  await agent.get(`/api/conversations/${conversationId}/messages?before=missing-message`).expect(400);
});

test("conversation detail restores running progress and terminal SSE replay", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-recovery-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);

  const conversationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "recover me");
  instance.db.createJob(jobId, conversationId);
  instance.db.updateJob(jobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  instance.db.appendEvent(jobId, "status", { label: "started" });
  instance.db.appendEvent(jobId, "progress", { label: "step two" });
  const laterQueuedJobId = crypto.randomUUID();
  instance.db.createJob(laterQueuedJobId, conversationId);

  const running = await agent.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(running.body.activeJob.id, jobId);
  assert.equal(running.body.jobEvents.length, 2);
  assert.equal(running.body.jobEvents[1].label, "step two");
  const activity = await agent.get(`/api/conversations/${conversationId}/activity`).expect(200);
  assert.equal(activity.body.activeJob.id, jobId);
  assert.equal(activity.body.externalStatus, "idle");
  assert.deepEqual(activity.body.jobEvents.map((event: { label: string }) => event.label), ["started", "step two"]);
  instance.db.sqlite.prepare("DELETE FROM jobs WHERE id=?").run(laterQueuedJobId);

  instance.db.addMessage({ id: crypto.randomUUID(), conversation_id: conversationId, role: "assistant", content: "finished", created_at: new Date().toISOString() });
  instance.db.finishJob(jobId, conversationId, "completed");
  instance.db.appendEvent(jobId, "done", { status: "completed" });
  const terminal = await agent.get(`/api/conversations/${conversationId}`).expect(200);
  assert.equal(terminal.body.activeJob, null);
  assert.equal(terminal.body.latestJob.status, "completed");
  assert.equal(terminal.body.messages.at(-1).content, "finished");

  const replay = await agent.get(`/api/jobs/${jobId}/events?after=1`).expect(200);
  assert.equal(replay.headers["x-accel-buffering"], "no");
  assert.doesNotMatch(replay.text, /id: 1\n/);
  assert.match(replay.text, /id: 2\n/);
  assert.match(replay.text, /id: 3\n/);
  assert.match(replay.text, /"type":"replay_complete"/);
  assert.match(replay.text, /"created_at":"2026-/);
  await agent.get(`/api/conversations/${crypto.randomUUID()}`).expect(404);
});

test("conversation activity snapshots retain five stage updates before the rolling window", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-activity-retention-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);

  const conversationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "retain stage updates");
  instance.db.createJob(jobId, conversationId);
  instance.db.updateJob(jobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  for (let seq = 1; seq <= 6; seq += 1) {
    instance.db.appendEvent(jobId, "progress", { kind: "update", label: "阶段反馈", detail: `阶段 ${seq}` });
  }
  for (let seq = 7; seq <= 62; seq += 1) {
    instance.db.appendEvent(jobId, "progress", { kind: "command", label: `步骤 ${seq}`, detail: `command ${seq}` });
  }

  const activity = await agent.get(`/api/conversations/${conversationId}/activity`).expect(200);
  assert.equal(activity.body.jobEvents.length, 55);
  assert.deepEqual(activity.body.jobEvents.slice(0, 5).map((event: { seq: number }) => event.seq), [2, 3, 4, 5, 6]);
  assert.deepEqual(activity.body.jobEvents.slice(5).map((event: { seq: number }) => event.seq), Array.from({ length: 50 }, (_, index) => index + 13));
});
