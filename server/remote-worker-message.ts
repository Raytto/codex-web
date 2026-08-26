import { z } from "zod";
import type { RemoteWorkerToServer } from "./remote-worker-protocol.js";

export const REMOTE_WORKER_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const REMOTE_WORKER_MAX_PROTOCOL_ERRORS = 3;

const text = (maximum: number, minimum = 0) => z.string().min(minimum).max(maximum);
const id = text(200, 1);
const uuid = z.string().uuid();
const iso = text(80, 1);
const finite = z.number().finite();

const transcriptItem = z.object({
  turnId: id,
  itemId: id,
  role: z.enum(["user", "assistant"]),
  content: text(2_000_000),
  createdAt: iso,
}).strict();

const activity = z.object({
  turnId: id,
  itemId: id,
  kind: z.enum(["reasoning", "update", "command", "file", "search", "tool", "agent"]),
  label: text(1_000),
  detail: text(200_000).optional(),
  files: z.array(text(2_000, 1)).max(200).optional(),
  agents: z.array(z.object({
    id,
    path: text(500, 1).optional(),
    status: z.enum(["pending", "running", "completed", "failed", "interrupted"]),
    summary: text(2_000, 1).optional(),
  }).strict()).max(64).optional(),
  createdAt: iso,
}).strict();

const threadSnapshot = z.object({
  id,
  name: text(500),
  nameSource: z.enum(["explicit", "preview", "fallback"]).optional(),
  createdAt: finite,
  updatedAt: finite,
  status: z.enum(["idle", "running"]),
  rolloutBytes: z.number().int().nonnegative().nullable().optional(),
  // Protocol v4 workers could publish up to 5,000 snapshot records. Keep this
  // bounded compatibility envelope while v5 workers proactively trim to
  // 1,000 messages and 2,000 activities before transmission.
  messages: z.array(transcriptItem).max(5_000),
  activities: z.array(activity).max(5_000),
}).strict();

const runtimeStatus = {
  installedVersion: text(80, 1),
  latestVersion: text(80, 1).nullable(),
  versionCheckedAt: iso.nullable(),
  catalogUpdatedAt: iso.nullable(),
  agentOptions: z.object({
    models: z.array(z.object({
      id: text(100, 1),
      label: text(200, 1),
      description: text(2_000),
      reasoningEfforts: z.array(text(32, 1)).max(20),
    }).strict()).max(100),
    reasoningEfforts: z.array(z.object({ id: text(32, 1), label: text(100, 1) }).strict()).max(20),
    defaults: z.object({ model: text(100, 1), reasoningEffort: text(32, 1) }).strict(),
  }).strict().nullable(),
};

const omittedArtifact = z.object({
  path: text(500, 1),
  reason: z.enum(["count_limit", "outside_project", "missing", "not_file", "too_large", "manifest_limit"]),
}).strict();

const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread_started"), threadId: id }).strict(),
  z.object({ type: z.literal("context_usage"), usage: z.object({
    threadId: id,
    inputTokens: z.number().int().nonnegative(),
    modelContextWindow: z.number().int().positive().nullable(),
  }).strict() }).strict(),
  z.object({ type: z.literal("quota_usage"), usage: z.object({ remainingPercent: finite.min(0).max(100), resetAt: iso.nullable().optional() }).strict() }).strict(),
  z.object({ type: z.literal("progress"), payload: z.unknown() }).strict(),
  z.object({ type: z.literal("steer_completed"), requestId: uuid, turnId: id }).strict(),
  z.object({ type: z.literal("steer_failed"), requestId: uuid, message: text(2_000, 1) }).strict(),
  z.object({ type: z.literal("completed"), finalResponse: text(2_000_000), omittedArtifacts: z.array(omittedArtifact).max(100).optional() }).strict(),
  z.object({ type: z.literal("failed"), message: text(8_000, 1), cancelled: z.boolean().optional() }).strict(),
]);

const artifact = z.object({
  id: uuid,
  name: text(180, 1),
  mimeType: text(200, 1),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const remoteWorkerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.number().int().min(1).max(100),
    workerId: uuid,
    machineName: text(32, 1),
    enrollmentToken: text(1_024, 1),
    platform: text(80, 1),
    workerVersion: text(80, 1),
    workerRelease: text(100, 1).nullable().optional(),
    workerCommit: text(64, 1).nullable().optional(),
    capabilities: z.object({
      workerUpdate: z.boolean().optional(),
      waitAutomation: z.boolean().optional(),
      capacityConfig: z.boolean().optional(),
      dynamicWaitTool: z.boolean().optional(),
      agentTurnContext: z.boolean().optional(),
      accountSkills: z.boolean().optional(),
      titleAgent: z.boolean().optional(),
      codexAccounts: z.boolean().optional(),
    }).strict().optional(),
    codexVersion: text(80, 1),
    capacity: z.number().int().min(0).max(8),
  }).strict(),
  // Protocol v4/v5 workers historically reported opaque job identifiers here.
  // Keep them bounded strings during the compatibility window; authorization and
  // reconciliation still match them only against server-owned pending job IDs.
  z.object({ type: z.literal("heartbeat"), activeJobs: z.array(id).max(64) }).strict(),
  z.object({ type: z.literal("quota_usage"), usage: z.object({ remainingPercent: finite.min(0).max(100), resetAt: iso.nullable().optional() }).strict(), accountId: uuid.optional() }).strict(),
  z.object({ type: z.literal("thread_activity"), projectId: uuid, thread: threadSnapshot }).strict(),
  z.object({
    type: z.literal("project_fs_result"), requestId: uuid,
    directory: text(4_096), parent: text(4_096).nullable(),
    directories: z.array(z.object({ name: text(255, 1), path: text(4_096, 1) }).strict()).max(500),
    virtualRoot: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("request_failed"), requestId: uuid.optional(), message: text(2_000, 1) }).strict(),
  z.object({ type: z.literal("event"), jobId: uuid, event }).strict(),
  z.object({ type: z.literal("artifact_uploaded"), jobId: uuid, artifact }).strict(),
  z.object({ type: z.literal("thread_rename_result"), requestId: uuid, ok: z.boolean(), message: text(2_000, 1).optional() }).strict(),
  z.object({ type: z.literal("file_fetch_result"), requestId: uuid, ok: z.boolean(), message: text(2_000, 1).optional() }).strict(),
  z.object({ type: z.literal("title_agent_result"), requestId: uuid, ok: z.boolean(), output: text(1_000, 1).optional(), message: text(2_000, 1).optional() }).strict(),
  z.object({ type: z.literal("runtime_status"), requestId: uuid.optional(), ...runtimeStatus }).strict(),
  z.object({ type: z.literal("codex_upgrade_result"), requestId: uuid, ok: z.boolean(), message: text(2_000, 1).optional(), runtime: z.object(runtimeStatus).strict().optional() }).strict(),
  z.object({ type: z.literal("worker_update_ack"), requestId: uuid, accepted: z.boolean(), message: text(2_000, 1).optional() }).strict(),
  z.object({
    type: z.literal("worker_update_result"), requestId: uuid, targetVersion: text(80, 1), targetRef: text(160, 1),
    ok: z.boolean(), installedVersion: text(80, 1), installedRef: text(160, 1).nullable(),
    installedCommit: text(64, 1).nullable(), message: text(2_000, 1).optional(),
  }).strict(),
  z.object({ type: z.literal("worker_config_result"), requestId: uuid, ok: z.boolean(), capacity: z.number().int().min(0).max(8).optional(), message: text(2_000, 1).optional() }).strict(),
  z.object({
    type: z.literal("codex_accounts_result"), requestId: uuid, ok: z.boolean(),
    state: z.object({
      accounts: z.array(z.object({ id: uuid, label: text(60, 1), email: text(254, 3).nullable(), accountHint: text(40, 1), active: z.boolean(), createdAt: iso, lastUsedAt: iso.nullable() }).strict()).max(20),
      activeAccountId: uuid,
    }).strict().optional(),
    login: z.object({
      id: uuid, status: z.enum(["starting", "waiting_for_user", "succeeded", "failed", "cancelled"]),
      verificationUrl: text(2_000, 8).nullable(), userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/).nullable(),
      error: text(2_000, 1).nullable(),
      account: z.object({ id: uuid, label: text(60, 1), email: text(254, 3).nullable(), accountHint: text(40, 1), active: z.boolean(), createdAt: iso, lastUsedAt: iso.nullable() }).strict().nullable(),
      createdAt: iso, expiresAt: iso,
    }).strict().optional(),
    restart: z.boolean().optional(), message: text(2_000, 1).optional(),
  }).strict(),
  z.object({ type: z.literal("thread_sync_result"), requestId: uuid, threads: z.array(threadSnapshot).max(50), nextCursor: text(500, 1).nullable() }).strict(),
]);

export type RemoteWorkerMessageValidation =
  | { ok: true; message: RemoteWorkerToServer }
  | { ok: false; reason: "invalid_json" | "invalid_schema" | "too_complex" };

export function parseRemoteWorkerMessage(textValue: string): RemoteWorkerMessageValidation {
  let value: unknown;
  try { value = JSON.parse(textValue); }
  catch { return { ok: false, reason: "invalid_json" }; }
  if (!isBoundedJson(value)) return { ok: false, reason: "too_complex" };
  const parsed = remoteWorkerMessage.safeParse(value);
  return parsed.success
    ? { ok: true, message: parsed.data as RemoteWorkerToServer }
    : { ok: false, reason: "invalid_schema" };
}

function isBoundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  budget.nodes += 1;
  if (budget.nodes > 20_000 || depth > 16) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 2_000_000;
  if (Array.isArray(value)) return value.length <= 5_000 && value.every((item) => isBoundedJson(item, depth + 1, budget));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 200 && entries.every(([key, item]) => key.length <= 200 && isBoundedJson(item, depth + 1, budget));
}
