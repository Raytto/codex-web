import type { RunRequest, ServerMessage, ThreadSnapshot, WorkerMessage } from "./protocol.js";
import { isAccountSkillBundle } from "./account-skills.js";

export const SERVER_MESSAGE_MAX_BYTES = 2 * 1024 * 1024;
export const WORKER_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_PROTOCOL_ERRORS = 3;

type Validation<T> = { ok: true; message: T } | { ok: false; reason: "invalid_json" | "invalid_schema" | "too_complex" };

export function parseServerMessage(value: string): Validation<ServerMessage> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { return { ok: false, reason: "invalid_json" }; }
  if (!isBoundedJson(parsed)) return { ok: false, reason: "too_complex" };
  return isServerMessage(parsed)
    ? { ok: true, message: parsed }
    : { ok: false, reason: "invalid_schema" };
}

export function isPersistableWorkerMessage(value: unknown): value is WorkerMessage {
  if (!record(value) || !shortString(value.type, 80) || value.type === "hello" || !isBoundedJson(value)) return false;
  switch (value.type) {
    case "heartbeat": return stringArray(value.activeJobs, 64, 200);
    case "quota_usage": return quota(value.usage) && optionalUuid(value.accountId);
    case "thread_activity": return uuid(value.projectId) && thread(value.thread);
    case "project_fs_result": return uuid(value.requestId) && shortString(value.directory, 4_096)
      && (value.parent === null || shortString(value.parent, 4_096))
      && recordArray(value.directories, 500, (item) => shortString(item.name, 255, 1) && shortString(item.path, 4_096, 1));
    case "request_failed": return optionalUuid(value.requestId) && shortString(value.message, 2_000, 1);
    case "event": return uuid(value.jobId) && workerEvent(value.event);
    case "thread_rename_result":
    case "file_fetch_result": return uuid(value.requestId) && typeof value.ok === "boolean" && optionalString(value.message, 2_000, 1);
    case "title_agent_result": return uuid(value.requestId) && typeof value.ok === "boolean"
      && optionalString(value.output, 1_000, 1) && optionalString(value.message, 2_000, 1);
    case "runtime_status": return optionalUuid(value.requestId) && runtimeStatus(value);
    case "codex_upgrade_result": return uuid(value.requestId) && typeof value.ok === "boolean" && optionalString(value.message, 2_000, 1)
      && (value.runtime === undefined || runtimeStatus(value.runtime));
    case "worker_update_ack": return uuid(value.requestId) && typeof value.accepted === "boolean" && optionalString(value.message, 2_000, 1);
    case "worker_update_result": return uuid(value.requestId) && shortString(value.targetVersion, 80, 1) && shortString(value.targetRef, 160, 1)
      && typeof value.ok === "boolean" && shortString(value.installedVersion, 80, 1)
      && nullableString(value.installedRef, 160) && nullableString(value.installedCommit, 64) && optionalString(value.message, 2_000, 1);
    case "worker_config_result": return uuid(value.requestId) && typeof value.ok === "boolean"
      && (value.capacity === undefined || integer(value.capacity, 0, 8)) && optionalString(value.message, 2_000, 1);
    case "codex_accounts_result": return uuid(value.requestId) && typeof value.ok === "boolean"
      && (value.state === undefined || codexAccountsState(value.state))
      && (value.login === undefined || codexAccountLogin(value.login))
      && (value.restart === undefined || typeof value.restart === "boolean")
      && optionalString(value.message, 2_000, 1);
    case "thread_sync_result": return uuid(value.requestId) && recordArray(value.threads, 50, thread)
      && (value.nextCursor === null || shortString(value.nextCursor, 500, 1));
    default: return false;
  }
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (!record(value) || !shortString(value.type, 80)) return false;
  const allowed = SERVER_MESSAGE_KEYS[value.type];
  if (!allowed || !exactKeys(value, allowed)) return false;
  switch (value.type) {
    case "authenticated": return uuid(value.workerId) && integer(value.heartbeatIntervalMs, 5_000, 60_000);
    case "project_watch": return recordArray(value.projects, 200, (item) => exactKeys(item, ["id", "rootPath"]) && uuid(item.id) && shortString(item.rootPath, 4_096, 1));
    case "request_failed": return optionalUuid(value.requestId) && shortString(value.message, 2_000, 1);
    case "project_fs": return uuid(value.requestId) && ["list", "create", "validate", "initialize"].includes(String(value.action))
      && shortString(value.path, 4_096) && optionalString(value.name, 255) && optionalString(value.content, 20_000);
    case "run": return runRequest(value.request);
    case "steer": return uuid(value.jobId) && uuid(value.requestId) && shortString(value.prompt, 100_000, 1)
      && secret(value.transferToken) && recordArray(value.attachments, 12, (item) => exactKeys(item, ["id", "name", "mimeType", "size", "downloadPath"])
        && uuid(item.id) && shortString(item.name, 180, 1) && shortString(item.mimeType, 200, 1)
        && integer(item.size, 0, 100 * 1024 * 1024) && shortString(item.downloadPath, 1_000, 1))
      && (value.turnContext === undefined || (record(value.turnContext)
        && exactKeys(value.turnContext, ["version", "userPrompt", "imageInput"])
        && value.turnContext.version === 1 && shortString(value.turnContext.userPrompt, 100_000, 1)
        && ["preload", "path_only", "none"].includes(String(value.turnContext.imageInput))));
    case "cancel": return uuid(value.jobId);
    case "thread_rename": return uuid(value.requestId) && shortString(value.threadId, 200, 1) && shortString(value.name, 500, 1);
    case "thread_archive": return uuid(value.requestId) && shortString(value.threadId, 200, 1);
    case "thread_sync": return uuid(value.requestId) && shortString(value.projectRoot, 4_096, 1)
      && (value.cursor === null || shortString(value.cursor, 500, 1)) && integer(value.limit, 1, 50);
    case "file_fetch": return uuid(value.requestId) && shortString(value.projectRoot, 4_096, 1)
      && shortString(value.path, 4_096, 1) && secret(value.transferToken);
    case "title_agent": return uuid(value.requestId) && shortString(value.prompt, 100_000, 1) && integer(value.timeoutMs, 15_000, 120_000);
    case "runtime_refresh": return uuid(value.requestId) && typeof value.checkLatest === "boolean";
    case "codex_upgrade": return uuid(value.requestId) && shortString(value.version, 80, 1);
    case "worker_update": return uuid(value.requestId) && shortString(value.targetVersion, 80, 1) && shortString(value.targetRef, 160, 1);
    case "worker_update_result_ack": return uuid(value.requestId);
    case "worker_config": return uuid(value.requestId) && integer(value.capacity, 0, 8);
    case "codex_accounts": {
      if (!uuid(value.requestId) || !["list", "login_start", "login_status", "login_cancel", "activate", "delete"].includes(String(value.action))) return false;
      if (value.action === "list") return value.label === undefined && value.loginId === undefined && value.accountId === undefined;
      if (value.action === "login_start") return optionalString(value.label, 60) && value.loginId === undefined && value.accountId === undefined;
      if (value.action === "login_status" || value.action === "login_cancel") return uuid(value.loginId) && value.label === undefined && value.accountId === undefined;
      return uuid(value.accountId) && value.label === undefined && value.loginId === undefined;
    }
    case "heartbeat_ack": return shortString(value.at, 80, 1);
    default: return false;
  }
}

function runRequest(value: unknown): value is RunRequest {
  if (!record(value) || !exactKeys(value, ["jobId", "conversationId", "projectRoot", "codexThreadId", "prompt", "attachments", "transferToken", "selection", "optionalCapabilities", "accountSkills", "automation", "turnContext"])
    || !uuid(value.jobId) || !uuid(value.conversationId) || !shortString(value.projectRoot, 4_096, 1)
    || !(value.codexThreadId === null || shortString(value.codexThreadId, 200, 1)) || !shortString(value.prompt, 100_000, 1)
    || !secret(value.transferToken) || !record(value.selection) || !exactKeys(value.selection, ["model", "reasoningEffort"]) || !shortString(value.selection.model, 100, 1)
    || !shortString(value.selection.reasoningEffort, 32, 1) || !booleanRecord(value.optionalCapabilities, 32)
    || (value.accountSkills !== undefined && !isAccountSkillBundle(value.accountSkills))) return false;
  if (!recordArray(value.attachments, 32, (item) => exactKeys(item, ["id", "name", "mimeType", "size", "downloadPath"]) && uuid(item.id) && shortString(item.name, 180, 1)
    && shortString(item.mimeType, 200, 1) && integer(item.size, 0, 100 * 1024 * 1024)
    && shortString(item.downloadPath, 1_000, 1))) return false;
  if (value.automation !== undefined && !(record(value.automation) && exactKeys(value.automation, ["token", "dynamicTool"])
    && secret(value.automation.token) && (value.automation.dynamicTool === undefined || value.automation.dynamicTool === true))) return false;
  return value.turnContext === undefined || (record(value.turnContext)
    && exactKeys(value.turnContext, ["version", "userPrompt", "interruptedContext", "imageInput"])
    && value.turnContext.version === 1 && shortString(value.turnContext.userPrompt, 100_000, 1)
    && optionalString(value.turnContext.interruptedContext, 20_000)
    && ["preload", "path_only", "none"].includes(String(value.turnContext.imageInput)));
}

function workerEvent(value: unknown): boolean {
  if (!record(value) || !shortString(value.type, 80)) return false;
  if (value.type === "thread_started") return shortString(value.threadId, 200, 1);
  if (value.type === "context_usage") return record(value.usage) && shortString(value.usage.threadId, 200, 1)
    && integer(value.usage.inputTokens, 0, Number.MAX_SAFE_INTEGER)
    && (value.usage.modelContextWindow === null || integer(value.usage.modelContextWindow, 1, Number.MAX_SAFE_INTEGER));
  if (value.type === "quota_usage") return quota(value.usage);
  if (value.type === "progress") return isBoundedJson(value.payload);
  if (value.type === "steer_completed") return uuid(value.requestId) && shortString(value.turnId, 200, 1);
  if (value.type === "steer_failed") return uuid(value.requestId) && shortString(value.message, 2_000, 1);
  if (value.type === "completed") return shortString(value.finalResponse, 2_000_000)
    && (value.omittedArtifacts === undefined || recordArray(value.omittedArtifacts, 100, (item) => shortString(item.path, 500, 1)
      && ["count_limit", "outside_project", "missing", "not_file", "too_large", "manifest_limit"].includes(String(item.reason))));
  if (value.type === "failed") return shortString(value.message, 8_000, 1) && (value.cancelled === undefined || typeof value.cancelled === "boolean");
  return false;
}

function thread(value: unknown): value is ThreadSnapshot {
  return record(value) && shortString(value.id, 200, 1) && shortString(value.name, 500)
    && ["explicit", "preview", "fallback"].includes(String(value.nameSource))
    && finite(value.createdAt) && finite(value.updatedAt) && ["idle", "running"].includes(String(value.status))
    && (value.rolloutBytes === undefined || value.rolloutBytes === null || integer(value.rolloutBytes, 0, Number.MAX_SAFE_INTEGER))
    && recordArray(value.messages, 1_000, (item) => shortString(item.turnId, 200, 1) && shortString(item.itemId, 200, 1)
      && ["user", "assistant"].includes(String(item.role)) && shortString(item.content, 2_000_000) && shortString(item.createdAt, 80, 1))
    && recordArray(value.activities, 2_000, (item) => shortString(item.turnId, 200, 1) && shortString(item.itemId, 200, 1)
      && ["reasoning", "update", "command", "file", "search", "tool"].includes(String(item.kind))
      && shortString(item.label, 1_000) && optionalString(item.detail, 200_000)
      && (item.files === undefined || stringArray(item.files, 200, 2_000)) && shortString(item.createdAt, 80, 1));
}

function runtimeStatus(value: unknown): boolean {
  if (!record(value) || !shortString(value.installedVersion, 80, 1) || !nullableString(value.latestVersion, 80)
    || !nullableString(value.versionCheckedAt, 80) || !nullableString(value.catalogUpdatedAt, 80)) return false;
  if (value.agentOptions === null) return true;
  if (!record(value.agentOptions) || !record(value.agentOptions.defaults)) return false;
  return recordArray(value.agentOptions.models, 100, (model) => shortString(model.id, 100, 1) && shortString(model.label, 200, 1)
    && shortString(model.description, 2_000) && stringArray(model.reasoningEfforts, 20, 32))
    && recordArray(value.agentOptions.reasoningEfforts, 20, (effort) => shortString(effort.id, 32, 1) && shortString(effort.label, 100, 1))
    && shortString(value.agentOptions.defaults.model, 100, 1) && shortString(value.agentOptions.defaults.reasoningEffort, 32, 1);
}

function codexAccount(value: unknown): boolean {
  return record(value) && uuid(value.id) && shortString(value.label, 60, 1)
    && (value.email === null || shortString(value.email, 254, 3)) && shortString(value.accountHint, 40, 1)
    && typeof value.active === "boolean" && shortString(value.createdAt, 80, 1)
    && (value.lastUsedAt === null || shortString(value.lastUsedAt, 80, 1));
}
function codexAccountsState(value: unknown): boolean {
  return record(value) && uuid(value.activeAccountId) && recordArray(value.accounts, 20, codexAccount);
}
function codexAccountLogin(value: unknown): boolean {
  return record(value) && uuid(value.id)
    && ["starting", "waiting_for_user", "succeeded", "failed", "cancelled"].includes(String(value.status))
    && (value.verificationUrl === null || shortString(value.verificationUrl, 2_000, 8))
    && (value.userCode === null || /^[A-Z0-9]{4}-[A-Z0-9]{5}$/.test(String(value.userCode)))
    && (value.error === null || shortString(value.error, 2_000, 1))
    && (value.account === null || codexAccount(value.account))
    && shortString(value.createdAt, 80, 1) && shortString(value.expiresAt, 80, 1);
}

function isBoundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  budget.nodes += 1;
  if (budget.nodes > 20_000 || depth > 16) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 2_000_000;
  if (Array.isArray(value)) return value.length <= 2_000 && value.every((item) => isBoundedJson(item, depth + 1, budget));
  if (!record(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 200 && entries.every(([key, item]) => key.length <= 200 && isBoundedJson(item, depth + 1, budget));
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && !Array.isArray(value) && typeof value === "object"; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function integer(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum; }
function shortString(value: unknown, maximum: number, minimum = 0): value is string { return typeof value === "string" && value.length >= minimum && value.length <= maximum; }
function optionalString(value: unknown, maximum: number, minimum = 0): boolean { return value === undefined || shortString(value, maximum, minimum); }
function nullableString(value: unknown, maximum: number): boolean { return value === null || shortString(value, maximum, 1); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function optionalUuid(value: unknown): boolean { return value === undefined || uuid(value); }
function secret(value: unknown): value is string { return shortString(value, 1_024, 16); }
function quota(value: unknown): boolean { return record(value) && finite(value.remainingPercent) && value.remainingPercent >= 0 && value.remainingPercent <= 100; }
function stringArray(value: unknown, maximumItems: number, maximumLength: number): value is string[] { return Array.isArray(value) && value.length <= maximumItems && value.every((item) => shortString(item, maximumLength, 1)); }
function recordArray(value: unknown, maximumItems: number, validate: (item: Record<string, unknown>) => boolean): boolean { return Array.isArray(value) && value.length <= maximumItems && value.every((item) => record(item) && validate(item)); }
function booleanRecord(value: unknown, maximumItems: number): boolean { return record(value) && Object.keys(value).length <= maximumItems && Object.entries(value).every(([key, item]) => key.length <= 100 && typeof item === "boolean"); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }

const SERVER_MESSAGE_KEYS: Record<string, readonly string[]> = {
  authenticated: ["type", "workerId", "heartbeatIntervalMs"],
  project_watch: ["type", "projects"],
  request_failed: ["type", "requestId", "message"],
  project_fs: ["type", "requestId", "action", "path", "name", "content"],
  run: ["type", "request"],
  steer: ["type", "jobId", "requestId", "prompt", "attachments", "transferToken", "turnContext"],
  cancel: ["type", "jobId"],
  thread_rename: ["type", "requestId", "threadId", "name"],
  thread_archive: ["type", "requestId", "threadId"],
  thread_sync: ["type", "requestId", "projectRoot", "cursor", "limit"],
  file_fetch: ["type", "requestId", "projectRoot", "path", "transferToken"],
  title_agent: ["type", "requestId", "prompt", "timeoutMs"],
  runtime_refresh: ["type", "requestId", "checkLatest"],
  codex_upgrade: ["type", "requestId", "version"],
  worker_update: ["type", "requestId", "targetVersion", "targetRef"],
  worker_update_result_ack: ["type", "requestId"],
  worker_config: ["type", "requestId", "capacity"],
  codex_accounts: ["type", "requestId", "action", "label", "loginId", "accountId"],
  heartbeat_ack: ["type", "at"],
};
