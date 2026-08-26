import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAT_FONT_SIZE_DEFAULT, normalizeChatFontSize } from "../src/chat-font-size.js";
import { buildAskAgentDraft } from "../src/ask-agent-selection.js";
import { parseResponseAnnotatedRequest } from "../src/response-annotations.js";
import { isDeliverablePath, normalizeStoredRelativePath, normalizeUploadFileName } from "./paths.js";
import type { AgentOptions, ExecutorRuntimeStatus } from "./model-options.js";
import type { CodexQuotaUsage, ContextTokenUsage } from "./app-server-turn.js";
import { isHostRootUser } from "./host-root-user.js";
import type { OptionalAgentCapabilities } from "./optional-capabilities.js";
import { containsPersonalContext, stripPersonalContext } from "./personal-context.js";

export const LEGACY_USER_ID = "00000000-0000-4000-8000-000000000001";
const SUPPRESSED_CONTROLLED_ACTIVITY_KIND = "_codex_web_controlled";

export class StorageQuotaExceededError extends Error {
  readonly code = "USER_STORAGE_LIMIT";
  constructor() { super("User storage quota would be exceeded"); }
}

export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: "owner" | "member";
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
};

export type ConversationRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  title_source: ConversationTitleSource;
  codex_thread_id: string | null;
  agent_model: string | null;
  reasoning_effort: string | null;
  status: "idle" | "running";
  external_status: "idle" | "running";
  sync_origin: "codex_web" | "codex_app";
  remote_updated_at: number;
  pinned_at: string | null;
  sidebar_order: number;
  has_unread_result: number;
  unread_anchor_message_id: string | null;
  has_pending_work: number;
  active_wake_count: number;
  next_wake_at: string | null;
  active_wake_mode: WakePlanMode | null;
  active_wake_label: string | null;
  project_move_blocked: number;
  rollout_bytes: number | null;
  last_active_at: string;
  cold_storage_state: ConversationStorageState;
  cold_storage_generation: number;
  cold_storage_revision: number;
  cold_storage_manifest_sha256: string | null;
  cold_storage_archive_sha256: string | null;
  cold_storage_archive_bytes: number | null;
  cold_storage_remote_path: string | null;
  cold_storage_error: string | null;
  context_input_tokens: number | null;
  context_window_tokens: number | null;
  context_usage_updated_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  deletion_state: "active" | "deleting" | "cleanup_failed";
  cleanup_error: string | null;
  optional_capabilities_json: string | null;
  personal_context_revision: number;
  created_at: string;
  updated_at: string;
};

export type ConversationStorageState = "local" | "uploading" | "remote_verified" | "evicting" | "cold" | "restoring" | "error";
export type ConversationStorageRow = {
  conversation_id: string;
  state: ConversationStorageState;
  generation: number;
  revision: number;
  manifest_json: string | null;
  manifest_sha256: string | null;
  archive_sha256: string | null;
  archive_bytes: number | null;
  plaintext_bytes: number | null;
  remote_drive_id: string | null;
  remote_path: string | null;
  local_isolated_path: string | null;
  retry_count: number;
  last_error: string | null;
  uploaded_at: string | null;
  verified_at: string | null;
  restored_at: string | null;
  created_at: string;
  updated_at: string;
};
export type ConversationStorageAuditRow = {
  id: string;
  conversation_id: string;
  generation: number;
  revision: number;
  from_state: ConversationStorageState;
  to_state: ConversationStorageState;
  action: string;
  details_json: string | null;
  created_at: string;
};

export type CodexQuotaSnapshot = {
  remainingPercent: number;
  resetAt?: string | null;
  updatedAt: string;
};

export type ProjectRow = {
  id: string;
  user_id: string;
  name: string;
  root_path: string;
  executor_id: string;
  is_default: number;
  sort_order: number;
  sidebar_collapsed: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ConversationTitleAuditRow = {
  id: string;
  conversation_id: string | null;
  user_id: string;
  project_id: string | null;
  executor_id: string;
  trigger: "first_message" | "remote_import";
  model: string;
  reasoning_effort: string;
  prompt_version: string;
  request_excerpt: string;
  request_sha256: string;
  context_json: string;
  status: "running" | "succeeded" | "failed";
  output_title: string | null;
  applied: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
};

export type RemoteWorkerRow = {
  id: string;
  machine_name: string;
  status: "online" | "offline" | "disabled";
  platform: string;
  protocol_version: number;
  worker_version: string;
  worker_release: string | null;
  worker_commit: string | null;
  worker_update_capable: number;
  codex_version: string;
  capacity: number;
  active_jobs: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RemoteWorkerUpdateState = "queued" | "dispatching" | "updating" | "succeeded" | "failed";
export type RemoteWorkerUpdateRow = {
  worker_id: string;
  request_id: string;
  target_version: string;
  target_ref: string;
  state: RemoteWorkerUpdateState;
  requested_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  error: string | null;
  updated_at: string;
};

export type RemoteWorkerCredentialState = "active" | "retired" | "revoked";
export type RemoteWorkerCredentialRow = {
  credential_id: string;
  worker_id: string;
  token_hash: string;
  state: RemoteWorkerCredentialState;
  issued_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  replaced_by: string | null;
};

export type ExecutorRuntimeRow = {
  executor_id: string;
  installed_version: string;
  latest_version: string | null;
  version_checked_at: string | null;
  catalog_json: string | null;
  catalog_updated_at: string | null;
  update_state: ExecutorRuntimeStatus["updateState"];
  update_error: string | null;
  updated_at: string;
};

export type ConversationPage = {
  conversations: ConversationRow[];
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type ConversationProjectMoveResult =
  | { status: "moved" | "unchanged"; conversation: ConversationRow; fromProjectId: string; toProjectId: string }
  | { status: "not_found" }
  | { status: "project_unavailable" }
  | { status: "unsupported_executor" }
  | { status: "busy" };

export type RunningJobSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type ConversationTitleSource = "default" | "ai" | "manual" | "legacy";

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  quote_excerpt?: string | null;
  is_scheduled?: number;
  created_at: string;
};

export type PersonalMemoryKind = "identity" | "preference" | "knowledge_level" | "current_focus" | "project_pointer";
export type PersonalMemoryEvidenceKind = "direct" | "inferred" | "correction" | "forget";
export type PersonalMemoryStatus = "candidate" | "active" | "conflicted" | "forgotten" | "stale";
export type PersonalMemoryConfidence = "explicit" | "high" | "medium" | "low";
export type PersonalMemoryReviewState = "unreviewed" | "accepted" | "rejected" | "corrected" | "forgotten";
export type PersonalMemoryReviewAction = "accept" | "reject" | "correct" | "forget";

export type PersonalMemoryEntryRow = {
  id: string;
  user_id: string;
  kind: PersonalMemoryKind;
  canonical_key: string;
  statement: string;
  scope: string;
  status: PersonalMemoryStatus;
  confidence: PersonalMemoryConfidence;
  sensitivity: "normal" | "sensitive";
  review_state: PersonalMemoryReviewState;
  reviewed_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  evidence_count?: number;
  conversation_count?: number;
  evidence_date_count?: number;
};

export type PersonalMemorySourceMessage = {
  id: string;
  user_id: string;
  conversation_id: string;
  conversation_title: string;
  project_id: string | null;
  content: string;
  quote_excerpt: string | null;
  created_at: string;
  attempts: number;
};

export type PersonalMemoryCandidateInput = {
  kind: PersonalMemoryKind;
  canonicalKey: string;
  statement: string;
  scope: string;
  evidenceKind: PersonalMemoryEvidenceKind;
  sensitivity: "normal" | "sensitive";
  messageIds: string[];
  ttlDays: number | null;
};

export type PersonalMemoryStateRow = {
  user_id: string;
  revision: number;
  snapshot_hash: string | null;
  last_published_at: string | null;
  last_successful_run_at: string | null;
};

export type PersonalMemoryEvidenceView = {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  evidence_kind: PersonalMemoryEvidenceKind;
  evidence_date: string;
  source_excerpt: string;
  created_at: string;
};

export type VoiceTranscriptionRow = {
  id: string;
  user_id: string;
  client_recording_id: string | null;
  conversation_id: string | null;
  project_id: string | null;
  message_id: string | null;
  pending_prompt_id: string | null;
  raw_text: string;
  model: string;
  prompt_version: string;
  selected_terms_json: string;
  audio_relative_path: string | null;
  audio_mime_type: string | null;
  audio_bytes: number | null;
  audio_sha256: string | null;
  audio_storage_state: "none" | "local" | "uploading" | "remote_verified" | "evicting" | "cold" | "restoring" | "error";
  audio_generation: number;
  audio_revision: number;
  audio_archive_sha256: string | null;
  audio_archive_bytes: number | null;
  audio_remote_drive_id: string | null;
  audio_remote_path: string | null;
  audio_local_isolated_path: string | null;
  audio_last_error: string | null;
  audio_uploaded_at: string | null;
  audio_verified_at: string | null;
  audio_restored_at: string | null;
  audio_updated_at: string | null;
  status: "pending" | "processing" | "processed";
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
};

export type VoiceTranscriptionReceiptRow = {
  user_id: string;
  client_recording_id: string;
  audio_sha256: string;
  audio_bytes: number;
  state: "processing" | "succeeded" | "failed";
  transcription_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type VoiceReviewSource = VoiceTranscriptionRow & {
  conversation_title: string;
  message_content: string;
};

export type VoiceLexiconTermRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  canonical_key: string;
  canonical_text: string;
  aliases_json: string;
  term_kind: string;
  status: "candidate" | "active" | "conflicted" | "suppressed";
  pinned: number;
  usage_score: number;
  voice_opportunities: number;
  weighted_errors: number;
  reliable_error_rate: number;
  rank_index: number;
  last_used_at: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
};

export type VoiceLexiconManagementTermRow = VoiceLexiconTermRow & {
  project_name: string | null;
  evidence_count: number;
  error_evidence_count: number;
};

export type VoiceLexiconManagementStats = {
  pending: number;
  submitted_pending: number;
  processing: number;
  processed: number;
  failed_attempts: number;
  run_count: number;
  successful_runs: number;
  failed_runs: number;
};

export type VoiceLexiconRunSummary = {
  model: string;
  prompt_version: string;
  status: "succeeded" | "failed";
  candidate_count: number;
  created_at: string;
  completed_at: string;
} | null;

export type VoiceTermEvidenceInput = {
  transcriptionId: string;
  canonicalText: string;
  canonicalKey: string;
  observedText: string;
  termKind: string;
  confidence: number;
  useWeight: number;
  errorWeight: number;
};

export type FileRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  pending_prompt_id?: string | null;
  composer_draft_id?: string | null;
  original_name: string;
  relative_path: string;
  source_path?: string | null;
  mime_type: string;
  size: number;
  sha256?: string | null;
  kind: "upload" | "output";
  created_at: string;
};

export type PublicFileShareRow = {
  id: string;
  file_id: string;
  user_id: string;
  file_name_snapshot: string;
  enabled: number;
  created_at: string;
  enabled_at: string | null;
  disabled_at: string | null;
};

export type PublicFileShareAssetRow = {
  share_id: string;
  asset_file_id: string;
  source_ref: string;
  created_at: string;
};

export type ManagedPublicFileShareRow = PublicFileShareRow & {
  current_file_name: string;
  mime_type: string;
  size: number;
  conversation_id: string;
  conversation_title: string;
};

export type ResumableUploadState = "uploading" | "finalizing" | "completed" | "cancelled" | "expired";
export type ResumableUploadRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  file_id: string;
  original_name: string;
  mime_type: string;
  size: number;
  offset: number;
  storage_name: string;
  final_name: string;
  state: ResumableUploadState;
  created_at: string;
  updated_at: string;
  expires_at: string;
  completed_at: string | null;
};

export type MessagePage = {
  messages: Array<MessageRow & { files: FileRow[] }>;
  hasMore: boolean;
  nextCursor: string | null;
};

export type PendingPromptRow = {
  id: string;
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  agent_model: string;
  reasoning_effort: string;
  position: number;
  status: "queued" | "editing";
  created_at: string;
  updated_at: string;
};

export type PendingPromptWithFiles = PendingPromptRow & { files: FileRow[] };

export type WakePlanMode = "time" | "event_or_deadline";
export type WakePlanState = "armed" | "triggered" | "cancelled";
export type WakeTriggerCause = "success" | "failure" | "deadline" | "manual";
export type WakeEventKind = WakeTriggerCause | "heartbeat";

export type WakePlanRow = {
  id: string;
  conversation_id: string;
  created_by_job_id: string | null;
  mode: WakePlanMode;
  state: WakePlanState;
  revision: number;
  label: string;
  run_id: string | null;
  deadline_at: string;
  success_prompt: string;
  failure_prompt: string;
  timeout_prompt: string;
  new_conversation: number;
  target_conversation_id: string | null;
  agent_model: string;
  reasoning_effort: string;
  event_token_hash: string | null;
  trigger_cause: WakeTriggerCause | null;
  triggered_at: string | null;
  cancelled_at: string | null;
  pending_prompt_id: string | null;
  job_id: string | null;
  last_heartbeat_at: string | null;
  last_event_at: string | null;
  last_event_kind: WakeEventKind | null;
  last_event_summary: string | null;
  created_at: string;
  updated_at: string;
};

export type WakeEventRow = {
  wake_plan_id: string;
  event_id: string;
  kind: WakeEventKind;
  summary: string | null;
  accepted: number;
  created_at: string;
};

export type WakeTriggerResult = {
  status: "triggered" | "heartbeat" | "duplicate" | "stale" | "missing";
  plan?: WakePlanRow;
  pendingPrompt?: PendingPromptWithFiles;
  targetConversation?: ConversationRow;
};

export type ComposerDraftRow = {
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  created_at: string;
  updated_at: string;
};

export type ComposerDraftWithFiles = ComposerDraftRow & { files: FileRow[] };

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type FinalizationState = "staging" | "files_ready" | "db_committed" | "published";

export type JobFinalizationPayload = {
  message: MessageRow;
  files: FileRow[];
};

export type JobRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  agent_model: string | null;
  reasoning_effort: string | null;
  queue_seq: number;
  status: JobStatus;
  error: string | null;
  finalization_state: FinalizationState;
  finalization_payload: string | null;
  finalization_error: string | null;
  created_at: string;
  updated_at: string;
};

export type TerminalJobRuntimeRow = {
  job_id: string;
  conversation_id: string;
  user_id: string;
};

export type SessionRow = {
  token_hash: string;
  csrf_token: string;
  expires_at: string;
  user_id: string;
  username: string;
  display_name: string;
  role: UserRow["role"];
};
export type LoginThrottleRow = { ip_hash: string; fail_count: number; blocked_until: string | null; updated_at: string };

export type JobEventRow = {
  seq: number;
  event_type: string;
  payload: string;
  created_at: string;
};

export type RemoteThreadEventView = {
  seq: number;
  type: "progress";
  created_at: string;
  kind: string;
  label: string;
  detail?: string;
  files?: string[];
  agents?: Array<{ id: string; path?: string; status: "pending" | "running" | "completed" | "failed" | "interrupted"; summary?: string }>;
};

export type StoredAgentSelection = {
  model: string;
  reasoningEffort: string;
};

export type RemoteThreadSnapshotInput = {
  id: string;
  name: string;
  nameSource?: "explicit" | "preview" | "fallback";
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running";
  rolloutBytes?: number | null;
  messages: Array<{ turnId: string; itemId: string; role: "user" | "assistant"; content: string; createdAt: string }>;
  activities?: Array<{
    turnId: string;
    itemId: string;
    kind: string;
    label: string;
    detail?: string;
    files?: string[];
    agents?: Array<{ id: string; path?: string; status: "pending" | "running" | "completed" | "failed" | "interrupted"; summary?: string }>;
    createdAt: string;
  }>;
};

export type RemoteThreadImportResult = { conversation: ConversationRow; created: boolean; changed: boolean; importedMessages: number; importedActivities: number };

type LegacyUserSeed = { username: string; passwordHash: string; displayName?: string };

const remoteThreadTimestamp = (value: number): number => Number.isFinite(value) && value > 0 ? value : 0;
const isSuppressedControlledActivity = (payload: string): boolean => {
  try {
    return (JSON.parse(payload) as { kind?: unknown })?.kind === SUPPRESSED_CONTROLLED_ACTIVITY_KIND;
  } catch {
    return false;
  }
};
const normalizedMessageContent = (value: string): string => value.replace(/\r\n?/g, "\n").trim();
const normalizePersonalMemoryStatement = (value: string): string => value
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[\s`*_~，。！？；：、,.!?;:'"“”‘’（）()\[\]【】]+/g, "")
  .trim();
const remoteUserMessageMatchesJob = (remoteContent: string, jobContent: string, jobQuoteExcerpt?: string | null): boolean => {
  const remote = normalizedMessageContent(stripPersonalContext(remoteContent));
  const job = normalizedMessageContent(jobQuoteExcerpt ? buildAskAgentDraft(jobContent, jobQuoteExcerpt) : jobContent);
  if (!job || remote === job) return remote === job;
  if (remote.startsWith(job)) {
    const suffix = remote.slice(job.length).trimStart();
    return suffix.startsWith("本轮附件：\n") || suffix.startsWith("<codex_web_wait_automation>");
  }
  const withoutWaitAutomation = remote
    .replace(/\s*<codex_web_wait_automation>[\s\S]*?<\/codex_web_wait_automation>\s*$/u, "")
    .trim();
  if (!withoutWaitAutomation.endsWith(job)) return false;
  const prefix = withoutWaitAutomation.slice(0, -job.length).trimEnd();
  return prefix.startsWith("本轮附件：\n") || prefix.startsWith("上一次任务由用户主动终止。");
};
const remoteItemFallsWithinJob = (remoteCreatedAt: string, jobCreatedAt: string, jobUpdatedAt: string): boolean => {
  const remote = Date.parse(remoteCreatedAt);
  const started = Date.parse(jobCreatedAt);
  const finished = Date.parse(jobUpdatedAt);
  return Number.isFinite(remote) && Number.isFinite(started) && Number.isFinite(finished)
    && remote >= started - 30_000
    && remote <= finished + 30_000;
};
const conversationSelect = `
  conversations.*,
  COALESCE(conversations.last_active_at, conversations.updated_at) AS last_active_at,
  COALESCE((SELECT state FROM conversation_storage WHERE conversation_id=conversations.id), 'local') AS cold_storage_state,
  COALESCE((SELECT generation FROM conversation_storage WHERE conversation_id=conversations.id), 0) AS cold_storage_generation,
  COALESCE((SELECT revision FROM conversation_storage WHERE conversation_id=conversations.id), 0) AS cold_storage_revision,
  (SELECT manifest_sha256 FROM conversation_storage WHERE conversation_id=conversations.id) AS cold_storage_manifest_sha256,
  (SELECT archive_sha256 FROM conversation_storage WHERE conversation_id=conversations.id) AS cold_storage_archive_sha256,
  (SELECT archive_bytes FROM conversation_storage WHERE conversation_id=conversations.id) AS cold_storage_archive_bytes,
  (SELECT remote_path FROM conversation_storage WHERE conversation_id=conversations.id) AS cold_storage_remote_path,
  (SELECT last_error FROM conversation_storage WHERE conversation_id=conversations.id) AS cold_storage_error,
  CASE WHEN
    EXISTS (SELECT 1 FROM jobs WHERE jobs.conversation_id=conversations.id AND jobs.status='queued')
    OR EXISTS (SELECT 1 FROM pending_prompts WHERE pending_prompts.conversation_id=conversations.id AND pending_prompts.status='queued')
  THEN 1 ELSE 0 END AS has_pending_work,
  (SELECT count(1) FROM wake_plans WHERE wake_plans.conversation_id=conversations.id AND wake_plans.state='armed') AS active_wake_count,
  (SELECT min(deadline_at) FROM wake_plans WHERE wake_plans.conversation_id=conversations.id AND wake_plans.state='armed') AS next_wake_at,
  (SELECT mode FROM wake_plans WHERE wake_plans.conversation_id=conversations.id AND wake_plans.state='armed' LIMIT 1) AS active_wake_mode,
  (SELECT label FROM wake_plans WHERE wake_plans.conversation_id=conversations.id AND wake_plans.state='armed' LIMIT 1) AS active_wake_label,
  CASE WHEN
    conversations.status<>'idle'
    OR conversations.external_status<>'idle'
    OR EXISTS (SELECT 1 FROM jobs WHERE jobs.conversation_id=conversations.id AND jobs.status IN ('queued','running'))
    OR EXISTS (SELECT 1 FROM pending_prompts WHERE pending_prompts.conversation_id=conversations.id AND pending_prompts.status IN ('queued','editing'))
    OR EXISTS (SELECT 1 FROM wake_plans WHERE wake_plans.conversation_id=conversations.id AND wake_plans.state='armed')
  THEN 1 ELSE 0 END AS project_move_blocked
`;

export class AppDatabase {
  readonly sqlite: DatabaseSync;

  constructor(dataRoot: string, legacyUser: LegacyUserSeed = { username: "owner", passwordHash: "", displayName: "Owner" }, recoverJobs = true) {
    fs.mkdirSync(dataRoot, { recursive: true });
    this.sqlite = new DatabaseSync(path.join(dataRoot, "codex-web.sqlite"));
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate(legacyUser);
    if (recoverJobs) {
      // Local running child processes cannot survive an application restart. Remote
      // Worker turns are different: the Worker process and its Codex turn can remain
      // alive while the Web service restarts. A persisted recovery lease lets the new
      // gateway reattach to that exact turn without replaying it.
      const interrupted = this.sqlite.prepare(`
        SELECT job.id,job.conversation_id,conversation.deleted_at,project.executor_id
        FROM jobs job
        JOIN conversations conversation ON conversation.id=job.conversation_id
        LEFT JOIN projects project ON project.id=conversation.project_id
        WHERE job.status='running'
      `).all() as Array<{ id: string; conversation_id: string; deleted_at: string | null; executor_id: string | null }>;
      const now = new Date().toISOString();
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const job of interrupted) {
          const remoteLease = job.executor_id?.startsWith("remote:")
            && fs.existsSync(path.join(dataRoot, "remote-worker-recovery", `${job.id}.json`));
          if (remoteLease) continue;
          const error = "服务重启，原运行任务已中断";
          const event = this.sqlite.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM job_events WHERE job_id=?").get(job.id) as { seq: number };
          this.sqlite.prepare(`
            UPDATE jobs
            SET status='interrupted',error=COALESCE(error,?),
              finalization_state=CASE
                WHEN finalization_state='published' OR (finalization_state='staging' AND finalization_payload IS NULL) THEN 'published'
                ELSE finalization_state
              END,
              finalization_payload=CASE WHEN finalization_state='published' THEN NULL ELSE finalization_payload END,
              finalization_error=CASE
                WHEN finalization_state='published' OR (finalization_state='staging' AND finalization_payload IS NULL) THEN NULL
                ELSE finalization_error
              END,
              updated_at=?
            WHERE id=?
          `).run(error, now, job.id);
          this.sqlite.prepare("INSERT INTO job_events(job_id,seq,event_type,payload,created_at) VALUES(?,?,?,?,?)")
            .run(job.id, event.seq, "failed", JSON.stringify({ status: "interrupted", message: error }), now);
          if (job.deleted_at) continue;
          const noticeMessageId = crypto.randomUUID();
          this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,'assistant',?,NULL,?)")
            .run(noticeMessageId, job.conversation_id, "上一条任务因服务重启而中断，尚未执行完成。为避免重复产生副作用，系统没有自动重试；请重新发送该任务。", now);
          this.sqlite.prepare(`
            UPDATE conversations
            SET status='idle',has_unread_result=1,unread_anchor_message_id=COALESCE(unread_anchor_message_id,?),updated_at=?
            WHERE id=?
          `).run(noticeMessageId, now, job.conversation_id);
          this.bumpConversationSidebarOrder(job.conversation_id);
        }
        this.sqlite.prepare(`
          UPDATE conversations SET status='idle'
          WHERE status='running'
            AND NOT EXISTS (
              SELECT 1 FROM jobs
              WHERE jobs.conversation_id=conversations.id AND jobs.status='running'
            )
        `).run();
        this.sqlite.exec("COMMIT");
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private migrate(legacyUser: LegacyUserSeed): void {
    this.sqlite.exec("DROP INDEX IF EXISTS jobs_queue_idx");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        executor_id TEXT NOT NULL DEFAULT 'local-host',
        is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        project_id TEXT REFERENCES projects(id),
        title TEXT NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'legacy',
        codex_thread_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        external_status TEXT NOT NULL DEFAULT 'idle',
        sync_origin TEXT NOT NULL DEFAULT 'codex_web',
        remote_updated_at INTEGER NOT NULL DEFAULT 0,
        pinned_at TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0,
        has_unread_result INTEGER NOT NULL DEFAULT 0,
        unread_anchor_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        rollout_bytes INTEGER,
        last_active_at TEXT,
        context_input_tokens INTEGER,
        context_window_tokens INTEGER,
        context_usage_updated_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        deletion_state TEXT NOT NULL DEFAULT 'active',
        cleanup_error TEXT,
        optional_capabilities_json TEXT,
        personal_context_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_quota_snapshots (
        scope_id TEXT PRIMARY KEY,
        remaining_percent REAL NOT NULL,
        reset_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_storage (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('local','uploading','remote_verified','evicting','cold','restoring','error')),
        generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
        manifest_json TEXT,
        manifest_sha256 TEXT,
        archive_sha256 TEXT,
        archive_bytes INTEGER,
        plaintext_bytes INTEGER,
        remote_drive_id TEXT,
        remote_path TEXT,
        local_isolated_path TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
        last_error TEXT,
        uploaded_at TEXT,
        verified_at TEXT,
        restored_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_storage_audit (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        action TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS conversations_storage_init
      AFTER INSERT ON conversations
      BEGIN
        INSERT OR IGNORE INTO conversation_storage(conversation_id,state,generation,revision,created_at,updated_at)
        VALUES(NEW.id,'local',0,0,NEW.created_at,NEW.created_at);
      END;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        quote_excerpt TEXT,
        is_scheduled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_prompts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        quote_excerpt TEXT,
        agent_model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composer_drafts (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        quote_excerpt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        pending_prompt_id TEXT REFERENCES pending_prompts(id) ON DELETE CASCADE,
        composer_draft_id TEXT REFERENCES composer_drafts(conversation_id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        source_path TEXT,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        agent_model TEXT,
        reasoning_effort TEXT,
        queue_seq INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        finalization_state TEXT NOT NULL DEFAULT 'staging',
        finalization_payload TEXT,
        finalization_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_events (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(job_id, seq)
      );
      CREATE TABLE IF NOT EXISTS wake_plans (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        created_by_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'armed',
        revision INTEGER NOT NULL DEFAULT 0,
        label TEXT NOT NULL,
        run_id TEXT,
        deadline_at TEXT NOT NULL,
        success_prompt TEXT NOT NULL,
        failure_prompt TEXT NOT NULL,
        timeout_prompt TEXT NOT NULL,
        new_conversation INTEGER NOT NULL DEFAULT 0,
        target_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        agent_model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        event_token_hash TEXT,
        trigger_cause TEXT,
        triggered_at TEXT,
        cancelled_at TEXT,
        pending_prompt_id TEXT UNIQUE REFERENCES pending_prompts(id) ON DELETE SET NULL,
        job_id TEXT UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
        last_heartbeat_at TEXT,
        last_event_at TEXT,
        last_event_kind TEXT,
        last_event_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wake_events (
        wake_plan_id TEXT NOT NULL REFERENCES wake_plans(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT,
        accepted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY(wake_plan_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, key)
      );
      CREATE TABLE IF NOT EXISTS remote_workers (
        id TEXT PRIMARY KEY,
        machine_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        status TEXT NOT NULL DEFAULT 'offline',
        platform TEXT NOT NULL,
        protocol_version INTEGER NOT NULL,
        worker_version TEXT NOT NULL,
        worker_release TEXT,
        worker_commit TEXT,
        worker_update_capable INTEGER NOT NULL DEFAULT 0,
        codex_version TEXT NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 1,
        active_jobs INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_worker_updates (
        worker_id TEXT PRIMARY KEY REFERENCES remote_workers(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL UNIQUE,
        target_version TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        dispatched_at TEXT,
        completed_at TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_worker_credentials (
        credential_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL REFERENCES remote_workers(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('active','retired','revoked')),
        issued_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        replaced_by TEXT REFERENCES remote_worker_credentials(credential_id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS executor_runtimes (
        executor_id TEXT PRIMARY KEY,
        installed_version TEXT NOT NULL DEFAULT 'unknown',
        latest_version TEXT,
        version_checked_at TEXT,
        catalog_json TEXT,
        catalog_updated_at TEXT,
        update_state TEXT NOT NULL DEFAULT 'idle',
        update_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_thread_items (
        executor_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(executor_id,thread_id,turn_id,item_id)
      );
      CREATE TABLE IF NOT EXISTS remote_thread_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        executor_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(executor_id,thread_id,turn_id,item_id)
      );
      CREATE INDEX IF NOT EXISTS remote_thread_events_conversation_seq_idx
        ON remote_thread_events(conversation_id,seq);
    `);

    const projectColumns = this.columnNames("projects");
    if (!projectColumns.has("executor_id")) this.sqlite.exec("ALTER TABLE projects ADD COLUMN executor_id TEXT NOT NULL DEFAULT 'local-host'");
    if (!projectColumns.has("archived_at")) this.sqlite.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
    if (!projectColumns.has("sort_order")) {
      this.sqlite.exec("ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
      this.sqlite.exec(`
        WITH ranked AS (
          SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY is_default DESC, updated_at DESC, name COLLATE NOCASE, id) AS position
          FROM projects
        )
        UPDATE projects SET sort_order=(SELECT position FROM ranked WHERE ranked.id=projects.id)
      `);
    }
    if (!projectColumns.has("sidebar_collapsed")) this.sqlite.exec("ALTER TABLE projects ADD COLUMN sidebar_collapsed INTEGER NOT NULL DEFAULT 0");
    const remoteWorkerColumns = this.columnNames("remote_workers");
    if (!remoteWorkerColumns.has("worker_release")) this.sqlite.exec("ALTER TABLE remote_workers ADD COLUMN worker_release TEXT");
    if (!remoteWorkerColumns.has("worker_commit")) this.sqlite.exec("ALTER TABLE remote_workers ADD COLUMN worker_commit TEXT");
    if (!remoteWorkerColumns.has("worker_update_capable")) this.sqlite.exec("ALTER TABLE remote_workers ADD COLUMN worker_update_capable INTEGER NOT NULL DEFAULT 0");

    const conversationColumns = this.columnNames("conversations");
    if (!conversationColumns.has("user_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES users(id)");
    if (!conversationColumns.has("project_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id)");
    if (!conversationColumns.has("agent_model")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN agent_model TEXT");
    if (!conversationColumns.has("reasoning_effort")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT");
    if (!conversationColumns.has("pinned_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN pinned_at TEXT");
    if (!conversationColumns.has("sidebar_order")) {
      this.sqlite.exec("ALTER TABLE conversations ADD COLUMN sidebar_order INTEGER NOT NULL DEFAULT 0");
      this.sqlite.exec(`
        WITH ranked AS (
          SELECT id, row_number() OVER (PARTITION BY user_id, project_id ORDER BY updated_at, id) AS position
          FROM conversations
        )
        UPDATE conversations SET sidebar_order=(SELECT position FROM ranked WHERE ranked.id=conversations.id)
      `);
    }
    if (!conversationColumns.has("has_unread_result")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN has_unread_result INTEGER NOT NULL DEFAULT 0");
    if (!conversationColumns.has("unread_anchor_message_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN unread_anchor_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL");
    if (!conversationColumns.has("rollout_bytes")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN rollout_bytes INTEGER");
    if (!conversationColumns.has("context_input_tokens")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN context_input_tokens INTEGER");
    if (!conversationColumns.has("context_window_tokens")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN context_window_tokens INTEGER");
    if (!conversationColumns.has("context_usage_updated_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN context_usage_updated_at TEXT");
    if (!conversationColumns.has("archived_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN archived_at TEXT");
    if (!conversationColumns.has("deleted_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN deleted_at TEXT");
    if (!conversationColumns.has("title_source")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'");
    if (!conversationColumns.has("external_status")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN external_status TEXT NOT NULL DEFAULT 'idle'");
    if (!conversationColumns.has("sync_origin")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN sync_origin TEXT NOT NULL DEFAULT 'codex_web'");
    if (!conversationColumns.has("remote_updated_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN remote_updated_at INTEGER NOT NULL DEFAULT 0");
    if (!conversationColumns.has("optional_capabilities_json")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN optional_capabilities_json TEXT");
    if (!conversationColumns.has("personal_context_revision")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN personal_context_revision INTEGER NOT NULL DEFAULT 0");
    const messageColumns = this.columnNames("messages");
    if (!messageColumns.has("quote_excerpt")) this.sqlite.exec("ALTER TABLE messages ADD COLUMN quote_excerpt TEXT");
    this.repairImportedResponseAnnotations();
    const pendingPromptColumns = this.columnNames("pending_prompts");
    if (!pendingPromptColumns.has("quote_excerpt")) this.sqlite.exec("ALTER TABLE pending_prompts ADD COLUMN quote_excerpt TEXT");
    const sessionColumns = this.columnNames("sessions");
    if (!sessionColumns.has("user_id")) this.sqlite.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)");
    const jobColumns = this.columnNames("jobs");
    if (!jobColumns.has("message_id")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN message_id TEXT REFERENCES messages(id) ON DELETE SET NULL");
    if (!jobColumns.has("agent_model")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN agent_model TEXT");
    if (!jobColumns.has("reasoning_effort")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN reasoning_effort TEXT");
    if (!jobColumns.has("queue_seq")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN queue_seq INTEGER");
    const fileColumns = this.columnNames("files");
    if (!fileColumns.has("pending_prompt_id")) this.sqlite.exec("ALTER TABLE files ADD COLUMN pending_prompt_id TEXT REFERENCES pending_prompts(id) ON DELETE CASCADE");
    if (!fileColumns.has("composer_draft_id")) this.sqlite.exec("ALTER TABLE files ADD COLUMN composer_draft_id TEXT REFERENCES composer_drafts(conversation_id) ON DELETE CASCADE");
    if (!fileColumns.has("source_path")) this.sqlite.exec("ALTER TABLE files ADD COLUMN source_path TEXT");
    this.applyMigration(2026080401, "wake-plan-prompt-revision", () => {
      if (!this.columnNames("wake_plans").has("revision")) this.sqlite.exec("ALTER TABLE wake_plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    });
    this.applyMigration(2026080402, "job-finalization-saga-and-file-hash", () => {
      const columns = this.columnNames("jobs");
      if (!columns.has("finalization_state")) {
        this.sqlite.exec("ALTER TABLE jobs ADD COLUMN finalization_state TEXT NOT NULL DEFAULT 'staging'");
        this.sqlite.prepare("UPDATE jobs SET finalization_state='published' WHERE status='completed'").run();
      }
      if (!columns.has("finalization_payload")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN finalization_payload TEXT");
      if (!columns.has("finalization_error")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN finalization_error TEXT");
      if (!this.columnNames("files").has("sha256")) this.sqlite.exec("ALTER TABLE files ADD COLUMN sha256 TEXT");
    });
    this.applyMigration(2026080403, "conversation-tombstone-gc", () => {
      const columns = this.columnNames("conversations");
      if (!columns.has("deletion_state")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'active'");
      if (!columns.has("cleanup_error")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN cleanup_error TEXT");
    });
    this.applyMigration(2026080404, "remote-worker-device-credentials", () => {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS remote_worker_credentials (
          credential_id TEXT PRIMARY KEY,
          worker_id TEXT NOT NULL REFERENCES remote_workers(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('active','retired','revoked')),
          issued_at TEXT NOT NULL,
          last_used_at TEXT,
          expires_at TEXT,
          revoked_at TEXT,
          replaced_by TEXT REFERENCES remote_worker_credentials(credential_id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS remote_worker_credentials_active_idx
          ON remote_worker_credentials(worker_id) WHERE state='active';
      `);
    });
    this.applyMigration(2026080405, "terminal-job-finalization-reconciliation", () => {
      // A terminal Job with no persisted saga payload has no filesystem work to
      // recover. Mark it published so monitoring does not report ordinary
      // failures/cancellations as stuck finalizations. Preserve payload-bearing
      // staging/files_ready/db_committed rows: startup recovery still owns them.
      this.sqlite.prepare(`
        UPDATE jobs
        SET finalization_state='published',finalization_error=NULL
        WHERE status IN ('completed','failed','cancelled','interrupted')
          AND finalization_state='staging' AND finalization_payload IS NULL
      `).run();
      // The payload is a recovery journal, not permanent message history. Once
      // published, the normalized messages/files rows are authoritative.
      this.sqlite.prepare(`
        UPDATE jobs SET finalization_payload=NULL,finalization_error=NULL
        WHERE finalization_state='published'
      `).run();
    });
    this.applyMigration(2026080406, "unique-active-project-thread", () => {
      // A Remote observer can see a newly created Codex thread just before the
      // controlled Job receives thread_started. The claim path below merges that
      // short-lived observer row before assigning the canonical thread ID; this
      // index prevents any other path from silently retaining two visible rows.
      this.sqlite.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS conversations_active_project_thread_idx
        ON conversations(project_id,codex_thread_id)
        WHERE codex_thread_id IS NOT NULL AND deleted_at IS NULL
      `);
    });
    this.applyMigration(2026080801, "tus-resumable-uploads", () => {
      this.sqlite.exec(`
        CREATE TABLE resumable_uploads (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          file_id TEXT NOT NULL UNIQUE,
          original_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL CHECK(size >= 0),
          offset INTEGER NOT NULL DEFAULT 0 CHECK(offset >= 0 AND offset <= size),
          storage_name TEXT NOT NULL UNIQUE,
          final_name TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('uploading','finalizing','completed','cancelled','expired')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX resumable_uploads_owner_state_idx ON resumable_uploads(user_id,state,expires_at);
        CREATE INDEX resumable_uploads_conversation_state_idx ON resumable_uploads(conversation_id,state);
        CREATE INDEX resumable_uploads_expiry_idx ON resumable_uploads(state,expires_at);
      `);
    });
    this.applyMigration(2026080901, "public-file-sharing-and-audit", () => {
      this.sqlite.exec(`
        CREATE TABLE public_file_shares (
          id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          file_name_snapshot TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
          created_at TEXT NOT NULL,
          enabled_at TEXT,
          disabled_at TEXT
        );
        CREATE TABLE public_file_share_assets (
          share_id TEXT NOT NULL REFERENCES public_file_shares(id) ON DELETE CASCADE,
          asset_file_id TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(share_id,source_ref),
          UNIQUE(share_id,asset_file_id,source_ref)
        );
        CREATE TABLE public_share_access_events (
          id TEXT PRIMARY KEY,
          share_id TEXT NOT NULL REFERENCES public_file_shares(id) ON DELETE CASCADE,
          ip_address TEXT NOT NULL,
          view_id TEXT NOT NULL,
          user_agent TEXT,
          accessed_at TEXT NOT NULL,
          UNIQUE(share_id,view_id)
        );
        CREATE TABLE public_share_access_rollups (
          share_id TEXT NOT NULL REFERENCES public_file_shares(id) ON DELETE CASCADE,
          ip_address TEXT NOT NULL,
          first_accessed_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(share_id,ip_address)
        );
        CREATE INDEX public_file_shares_user_enabled_idx ON public_file_shares(user_id,enabled);
        CREATE INDEX public_file_share_assets_asset_idx ON public_file_share_assets(asset_file_id);
        CREATE INDEX public_share_access_events_share_time_idx ON public_share_access_events(share_id,accessed_at);
        CREATE INDEX public_share_access_events_time_idx ON public_share_access_events(accessed_at);
        CREATE INDEX public_share_access_rollups_last_idx ON public_share_access_rollups(last_accessed_at);
      `);
    });
    this.applyMigration(2026081201, "conversation-optional-capability-state", () => {
      if (!this.columnNames("conversations").has("optional_capabilities_json")) {
        this.sqlite.exec("ALTER TABLE conversations ADD COLUMN optional_capabilities_json TEXT");
      }
    });
    this.applyMigration(2026081501, "agent-wake-new-conversation", () => {
      const columns = this.columnNames("wake_plans");
      if (!columns.has("new_conversation")) {
        this.sqlite.exec("ALTER TABLE wake_plans ADD COLUMN new_conversation INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.has("target_conversation_id")) {
        this.sqlite.exec("ALTER TABLE wake_plans ADD COLUMN target_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL");
      }
    });
    this.applyMigration(2026081502, "conversation-unread-message-anchor", () => {
      const columns = this.columnNames("conversations");
      if (!columns.has("unread_anchor_message_id")) {
        this.sqlite.exec("ALTER TABLE conversations ADD COLUMN unread_anchor_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL");
      }
      this.sqlite.exec(`
        UPDATE conversations
        SET unread_anchor_message_id=(
          SELECT assistant.id
          FROM messages assistant
          WHERE assistant.conversation_id=conversations.id AND assistant.role='assistant'
            AND NOT EXISTS (
              SELECT 1 FROM messages later_user
              WHERE later_user.conversation_id=conversations.id AND later_user.role='user'
                AND (later_user.created_at>assistant.created_at OR (later_user.created_at=assistant.created_at AND later_user.id>assistant.id))
            )
          ORDER BY assistant.created_at,assistant.id LIMIT 1
        )
        WHERE has_unread_result=1 AND unread_anchor_message_id IS NULL
      `);
    });
    this.applyMigration(2026081503, "personal-memory-pipeline", () => {
      const columns = this.columnNames("conversations");
      if (!columns.has("personal_context_revision")) {
        this.sqlite.exec("ALTER TABLE conversations ADD COLUMN personal_context_revision INTEGER NOT NULL DEFAULT 0");
      }
      this.sqlite.exec(`
        CREATE TABLE personal_memory_outbox (
          message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          processed_at TEXT
        );
        CREATE TABLE personal_memory_entries (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('identity','preference','knowledge_level','current_focus','project_pointer')),
          canonical_key TEXT NOT NULL,
          statement TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'user_global',
          status TEXT NOT NULL CHECK(status IN ('candidate','active','conflicted','forgotten','stale')),
          confidence TEXT NOT NULL CHECK(confidence IN ('explicit','high','medium','low')),
          sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK(sensitivity IN ('normal','sensitive')),
          review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_state IN ('unreviewed','accepted','rejected','corrected','forgotten')),
          reviewed_at TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id,kind,canonical_key)
        );
        CREATE TABLE personal_memory_evidence (
          entry_id TEXT NOT NULL REFERENCES personal_memory_entries(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('direct','inferred','correction','forget')),
          evidence_date TEXT NOT NULL,
          excerpt TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(entry_id,message_id)
        );
        CREATE TABLE personal_memory_runs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message_ids_json TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
          candidate_count INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT NOT NULL
        );
        CREATE TABLE personal_memory_state (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL DEFAULT 0,
          snapshot_hash TEXT,
          last_published_at TEXT,
          last_successful_run_at TEXT
        );
        CREATE TABLE personal_memory_revisions (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          snapshot_hash TEXT NOT NULL,
          run_id TEXT REFERENCES personal_memory_runs(id) ON DELETE SET NULL,
          published_file TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(user_id,revision)
        );
        CREATE INDEX personal_memory_outbox_pending_idx ON personal_memory_outbox(user_id,status,next_attempt_at,created_at);
        CREATE INDEX personal_memory_entries_active_idx ON personal_memory_entries(user_id,status,kind,last_seen_at);
        CREATE INDEX personal_memory_evidence_message_idx ON personal_memory_evidence(message_id);
        CREATE TRIGGER personal_memory_enqueue_user_message
        AFTER INSERT ON messages WHEN NEW.role='user'
        BEGIN
          INSERT OR IGNORE INTO personal_memory_outbox(
            message_id,user_id,conversation_id,status,attempts,next_attempt_at,last_error,created_at,processed_at
          )
          SELECT NEW.id,conversation.user_id,NEW.conversation_id,'pending',0,NULL,NULL,NEW.created_at,NULL
          FROM conversations conversation WHERE conversation.id=NEW.conversation_id;
        END;
      `);
    });
    this.applyMigration(2026081504, "hide-personal-context-progress-echoes", () => {
      const replacement = JSON.stringify({ kind: "status", label: "正在继续处理" });
      this.sqlite.prepare(`
        UPDATE job_events SET payload=?
        WHERE instr(payload,'codex_web_personal_context')>0
      `).run(replacement);
      this.sqlite.prepare(`
        UPDATE remote_thread_events SET payload=?
        WHERE instr(payload,'codex_web_personal_context')>0
      `).run(replacement);
      const leakedMessages = this.sqlite.prepare(`
        SELECT id,content FROM messages WHERE instr(content,'codex_web_personal_context')>0
      `).all() as Array<{ id: string; content: string }>;
      const updateMessage = this.sqlite.prepare("UPDATE messages SET content=? WHERE id=?");
      for (const message of leakedMessages) updateMessage.run(stripPersonalContext(message.content), message.id);
    });
    this.applyMigration(2026081601, "voice-lexicon-pipeline", () => {
      this.sqlite.exec(`
        CREATE TABLE voice_transcriptions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          pending_prompt_id TEXT REFERENCES pending_prompts(id) ON DELETE SET NULL,
          raw_text TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          selected_terms_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','processed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          submitted_at TEXT,
          reviewed_at TEXT
        );
        CREATE TABLE voice_lexicon_terms (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          canonical_key TEXT NOT NULL,
          canonical_text TEXT NOT NULL,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          term_kind TEXT NOT NULL DEFAULT 'specialized_term',
          status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','active','conflicted','suppressed')),
          pinned INTEGER NOT NULL DEFAULT 0,
          usage_score REAL NOT NULL DEFAULT 0,
          voice_opportunities REAL NOT NULL DEFAULT 0,
          weighted_errors REAL NOT NULL DEFAULT 0,
          reliable_error_rate REAL NOT NULL DEFAULT 0,
          rank_index REAL NOT NULL DEFAULT 0,
          last_used_at TEXT,
          last_error_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE voice_term_evidence (
          id TEXT PRIMARY KEY,
          term_id TEXT NOT NULL REFERENCES voice_lexicon_terms(id) ON DELETE CASCADE,
          transcription_id TEXT NOT NULL REFERENCES voice_transcriptions(id) ON DELETE CASCADE,
          observed_text TEXT NOT NULL,
          canonical_text TEXT NOT NULL,
          confidence REAL NOT NULL,
          use_weight REAL NOT NULL,
          error_weight REAL NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(term_id,transcription_id,observed_text)
        );
        CREATE TABLE voice_lexicon_runs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          transcription_ids_json TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
          candidate_count INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX voice_lexicon_term_scope_idx
          ON voice_lexicon_terms(user_id,COALESCE(project_id,''),canonical_key);
        CREATE INDEX voice_transcriptions_review_idx
          ON voice_transcriptions(user_id,status,next_attempt_at,submitted_at);
        CREATE INDEX voice_term_evidence_term_idx ON voice_term_evidence(term_id,created_at);
      `);
    });
    this.applyMigration(2026081602, "remove-run-auto-pins", () => {
      // d9e51a0 used pinned_at as a permanent side effect of entering the
      // running state. A pin written while a Job was active can therefore be
      // identified without disturbing pins set outside a run.
      this.sqlite.exec(`
        UPDATE conversations
        SET pinned_at=NULL
        WHERE pinned_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM jobs
          WHERE jobs.conversation_id=conversations.id
            AND jobs.created_at<=conversations.pinned_at
            AND jobs.updated_at>=conversations.pinned_at
        )
      `);
    });
    this.applyMigration(2026081603, "personal-memory-management", () => {
      const columns = this.columnNames("personal_memory_entries");
      if (!columns.has("review_state")) {
        this.sqlite.exec("ALTER TABLE personal_memory_entries ADD COLUMN review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_state IN ('unreviewed','accepted','rejected','corrected','forgotten'))");
      }
      if (!columns.has("reviewed_at")) {
        this.sqlite.exec("ALTER TABLE personal_memory_entries ADD COLUMN reviewed_at TEXT");
      }
    });
    this.applyMigration(2026081701, "codex-conversation-title-audit", () => {
      this.sqlite.exec(`
        CREATE TABLE conversation_title_audits (
          id TEXT PRIMARY KEY,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          executor_id TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK(trigger IN ('first_message','remote_import')),
          model TEXT NOT NULL,
          reasoning_effort TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          request_excerpt TEXT NOT NULL,
          request_sha256 TEXT NOT NULL,
          context_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
          output_title TEXT,
          applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
          error TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          duration_ms INTEGER
        );
        CREATE INDEX conversation_title_audits_conversation_idx ON conversation_title_audits(conversation_id,started_at);
        CREATE INDEX conversation_title_audits_executor_idx ON conversation_title_audits(executor_id,started_at);
        CREATE INDEX conversation_title_audits_status_idx ON conversation_title_audits(status,started_at);
      `);
    });
    this.applyMigration(2026082001, "allow-multiple-agent-wake-plans", () => {
      // A single running Job may intentionally fan out into several independent
      // continuation conversations. The conversation-level guard still prevents
      // duplicate armed plans on the same target, but the creator Job itself is
      // no longer a global one-plan bottleneck.
      this.sqlite.exec("DROP INDEX IF EXISTS wake_plans_active_creator_idx");
    });
    this.applyMigration(2026082002, "scheduled-message-identity", () => {
      if (!this.columnNames("messages").has("is_scheduled")) {
        this.sqlite.exec("ALTER TABLE messages ADD COLUMN is_scheduled INTEGER NOT NULL DEFAULT 0");
      }
      // Existing wake plans retain their dispatched Job, so old scheduled
      // prompts can receive the same identity without relabeling manual input.
      this.sqlite.exec(`
        UPDATE messages SET is_scheduled=1
        WHERE id IN (
          SELECT job.message_id FROM wake_plans wake
          JOIN jobs job ON job.id=wake.job_id
          WHERE job.message_id IS NOT NULL
        )
      `);
    });
    this.applyMigration(2026082101, "executor-codex-account-quota-scope", () => {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS executor_codex_account_state (
          executor_id TEXT PRIMARY KEY,
          active_account_id TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    });
    this.applyMigration(2026082201, "conversation-cold-storage", () => {
      if (!this.columnNames("conversations").has("last_active_at")) {
        this.sqlite.exec("ALTER TABLE conversations ADD COLUMN last_active_at TEXT");
      }
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS conversation_storage (
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN ('local','uploading','remote_verified','evicting','cold','restoring','error')),
          generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
          manifest_json TEXT,
          manifest_sha256 TEXT,
          archive_sha256 TEXT,
          archive_bytes INTEGER,
          plaintext_bytes INTEGER,
          remote_drive_id TEXT,
          remote_path TEXT,
          local_isolated_path TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
          last_error TEXT,
          uploaded_at TEXT,
          verified_at TEXT,
          restored_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversation_storage_audit (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          generation INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          from_state TEXT NOT NULL,
          to_state TEXT NOT NULL,
          action TEXT NOT NULL,
          details_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS conversations_storage_init
        AFTER INSERT ON conversations
        BEGIN
          INSERT OR IGNORE INTO conversation_storage(conversation_id,state,generation,revision,created_at,updated_at)
          VALUES(NEW.id,'local',0,0,NEW.created_at,NEW.created_at);
        END;
        CREATE INDEX IF NOT EXISTS conversation_storage_state_idx ON conversation_storage(state,updated_at);
        CREATE INDEX IF NOT EXISTS conversation_storage_audit_conversation_idx ON conversation_storage_audit(conversation_id,created_at);
      `);
      this.sqlite.prepare("UPDATE conversations SET last_active_at=COALESCE(last_active_at,updated_at)").run();
      const now = new Date().toISOString();
      this.sqlite.prepare(`
        INSERT OR IGNORE INTO conversation_storage(conversation_id,state,generation,revision,created_at,updated_at)
        SELECT id,'local',0,0,?,? FROM conversations
      `).run(now, now);
    });
    this.applyMigration(2026082202, "codex-quota-reset-time", () => {
      if (!this.columnNames("codex_quota_snapshots").has("reset_at")) {
        this.sqlite.exec("ALTER TABLE codex_quota_snapshots ADD COLUMN reset_at TEXT");
      }
    });
    this.applyMigration(2026082401, "voice-recording-storage", () => {
      const columns = this.columnNames("voice_transcriptions");
      const additions = [
        ["audio_relative_path", "TEXT"],
        ["audio_mime_type", "TEXT"],
        ["audio_bytes", "INTEGER"],
        ["audio_sha256", "TEXT"],
        ["audio_storage_state", "TEXT NOT NULL DEFAULT 'none' CHECK(audio_storage_state IN ('none','local','uploading','remote_verified','evicting','cold','restoring','error'))"],
        ["audio_generation", "INTEGER NOT NULL DEFAULT 0"],
        ["audio_revision", "INTEGER NOT NULL DEFAULT 0"],
        ["audio_archive_sha256", "TEXT"],
        ["audio_archive_bytes", "INTEGER"],
        ["audio_remote_drive_id", "TEXT"],
        ["audio_remote_path", "TEXT"],
        ["audio_local_isolated_path", "TEXT"],
        ["audio_last_error", "TEXT"],
        ["audio_uploaded_at", "TEXT"],
        ["audio_verified_at", "TEXT"],
        ["audio_restored_at", "TEXT"],
        ["audio_updated_at", "TEXT"],
      ] as const;
      for (const [name, definition] of additions) {
        if (!columns.has(name)) this.sqlite.exec(`ALTER TABLE voice_transcriptions ADD COLUMN ${name} ${definition}`);
      }
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS voice_recording_storage_audit (
          id TEXT PRIMARY KEY,
          transcription_id TEXT NOT NULL REFERENCES voice_transcriptions(id) ON DELETE CASCADE,
          generation INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          from_state TEXT NOT NULL,
          to_state TEXT NOT NULL,
          action TEXT NOT NULL,
          details_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS voice_recording_storage_state_idx ON voice_transcriptions(audio_storage_state,audio_updated_at,created_at);
        CREATE INDEX IF NOT EXISTS voice_recording_storage_audit_idx ON voice_recording_storage_audit(transcription_id,created_at);
      `);
    });
    this.applyMigration(2026082501, "login-throttle", () => {
      this.sqlite.exec("CREATE TABLE IF NOT EXISTS login_ip_throttles (ip_hash TEXT PRIMARY KEY,fail_count INTEGER NOT NULL DEFAULT 0 CHECK(fail_count>=0),blocked_until TEXT,updated_at TEXT NOT NULL);");
    });
    this.applyMigration(2026082601, "voice-transcription-idempotency", () => {
      if (!this.columnNames("voice_transcriptions").has("client_recording_id")) this.sqlite.exec("ALTER TABLE voice_transcriptions ADD COLUMN client_recording_id TEXT");
      this.sqlite.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS voice_transcriptions_client_recording_idx
          ON voice_transcriptions(user_id,client_recording_id) WHERE client_recording_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS voice_transcription_receipts (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          client_recording_id TEXT NOT NULL,
          audio_sha256 TEXT NOT NULL,
          audio_bytes INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('processing','succeeded','failed')),
          transcription_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(user_id,client_recording_id)
        );
        CREATE INDEX IF NOT EXISTS voice_transcription_receipts_retention_idx ON voice_transcription_receipts(state,updated_at);
      `);
    });
    const titleAuditRecoveryAt = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE conversation_title_audits
      SET status='failed',error='server_restart',completed_at=?,duration_ms=MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER))
      WHERE status='running'
    `).run(titleAuditRecoveryAt, titleAuditRecoveryAt);
    this.sqlite.prepare("UPDATE jobs SET queue_seq=rowid WHERE queue_seq IS NULL").run();
    this.suppressImportedControlledTurns();
    this.convergeImportedRemoteAssistantTurns();

    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO users(id,username,display_name,password_hash,role,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username, display_name=excluded.display_name,
        password_hash=CASE WHEN excluded.password_hash<>'' THEN excluded.password_hash ELSE users.password_hash END,
        role='owner', status='active', updated_at=excluded.updated_at
    `).run(LEGACY_USER_ID, legacyUser.username, legacyUser.displayName ?? legacyUser.username, legacyUser.passwordHash, "owner", now, now);

    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("UPDATE conversations SET user_id=? WHERE user_id IS NULL").run(LEGACY_USER_ID);
      this.sqlite.prepare("UPDATE sessions SET user_id=? WHERE user_id IS NULL").run(LEGACY_USER_ID);
      const legacySetting = this.sqlite.prepare("SELECT value,updated_at FROM app_settings WHERE key='agent_selection'").get() as { value: string; updated_at: string } | undefined;
      if (legacySetting) {
        this.sqlite.prepare("INSERT OR IGNORE INTO user_settings(user_id,key,value,updated_at) VALUES(?,'agent_selection',?,?)")
          .run(LEGACY_USER_ID, legacySetting.value, legacySetting.updated_at);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }

    this.sqlite.exec("DROP INDEX IF EXISTS projects_user_root_idx");
    this.sqlite.exec("DROP INDEX IF EXISTS conversations_project_idx");
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(user_id, project_id, sidebar_order);
      CREATE UNIQUE INDEX IF NOT EXISTS projects_user_executor_root_idx ON projects(user_id, executor_id, root_path);
      CREATE UNIQUE INDEX IF NOT EXISTS projects_user_default_idx ON projects(user_id) WHERE is_default=1;
      CREATE INDEX IF NOT EXISTS conversations_user_active_idx ON conversations(user_id, deleted_at, updated_at);
      CREATE INDEX IF NOT EXISTS conversations_user_archived_idx ON conversations(user_id, deleted_at, archived_at);
      CREATE INDEX IF NOT EXISTS conversations_user_pinned_idx ON conversations(user_id, deleted_at, pinned_at, updated_at);
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS files_conversation_idx ON files(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS files_pending_prompt_idx ON files(pending_prompt_id, created_at);
      CREATE INDEX IF NOT EXISTS files_composer_draft_idx ON files(composer_draft_id, created_at);
      CREATE INDEX IF NOT EXISTS pending_prompts_queue_idx ON pending_prompts(conversation_id, status, position);
      CREATE INDEX IF NOT EXISTS jobs_conversation_idx ON jobs(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, queue_seq);
      CREATE UNIQUE INDEX IF NOT EXISTS wake_plans_active_conversation_idx ON wake_plans(conversation_id) WHERE state='armed';
      CREATE INDEX IF NOT EXISTS wake_plans_due_idx ON wake_plans(state,deadline_at);
      CREATE INDEX IF NOT EXISTS wake_events_plan_created_idx ON wake_events(wake_plan_id,created_at);
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS remote_thread_items_conversation_idx ON remote_thread_items(conversation_id,created_at);
      CREATE INDEX IF NOT EXISTS remote_worker_credentials_worker_idx ON remote_worker_credentials(worker_id,issued_at);
      CREATE INDEX IF NOT EXISTS personal_memory_outbox_pending_idx ON personal_memory_outbox(user_id,status,next_attempt_at,created_at);
      CREATE INDEX IF NOT EXISTS personal_memory_entries_active_idx ON personal_memory_entries(user_id,status,kind,last_seen_at);
      CREATE INDEX IF NOT EXISTS personal_memory_evidence_message_idx ON personal_memory_evidence(message_id);
      CREATE INDEX IF NOT EXISTS voice_transcriptions_review_idx ON voice_transcriptions(user_id,status,next_attempt_at,submitted_at);
      CREATE INDEX IF NOT EXISTS voice_term_evidence_term_idx ON voice_term_evidence(term_id,created_at);
    `);

    const uploadedFiles = this.sqlite.prepare("SELECT id,original_name FROM files WHERE kind='upload'").all() as Array<{ id: string; original_name: string }>;
    const updateName = this.sqlite.prepare("UPDATE files SET original_name=? WHERE id=?");
    for (const file of uploadedFiles) {
      const normalizedName = normalizeUploadFileName(file.original_name);
      if (normalizedName !== file.original_name) updateName.run(normalizedName, file.id);
    }
    this.sqlite.prepare("UPDATE files SET relative_path=replace(relative_path, '\\', '/') WHERE instr(relative_path, '\\') > 0").run();
  }

  private columnNames(table: string): Set<string> {
    return new Set((this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  }

  private applyMigration(version: number, name: string, change: () => void): void {
    const applied = this.sqlite.prepare("SELECT name FROM schema_migrations WHERE version=?").get(version) as { name: string } | undefined;
    if (applied) {
      if (applied.name !== name) throw new Error(`SQLite migration ${version} name mismatch`);
      return;
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const concurrent = this.sqlite.prepare("SELECT name FROM schema_migrations WHERE version=?").get(version) as { name: string } | undefined;
      if (concurrent) {
        if (concurrent.name !== name) throw new Error(`SQLite migration ${version} name mismatch`);
      } else {
        change();
        this.sqlite.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
          .run(version, name, new Date().toISOString());
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private repairImportedResponseAnnotations(): number {
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT messages.id,messages.content,messages.quote_excerpt
      FROM messages
      JOIN remote_thread_items ON remote_thread_items.message_id=messages.id
      WHERE messages.role='user' AND instr(messages.content,'Response annotations:') > 0
    `).all() as Array<{ id: string; content: string; quote_excerpt: string | null }>;
    const update = this.sqlite.prepare("UPDATE messages SET content=?,quote_excerpt=? WHERE id=?");
    let repaired = 0;
    for (const row of rows) {
      const parsed = parseResponseAnnotatedRequest(row.content);
      if (!parsed || (parsed.content === row.content && parsed.quoteExcerpt === row.quote_excerpt)) continue;
      update.run(parsed.content, parsed.quoteExcerpt, row.id);
      repaired += 1;
    }
    return repaired;
  }

  private suppressImportedControlledTurns(conversationId?: string): number {
    const assistantItems = this.sqlite.prepare(`
      SELECT item.rowid AS mapping_rowid,item.message_id,message.content
      FROM remote_thread_items item
      JOIN messages message ON message.id=item.message_id
      WHERE item.executor_id=? AND item.thread_id=? AND item.turn_id=? AND item.conversation_id=?
        AND item.role='assistant' AND item.message_id IS NOT NULL
      ORDER BY item.rowid
    `);
    const duplicateAssistant = this.sqlite.prepare(`
      SELECT 1 FROM messages message
      WHERE message.conversation_id=? AND message.role='assistant' AND message.content=? AND message.id<>?
      LIMIT 1
    `);
    const clearMapping = this.sqlite.prepare("UPDATE remote_thread_items SET message_id=NULL WHERE rowid=?");
    const deleteUnreferencedMessage = this.sqlite.prepare(`
      DELETE FROM messages
      WHERE id=?
        AND NOT EXISTS (SELECT 1 FROM remote_thread_items item WHERE item.message_id=messages.id)
        AND NOT EXISTS (SELECT 1 FROM files file WHERE file.message_id=messages.id)
        AND NOT EXISTS (SELECT 1 FROM jobs job WHERE job.message_id=messages.id)
    `);
    const suppressActivities = this.sqlite.prepare(`
      UPDATE remote_thread_events SET payload=?
      WHERE executor_id=? AND thread_id=? AND turn_id=? AND conversation_id=?
    `);
    let repaired = 0;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const candidateClaims = this.sqlite.prepare(`
        SELECT item.rowid AS mapping_rowid,item.message_id AS remote_message_id,item.created_at AS remote_created_at,
          remote_message.content AS remote_content,job.message_id AS job_message_id,
          job.created_at AS job_created_at,job.updated_at AS job_updated_at,job_message.content AS job_content,
          job_message.quote_excerpt AS job_quote_excerpt
        FROM remote_thread_items item
        JOIN messages remote_message ON remote_message.id=item.message_id
        JOIN jobs job ON job.conversation_id=item.conversation_id AND job.message_id IS NOT NULL
        JOIN messages job_message ON job_message.id=job.message_id
        WHERE item.role='user' AND item.message_id IS NOT NULL AND item.message_id<>job.message_id
          AND (? IS NULL OR item.conversation_id=?)
        ORDER BY item.rowid,job.created_at DESC,job.id DESC
      `).all(conversationId ?? null, conversationId ?? null) as Array<{
        mapping_rowid: number;
        remote_message_id: string;
        remote_created_at: string;
        remote_content: string;
        job_message_id: string;
        job_created_at: string;
        job_updated_at: string;
        job_content: string;
        job_quote_excerpt: string | null;
      }>;
      const claimedMappings = new Set<number>();
      const alreadyClaimedJobs = new Set((this.sqlite.prepare(`
        SELECT DISTINCT job.message_id
        FROM remote_thread_items item JOIN jobs job ON job.message_id=item.message_id
      `).all() as Array<{ message_id: string }>).map((row) => row.message_id));
      const claimMapping = this.sqlite.prepare("UPDATE remote_thread_items SET message_id=? WHERE rowid=?");
      for (const candidate of candidateClaims) {
        if (claimedMappings.has(candidate.mapping_rowid) || alreadyClaimedJobs.has(candidate.job_message_id)
          || !remoteItemFallsWithinJob(candidate.remote_created_at, candidate.job_created_at, candidate.job_updated_at)
          || !remoteUserMessageMatchesJob(candidate.remote_content, candidate.job_content, candidate.job_quote_excerpt)) continue;
        claimMapping.run(candidate.job_message_id, candidate.mapping_rowid);
        deleteUnreferencedMessage.run(candidate.remote_message_id);
        claimedMappings.add(candidate.mapping_rowid);
        alreadyClaimedJobs.add(candidate.job_message_id);
        repaired += 1;
      }

      const turns = this.sqlite.prepare(`
        SELECT controlled.executor_id,controlled.thread_id,controlled.turn_id,controlled.conversation_id,
          MAX(CASE WHEN job.status='running' THEN 1 ELSE 0 END) AS active_job
        FROM remote_thread_items controlled
        JOIN jobs job ON job.message_id=controlled.message_id
        WHERE (? IS NULL OR controlled.conversation_id=?)
        GROUP BY controlled.executor_id,controlled.thread_id,controlled.turn_id,controlled.conversation_id
      `).all(conversationId ?? null, conversationId ?? null) as Array<{ executor_id: string; thread_id: string; turn_id: string; conversation_id: string; active_job: number }>;
      for (const turn of turns) {
        const items = assistantItems.all(
          turn.executor_id, turn.thread_id, turn.turn_id, turn.conversation_id,
        ) as Array<{ mapping_rowid: number; message_id: string; content: string }>;
        for (const [index, item] of items.entries()) {
          const finalItem = index === items.length - 1;
          const hasCanonicalFinal = finalItem && Boolean(duplicateAssistant.get(turn.conversation_id, item.content, item.message_id));
          if (!turn.active_job && finalItem && !hasCanonicalFinal) continue;
          clearMapping.run(item.mapping_rowid);
          deleteUnreferencedMessage.run(item.message_id);
          repaired += 1;
        }
        const suppressedPayload = JSON.stringify({ kind: SUPPRESSED_CONTROLLED_ACTIVITY_KIND, label: "" });
        const result = suppressActivities.run(
          suppressedPayload, turn.executor_id, turn.thread_id, turn.turn_id, turn.conversation_id,
        );
        repaired += Number(result.changes);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return repaired;
  }

  private convergeImportedRemoteAssistantTurns(): number {
    const turns = this.sqlite.prepare(`
      SELECT DISTINCT assistant.executor_id,assistant.thread_id,assistant.turn_id,assistant.conversation_id
      FROM remote_thread_items assistant
      WHERE assistant.role='assistant' AND assistant.message_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM remote_thread_items controlled
          JOIN jobs job ON job.message_id=controlled.message_id
          WHERE controlled.executor_id=assistant.executor_id AND controlled.thread_id=assistant.thread_id
            AND controlled.turn_id=assistant.turn_id AND controlled.conversation_id=assistant.conversation_id
        )
    `).all() as Array<{ executor_id: string; thread_id: string; turn_id: string; conversation_id: string }>;
    let repaired = 0;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const turn of turns) repaired += this.convergeRemoteAssistantTurn(
        turn.executor_id, turn.thread_id, turn.turn_id, turn.conversation_id,
      );
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return repaired;
  }

  private convergeRemoteAssistantTurn(
    executorId: string,
    threadId: string,
    turnId: string,
    conversationId: string,
    preferredItemId?: string,
  ): number {
    const items = this.sqlite.prepare(`
      SELECT item.rowid AS mapping_rowid,item.item_id,item.message_id,event.payload,
        EXISTS(SELECT 1 FROM files file WHERE file.message_id=item.message_id) AS has_files
      FROM remote_thread_items item
      LEFT JOIN remote_thread_events event
        ON event.executor_id=item.executor_id AND event.thread_id=item.thread_id
          AND event.turn_id=item.turn_id AND event.item_id=item.item_id
      WHERE item.executor_id=? AND item.thread_id=? AND item.turn_id=? AND item.conversation_id=?
        AND item.role='assistant' AND item.message_id IS NOT NULL
      ORDER BY item.rowid
    `).all(executorId, threadId, turnId, conversationId) as Array<{
      mapping_rowid: number;
      item_id: string;
      message_id: string;
      payload: string | null;
      has_files: number;
    }>;
    if (items.length === 0) return 0;
    const preferred = preferredItemId ? items.find((item) => item.item_id === preferredItemId) : undefined;
    const newestFirst = [...items].reverse();
    const canonical = preferred
      ?? newestFirst.find((item) => !item.payload || isSuppressedControlledActivity(item.payload))
      ?? newestFirst.find((item) => Boolean(item.has_files));
    const clearMapping = this.sqlite.prepare("UPDATE remote_thread_items SET message_id=NULL WHERE rowid=?");
    const moveFiles = this.sqlite.prepare("UPDATE files SET message_id=? WHERE message_id=?");
    const deleteUnreferencedMessage = this.sqlite.prepare(`
      DELETE FROM messages
      WHERE id=?
        AND NOT EXISTS (SELECT 1 FROM remote_thread_items item WHERE item.message_id=messages.id)
        AND NOT EXISTS (SELECT 1 FROM files file WHERE file.message_id=messages.id)
        AND NOT EXISTS (SELECT 1 FROM jobs job WHERE job.message_id=messages.id)
    `);
    let repaired = 0;
    for (const item of items) {
      if (item.mapping_rowid === canonical?.mapping_rowid) continue;
      if (canonical && item.has_files) moveFiles.run(canonical.message_id, item.message_id);
      clearMapping.run(item.mapping_rowid);
      deleteUnreferencedMessage.run(item.message_id);
      repaired += 1;
    }
    if (canonical) {
      const event = this.sqlite.prepare(`
        SELECT seq,payload FROM remote_thread_events
        WHERE executor_id=? AND thread_id=? AND turn_id=? AND item_id=?
      `).get(executorId, threadId, turnId, canonical.item_id) as { seq: number; payload: string } | undefined;
      if (event && !isSuppressedControlledActivity(event.payload)) {
        this.sqlite.prepare("DELETE FROM remote_thread_events WHERE seq=?").run(event.seq);
        repaired += 1;
      }
    } else {
      const remainingAssistant = this.sqlite.prepare(`
        SELECT 1 AS present FROM messages WHERE conversation_id=? AND role='assistant' LIMIT 1
      `).get(conversationId) as { present: number } | undefined;
      if (!remainingAssistant) {
        this.sqlite.prepare("UPDATE conversations SET has_unread_result=0,unread_anchor_message_id=NULL WHERE id=?")
          .run(conversationId);
      }
    }
    return repaired;
  }

  listUsers(): UserRow[] {
    return this.sqlite.prepare("SELECT * FROM users ORDER BY created_at,id").all() as UserRow[];
  }

  getUser(id: string): UserRow | undefined {
    return this.sqlite.prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow | undefined;
  }

  getUserByUsername(username: string): UserRow | undefined {
    return this.sqlite.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(username) as UserRow | undefined;
  }
  createUser(user: UserRow): void {
    this.sqlite.prepare("INSERT INTO users(id,username,display_name,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(
      user.id, user.username, user.display_name, user.password_hash, user.role, user.status, user.created_at, user.updated_at,
    );
  }
  getLoginThrottle(ipHash: string): LoginThrottleRow | undefined { return this.sqlite.prepare("SELECT ip_hash,fail_count,blocked_until,updated_at FROM login_ip_throttles WHERE ip_hash=?").get(ipHash) as LoginThrottleRow | undefined; }
  recordLoginFailure(ipHash: string, now = new Date()): LoginThrottleRow { const count = (this.getLoginThrottle(ipHash)?.fail_count ?? 0) + 1; const ms = count === 5 ? 60_000 : (count > 5 && count % 5 === 0 ? 300_000 : 0); const blocked = ms ? new Date(now.getTime() + ms).toISOString() : null; const updated = now.toISOString(); this.sqlite.prepare("INSERT INTO login_ip_throttles(ip_hash,fail_count,blocked_until,updated_at) VALUES(?,?,?,?) ON CONFLICT(ip_hash) DO UPDATE SET fail_count=excluded.fail_count,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at").run(ipHash, count, blocked, updated); return { ip_hash: ipHash, fail_count: count, blocked_until: blocked, updated_at: updated }; }
  resetLoginThrottle(ipHash: string): void { this.sqlite.prepare("DELETE FROM login_ip_throttles WHERE ip_hash=?").run(ipHash); }

  setUserPassword(userId: string, passwordHash: string): void {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("UPDATE users SET password_hash=?,updated_at=? WHERE id=?").run(passwordHash, new Date().toISOString(), userId);
      this.sqlite.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  setUserStatus(userId: string, status: UserRow["status"]): void {
    this.sqlite.prepare("UPDATE users SET status=?,updated_at=? WHERE id=?").run(status, new Date().toISOString(), userId);
    if (status === "disabled") this.sqlite.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
  }

  listConversations(userId?: string): ConversationRow[] {
    const order = "ORDER BY CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END, sidebar_order DESC, id";
    if (userId) return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NULL ${order}`).all(userId) as ConversationRow[];
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE deleted_at IS NULL AND archived_at IS NULL ${order}`).all() as ConversationRow[];
  }

  listConversationPage(userId: string, options: { projectId?: string; query?: string; limit?: number; offset?: number } = {}): ConversationPage {
    const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 20;
    const requestedOffset = Number.isFinite(options.offset) ? Number(options.offset) : 0;
    const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)));
    const offset = Math.max(0, Math.trunc(requestedOffset));
    const where = ["user_id=?", "deleted_at IS NULL", "archived_at IS NULL"];
    const parameters: Array<string | number> = [userId];
    if (options.projectId) { where.push("project_id=?"); parameters.push(options.projectId); }
    const query = options.query?.trim().slice(0, 100);
    if (query) { where.push("title LIKE ? ESCAPE '\\' COLLATE NOCASE"); parameters.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`); }
    const clause = where.join(" AND ");
    const total = Number((this.sqlite.prepare(`SELECT count(1) AS count FROM conversations WHERE ${clause}`).get(...parameters) as { count: number }).count);
    const order = "ORDER BY CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END, sidebar_order DESC, id";
    const conversations = this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE ${clause} ${order} LIMIT ? OFFSET ?`)
      .all(...parameters, limit, offset) as ConversationRow[];
    const nextOffset = offset + conversations.length;
    return { conversations, total, hasMore: nextOffset < total, nextOffset: nextOffset < total ? nextOffset : null };
  }

  listConversationBodySearchPage(userId: string, options: { projectId?: string; query?: string; limit?: number; offset?: number } = {}): ConversationPage {
    const query = options.query?.trim().slice(0, 100);
    if (!query) return { conversations: [], total: 0, hasMore: false, nextOffset: null };
    const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 1;
    const requestedOffset = Number.isFinite(options.offset) ? Number(options.offset) : 0;
    const limit = Math.max(1, Math.min(20, Math.trunc(requestedLimit)));
    const offset = Math.max(0, Math.trunc(requestedOffset));
    const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const where = [
      "conversations.user_id=?",
      "conversations.deleted_at IS NULL",
      "conversations.archived_at IS NULL",
      "conversations.title NOT LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "EXISTS (SELECT 1 FROM messages message WHERE message.conversation_id=conversations.id AND message.content LIKE ? ESCAPE '\\' COLLATE NOCASE)",
    ];
    const parameters: Array<string | number> = [userId, escaped, escaped];
    if (options.projectId) { where.push("conversations.project_id=?"); parameters.push(options.projectId); }
    const order = "ORDER BY CASE WHEN conversations.pinned_at IS NULL THEN 1 ELSE 0 END, conversations.sidebar_order DESC, conversations.id";
    const rows = this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE ${where.join(" AND ")} ${order} LIMIT ? OFFSET ?`)
      .all(...parameters, limit + 1, offset) as ConversationRow[];
    const hasMore = rows.length > limit;
    const conversations = rows.slice(0, limit);
    const nextOffset = offset + conversations.length;
    return { conversations, total: nextOffset + (hasMore ? 1 : 0), hasMore, nextOffset: hasMore ? nextOffset : null };
  }

  listArchivedConversationPage(userId: string, options: { query?: string; limit?: number; offset?: number } = {}): ConversationPage {
    const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 50;
    const requestedOffset = Number.isFinite(options.offset) ? Number(options.offset) : 0;
    const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)));
    const offset = Math.max(0, Math.trunc(requestedOffset));
    const where = ["user_id=?", "deleted_at IS NULL", "archived_at IS NOT NULL"];
    const parameters: Array<string | number> = [userId];
    const query = options.query?.trim().slice(0, 100);
    if (query) { where.push("title LIKE ? ESCAPE '\\' COLLATE NOCASE"); parameters.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`); }
    const clause = where.join(" AND ");
    const total = Number((this.sqlite.prepare(`SELECT count(1) AS count FROM conversations WHERE ${clause}`).get(...parameters) as { count: number }).count);
    const conversations = this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE ${clause} ORDER BY archived_at DESC,id LIMIT ? OFFSET ?`)
      .all(...parameters, limit, offset) as ConversationRow[];
    const nextOffset = offset + conversations.length;
    return { conversations, total, hasMore: nextOffset < total, nextOffset: nextOffset < total ? nextOffset : null };
  }

  ensureDefaultProject(id: string, userId: string, name: string, rootPath: string, executorId = "local-host"): ProjectRow {
    let project = this.sqlite.prepare("SELECT * FROM projects WHERE user_id=? AND is_default=1").get(userId) as ProjectRow | undefined;
    if (!project) {
      const now = new Date().toISOString();
      const sortOrder = this.nextProjectSortOrder(userId);
      this.sqlite.prepare("INSERT INTO projects(id,user_id,name,root_path,executor_id,is_default,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)")
        .run(id, userId, name, rootPath, executorId, sortOrder, now, now);
      project = this.getProject(id)!;
    } else if (project.root_path !== rootPath || project.executor_id !== executorId || project.archived_at || (project.name === "个人知识库" && name === "默认项目")) {
      const nextName = project.name === "个人知识库" && name === "默认项目" ? name : project.name;
      this.sqlite.prepare("UPDATE projects SET name=?,root_path=?,executor_id=?,archived_at=NULL,updated_at=? WHERE id=? AND user_id=?")
        .run(nextName, rootPath, executorId, new Date().toISOString(), project.id, userId);
      project = this.getProject(project.id)!;
    }
    this.sqlite.prepare("UPDATE conversations SET project_id=? WHERE user_id=? AND project_id IS NULL").run(project.id, userId);
    return project;
  }

  listProjects(userId: string): Array<ProjectRow & { conversation_count: number }> {
    return this.sqlite.prepare(`
      SELECT project.*, count(conversation.id) AS conversation_count
      FROM projects project LEFT JOIN conversations conversation
        ON conversation.project_id=project.id AND conversation.deleted_at IS NULL AND conversation.archived_at IS NULL
      WHERE project.user_id=? AND project.archived_at IS NULL GROUP BY project.id
      ORDER BY project.sort_order, project.id
    `).all(userId) as Array<ProjectRow & { conversation_count: number }>;
  }

  listActiveProjectsForExecutor(executorId: string): ProjectRow[] {
    return this.sqlite.prepare("SELECT * FROM projects WHERE executor_id=? AND archived_at IS NULL ORDER BY sort_order,id")
      .all(executorId) as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.sqlite.prepare("SELECT * FROM projects WHERE id=?").get(id) as ProjectRow | undefined;
  }

  getProjectForUser(id: string, userId: string): ProjectRow | undefined {
    return this.sqlite.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").get(id, userId) as ProjectRow | undefined;
  }

  getActiveProjectForUser(id: string, userId: string): ProjectRow | undefined {
    return this.sqlite.prepare("SELECT * FROM projects WHERE id=? AND user_id=? AND archived_at IS NULL").get(id, userId) as ProjectRow | undefined;
  }

  getProjectByRootForUser(rootPath: string, userId: string, executorId = "local-host"): ProjectRow | undefined {
    return this.sqlite.prepare("SELECT * FROM projects WHERE root_path=? AND user_id=? AND executor_id=?").get(rootPath, userId, executorId) as ProjectRow | undefined;
  }

  ensureAppSetting(key: string, value: string): string {
    this.sqlite.prepare("INSERT OR IGNORE INTO app_settings(key,value,updated_at) VALUES(?,?,?)")
      .run(key, value, new Date().toISOString());
    return (this.sqlite.prepare("SELECT value FROM app_settings WHERE key=?").get(key) as { value: string }).value;
  }

  getDefaultProject(userId: string): ProjectRow | undefined {
    return this.sqlite.prepare("SELECT * FROM projects WHERE user_id=? AND is_default=1 AND archived_at IS NULL").get(userId) as ProjectRow | undefined;
  }

  createProject(id: string, userId: string, name: string, rootPath: string, executorId = "local-host"): ProjectRow {
    const now = new Date().toISOString();
    const sortOrder = this.nextProjectSortOrder(userId);
    this.sqlite.prepare("INSERT INTO projects(id,user_id,name,root_path,executor_id,is_default,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?)")
      .run(id, userId, name, rootPath, executorId, sortOrder, now, now);
    return this.getProject(id)!;
  }

  archiveProjectForUser(id: string, userId: string): ProjectRow | undefined {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare("UPDATE projects SET archived_at=?,updated_at=? WHERE id=? AND user_id=? AND archived_at IS NULL")
      .run(now, now, id, userId);
    return result.changes ? this.getProjectForUser(id, userId) : undefined;
  }

  restoreProjectForUser(id: string, userId: string, name: string): ProjectRow | undefined {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare("UPDATE projects SET name=?,archived_at=NULL,sort_order=?,updated_at=? WHERE id=? AND user_id=? AND archived_at IS NOT NULL")
      .run(name, this.nextProjectSortOrder(userId), now, id, userId);
    return result.changes ? this.getProjectForUser(id, userId) : undefined;
  }

  private nextProjectSortOrder(userId: string): number {
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS next_order FROM projects WHERE user_id=?").get(userId) as { next_order: number };
    return row.next_order;
  }

  reorderProjectsForUser(userId: string, projectIds: string[]): boolean {
    const existing = this.listProjects(userId).map((project) => project.id);
    if (projectIds.length !== existing.length || new Set(projectIds).size !== projectIds.length || projectIds.some((id) => !existing.includes(id))) return false;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const update = this.sqlite.prepare("UPDATE projects SET sort_order=? WHERE id=? AND user_id=?");
      projectIds.forEach((id, index) => update.run(index + 1, id, userId));
      this.sqlite.exec("COMMIT");
      return true;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  setProjectSidebarCollapsedForUser(id: string, userId: string, collapsed: boolean): ProjectRow | undefined {
    const result = this.sqlite.prepare("UPDATE projects SET sidebar_collapsed=? WHERE id=? AND user_id=? AND archived_at IS NULL")
      .run(collapsed ? 1 : 0, id, userId);
    return result.changes ? this.getActiveProjectForUser(id, userId) : undefined;
  }

  listRemoteWorkers(): RemoteWorkerRow[] {
    return this.sqlite.prepare("SELECT * FROM remote_workers ORDER BY machine_name COLLATE NOCASE,id").all() as RemoteWorkerRow[];
  }

  getRemoteWorker(id: string): RemoteWorkerRow | undefined {
    return this.sqlite.prepare("SELECT * FROM remote_workers WHERE id=?").get(id) as RemoteWorkerRow | undefined;
  }

  registerRemoteWorker(input: Omit<RemoteWorkerRow, "status" | "active_jobs" | "last_seen_at" | "created_at" | "updated_at">): RemoteWorkerRow {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO remote_workers(id,machine_name,status,platform,protocol_version,worker_version,worker_release,worker_commit,worker_update_capable,codex_version,capacity,active_jobs,last_seen_at,created_at,updated_at)
      VALUES(?,?,'online',?,?,?,?,?,?,?,?,0,?,?,?)
      ON CONFLICT(id) DO UPDATE SET machine_name=excluded.machine_name,status='online',platform=excluded.platform,
        protocol_version=excluded.protocol_version,worker_version=excluded.worker_version,worker_release=excluded.worker_release,
        worker_commit=excluded.worker_commit,worker_update_capable=excluded.worker_update_capable,codex_version=excluded.codex_version,
        capacity=excluded.capacity,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at
    `).run(input.id, input.machine_name, input.platform, input.protocol_version, input.worker_version, input.worker_release,
      input.worker_commit, input.worker_update_capable, input.codex_version, input.capacity, now, now, now);
    return this.getRemoteWorker(input.id)!;
  }

  updateRemoteWorkerCapacity(id: string, capacity: number): RemoteWorkerRow | undefined {
    const result = this.sqlite.prepare("UPDATE remote_workers SET capacity=?,updated_at=? WHERE id=?")
      .run(capacity, new Date().toISOString(), id);
    return result.changes ? this.getRemoteWorker(id) : undefined;
  }

  listRemoteWorkerCredentials(workerId: string): RemoteWorkerCredentialRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM remote_worker_credentials WHERE worker_id=? ORDER BY issued_at DESC,credential_id
    `).all(workerId) as RemoteWorkerCredentialRow[];
  }

  issueRemoteWorkerCredential(workerId: string, credentialId: string, tokenHash: string, expiresAt: string | null = null): RemoteWorkerCredentialRow {
    if (!/^[0-9a-f-]{36}$/i.test(credentialId) || !/^[0-9a-f]{64}$/i.test(tokenHash)) {
      throw new Error("Remote Worker credential metadata is invalid");
    }
    if (!this.getRemoteWorker(workerId)) throw new Error("Remote Worker does not exist");
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        UPDATE remote_worker_credentials SET state='retired',revoked_at=?
        WHERE worker_id=? AND state='active'
      `).run(now, workerId);
      this.sqlite.prepare(`
        INSERT INTO remote_worker_credentials(
          credential_id,worker_id,token_hash,state,issued_at,last_used_at,expires_at,revoked_at,replaced_by
        ) VALUES(?,?,?,'active',?,NULL,?,NULL,NULL)
      `).run(credentialId, workerId, tokenHash.toLowerCase(), now, expiresAt);
      this.sqlite.prepare(`
        UPDATE remote_worker_credentials SET replaced_by=?
        WHERE worker_id=? AND state='retired' AND revoked_at=? AND replaced_by IS NULL
      `).run(credentialId, workerId, now);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.sqlite.prepare("SELECT * FROM remote_worker_credentials WHERE credential_id=?")
      .get(credentialId) as RemoteWorkerCredentialRow;
  }

  markRemoteWorkerCredentialUsed(workerId: string, credentialId: string): boolean {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare(`
      UPDATE remote_worker_credentials SET last_used_at=?
      WHERE worker_id=? AND credential_id=? AND state='active' AND (expires_at IS NULL OR expires_at>?)
    `).run(now, workerId, credentialId, now);
    return result.changes === 1;
  }

  revokeRemoteWorkerCredential(workerId: string, credentialId: string): boolean {
    const result = this.sqlite.prepare(`
      UPDATE remote_worker_credentials SET state='revoked',revoked_at=?
      WHERE worker_id=? AND credential_id=? AND state<>'revoked'
    `).run(new Date().toISOString(), workerId, credentialId);
    return result.changes === 1;
  }

  getRemoteWorkerUpdate(workerId: string): RemoteWorkerUpdateRow | undefined {
    return this.sqlite.prepare("SELECT * FROM remote_worker_updates WHERE worker_id=?").get(workerId) as RemoteWorkerUpdateRow | undefined;
  }

  listRemoteWorkerUpdates(): RemoteWorkerUpdateRow[] {
    return this.sqlite.prepare("SELECT * FROM remote_worker_updates ORDER BY requested_at,worker_id").all() as RemoteWorkerUpdateRow[];
  }

  requestRemoteWorkerUpdate(workerId: string, requestId: string, targetVersion: string, targetRef: string): RemoteWorkerUpdateRow {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO remote_worker_updates(worker_id,request_id,target_version,target_ref,state,requested_at,dispatched_at,completed_at,error,updated_at)
      VALUES(?,?,?,?,'queued',?,NULL,NULL,NULL,?)
      ON CONFLICT(worker_id) DO UPDATE SET request_id=excluded.request_id,target_version=excluded.target_version,
        target_ref=excluded.target_ref,state='queued',requested_at=excluded.requested_at,dispatched_at=NULL,
        completed_at=NULL,error=NULL,updated_at=excluded.updated_at
    `).run(workerId, requestId, targetVersion, targetRef, now, now);
    return this.getRemoteWorkerUpdate(workerId)!;
  }

  updateRemoteWorkerUpdate(workerId: string, state: RemoteWorkerUpdateState, error: string | null = null): RemoteWorkerUpdateRow | undefined {
    const now = new Date().toISOString();
    const dispatchedAt = state === "dispatching" ? now : undefined;
    const completedAt = state === "succeeded" || state === "failed" ? now : undefined;
    const result = this.sqlite.prepare(`
      UPDATE remote_worker_updates SET state=?,error=?,
        dispatched_at=CASE WHEN ? IS NOT NULL THEN ? ELSE dispatched_at END,
        completed_at=CASE WHEN ? IS NOT NULL THEN ? ELSE completed_at END,updated_at=? WHERE worker_id=?
    `).run(state, error, dispatchedAt ?? null, dispatchedAt ?? null, completedAt ?? null, completedAt ?? null, now, workerId);
    return result.changes ? this.getRemoteWorkerUpdate(workerId) : undefined;
  }

  updateRemoteWorkerPresence(id: string, status: RemoteWorkerRow["status"], activeJobs = 0): RemoteWorkerRow | undefined {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare("UPDATE remote_workers SET status=?,active_jobs=?,last_seen_at=?,updated_at=? WHERE id=?")
      .run(status, activeJobs, now, now, id);
    return result.changes ? this.getRemoteWorker(id) : undefined;
  }

  markRemoteWorkerOffline(id: string): RemoteWorkerRow | undefined {
    const result = this.sqlite.prepare("UPDATE remote_workers SET status='offline',active_jobs=0,updated_at=? WHERE id=? AND status<>'disabled'")
      .run(new Date().toISOString(), id);
    return result.changes ? this.getRemoteWorker(id) : this.getRemoteWorker(id);
  }

  getExecutorRuntime(executorId: string): ExecutorRuntimeStatus | undefined {
    const row = this.sqlite.prepare("SELECT * FROM executor_runtimes WHERE executor_id=?").get(executorId) as ExecutorRuntimeRow | undefined;
    if (!row) return undefined;
    let agentOptions: AgentOptions | null = null;
    try { agentOptions = row.catalog_json ? JSON.parse(row.catalog_json) as AgentOptions : null; }
    catch { agentOptions = null; }
    return {
      installedVersion: row.installed_version,
      latestVersion: row.latest_version,
      versionCheckedAt: row.version_checked_at,
      catalogUpdatedAt: row.catalog_updated_at,
      updateState: row.update_state,
      updateError: row.update_error,
      agentOptions,
    };
  }

  upsertExecutorRuntime(executorId: string, input: Partial<ExecutorRuntimeStatus>): ExecutorRuntimeStatus {
    const current = this.getExecutorRuntime(executorId);
    const value: ExecutorRuntimeStatus = {
      installedVersion: input.installedVersion ?? current?.installedVersion ?? "unknown",
      latestVersion: input.latestVersion !== undefined ? input.latestVersion : current?.latestVersion ?? null,
      versionCheckedAt: input.versionCheckedAt !== undefined ? input.versionCheckedAt : current?.versionCheckedAt ?? null,
      catalogUpdatedAt: input.catalogUpdatedAt !== undefined ? input.catalogUpdatedAt : current?.catalogUpdatedAt ?? null,
      updateState: input.updateState ?? current?.updateState ?? "idle",
      updateError: input.updateError !== undefined ? input.updateError : current?.updateError ?? null,
      agentOptions: input.agentOptions !== undefined ? input.agentOptions : current?.agentOptions ?? null,
    };
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO executor_runtimes(executor_id,installed_version,latest_version,version_checked_at,catalog_json,catalog_updated_at,update_state,update_error,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(executor_id) DO UPDATE SET installed_version=excluded.installed_version,latest_version=excluded.latest_version,
        version_checked_at=excluded.version_checked_at,catalog_json=excluded.catalog_json,catalog_updated_at=excluded.catalog_updated_at,
        update_state=excluded.update_state,update_error=excluded.update_error,updated_at=excluded.updated_at
    `).run(executorId, value.installedVersion, value.latestVersion, value.versionCheckedAt,
      value.agentOptions ? JSON.stringify(value.agentOptions) : null, value.catalogUpdatedAt, value.updateState, value.updateError, now);
    return value;
  }

  renameProjectForUser(id: string, userId: string, name: string): ProjectRow | undefined {
    const result = this.sqlite.prepare("UPDATE projects SET name=?,updated_at=? WHERE id=? AND user_id=? AND archived_at IS NULL")
      .run(name, new Date().toISOString(), id, userId);
    return result.changes ? this.getProjectForUser(id, userId) : undefined;
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE id=?`).get(id) as ConversationRow | undefined;
  }

  getConversationStorage(id: string): ConversationStorageRow | undefined {
    return this.sqlite.prepare("SELECT * FROM conversation_storage WHERE conversation_id=?").get(id) as ConversationStorageRow | undefined;
  }

  listConversationStorageByState(state: ConversationStorageState): ConversationStorageRow[] {
    return this.sqlite.prepare("SELECT * FROM conversation_storage WHERE state=? ORDER BY updated_at,conversation_id").all(state) as ConversationStorageRow[];
  }

  touchConversationActivity(id: string, at = new Date().toISOString()): boolean {
    return this.sqlite.prepare(`
      UPDATE conversations SET last_active_at=?
      WHERE id=? AND deleted_at IS NULL AND deletion_state='active'
    `).run(at, id).changes > 0;
  }

  transitionConversationStorage(
    id: string,
    expected: ConversationStorageState[],
    toState: ConversationStorageState,
    action: string,
    patch: Partial<Pick<ConversationStorageRow, "manifest_json" | "manifest_sha256" | "archive_sha256" | "archive_bytes" | "plaintext_bytes" | "remote_drive_id" | "remote_path" | "local_isolated_path" | "last_error" | "uploaded_at" | "verified_at" | "restored_at">> = {},
  ): ConversationStorageRow | undefined {
    const current = this.getConversationStorage(id);
    if (!current || !expected.includes(current.state)) return undefined;
    const now = new Date().toISOString();
    const allowed = new Set<string>([
      "manifest_json", "manifest_sha256", "archive_sha256", "archive_bytes", "plaintext_bytes",
      "remote_drive_id", "remote_path", "local_isolated_path", "last_error", "uploaded_at", "verified_at", "restored_at",
    ] as const);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    const assignments = ["state=?", "revision=revision+1", "updated_at=?", ...entries.map(([key]) => `${key}=?`)].join(",");
    const values: Array<string | number | null> = [toState, now, ...entries.map(([, value]) => value as string | number | null), id, current.revision, ...expected];
    const result = this.sqlite.prepare(`UPDATE conversation_storage SET ${assignments} WHERE conversation_id=? AND revision=? AND state IN (${expected.map(() => "?").join(",")})`).run(...values);
    if (!result.changes) return undefined;
    const next = this.getConversationStorage(id);
    if (!next) return undefined;
    this.sqlite.prepare(`
      INSERT INTO conversation_storage_audit(id,conversation_id,generation,revision,from_state,to_state,action,details_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(crypto.randomUUID(), id, next.generation, next.revision, current.state, toState, action,
      entries.length ? JSON.stringify(Object.fromEntries(entries)) : null, now);
    return next;
  }

  setConversationStorageError(id: string, message: string, action = "error"): ConversationStorageRow | undefined {
    const current = this.getConversationStorage(id);
    if (!current) return undefined;
    const next = this.transitionConversationStorage(id, [current.state], "error", action, { last_error: message.slice(0, 2_000) });
    if (next) this.sqlite.prepare("UPDATE conversation_storage SET retry_count=retry_count+1 WHERE conversation_id=? AND revision=?").run(id, next.revision);
    return next ? this.getConversationStorage(id) : undefined;
  }

  getConversationForUser(id: string, userId: string): ConversationRow | undefined {
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE id=? AND user_id=? AND deleted_at IS NULL`).get(id, userId) as ConversationRow | undefined;
  }

  getConversationCleanupForUser(id: string, userId: string): ConversationRow | undefined {
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE id=? AND user_id=? AND deletion_state IN ('deleting','cleanup_failed')`).get(id, userId) as ConversationRow | undefined;
  }

  listConversationCleanupCandidates(): ConversationRow[] {
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE deletion_state IN ('deleting','cleanup_failed') ORDER BY updated_at,id`).all() as ConversationRow[];
  }

  beginConversationDeletion(id: string, userId: string): ConversationRow | undefined {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.sqlite.prepare(`
        UPDATE conversations
        SET deleted_at=COALESCE(deleted_at,?),deletion_state='deleting',cleanup_error=NULL,status='idle',pinned_at=NULL,updated_at=?
        WHERE id=? AND user_id=? AND deletion_state IN ('active','cleanup_failed')
      `).run(now, now, id, userId);
      const existing = result.changes ? this.getConversation(id) : this.getConversationCleanupForUser(id, userId);
      this.sqlite.exec("COMMIT");
      return existing;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  markConversationCleanupFailed(id: string, message: string): void {
    this.sqlite.prepare(`
      UPDATE conversations SET deletion_state='cleanup_failed',cleanup_error=?,updated_at=?
      WHERE id=? AND deleted_at IS NOT NULL
    `).run(message.slice(0, 2_000), new Date().toISOString(), id);
  }

  completeConversationDeletion(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM conversations WHERE id=? AND deletion_state='deleting'").run(id).changes > 0;
  }

  createConversation(id: string, title: string, selection?: StoredAgentSelection, userId = LEGACY_USER_ID, projectId?: string): ConversationRow {
    const now = new Date().toISOString();
    const resolvedProjectId = projectId ?? this.getDefaultProject(userId)?.id ?? null;
    const sidebarOrder = this.nextConversationSidebarOrder(userId, resolvedProjectId);
    this.sqlite.prepare("INSERT INTO conversations(id,user_id,project_id,title,title_source,agent_model,reasoning_effort,status,sidebar_order,last_active_at,created_at,updated_at) VALUES(?,?,?,?,'default',?,?,'idle',?,?,?,?)").run(
      id, userId, resolvedProjectId, title, selection?.model ?? null, selection?.reasoningEffort ?? null, sidebarOrder, now, now, now,
    );
    return this.getConversation(id)!;
  }

  findReusableEmptyConversation(userId: string, projectId: string): ConversationRow | undefined {
    return this.sqlite.prepare(`
      SELECT ${conversationSelect}
      FROM conversations
      WHERE user_id=? AND project_id=?
        AND title='新任务' AND title_source='default'
        AND status='idle' AND external_status='idle'
        AND sync_origin='codex_web' AND codex_thread_id IS NULL AND remote_updated_at=0
        AND pinned_at IS NULL AND has_unread_result=0 AND unread_anchor_message_id IS NULL
        AND rollout_bytes IS NULL AND context_input_tokens IS NULL AND context_window_tokens IS NULL
        AND context_usage_updated_at IS NULL AND personal_context_revision=0
        AND archived_at IS NULL AND deleted_at IS NULL AND deletion_state='active'
        AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id=conversations.id)
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.conversation_id=conversations.id)
        AND NOT EXISTS (SELECT 1 FROM pending_prompts WHERE pending_prompts.conversation_id=conversations.id)
        AND NOT EXISTS (
          SELECT 1 FROM composer_drafts
          WHERE composer_drafts.conversation_id=conversations.id
            AND (composer_drafts.content<>'' OR composer_drafts.quote_excerpt IS NOT NULL)
        )
        AND NOT EXISTS (SELECT 1 FROM files WHERE files.conversation_id=conversations.id)
        AND NOT EXISTS (
          SELECT 1 FROM resumable_uploads
          WHERE resumable_uploads.conversation_id=conversations.id
            AND resumable_uploads.state IN ('uploading','finalizing')
        )
        AND NOT EXISTS (
          SELECT 1 FROM wake_plans
          WHERE wake_plans.conversation_id=conversations.id OR wake_plans.target_conversation_id=conversations.id
        )
      ORDER BY sidebar_order DESC,created_at DESC,id DESC
      LIMIT 1
    `).get(userId, projectId) as ConversationRow | undefined;
  }

  reuseEmptyConversationForNewTask(userId: string, projectId: string): ConversationRow | undefined {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const reusable = this.findReusableEmptyConversation(userId, projectId);
      if (!reusable) {
        this.sqlite.exec("COMMIT");
        return undefined;
      }
      this.bumpConversationSidebarOrder(reusable.id);
      const promoted = this.getConversationForUser(reusable.id, userId);
      if (!promoted) throw new Error("Reusable conversation could not be reloaded");
      this.sqlite.exec("COMMIT");
      return promoted;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  createOrReuseEmptyConversation(id: string, selection: StoredAgentSelection, userId: string, projectId: string): { conversation: ConversationRow; reused: boolean } {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const reusable = this.findReusableEmptyConversation(userId, projectId);
      if (reusable) {
        this.bumpConversationSidebarOrder(reusable.id);
        const promoted = this.getConversationForUser(reusable.id, userId);
        if (!promoted) throw new Error("Reusable conversation could not be reloaded");
        this.sqlite.exec("COMMIT");
        return { conversation: promoted, reused: true };
      }
      const conversation = this.createConversation(id, "新任务", selection, userId, projectId);
      this.sqlite.exec("COMMIT");
      return { conversation, reused: false };
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getConversationByCodexThread(projectId: string, threadId: string): ConversationRow | undefined {
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE project_id=? AND codex_thread_id=? AND deleted_at IS NULL LIMIT 1`)
      .get(projectId, threadId) as ConversationRow | undefined;
  }

  claimCodexThreadForConversation(id: string, threadId: string): { conversation: ConversationRow; mergedConversationIds: string[] } | undefined {
    const now = new Date().toISOString();
    const mergedConversationIds: string[] = [];
    let claimed: ConversationRow | undefined;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const target = this.getConversation(id);
      if (!target || target.deleted_at || !target.project_id || !target.user_id) {
        this.sqlite.exec("ROLLBACK");
        return undefined;
      }
      const duplicates = this.sqlite.prepare(`
        SELECT ${conversationSelect}
        FROM conversations
        WHERE project_id=? AND codex_thread_id=? AND id<>? AND deleted_at IS NULL
        ORDER BY created_at,id
      `).all(target.project_id, threadId, id) as ConversationRow[];
      for (const duplicate of duplicates) {
        if (duplicate.user_id !== target.user_id || duplicate.sync_origin !== "codex_app") {
          throw new Error("Codex thread is already owned by an incompatible conversation");
        }
        const unsafe = this.sqlite.prepare(`
          SELECT
            (SELECT COUNT(*) FROM jobs WHERE conversation_id=?) AS jobs,
            (SELECT COUNT(*) FROM pending_prompts WHERE conversation_id=?) AS prompts,
            (SELECT COUNT(*) FROM composer_drafts WHERE conversation_id=?) AS drafts,
            (SELECT COUNT(*) FROM wake_plans WHERE conversation_id=?) AS wakes,
            (SELECT COUNT(*) FROM files WHERE conversation_id=?) AS files
        `).get(duplicate.id, duplicate.id, duplicate.id, duplicate.id, duplicate.id) as {
          jobs: number; prompts: number; drafts: number; wakes: number; files: number;
        };
        if (Object.values(unsafe).some((count) => count > 0)) {
          throw new Error("Observed Codex thread already contains state that cannot be merged safely");
        }
        this.sqlite.prepare("UPDATE messages SET conversation_id=? WHERE conversation_id=?").run(id, duplicate.id);
        this.sqlite.prepare("UPDATE remote_thread_items SET conversation_id=? WHERE conversation_id=?").run(id, duplicate.id);
        this.sqlite.prepare("UPDATE remote_thread_events SET conversation_id=? WHERE conversation_id=?").run(id, duplicate.id);
        this.sqlite.prepare("DELETE FROM conversations WHERE id=?").run(duplicate.id);
        mergedConversationIds.push(duplicate.id);
      }
      this.sqlite.prepare(`
        UPDATE conversations SET
          context_input_tokens=CASE WHEN codex_thread_id=? THEN context_input_tokens ELSE NULL END,
          context_window_tokens=CASE WHEN codex_thread_id=? THEN context_window_tokens ELSE NULL END,
          context_usage_updated_at=CASE WHEN codex_thread_id=? THEN context_usage_updated_at ELSE NULL END,
          codex_thread_id=?,updated_at=?
        WHERE id=? AND deleted_at IS NULL
      `).run(threadId, threadId, threadId, threadId, now, id);
      claimed = this.getConversation(id);
      if (!claimed) throw new Error("Conversation disappeared while claiming its Codex thread");
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    // If the observer already imported the first user item, bind it to the
    // running Job and suppress any same-turn assistant/activity playback.
    // This second transaction runs synchronously before another JS callback.
    if (mergedConversationIds.length > 0) this.suppressImportedControlledTurns(id);
    return { conversation: this.getConversation(id) ?? claimed, mergedConversationIds };
  }

  importRemoteThread(userId: string, projectId: string, executorId: string, thread: RemoteThreadSnapshotInput, selection: StoredAgentSelection): RemoteThreadImportResult {
    const now = new Date().toISOString();
    const remoteCreatedAt = thread.createdAt > 0 ? new Date(thread.createdAt * 1000).toISOString() : now;
    const remoteUpdatedAt = thread.updatedAt > 0 ? new Date(thread.updatedAt * 1000).toISOString() : remoteCreatedAt;
    const title = thread.name.trim().slice(0, 200) || "本机任务";
    let conversation = this.getConversationByCodexThread(projectId, thread.id);
    const created = !conversation;
    const previousRemoteUpdatedAt = conversation?.remote_updated_at ?? 0;
    const previousTitle = conversation?.title;
    const previousTitleSource = conversation?.title_source;
    const previousExternalStatus = conversation?.external_status;
    const activeJob = conversation ? this.getActiveJobForConversation(conversation.id) : undefined;
    const controlledJobActive = activeJob?.status === "running";
    let importedMessages = 0;
    let importedUserMessages = 0;
    const importedAssistantMessageIds: string[] = [];
    let repairedMessages = 0;
    let importedActivities = 0;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (!conversation) {
        const id = crypto.randomUUID();
        const sidebarOrder = this.nextConversationSidebarOrder(userId, projectId);
        const titleSource: ConversationTitleSource = thread.nameSource === "explicit"
          ? "manual"
          : thread.nameSource === "preview" || thread.nameSource === "fallback"
            ? "default"
            : "legacy";
        this.sqlite.prepare(`
          INSERT INTO conversations(
            id,user_id,project_id,title,title_source,codex_thread_id,agent_model,reasoning_effort,status,external_status,
            sync_origin,remote_updated_at,rollout_bytes,sidebar_order,has_unread_result,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,'codex_app',?,?,?,0,?,?)
        `).run(
          id, userId, projectId, title, titleSource, thread.id, selection.model, selection.reasoningEffort, "idle", thread.status,
          Math.max(0, Math.trunc(thread.updatedAt)), thread.rolloutBytes ?? null, sidebarOrder, remoteCreatedAt, remoteUpdatedAt,
        );
        conversation = this.getConversation(id)!;
      } else if (controlledJobActive) {
        this.sqlite.prepare("UPDATE conversations SET rollout_bytes=COALESCE(?,rollout_bytes) WHERE id=?")
          .run(thread.rolloutBytes ?? null, conversation.id);
      } else {
        let nextTitle = conversation.title;
        let nextTitleSource = conversation.title_source;
        if (thread.nameSource === "explicit") {
          if (title !== conversation.title || !["ai", "manual"].includes(conversation.title_source)) {
            nextTitle = title;
            nextTitleSource = "manual";
          }
        } else if (thread.nameSource === "preview" || thread.nameSource === "fallback") {
          if (conversation.title_source === "default") {
            nextTitle = title;
          }
        } else if (conversation.title_source !== "ai" && conversation.title_source !== "manual") {
          nextTitle = title;
        }
        this.sqlite.prepare(`
          UPDATE conversations SET title=?,title_source=?,external_status=?,rollout_bytes=COALESCE(?,rollout_bytes),remote_updated_at=MAX(remote_updated_at,?),updated_at=CASE WHEN ? > remote_updated_at THEN ? ELSE updated_at END
          WHERE id=?
        `).run(nextTitle, nextTitleSource, thread.status, thread.rolloutBytes ?? null, Math.max(0, Math.trunc(thread.updatedAt)), Math.max(0, Math.trunc(thread.updatedAt)), remoteUpdatedAt, conversation.id);
      }

      const existingMessages = this.sqlite.prepare("SELECT id,role,content,quote_excerpt FROM messages WHERE conversation_id=? ORDER BY created_at,id")
        .all(conversation.id) as Array<{ id: string; role: string; content: string; quote_excerpt: string | null }>;
      const controlledJobMessageIds = new Set((this.sqlite.prepare("SELECT message_id FROM jobs WHERE conversation_id=? AND message_id IS NOT NULL")
        .all(conversation.id) as Array<{ message_id: string }>).map((row) => row.message_id));
      const controlledTurns = new Set((this.sqlite.prepare(`
          SELECT DISTINCT item.turn_id
          FROM remote_thread_items item
          JOIN jobs job ON job.message_id=item.message_id
          WHERE item.executor_id=? AND item.thread_id=? AND item.conversation_id=?
        `).all(executorId, thread.id, conversation.id) as Array<{ turn_id: string }>).map((row) => row.turn_id));
      const matchedExistingIds = new Set((this.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE conversation_id=? AND message_id IS NOT NULL")
        .all(conversation.id) as Array<{ message_id: string }>).map((row) => row.message_id));
      const activeJobMessage = activeJob?.message_id
        ? existingMessages.find((message) => message.id === activeJob.message_id)
        : undefined;
      const preferredAssistantItemByTurn = new Map<string, string>();
      const touchedRemoteTurns = new Set<string>();
      for (const item of thread.messages) {
        touchedRemoteTurns.add(item.turnId);
        if (item.role === "assistant") preferredAssistantItemByTurn.set(item.turnId, item.itemId);
      }
      for (const activity of thread.activities ?? []) touchedRemoteTurns.add(activity.turnId);
      let existingCursor = 0;
      for (const item of thread.messages) {
        const parsed = item.role === "user" ? parseResponseAnnotatedRequest(item.content) : null;
        const content = stripPersonalContext(parsed?.content ?? item.content);
        const quoteExcerpt = parsed?.quoteExcerpt ?? null;
        const alreadyMapped = this.sqlite.prepare(`
          SELECT message_id FROM remote_thread_items WHERE executor_id=? AND thread_id=? AND turn_id=? AND item_id=?
        `).get(executorId, thread.id, item.turnId, item.itemId) as { message_id: string | null } | undefined;
        if (alreadyMapped) {
          if (alreadyMapped.message_id && controlledJobMessageIds.has(alreadyMapped.message_id)) controlledTurns.add(item.turnId);
          if (alreadyMapped.message_id) {
            const current = this.sqlite.prepare("SELECT content,quote_excerpt FROM messages WHERE id=?")
              .get(alreadyMapped.message_id) as { content: string; quote_excerpt: string | null } | undefined;
            if (current && !controlledJobMessageIds.has(alreadyMapped.message_id)
              && (current.content !== content || current.quote_excerpt !== quoteExcerpt)) {
              this.sqlite.prepare("UPDATE messages SET content=?,quote_excerpt=? WHERE id=?")
                .run(content, quoteExcerpt, alreadyMapped.message_id);
              repairedMessages += 1;
            }
          }
          continue;
        }
        let matchedMessageId: string | null = null;
        if (item.role === "user" && controlledJobActive && activeJobMessage && !matchedExistingIds.has(activeJobMessage.id)
          && remoteUserMessageMatchesJob(content, activeJobMessage.content, activeJobMessage.quote_excerpt)) {
          matchedMessageId = activeJobMessage.id;
          matchedExistingIds.add(activeJobMessage.id);
          controlledTurns.add(item.turnId);
        } else {
          for (let index = existingCursor; index < existingMessages.length; index += 1) {
            const candidate = existingMessages[index];
            if (matchedExistingIds.has(candidate.id) || candidate.role !== item.role || candidate.content.trim() !== content.trim()
              || (candidate.quote_excerpt ?? null) !== quoteExcerpt) continue;
            matchedMessageId = candidate.id;
            matchedExistingIds.add(candidate.id);
            existingCursor = index + 1;
            break;
          }
        }
        if (matchedMessageId && controlledJobMessageIds.has(matchedMessageId)) controlledTurns.add(item.turnId);
        const suppressControlledPlayback = controlledTurns.has(item.turnId);
        if (!matchedMessageId && !suppressControlledPlayback) {
          matchedMessageId = crypto.randomUUID();
          this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,?,?,?,?)")
            .run(matchedMessageId, conversation.id, item.role, content, quoteExcerpt, item.createdAt || remoteUpdatedAt);
          importedMessages += 1;
          if (item.role === "user") importedUserMessages += 1;
          else importedAssistantMessageIds.push(matchedMessageId);
        }
        this.sqlite.prepare(`
          INSERT OR IGNORE INTO remote_thread_items(executor_id,thread_id,turn_id,item_id,conversation_id,message_id,role,created_at)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(executorId, thread.id, item.turnId, item.itemId, conversation.id, matchedMessageId, item.role, item.createdAt || remoteUpdatedAt);
      }
      for (const activity of thread.activities ?? []) {
        const suppressControlledPlayback = controlledTurns.has(activity.turnId) || containsPersonalContext(activity.detail ?? "");
        const payload = JSON.stringify({
          kind: suppressControlledPlayback ? SUPPRESSED_CONTROLLED_ACTIVITY_KIND : String(activity.kind).slice(0, 40),
          label: suppressControlledPlayback ? "" : String(activity.label).slice(0, 300),
          ...(!suppressControlledPlayback && activity.detail ? { detail: String(activity.detail).slice(0, 200_000) } : {}),
          ...(!suppressControlledPlayback && activity.files?.length ? { files: activity.files.map((file) => String(file).slice(0, 2_000)).slice(0, 200) } : {}),
          ...(!suppressControlledPlayback && activity.agents?.length ? { agents: activity.agents.slice(0, 64).map((agent) => ({
            id: String(agent.id).slice(0, 200),
            ...(agent.path ? { path: String(agent.path).slice(0, 500) } : {}),
            status: agent.status,
            ...(agent.summary ? { summary: String(agent.summary).slice(0, 2_000) } : {}),
          })) } : {}),
        });
        const existing = this.sqlite.prepare(`
          SELECT seq,payload FROM remote_thread_events
          WHERE executor_id=? AND thread_id=? AND turn_id=? AND item_id=?
        `).get(executorId, thread.id, activity.turnId, activity.itemId) as { seq: number; payload: string } | undefined;
        if (!existing) {
          this.sqlite.prepare(`
            INSERT INTO remote_thread_events(executor_id,thread_id,turn_id,item_id,conversation_id,payload,created_at)
            VALUES(?,?,?,?,?,?,?)
          `).run(executorId, thread.id, activity.turnId, activity.itemId, conversation.id, payload, activity.createdAt || remoteUpdatedAt);
          if (!suppressControlledPlayback) importedActivities += 1;
        } else if (!isSuppressedControlledActivity(existing.payload) && existing.payload !== payload) {
          this.sqlite.prepare("UPDATE remote_thread_events SET payload=?,created_at=? WHERE seq=?")
            .run(payload, activity.createdAt || remoteUpdatedAt, existing.seq);
          if (!suppressControlledPlayback) importedActivities += 1;
        }
      }
      for (const turnId of touchedRemoteTurns) {
        if (controlledTurns.has(turnId)) continue;
        repairedMessages += this.convergeRemoteAssistantTurn(
          executorId, thread.id, turnId, conversation.id, preferredAssistantItemByTurn.get(turnId),
        );
      }
      let unreadAnchorMessageId = thread.status === "idle"
        ? importedAssistantMessageIds.find((messageId) => Boolean(this.getMessage(messageId))) ?? null
        : null;
      if (!unreadAnchorMessageId && thread.status === "idle" && previousExternalStatus === "running") {
        const latestUser = this.sqlite.prepare(`
          SELECT id,created_at FROM messages
          WHERE conversation_id=? AND role='user'
          ORDER BY created_at DESC,id DESC LIMIT 1
        `).get(conversation.id) as { id: string; created_at: string } | undefined;
        if (latestUser) {
          unreadAnchorMessageId = (this.sqlite.prepare(`
            SELECT id FROM messages
            WHERE conversation_id=? AND role='assistant'
              AND (created_at>? OR (created_at=? AND id>?))
            ORDER BY created_at DESC,id DESC LIMIT 1
          `).get(conversation.id, latestUser.created_at, latestUser.created_at, latestUser.id) as { id: string } | undefined)?.id ?? null;
        }
      }
      const sidebarActivityChanged = created || importedUserMessages > 0 || unreadAnchorMessageId !== null;
      if (sidebarActivityChanged) {
        this.sqlite.prepare(`
          UPDATE conversations
          SET sidebar_order=?,has_unread_result=CASE WHEN ? IS NOT NULL THEN 1 ELSE has_unread_result END,
            unread_anchor_message_id=CASE WHEN ? IS NOT NULL THEN COALESCE(unread_anchor_message_id,?) ELSE unread_anchor_message_id END
          WHERE id=?
        `).run(
          this.nextConversationSidebarOrder(userId, projectId), unreadAnchorMessageId,
          unreadAnchorMessageId, unreadAnchorMessageId, conversation.id,
        );
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    conversation = this.getConversation(conversation.id)!;
    return {
      conversation,
      created,
      changed: created || importedMessages > 0 || repairedMessages > 0 || importedActivities > 0
        || (!controlledJobActive && (thread.updatedAt > previousRemoteUpdatedAt || conversation.title !== previousTitle
          || conversation.title_source !== previousTitleSource || thread.status !== previousExternalStatus)),
      importedMessages,
      importedActivities,
    };
  }

  getLatestRemoteTurnId(conversationId: string): string | null {
    const row = this.sqlite.prepare(`
      SELECT turn_id FROM remote_thread_items
      WHERE conversation_id=? AND role='user'
      ORDER BY rowid DESC LIMIT 1
    `).get(conversationId) as { turn_id: string } | undefined;
    return row?.turn_id ?? null;
  }

  listRemoteThreadActivities(conversationId: string, limit = 50, turnId?: string | null): RemoteThreadEventView[] {
    const size = Math.max(1, Math.min(200, Math.trunc(limit)));
    const recentRows = turnId
      ? this.sqlite.prepare(`
          SELECT seq,payload,created_at FROM remote_thread_events
          WHERE conversation_id=? AND turn_id=? ORDER BY seq DESC LIMIT ?
        `).all(conversationId, turnId, size) as Array<{ seq: number; payload: string; created_at: string }>
      : this.sqlite.prepare(`
          SELECT seq,payload,created_at FROM remote_thread_events
          WHERE conversation_id=? ORDER BY seq DESC LIMIT ?
        `).all(conversationId, size) as Array<{ seq: number; payload: string; created_at: string }>;
    const agentRows = turnId
      ? this.sqlite.prepare(`
          SELECT seq,payload,created_at FROM remote_thread_events
          WHERE conversation_id=? AND turn_id=? AND json_valid(payload)
            AND json_extract(payload,'$.kind')='agent'
          ORDER BY seq DESC LIMIT 128
        `).all(conversationId, turnId) as Array<{ seq: number; payload: string; created_at: string }>
      : this.sqlite.prepare(`
          SELECT seq,payload,created_at FROM remote_thread_events
          WHERE conversation_id=? AND json_valid(payload)
            AND json_extract(payload,'$.kind')='agent'
          ORDER BY seq DESC LIMIT 128
        `).all(conversationId) as Array<{ seq: number; payload: string; created_at: string }>;
    const rows = [...new Map([...recentRows, ...agentRows].map((row) => [row.seq, row])).values()]
      .sort((left, right) => left.seq - right.seq);
    return rows.flatMap((row): RemoteThreadEventView[] => {
      try {
        const payload = JSON.parse(row.payload) as Omit<RemoteThreadEventView, "seq" | "type" | "created_at">;
        if (!payload || typeof payload.kind !== "string" || typeof payload.label !== "string"
          || payload.kind === SUPPRESSED_CONTROLLED_ACTIVITY_KIND) return [];
        return [{ seq: row.seq, type: "progress", created_at: row.created_at, ...payload }];
      } catch {
        return [];
      }
    });
  }

  applyRemoteThreadOrderForUser(userId: string, projectId: string, threads: Array<Pick<RemoteThreadSnapshotInput, "id" | "createdAt" | "updatedAt">>): number {
    const conversations = this.sqlite.prepare(`
      SELECT id,codex_thread_id FROM conversations
      WHERE user_id=? AND project_id=? AND deleted_at IS NULL AND archived_at IS NULL AND codex_thread_id IS NOT NULL
    `).all(userId, projectId) as Array<{ id: string; codex_thread_id: string }>;
    const conversationByThread = new Map(conversations.map((conversation) => [conversation.codex_thread_id, conversation.id]));
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const thread of [...threads].sort((left, right) => remoteThreadTimestamp(right.updatedAt) - remoteThreadTimestamp(left.updatedAt)
      || remoteThreadTimestamp(right.createdAt) - remoteThreadTimestamp(left.createdAt))) {
      const conversationId = conversationByThread.get(thread.id);
      if (!conversationId || seen.has(conversationId)) continue;
      seen.add(conversationId);
      ordered.push(conversationId);
    }
    if (ordered.length === 0) return 0;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const maximum = this.sqlite.prepare(`
        SELECT COALESCE(MAX(sidebar_order),0) AS maximum FROM conversations
        WHERE user_id=? AND project_id=? AND deleted_at IS NULL
      `).get(userId, projectId) as { maximum: number };
      const update = this.sqlite.prepare("UPDATE conversations SET sidebar_order=? WHERE id=? AND user_id=? AND project_id=? AND deleted_at IS NULL");
      ordered.forEach((conversationId, index) => update.run(maximum.maximum + ordered.length - index, conversationId, userId, projectId));
      this.sqlite.exec("COMMIT");
      return ordered.length;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  updateConversation(id: string, fields: { title?: string; titleSource?: ConversationTitleSource; codexThreadId?: string; agentSelection?: StoredAgentSelection; status?: "idle" | "running" }): void {
    if (fields.title !== undefined) this.sqlite.prepare("UPDATE conversations SET title=?, title_source=COALESCE(?,title_source), updated_at=? WHERE id=?")
      .run(fields.title, fields.titleSource ?? null, new Date().toISOString(), id);
    if (fields.codexThreadId !== undefined) this.sqlite.prepare(`
      UPDATE conversations SET
        context_input_tokens=CASE WHEN codex_thread_id=? THEN context_input_tokens ELSE NULL END,
        context_window_tokens=CASE WHEN codex_thread_id=? THEN context_window_tokens ELSE NULL END,
        context_usage_updated_at=CASE WHEN codex_thread_id=? THEN context_usage_updated_at ELSE NULL END,
        personal_context_revision=CASE WHEN codex_thread_id=? THEN personal_context_revision ELSE 0 END,
        codex_thread_id=?,
        updated_at=?
      WHERE id=?
    `).run(fields.codexThreadId, fields.codexThreadId, fields.codexThreadId, fields.codexThreadId, fields.codexThreadId, new Date().toISOString(), id);
    if (fields.agentSelection !== undefined) this.sqlite.prepare("UPDATE conversations SET agent_model=?, reasoning_effort=?, updated_at=? WHERE id=?").run(
      fields.agentSelection.model, fields.agentSelection.reasoningEffort, new Date().toISOString(), id,
    );
    if (fields.status !== undefined) {
      const now = new Date().toISOString();
      this.sqlite.prepare("UPDATE conversations SET status=?, updated_at=? WHERE id=?").run(fields.status, now, id);
    }
  }

  setConversationPinnedForUser(id: string, userId: string, pinned: boolean): ConversationRow | undefined {
    const result = this.sqlite.prepare("UPDATE conversations SET pinned_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL")
      .run(pinned ? new Date().toISOString() : null, id, userId);
    if (result.changes) this.bumpConversationSidebarOrder(id);
    return result.changes ? this.getConversationForUser(id, userId) : undefined;
  }

  setConversationContextUsage(id: string, usage: ContextTokenUsage): boolean {
    const inputTokens = Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
      ? Math.trunc(usage.inputTokens)
      : null;
    const modelContextWindow = typeof usage.modelContextWindow === "number"
      && Number.isFinite(usage.modelContextWindow)
      && usage.modelContextWindow > 0
      ? Math.trunc(usage.modelContextWindow)
      : null;
    if (!usage.threadId || inputTokens === null) return false;
    const result = this.sqlite.prepare(`
      UPDATE conversations SET context_input_tokens=?,context_window_tokens=?,context_usage_updated_at=?
      WHERE id=? AND codex_thread_id=? AND deleted_at IS NULL
    `).run(inputTokens, modelContextWindow, new Date().toISOString(), id, usage.threadId);
    return result.changes > 0;
  }

  setConversationCodexQuota(id: string, usage: CodexQuotaUsage): boolean {
    const scopeId = this.conversationCodexQuotaScope(id);
    if (!scopeId) return false;
    return this.setCodexQuotaScope(scopeId, usage);
  }

  setExecutorCodexQuota(executorId: string, usage: CodexQuotaUsage, accountId?: string): boolean {
    if (!executorId) return false;
    if (accountId) this.setExecutorActiveCodexAccount(executorId, accountId);
    return this.setCodexQuotaScope(this.executorCodexQuotaScope(executorId, accountId), usage);
  }

  setExecutorActiveCodexAccount(executorId: string, accountId: string): void {
    if (!executorId || !/^[0-9a-f-]{36}$/i.test(accountId)) throw new Error("执行机器 Codex 账号状态无效");
    this.sqlite.prepare(`
      INSERT INTO executor_codex_account_state(executor_id,active_account_id,updated_at)
      VALUES(?,?,?)
      ON CONFLICT(executor_id) DO UPDATE SET active_account_id=excluded.active_account_id,updated_at=excluded.updated_at
    `).run(executorId, accountId, new Date().toISOString());
  }

  getExecutorActiveCodexAccount(executorId: string): string | null {
    const row = this.sqlite.prepare("SELECT active_account_id FROM executor_codex_account_state WHERE executor_id=?")
      .get(executorId) as { active_account_id: string } | undefined;
    return row?.active_account_id ?? null;
  }

  private executorCodexQuotaScope(executorId: string, accountId?: string): string {
    const active = accountId || this.getExecutorActiveCodexAccount(executorId);
    return active ? `executor:${executorId}:account:${active}` : `executor:${executorId}`;
  }

  private setCodexQuotaScope(scopeId: string, usage: CodexQuotaUsage): boolean {
    const remainingPercent = typeof usage.remainingPercent === "number" && Number.isFinite(usage.remainingPercent)
      ? Math.max(0, Math.min(100, usage.remainingPercent))
      : null;
    if (remainingPercent === null) return false;
    const resetAt = typeof usage.resetAt === "string" && !Number.isNaN(Date.parse(usage.resetAt))
      ? new Date(usage.resetAt).toISOString()
      : null;
    this.sqlite.prepare(`
      INSERT INTO codex_quota_snapshots(scope_id,remaining_percent,reset_at,updated_at)
      VALUES(?,?,?,?)
      ON CONFLICT(scope_id) DO UPDATE SET remaining_percent=excluded.remaining_percent,reset_at=excluded.reset_at,updated_at=excluded.updated_at
    `).run(scopeId, remainingPercent, resetAt, new Date().toISOString());
    return true;
  }

  getConversationCodexQuota(id: string): CodexQuotaSnapshot | null {
    const scopeId = this.conversationCodexQuotaScope(id);
    if (!scopeId) return null;
    const row = this.sqlite.prepare("SELECT remaining_percent,reset_at,updated_at FROM codex_quota_snapshots WHERE scope_id=?")
      .get(scopeId) as { remaining_percent: number; reset_at: string | null; updated_at: string } | undefined;
    return row ? {
      remainingPercent: row.remaining_percent,
      ...(row.reset_at ? { resetAt: row.reset_at } : {}),
      updatedAt: row.updated_at,
    } : null;
  }

  getExecutorCodexQuota(executorId: string, accountId: string): CodexQuotaSnapshot | null {
    if (!executorId || !accountId) return null;
    const scopeId = this.executorCodexQuotaScope(executorId, accountId);
    const row = this.sqlite.prepare("SELECT remaining_percent,reset_at,updated_at FROM codex_quota_snapshots WHERE scope_id=?")
      .get(scopeId) as { remaining_percent: number; reset_at: string | null; updated_at: string } | undefined;
    return row ? {
      remainingPercent: row.remaining_percent,
      ...(row.reset_at ? { resetAt: row.reset_at } : {}),
      updatedAt: row.updated_at,
    } : null;
  }

  private conversationCodexQuotaScope(id: string): string | null {
    const conversation = this.getConversation(id);
    if (!conversation) return null;
    if (isHostRootUser(conversation.user_id) && conversation.project_id) {
      const project = this.getProject(conversation.project_id);
      if (project) return this.executorCodexQuotaScope(project.executor_id);
    }
    return `user:${conversation.user_id}`;
  }

  moveConversationToProjectForUser(
    userId: string,
    id: string,
    targetProjectId: string,
    requiredExecutorId: string,
  ): ConversationProjectMoveResult {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const finish = (result: ConversationProjectMoveResult): ConversationProjectMoveResult => {
        this.sqlite.exec("COMMIT");
        return result;
      };
      const conversation = this.getConversationForUser(id, userId);
      if (!conversation || conversation.archived_at || !conversation.project_id) return finish({ status: "not_found" });
      const sourceProject = this.getProjectForUser(conversation.project_id, userId);
      const targetProject = this.getActiveProjectForUser(targetProjectId, userId);
      if (!sourceProject || sourceProject.archived_at || !targetProject) return finish({ status: "project_unavailable" });
      if (sourceProject.executor_id !== requiredExecutorId || targetProject.executor_id !== requiredExecutorId) {
        return finish({ status: "unsupported_executor" });
      }
      if (sourceProject.id === targetProject.id) {
        return finish({
          status: "unchanged",
          conversation,
          fromProjectId: sourceProject.id,
          toProjectId: targetProject.id,
        });
      }
      if (conversation.project_move_blocked) return finish({ status: "busy" });
      const now = new Date().toISOString();
      const result = this.sqlite.prepare(`
        UPDATE conversations SET project_id=?,sidebar_order=?,updated_at=?
        WHERE id=? AND user_id=? AND project_id=? AND deleted_at IS NULL AND archived_at IS NULL
      `).run(
        targetProject.id,
        this.nextConversationSidebarOrder(userId, targetProject.id),
        now,
        conversation.id,
        userId,
        sourceProject.id,
      );
      if (!result.changes) return finish({ status: "not_found" });
      const movedConversation = this.getConversationForUser(conversation.id, userId);
      if (!movedConversation) throw new Error("Moved conversation could not be reloaded");
      this.sqlite.exec("COMMIT");
      return {
        status: "moved",
        conversation: movedConversation,
        fromProjectId: sourceProject.id,
        toProjectId: targetProject.id,
      };
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  moveConversationForUser(userId: string, id: string, targetId: string, placement: "before" | "after"): boolean {
    const conversation = this.getConversationForUser(id, userId);
    const target = this.getConversationForUser(targetId, userId);
    if (!conversation || !target || conversation.id === target.id || conversation.project_id !== target.project_id || Boolean(conversation.pinned_at) !== Boolean(target.pinned_at)) return false;
    const rows = this.sqlite.prepare(`
      SELECT id FROM conversations
      WHERE user_id=? AND project_id IS ? AND deleted_at IS NULL AND archived_at IS NULL AND (pinned_at IS NULL)=?
      ORDER BY sidebar_order DESC,id
    `).all(userId, conversation.project_id, conversation.pinned_at === null ? 1 : 0) as Array<{ id: string }>;
    const ordered = rows.map((row) => row.id).filter((candidate) => candidate !== id);
    const targetIndex = ordered.indexOf(targetId);
    if (targetIndex < 0) return false;
    ordered.splice(targetIndex + (placement === "after" ? 1 : 0), 0, id);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const update = this.sqlite.prepare("UPDATE conversations SET sidebar_order=? WHERE id=? AND user_id=?");
      ordered.forEach((conversationId, index) => update.run(ordered.length - index, conversationId, userId));
      this.sqlite.exec("COMMIT");
      return true;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private nextConversationSidebarOrder(userId: string, projectId: string | null): number {
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(sidebar_order),0)+1 AS next_order FROM conversations WHERE user_id=? AND project_id IS ? AND deleted_at IS NULL AND archived_at IS NULL")
      .get(userId, projectId) as { next_order: number };
    return row.next_order;
  }

  private bumpConversationSidebarOrder(id: string): void {
    const conversation = this.getConversation(id);
    if (!conversation) return;
    this.sqlite.prepare("UPDATE conversations SET sidebar_order=? WHERE id=?")
      .run(this.nextConversationSidebarOrder(conversation.user_id, conversation.project_id), id);
  }

  markConversationResultSeenForUser(id: string, userId: string): ConversationRow | undefined {
    const conversation = this.getConversationForUser(id, userId);
    if (!conversation) return undefined;
    this.sqlite.prepare("UPDATE conversations SET has_unread_result=0,unread_anchor_message_id=NULL WHERE id=? AND user_id=? AND deleted_at IS NULL").run(id, userId);
    return this.getConversationForUser(id, userId);
  }

  archiveConversationForUser(id: string, userId: string): ConversationRow | undefined {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare(`
      UPDATE conversations SET archived_at=?,pinned_at=NULL
      WHERE id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL
    `).run(now, id, userId);
    return result.changes ? this.getConversationForUser(id, userId) : undefined;
  }

  restoreConversationForUser(id: string, userId: string): ConversationRow | undefined {
    const conversation = this.getConversationForUser(id, userId);
    if (!conversation?.archived_at) return undefined;
    const result = this.sqlite.prepare("UPDATE conversations SET archived_at=NULL,sidebar_order=? WHERE id=? AND user_id=? AND deleted_at IS NULL")
      .run(this.nextConversationSidebarOrder(userId, conversation.project_id), id, userId);
    return result.changes ? this.getConversationForUser(id, userId) : undefined;
  }

  setConversationRolloutBytes(id: string, bytes: number | null): void {
    const normalized = bytes === null || !Number.isFinite(bytes) ? null : Math.max(0, Math.trunc(bytes));
    this.sqlite.prepare("UPDATE conversations SET rollout_bytes=? WHERE id=? AND deleted_at IS NULL").run(normalized, id);
  }

  setAiConversationTitleIfDefault(id: string, title: string): boolean {
    const changed = this.sqlite.prepare(`
      UPDATE conversations SET title=?,title_source='ai',updated_at=?
      WHERE id=? AND title_source='default' AND deleted_at IS NULL
    `).run(title, new Date().toISOString(), id).changes > 0;
    return changed;
  }

  createConversationTitleAudit(row: Omit<ConversationTitleAuditRow, "status" | "output_title" | "applied" | "error" | "completed_at" | "duration_ms">): ConversationTitleAuditRow {
    this.sqlite.prepare(`
      INSERT INTO conversation_title_audits(
        id,conversation_id,user_id,project_id,executor_id,trigger,model,reasoning_effort,prompt_version,
        request_excerpt,request_sha256,context_json,status,output_title,applied,error,started_at,completed_at,duration_ms
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'running',NULL,0,NULL,?,NULL,NULL)
    `).run(row.id, row.conversation_id, row.user_id, row.project_id, row.executor_id, row.trigger, row.model,
      row.reasoning_effort, row.prompt_version, row.request_excerpt, row.request_sha256, row.context_json, row.started_at);
    return this.getConversationTitleAudit(row.id)!;
  }

  finishConversationTitleAudit(id: string, result: { status: "succeeded" | "failed"; outputTitle?: string | null; applied?: boolean; error?: string | null; completedAt: string; durationMs: number }): ConversationTitleAuditRow | undefined {
    this.sqlite.prepare(`
      UPDATE conversation_title_audits SET status=?,output_title=?,applied=?,error=?,completed_at=?,duration_ms=?
      WHERE id=? AND status='running'
    `).run(result.status, result.outputTitle ?? null, result.applied ? 1 : 0, result.error?.slice(0, 2_000) ?? null, result.completedAt, Math.max(0, Math.trunc(result.durationMs)), id);
    return this.getConversationTitleAudit(id);
  }

  getConversationTitleAudit(id: string): ConversationTitleAuditRow | undefined {
    return this.sqlite.prepare("SELECT * FROM conversation_title_audits WHERE id=?").get(id) as ConversationTitleAuditRow | undefined;
  }

  listConversationTitleAudits(conversationId: string): ConversationTitleAuditRow[] {
    return this.sqlite.prepare("SELECT * FROM conversation_title_audits WHERE conversation_id=? ORDER BY started_at,id").all(conversationId) as ConversationTitleAuditRow[];
  }

  getLatestConversationTitleAudit(conversationId: string): ConversationTitleAuditRow | undefined {
    return this.sqlite.prepare("SELECT * FROM conversation_title_audits WHERE conversation_id=? ORDER BY started_at DESC,id DESC LIMIT 1")
      .get(conversationId) as ConversationTitleAuditRow | undefined;
  }

  isFirstUserMessage(conversationId: string, messageId: string): boolean {
    const first = this.sqlite.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at,id LIMIT 1")
      .get(conversationId) as { id: string } | undefined;
    return first?.id === messageId;
  }

  getFirstUserMessage(conversationId: string): Pick<MessageRow, "id" | "content"> | undefined {
    return this.sqlite.prepare("SELECT id,content FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at,id LIMIT 1")
      .get(conversationId) as Pick<MessageRow, "id" | "content"> | undefined;
  }

  listUserMessageContents(conversationId: string): string[] {
    return (this.sqlite.prepare("SELECT content FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at,id")
      .all(conversationId) as Array<{ content: string }>).map((message) => message.content);
  }

  getLatestAssistantMessage(conversationId: string): Pick<MessageRow, "id" | "content"> | undefined {
    return this.sqlite.prepare(`
      SELECT id,content FROM messages
      WHERE conversation_id=? AND role='assistant'
      ORDER BY created_at DESC,id DESC LIMIT 1
    `).get(conversationId) as Pick<MessageRow, "id" | "content"> | undefined;
  }

  getConversationOptionalCapabilities(conversationId: string): OptionalAgentCapabilities | null {
    const row = this.sqlite.prepare("SELECT optional_capabilities_json FROM conversations WHERE id=?")
      .get(conversationId) as { optional_capabilities_json: string | null } | undefined;
    if (!row?.optional_capabilities_json) return null;
    try {
      const value = JSON.parse(row.optional_capabilities_json) as Partial<OptionalAgentCapabilities>;
      if (!value || typeof value !== "object") return null;
      const keys: Array<keyof OptionalAgentCapabilities> = ["apps", "remotePlugin", "goals", "multiAgent", "gameAnalysisMcp"];
      if (!keys.every((key) => typeof value[key] === "boolean")) return null;
      return value as OptionalAgentCapabilities;
    } catch {
      return null;
    }
  }

  setConversationOptionalCapabilities(conversationId: string, capabilities: OptionalAgentCapabilities): void {
    this.sqlite.prepare("UPDATE conversations SET optional_capabilities_json=? WHERE id=?")
      .run(JSON.stringify(capabilities), conversationId);
  }

  setConversationPersonalContextRevision(conversationId: string, revision: number): void {
    const normalized = Number.isFinite(revision) ? Math.max(0, Math.trunc(revision)) : 0;
    this.sqlite.prepare("UPDATE conversations SET personal_context_revision=MAX(personal_context_revision,?) WHERE id=? AND deleted_at IS NULL")
      .run(normalized, conversationId);
  }

  softDeleteConversation(id: string): void {
    const now = new Date().toISOString();
    this.sqlite.prepare("UPDATE conversations SET status='idle',deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now, now, id);
  }

  isCodexThreadUsedByAnotherActiveConversation(threadId: string, conversationId: string): boolean {
    const row = this.sqlite.prepare("SELECT 1 AS found FROM conversations WHERE codex_thread_id=? AND id<>? AND deleted_at IS NULL LIMIT 1").get(threadId, conversationId) as { found: number } | undefined;
    return Boolean(row);
  }

  addMessage(message: MessageRow): void {
    this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,is_scheduled,created_at) VALUES(?,?,?,?,?,?,?)").run(
      message.id, message.conversation_id, message.role, message.content, message.quote_excerpt ?? null, message.is_scheduled ? 1 : 0, message.created_at,
    );
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(message.created_at, message.conversation_id);
    if (message.role === "user") this.bumpConversationSidebarOrder(message.conversation_id);
  }

  createVoiceTranscription(input: {
    id: string; userId: string; conversationId?: string | null; projectId?: string | null;
    rawText: string; model: string; promptVersion: string; selectedTermIds?: string[]; createdAt?: string; clientRecordingId?: string | null;
    audio?: { relativePath: string; mimeType: string; bytes: number; sha256: string };
  }): VoiceTranscriptionRow {
    const now = input.createdAt ?? new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO voice_transcriptions(
        id,user_id,client_recording_id,conversation_id,project_id,raw_text,model,prompt_version,selected_terms_json,
        audio_relative_path,audio_mime_type,audio_bytes,audio_sha256,audio_storage_state,audio_updated_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.id, input.userId, input.clientRecordingId ?? null, input.conversationId ?? null, input.projectId ?? null,
      input.rawText.slice(0, 100_000), input.model, input.promptVersion,
      JSON.stringify((input.selectedTermIds ?? []).slice(0, 500)),
      input.audio?.relativePath ?? null, input.audio?.mimeType ?? null, input.audio?.bytes ?? null, input.audio?.sha256 ?? null,
      input.audio ? "local" : "none", input.audio ? now : null,
      now,
    );
    return this.sqlite.prepare("SELECT * FROM voice_transcriptions WHERE id=?").get(input.id) as VoiceTranscriptionRow;
  }

  getVoiceTranscriptionByClientRecordingId(userId: string, clientRecordingId: string): VoiceTranscriptionRow | undefined {
    return this.sqlite.prepare("SELECT * FROM voice_transcriptions WHERE user_id=? AND client_recording_id=?").get(userId, clientRecordingId) as VoiceTranscriptionRow | undefined;
  }

  getVoiceTranscriptionReceipt(userId: string, clientRecordingId: string): VoiceTranscriptionReceiptRow | undefined {
    return this.sqlite.prepare("SELECT * FROM voice_transcription_receipts WHERE user_id=? AND client_recording_id=?").get(userId, clientRecordingId) as VoiceTranscriptionReceiptRow | undefined;
  }

  claimVoiceTranscriptionReceipt(input: { userId: string; clientRecordingId: string; audioSha256: string; audioBytes: number; now?: string }): VoiceTranscriptionReceiptRow {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getVoiceTranscriptionReceipt(input.userId, input.clientRecordingId);
      if (!existing) {
        this.sqlite.prepare("INSERT INTO voice_transcription_receipts(user_id,client_recording_id,audio_sha256,audio_bytes,state,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(input.userId, input.clientRecordingId, input.audioSha256, input.audioBytes, "processing", 0, now, now);
      } else if (existing.audio_sha256 !== input.audioSha256 || existing.audio_bytes !== input.audioBytes) {
        throw new Error("同一录音 ID 对应了不同音频内容");
      } else if (existing.state === "failed") {
        this.sqlite.prepare("UPDATE voice_transcription_receipts SET state='processing',attempts=attempts+1,last_error=NULL,updated_at=? WHERE user_id=? AND client_recording_id=?")
          .run(now, input.userId, input.clientRecordingId);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    return this.getVoiceTranscriptionReceipt(input.userId, input.clientRecordingId)!;
  }

  updateVoiceTranscriptionReceipt(input: { userId: string; clientRecordingId: string; state: "processing" | "succeeded" | "failed"; transcriptionId?: string | null; error?: string | null; now?: string }): void {
    this.sqlite.prepare("UPDATE voice_transcription_receipts SET state=?,transcription_id=?,last_error=?,updated_at=? WHERE user_id=? AND client_recording_id=?")
      .run(input.state, input.transcriptionId ?? null, input.error?.slice(0, 1_000) ?? null, input.now ?? new Date().toISOString(), input.userId, input.clientRecordingId);
  }

  recoverVoiceTranscriptionReceipts(now = new Date().toISOString()): number {
    return Number(this.sqlite.prepare("UPDATE voice_transcription_receipts SET state='failed',last_error='语音识别进程中断，请重试',updated_at=? WHERE state='processing'").run(now).changes);
  }

  pruneVoiceTranscriptionReceipts(before: string): number {
    return Number(this.sqlite.prepare("DELETE FROM voice_transcription_receipts WHERE updated_at<? AND state!='processing'").run(before).changes);
  }

  validateVoiceTranscriptions(ids: string[], userId: string): boolean {
    const unique = [...new Set(ids)].slice(0, 20);
    if (unique.length !== ids.length) return false;
    const get = this.sqlite.prepare("SELECT user_id,submitted_at FROM voice_transcriptions WHERE id=?");
    return unique.every((id) => {
      const row = get.get(id) as { user_id: string; submitted_at: string | null } | undefined;
      return row?.user_id === userId && !row.submitted_at;
    });
  }

  attachVoiceTranscriptions(input: {
    ids: string[]; userId: string; conversationId: string; messageId?: string | null; pendingPromptId?: string | null;
  }): number {
    const unique = [...new Set(input.ids)].slice(0, 20);
    if (unique.length === 0) return 0;
    const conversation = this.getConversationForUser(input.conversationId, input.userId);
    if (!conversation || !this.validateVoiceTranscriptions(unique, input.userId)) throw new Error("Invalid voice transcription association");
    const now = new Date().toISOString();
    const update = this.sqlite.prepare(`
      UPDATE voice_transcriptions SET conversation_id=?,project_id=?,message_id=?,pending_prompt_id=?,submitted_at=?
      WHERE id=? AND user_id=? AND submitted_at IS NULL
    `);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      let changed = 0;
      for (const id of unique) changed += Number(update.run(
        input.conversationId, conversation.project_id, input.messageId ?? null, input.pendingPromptId ?? null,
        now, id, input.userId,
      ).changes);
      this.sqlite.exec("COMMIT");
      return changed;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  listVoiceLexiconTerms(userId: string, projectId: string | null, limit = 100): VoiceLexiconTermRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM voice_lexicon_terms
      WHERE user_id=? AND status='active' AND (project_id IS NULL OR project_id IS ?)
      ORDER BY pinned DESC,rank_index DESC,weighted_errors DESC,voice_opportunities DESC,canonical_text
      LIMIT ?
    `).all(userId, projectId, Math.max(1, Math.min(100, Math.trunc(limit)))) as VoiceLexiconTermRow[];
  }

  listVoiceLexiconManagementTerms(userId: string): VoiceLexiconManagementTermRow[] {
    return this.sqlite.prepare(`
      SELECT term.*,project.name AS project_name,
        count(evidence.id) AS evidence_count,
        sum(CASE WHEN evidence.error_weight>0 THEN 1 ELSE 0 END) AS error_evidence_count
      FROM voice_lexicon_terms term
      LEFT JOIN projects project ON project.id=term.project_id AND project.user_id=term.user_id
      LEFT JOIN voice_term_evidence evidence ON evidence.term_id=term.id
      WHERE term.user_id=?
      GROUP BY term.id
      ORDER BY term.pinned DESC,term.rank_index DESC,term.weighted_errors DESC,
        term.voice_opportunities DESC,term.canonical_text,term.id
    `).all(userId) as VoiceLexiconManagementTermRow[];
  }

  getVoiceLexiconManagementStats(userId: string): VoiceLexiconManagementStats {
    const transcriptions = this.sqlite.prepare(`
      SELECT count(CASE WHEN status='pending' THEN 1 END) AS pending,
        count(CASE WHEN status='pending' AND message_id IS NOT NULL THEN 1 END) AS submitted_pending,
        count(CASE WHEN status='processing' THEN 1 END) AS processing,
        count(CASE WHEN status='processed' THEN 1 END) AS processed,
        count(CASE WHEN attempts>0 AND status='pending' THEN 1 END) AS failed_attempts
      FROM voice_transcriptions WHERE user_id=?
    `).get(userId) as Omit<VoiceLexiconManagementStats, "run_count" | "successful_runs" | "failed_runs">;
    const runs = this.sqlite.prepare(`
      SELECT count(*) AS run_count,
        count(CASE WHEN status='succeeded' THEN 1 END) AS successful_runs,
        count(CASE WHEN status='failed' THEN 1 END) AS failed_runs
      FROM voice_lexicon_runs WHERE user_id=?
    `).get(userId) as Pick<VoiceLexiconManagementStats, "run_count" | "successful_runs" | "failed_runs">;
    return { ...transcriptions, ...runs };
  }

  getLatestVoiceLexiconRun(userId: string): VoiceLexiconRunSummary {
    return (this.sqlite.prepare(`
      SELECT model,prompt_version,status,candidate_count,created_at,completed_at
      FROM voice_lexicon_runs WHERE user_id=? ORDER BY completed_at DESC,id DESC LIMIT 1
    `).get(userId) as Exclude<VoiceLexiconRunSummary, null> | undefined) ?? null;
  }

  voiceReviewQueueStats(userId: string, now: string): { pending: number; oldestSubmittedAt: string | null } {
    const row = this.sqlite.prepare(`
      SELECT count(1) AS pending,min(submitted_at) AS oldest
      FROM voice_transcriptions transcription
      WHERE transcription.user_id=? AND transcription.status='pending' AND transcription.message_id IS NOT NULL
        AND (transcription.next_attempt_at IS NULL OR transcription.next_attempt_at<=?)
        AND NOT EXISTS (
          SELECT 1 FROM jobs active WHERE active.conversation_id=transcription.conversation_id
            AND active.status IN ('queued','running')
        )
    `).get(userId, now) as { pending: number; oldest: string | null };
    return { pending: row.pending, oldestSubmittedAt: row.oldest };
  }

  listPendingVoiceReviews(userId: string, now: string, readyBefore: string | null, limit = 20): VoiceReviewSource[] {
    const cutoff = readyBefore ? "AND transcription.submitted_at<=?" : "";
    const parameters: Array<string | number> = [userId, now];
    if (readyBefore) parameters.push(readyBefore);
    parameters.push(Math.max(1, Math.min(50, Math.trunc(limit))));
    return this.sqlite.prepare(`
      SELECT transcription.*,conversation.title AS conversation_title,message.content AS message_content
      FROM voice_transcriptions transcription
      JOIN conversations conversation ON conversation.id=transcription.conversation_id
      JOIN messages message ON message.id=transcription.message_id
      WHERE transcription.user_id=? AND transcription.status='pending' AND conversation.deleted_at IS NULL
        AND (transcription.next_attempt_at IS NULL OR transcription.next_attempt_at<=?)
        ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM jobs active WHERE active.conversation_id=conversation.id AND active.status IN ('queued','running')
        )
      ORDER BY transcription.submitted_at,transcription.id LIMIT ?
    `).all(...parameters) as VoiceReviewSource[];
  }

  markVoiceReviewsProcessing(ids: string[]): void {
    const update = this.sqlite.prepare("UPDATE voice_transcriptions SET status='processing' WHERE id=? AND status='pending'");
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { for (const id of ids) update.run(id); this.sqlite.exec("COMMIT"); }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }

  recoverInterruptedVoiceReviews(): number {
    return Number(this.sqlite.prepare(`
      UPDATE voice_transcriptions
      SET status='pending',attempts=attempts+1,next_attempt_at=NULL,last_error='review interrupted before completion'
      WHERE status='processing'
    `).run().changes);
  }

  markVoiceReviewsProcessed(ids: string[], reviewedAt: string): void {
    const update = this.sqlite.prepare(`
      UPDATE voice_transcriptions SET status='processed',reviewed_at=?,next_attempt_at=NULL,last_error=NULL
      WHERE id=? AND status='processing'
    `);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { for (const id of ids) update.run(reviewedAt, id); this.sqlite.exec("COMMIT"); }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }

  markVoiceReviewsFailed(ids: string[], error: string, nextAttemptAt: string): void {
    const update = this.sqlite.prepare(`
      UPDATE voice_transcriptions SET status='pending',attempts=attempts+1,last_error=?,next_attempt_at=?
      WHERE id=? AND status='processing'
    `);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { for (const id of ids) update.run(error.slice(0, 1_000), nextAttemptAt, id); this.sqlite.exec("COMMIT"); }
    catch (failure) { this.sqlite.exec("ROLLBACK"); throw failure; }
  }

  applyVoiceTermEvidence(userId: string, evidence: VoiceTermEvidenceInput[]): number {
    const source = this.sqlite.prepare("SELECT * FROM voice_transcriptions WHERE id=? AND user_id=?");
    const find = this.sqlite.prepare(`
      SELECT * FROM voice_lexicon_terms WHERE user_id=? AND project_id IS ? AND canonical_key=?
    `);
    const insert = this.sqlite.prepare(`
      INSERT INTO voice_lexicon_terms(
        id,user_id,project_id,canonical_key,canonical_text,aliases_json,term_kind,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,? ,?,'candidate',?,?)
    `);
    const addEvidence = this.sqlite.prepare(`
      INSERT OR IGNORE INTO voice_term_evidence(
        id,term_id,transcription_id,observed_text,canonical_text,confidence,use_weight,error_weight,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `);
    const stats = this.sqlite.prepare("SELECT * FROM voice_term_evidence WHERE term_id=? ORDER BY created_at");
    const update = this.sqlite.prepare(`
      UPDATE voice_lexicon_terms SET canonical_text=?,aliases_json=?,term_kind=?,status=?,usage_score=?,
        voice_opportunities=?,weighted_errors=?,reliable_error_rate=?,rank_index=?,last_used_at=?,last_error_at=?,updated_at=?
      WHERE id=?
    `);
    let changed = 0;
    const now = new Date();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const item of evidence) {
        const transcription = source.get(item.transcriptionId, userId) as VoiceTranscriptionRow | undefined;
        if (!transcription) continue;
        let term = find.get(userId, transcription.project_id, item.canonicalKey) as VoiceLexiconTermRow | undefined;
        if (!term) {
          const id = crypto.randomUUID();
          const timestamp = now.toISOString();
          insert.run(id, userId, transcription.project_id, item.canonicalKey, item.canonicalText, "[]", item.termKind, timestamp, timestamp);
          term = find.get(userId, transcription.project_id, item.canonicalKey) as VoiceLexiconTermRow;
        }
        const createdAt = transcription.submitted_at ?? transcription.created_at;
        const inserted = addEvidence.run(
          crypto.randomUUID(), term.id, transcription.id, item.observedText, item.canonicalText,
          item.confidence, item.useWeight, item.errorWeight, createdAt,
        );
        if (!inserted.changes) continue;
        const rows = stats.all(term.id) as Array<{ observed_text: string; canonical_text: string; confidence: number; use_weight: number; error_weight: number; created_at: string }>;
        let opportunities = 0; let errors = 0; let lastUsed: string | null = null; let lastError: string | null = null;
        const aliases = new Set<string>(safeJsonStringArray(term.aliases_json));
        for (const row of rows) {
          const ageDays = Math.max(0, (now.getTime() - Date.parse(row.created_at)) / 86_400_000);
          opportunities += row.use_weight * (0.5 ** (ageDays / 30));
          errors += row.error_weight * (0.5 ** (ageDays / 60));
          if (!lastUsed || row.created_at > lastUsed) lastUsed = row.created_at;
          if (row.error_weight > 0) {
            if (row.observed_text && row.observed_text !== row.canonical_text) aliases.add(row.observed_text);
            if (!lastError || row.created_at > lastError) lastError = row.created_at;
          }
        }
        const usageScore = 1 - Math.exp(-opportunities / 5);
        const reliableErrorRate = (errors + 5 * 0.05) / (opportunities + 5);
        const recentError = lastError ? Math.exp(-Math.max(0, (now.getTime() - Date.parse(lastError)) / 86_400_000) / 30) : 0;
        const rankIndex = 100 * (0.72 * reliableErrorRate + 0.20 * usageScore + 0.08 * recentError);
        const status = term.pinned || rows.length >= 2 || rows.some((row) => row.error_weight >= 0.8 && row.confidence >= 0.9)
          ? "active" : "candidate";
        update.run(
          item.canonicalText, JSON.stringify([...aliases].slice(0, 12)), item.termKind, status, usageScore,
          opportunities, errors, reliableErrorRate, rankIndex, lastUsed, lastError, now.toISOString(), term.id,
        );
        changed += 1;
      }
      this.sqlite.exec("COMMIT");
      return changed;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }

  recordVoiceLexiconRun(input: {
    id: string; userId: string; transcriptionIds: string[]; model: string; promptVersion: string;
    status: "succeeded" | "failed"; candidateCount: number; error?: string; createdAt: string; completedAt: string;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO voice_lexicon_runs(
        id,user_id,transcription_ids_json,model,prompt_version,status,candidate_count,error,created_at,completed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.id, input.userId, JSON.stringify(input.transcriptionIds), input.model, input.promptVersion,
      input.status, input.candidateCount, input.error?.slice(0, 1_000) ?? null, input.createdAt, input.completedAt,
    );
  }

  pruneVoiceTranscriptions(unsubmittedBefore: string, reviewedBefore: string): string[] {
    const removed = this.sqlite.prepare(`
      SELECT audio_relative_path FROM voice_transcriptions
      WHERE (submitted_at IS NULL OR message_id IS NULL) AND created_at<? AND audio_relative_path IS NOT NULL
    `).all(unsubmittedBefore) as Array<{ audio_relative_path: string }>;
    this.sqlite.prepare(`
      DELETE FROM voice_transcriptions
      WHERE (submitted_at IS NULL OR message_id IS NULL) AND created_at<?
    `).run(unsubmittedBefore);
    this.sqlite.prepare("UPDATE voice_transcriptions SET raw_text='' WHERE status='processed' AND reviewed_at<? AND raw_text<>''").run(reviewedBefore);
    return removed.map((row) => row.audio_relative_path);
  }

  backfillPersonalMemoryOutbox(userId: string, since: string): number {
    return Number(this.sqlite.prepare(`
      INSERT OR IGNORE INTO personal_memory_outbox(
        message_id,user_id,conversation_id,status,attempts,next_attempt_at,last_error,created_at,processed_at
      )
      SELECT message.id,conversation.user_id,conversation.id,'pending',0,NULL,NULL,message.created_at,NULL
      FROM messages message
      JOIN conversations conversation ON conversation.id=message.conversation_id
      WHERE conversation.user_id=? AND conversation.deleted_at IS NULL
        AND message.role='user' AND message.created_at>=?
    `).run(userId, since).changes);
  }

  listPendingPersonalMemoryMessages(userId: string, now: string, readyBefore: string, limit = 12): PersonalMemorySourceMessage[] {
    return this.sqlite.prepare(`
      SELECT message.id,outbox.user_id,message.conversation_id,
        conversation.title AS conversation_title,conversation.project_id,
        message.content,message.quote_excerpt,message.created_at,outbox.attempts
      FROM personal_memory_outbox outbox
      JOIN messages message ON message.id=outbox.message_id
      JOIN conversations conversation ON conversation.id=message.conversation_id
      WHERE outbox.user_id=? AND outbox.status='pending' AND conversation.deleted_at IS NULL
        AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at<=?)
        AND outbox.created_at<=?
        AND NOT EXISTS (
          SELECT 1 FROM jobs active
          WHERE active.conversation_id=conversation.id AND active.status IN ('queued','running')
        )
      ORDER BY outbox.created_at,outbox.message_id LIMIT ?
    `).all(userId, now, readyBefore, Math.max(1, Math.min(50, Math.trunc(limit)))) as PersonalMemorySourceMessage[];
  }

  markPersonalMemoryMessagesProcessed(messageIds: string[], processedAt: string): void {
    const update = this.sqlite.prepare(`
      UPDATE personal_memory_outbox
      SET status='processed',processed_at=?,next_attempt_at=NULL,last_error=NULL
      WHERE message_id=? AND status='pending'
    `);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const messageId of messageIds) update.run(processedAt, messageId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  markPersonalMemoryMessagesFailed(messageIds: string[], error: string, nextAttemptAt: string): void {
    const update = this.sqlite.prepare(`
      UPDATE personal_memory_outbox
      SET attempts=attempts+1,last_error=?,next_attempt_at=?
      WHERE message_id=? AND status='pending'
    `);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const messageId of messageIds) update.run(error.slice(0, 1_000), nextAttemptAt, messageId);
      this.sqlite.exec("COMMIT");
    } catch (failure) {
      this.sqlite.exec("ROLLBACK");
      throw failure;
    }
  }

  recordPersonalMemoryRun(input: {
    id: string;
    userId: string;
    messageIds: string[];
    model: string;
    promptVersion: string;
    status: "succeeded" | "failed";
    candidateCount: number;
    error?: string | null;
    createdAt: string;
    completedAt: string;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO personal_memory_runs(
        id,user_id,message_ids_json,model,prompt_version,status,candidate_count,error,created_at,completed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.id, input.userId, JSON.stringify(input.messageIds), input.model, input.promptVersion,
      input.status, input.candidateCount, input.error?.slice(0, 1_000) ?? null, input.createdAt, input.completedAt,
    );
    if (input.status === "succeeded") this.sqlite.prepare(`
      INSERT INTO personal_memory_state(user_id,revision,snapshot_hash,last_published_at,last_successful_run_at)
      VALUES(?,0,NULL,NULL,?)
      ON CONFLICT(user_id) DO UPDATE SET last_successful_run_at=excluded.last_successful_run_at
    `).run(input.userId, input.completedAt);
  }

  applyPersonalMemoryCandidates(userId: string, candidates: PersonalMemoryCandidateInput[]): number {
    const messageForUser = this.sqlite.prepare(`
      SELECT message.id,message.conversation_id,message.content,message.created_at
      FROM messages message JOIN conversations conversation ON conversation.id=message.conversation_id
      WHERE message.id=? AND conversation.user_id=? AND conversation.deleted_at IS NULL AND message.role='user'
    `);
    const findEntry = this.sqlite.prepare(`
      SELECT * FROM personal_memory_entries WHERE user_id=? AND kind=? AND canonical_key=?
    `);
    const insertEntry = this.sqlite.prepare(`
      INSERT INTO personal_memory_entries(
        id,user_id,kind,canonical_key,statement,scope,status,confidence,sensitivity,
        first_seen_at,last_seen_at,expires_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertEvidence = this.sqlite.prepare(`
      INSERT OR IGNORE INTO personal_memory_evidence(
        entry_id,message_id,conversation_id,evidence_kind,evidence_date,excerpt,created_at
      ) VALUES(?,?,?,?,?,?,?)
    `);
    const evidenceStats = this.sqlite.prepare(`
      SELECT count(1) AS evidence_count,count(DISTINCT conversation_id) AS conversation_count,
        count(DISTINCT evidence_date) AS evidence_date_count,min(created_at) AS first_seen_at,max(created_at) AS last_seen_at
      FROM personal_memory_evidence WHERE entry_id=?
    `);
    const updateEntry = this.sqlite.prepare(`
      UPDATE personal_memory_entries
      SET statement=?,scope=?,status=?,confidence=?,sensitivity=?,review_state=?,reviewed_at=?,first_seen_at=?,last_seen_at=?,expires_at=?,updated_at=?
      WHERE id=?
    `);
    let changed = 0;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const evidence = candidate.messageIds.flatMap((messageId) => {
          const row = messageForUser.get(messageId, userId) as { id: string; conversation_id: string; content: string; created_at: string } | undefined;
          return row ? [row] : [];
        });
        if (evidence.length === 0) continue;
        let entry = findEntry.get(userId, candidate.kind, candidate.canonicalKey) as PersonalMemoryEntryRow | undefined;
        const now = new Date().toISOString();
        if (!entry) {
          const id = crypto.randomUUID();
          const firstSeen = evidence.map((item) => item.created_at).sort()[0] ?? now;
          const lastSeen = evidence.map((item) => item.created_at).sort().at(-1) ?? now;
          const forgotten = candidate.evidenceKind === "forget";
          insertEntry.run(
            id, userId, candidate.kind, candidate.canonicalKey,
            forgotten ? "已按用户要求遗忘该项" : candidate.statement,
            candidate.scope, forgotten ? "forgotten" : "candidate", forgotten ? "explicit" : "low",
            candidate.sensitivity, firstSeen, lastSeen, null, now, now,
          );
          entry = findEntry.get(userId, candidate.kind, candidate.canonicalKey) as PersonalMemoryEntryRow;
        }
        for (const source of evidence) {
          insertEvidence.run(
            entry.id, source.id, source.conversation_id, candidate.evidenceKind,
            source.created_at.slice(0, 10), `sha256:${crypto.createHash("sha256").update(source.content).digest("hex")}`,
            source.created_at,
          );
        }
        const stats = evidenceStats.get(entry.id) as {
          evidence_count: number; conversation_count: number; evidence_date_count: number;
          first_seen_at: string; last_seen_at: string;
        };
        const sameStatement = normalizePersonalMemoryStatement(entry.statement) === normalizePersonalMemoryStatement(candidate.statement);
        let statement = entry.statement;
        let status: PersonalMemoryStatus = entry.status;
        let confidence: PersonalMemoryConfidence = entry.confidence;
        let reviewState: PersonalMemoryReviewState = entry.review_state ?? "unreviewed";
        let reviewedAt = entry.reviewed_at ?? null;
        const newerExplicitEvidence = Boolean(reviewedAt)
          && Date.parse(stats.last_seen_at) > Date.parse(reviewedAt!)
          && ["direct", "correction", "forget"].includes(candidate.evidenceKind);
        const reviewLocked = reviewState !== "unreviewed" && !newerExplicitEvidence;
        if (reviewLocked) {
          // A manual decision remains authoritative until the user gives a newer,
          // explicit direct/correction/forget statement in chat.
        } else if (candidate.evidenceKind === "forget") {
          reviewState = "unreviewed";
          reviewedAt = null;
          statement = "已按用户要求遗忘该项";
          status = "forgotten";
          confidence = "explicit";
        } else if (candidate.sensitivity === "sensitive") {
          reviewState = "unreviewed";
          reviewedAt = null;
          status = "candidate";
          confidence = "low";
        } else if (candidate.evidenceKind === "correction") {
          reviewState = "unreviewed";
          reviewedAt = null;
          statement = candidate.statement;
          status = "active";
          confidence = "explicit";
        } else if (candidate.evidenceKind === "direct") {
          reviewState = "unreviewed";
          reviewedAt = null;
          if (["candidate", "stale", "forgotten"].includes(entry.status) || sameStatement) {
            statement = candidate.statement;
            status = "active";
            confidence = "explicit";
          } else if (entry.status === "active" && !sameStatement) {
            status = "conflicted";
          }
        } else if (!sameStatement && entry.status === "active") {
          reviewState = "unreviewed";
          reviewedAt = null;
          status = "conflicted";
        } else {
          reviewState = "unreviewed";
          reviewedAt = null;
          statement = candidate.statement;
          if (stats.conversation_count >= 3 && stats.evidence_date_count >= 2) {
            status = "active";
            confidence = "high";
          } else if (stats.conversation_count >= 2 || stats.evidence_count >= 2) {
            status = "candidate";
            confidence = "medium";
          } else {
            status = "candidate";
            confidence = "low";
          }
        }
        const ttlDays = candidate.kind === "current_focus" || candidate.kind === "project_pointer"
          ? Math.max(1, Math.min(365, candidate.ttlDays ?? 30))
          : null;
        const expiresAt = ttlDays === null ? null : new Date(Date.parse(stats.last_seen_at) + ttlDays * 86_400_000).toISOString();
        const before = JSON.stringify([entry.statement, entry.scope, entry.status, entry.confidence, entry.sensitivity, entry.review_state, entry.reviewed_at, entry.first_seen_at, entry.last_seen_at, entry.expires_at]);
        const after = JSON.stringify([statement, candidate.scope, status, confidence, candidate.sensitivity, reviewState, reviewedAt, stats.first_seen_at, stats.last_seen_at, expiresAt]);
        updateEntry.run(
          statement, candidate.scope, status, confidence, candidate.sensitivity, reviewState, reviewedAt,
          stats.first_seen_at, stats.last_seen_at, expiresAt, now, entry.id,
        );
        if (before !== after) changed += 1;
      }
      this.sqlite.exec("COMMIT");
      return changed;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  expirePersonalMemoryEntries(userId: string, now: string): number {
    return Number(this.sqlite.prepare(`
      UPDATE personal_memory_entries SET status='stale',updated_at=?
      WHERE user_id=? AND status='active' AND expires_at IS NOT NULL AND expires_at<=?
    `).run(now, userId, now).changes);
  }

  listPersonalMemoryEntries(userId: string, status?: PersonalMemoryStatus): PersonalMemoryEntryRow[] {
    const statusClause = status ? "AND entry.status=?" : "";
    const parameters = status ? [userId, status] : [userId];
    return this.sqlite.prepare(`
      SELECT entry.*,
        count(evidence.message_id) AS evidence_count,
        count(DISTINCT evidence.conversation_id) AS conversation_count,
        count(DISTINCT evidence.evidence_date) AS evidence_date_count
      FROM personal_memory_entries entry
      LEFT JOIN personal_memory_evidence evidence ON evidence.entry_id=entry.id
      WHERE entry.user_id=? ${statusClause}
      GROUP BY entry.id ORDER BY entry.kind,entry.last_seen_at DESC,entry.id
    `).all(...parameters) as PersonalMemoryEntryRow[];
  }

  listPersonalMemoryEvidence(userId: string, entryId: string): PersonalMemoryEvidenceView[] {
    const rows = this.sqlite.prepare(`
      SELECT evidence.message_id,evidence.conversation_id,conversation.title AS conversation_title,
        evidence.evidence_kind,evidence.evidence_date,message.content,evidence.created_at
      FROM personal_memory_evidence evidence
      JOIN personal_memory_entries entry ON entry.id=evidence.entry_id
      JOIN conversations conversation ON conversation.id=evidence.conversation_id
      JOIN messages message ON message.id=evidence.message_id
      WHERE entry.user_id=? AND entry.id=? AND conversation.user_id=? AND conversation.deleted_at IS NULL
      ORDER BY evidence.evidence_date DESC,evidence.created_at DESC,evidence.message_id
    `).all(userId, entryId, userId) as Array<Omit<PersonalMemoryEvidenceView, "source_excerpt"> & { content: string }>;
    return rows.map(({ content, ...row }) => ({
      ...row,
      source_excerpt: stripPersonalContext(content).replace(/\s+/g, " ").trim().slice(0, 360),
    }));
  }

  reviewPersonalMemoryEntry(
    userId: string,
    entryId: string,
    action: PersonalMemoryReviewAction,
    correctedStatement?: string,
  ): PersonalMemoryEntryRow | undefined {
    const entry = this.sqlite.prepare("SELECT * FROM personal_memory_entries WHERE id=? AND user_id=?")
      .get(entryId, userId) as PersonalMemoryEntryRow | undefined;
    if (!entry) return undefined;
    const now = new Date().toISOString();
    let statement = entry.statement;
    let status: PersonalMemoryStatus = entry.status;
    let confidence: PersonalMemoryConfidence = entry.confidence;
    let reviewState: PersonalMemoryReviewState;
    if (action === "accept") {
      if (entry.status === "forgotten") throw new Error("已遗忘的知识不能直接恢复，请通过纠正重新填写内容。");
      status = "active";
      confidence = "explicit";
      reviewState = "accepted";
    } else if (action === "reject") {
      if (entry.status === "forgotten") throw new Error("已遗忘的知识不能标为拒绝。");
      status = "candidate";
      confidence = "low";
      reviewState = "rejected";
    } else if (action === "correct") {
      statement = correctedStatement?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 320) ?? "";
      if (statement.length < 2) throw new Error("纠正后的知识摘要至少需要 2 个字符。");
      status = "active";
      confidence = "explicit";
      reviewState = "corrected";
    } else {
      statement = "已按用户要求遗忘该项";
      status = "forgotten";
      confidence = "explicit";
      reviewState = "forgotten";
    }
    this.sqlite.prepare(`
      UPDATE personal_memory_entries
      SET statement=?,status=?,confidence=?,review_state=?,reviewed_at=?,updated_at=?
      WHERE id=? AND user_id=?
    `).run(statement, status, confidence, reviewState, now, now, entryId, userId);
    return this.sqlite.prepare("SELECT * FROM personal_memory_entries WHERE id=? AND user_id=?")
      .get(entryId, userId) as PersonalMemoryEntryRow | undefined;
  }

  getPersonalMemoryState(userId: string): PersonalMemoryStateRow {
    return (this.sqlite.prepare("SELECT * FROM personal_memory_state WHERE user_id=?").get(userId) as PersonalMemoryStateRow | undefined) ?? {
      user_id: userId, revision: 0, snapshot_hash: null, last_published_at: null, last_successful_run_at: null,
    };
  }

  getPersonalMemoryStatus(userId: string): PersonalMemoryStateRow & {
    pending: number; processed: number; active: number; candidates: number; conflicted: number; forgotten: number; failedAttempts: number;
  } {
    const state = this.getPersonalMemoryState(userId);
    const outbox = this.sqlite.prepare(`
      SELECT
        sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN status='processed' THEN 1 ELSE 0 END) AS processed,
        sum(CASE WHEN attempts>0 AND status='pending' THEN 1 ELSE 0 END) AS failed_attempts
      FROM personal_memory_outbox WHERE user_id=?
    `).get(userId) as { pending: number | null; processed: number | null; failed_attempts: number | null };
    const entries = this.sqlite.prepare(`
      SELECT
        sum(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
        sum(CASE WHEN status='candidate' THEN 1 ELSE 0 END) AS candidates,
        sum(CASE WHEN status='conflicted' THEN 1 ELSE 0 END) AS conflicted,
        sum(CASE WHEN status='forgotten' THEN 1 ELSE 0 END) AS forgotten
      FROM personal_memory_entries WHERE user_id=?
    `).get(userId) as { active: number | null; candidates: number | null; conflicted: number | null; forgotten: number | null };
    return {
      ...state,
      pending: outbox.pending ?? 0, processed: outbox.processed ?? 0, failedAttempts: outbox.failed_attempts ?? 0,
      active: entries.active ?? 0, candidates: entries.candidates ?? 0,
      conflicted: entries.conflicted ?? 0, forgotten: entries.forgotten ?? 0,
    };
  }

  commitPersonalMemoryRevision(input: {
    userId: string; expectedRevision: number; snapshotHash: string; runId?: string | null;
    publishedFile: string; publishedAt: string;
  }): number {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const state = this.getPersonalMemoryState(input.userId);
      if (state.revision !== input.expectedRevision) throw new Error("Personal memory revision changed during publication");
      if (state.snapshot_hash === input.snapshotHash) {
        this.sqlite.exec("COMMIT");
        return state.revision;
      }
      const revision = state.revision + 1;
      this.sqlite.prepare(`
        INSERT INTO personal_memory_state(user_id,revision,snapshot_hash,last_published_at,last_successful_run_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,snapshot_hash=excluded.snapshot_hash,last_published_at=excluded.last_published_at
      `).run(input.userId, revision, input.snapshotHash, input.publishedAt, state.last_successful_run_at);
      this.sqlite.prepare(`
        INSERT INTO personal_memory_revisions(user_id,revision,snapshot_hash,run_id,published_file,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(input.userId, revision, input.snapshotHash, input.runId ?? null, input.publishedFile, input.publishedAt);
      this.sqlite.exec("COMMIT");
      return revision;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  commitPersonalMemoryManualRevision(input: {
    userId: string; expectedRevision: number; publishedFile: string; publishedAt: string;
  }): number {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const state = this.getPersonalMemoryState(input.userId);
      if (state.revision !== input.expectedRevision) throw new Error("PERSONAL_MEMORY_REVISION_CONFLICT");
      const revision = state.revision + 1;
      const snapshotHash = state.snapshot_hash ?? crypto.createHash("sha256").update("manual-personal-memory").digest("hex");
      this.sqlite.prepare(`
        INSERT INTO personal_memory_state(user_id,revision,snapshot_hash,last_published_at,last_successful_run_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,last_published_at=excluded.last_published_at
      `).run(input.userId, revision, snapshotHash, input.publishedAt, state.last_successful_run_at);
      this.sqlite.prepare(`
        INSERT INTO personal_memory_revisions(user_id,revision,snapshot_hash,run_id,published_file,created_at)
        VALUES(?,?,?,NULL,?,?)
      `).run(input.userId, revision, snapshotHash, input.publishedFile, input.publishedAt);
      this.sqlite.exec("COMMIT");
      return revision;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getMessage(id: string): MessageRow | undefined {
    return this.sqlite.prepare("SELECT * FROM messages WHERE id=?").get(id) as MessageRow | undefined;
  }

  listMessages(conversationId: string): Array<MessageRow & { files: FileRow[] }> {
    const messages = this.sqlite.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as MessageRow[];
    const files = this.sqlite.prepare("SELECT * FROM files WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as FileRow[];
    return messages.map((message) => ({
      ...message,
      files: files.filter((file) => file.message_id === message.id && (file.kind === "upload" || isDeliverablePath(file.relative_path))),
    }));
  }

  listMessagesPage(conversationId: string, beforeMessageId?: string, limit = 30): MessagePage | undefined {
    const pageSize = Math.min(100, Math.max(1, Math.trunc(limit)));
    let newestFirst: MessageRow[];
    if (beforeMessageId) {
      const cursor = this.getMessage(beforeMessageId);
      if (!cursor || cursor.conversation_id !== conversationId) return undefined;
      newestFirst = this.sqlite.prepare(`
        SELECT * FROM messages
        WHERE conversation_id=? AND (created_at<? OR (created_at=? AND id<?))
        ORDER BY created_at DESC,id DESC LIMIT ?
      `).all(conversationId, cursor.created_at, cursor.created_at, cursor.id, pageSize + 1) as MessageRow[];
    } else {
      newestFirst = this.sqlite.prepare(`
        SELECT * FROM messages WHERE conversation_id=?
        ORDER BY created_at DESC,id DESC LIMIT ?
      `).all(conversationId, pageSize + 1) as MessageRow[];
    }

    const hasMore = newestFirst.length > pageSize;
    const messages = newestFirst.slice(0, pageSize).reverse();
    if (messages.length === 0) return { messages: [], hasMore: false, nextCursor: null };
    const placeholders = messages.map(() => "?").join(",");
    const files = this.sqlite.prepare(`
      SELECT * FROM files WHERE conversation_id=? AND message_id IN (${placeholders}) ORDER BY created_at,id
    `).all(conversationId, ...messages.map((message) => message.id)) as FileRow[];
    return {
      messages: messages.map((message) => ({
        ...message,
        files: files.filter((file) => file.message_id === message.id && (file.kind === "upload" || isDeliverablePath(file.relative_path))),
      })),
      hasMore,
      nextCursor: hasMore ? messages[0].id : null,
    };
  }

  addFile(file: FileRow): void {
    this.sqlite.prepare("INSERT INTO files(id,conversation_id,message_id,pending_prompt_id,composer_draft_id,original_name,relative_path,source_path,mime_type,size,sha256,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      file.id, file.conversation_id, file.message_id, file.pending_prompt_id ?? null, file.composer_draft_id ?? null, file.original_name, normalizeStoredRelativePath(file.relative_path), file.source_path ?? null, file.mime_type, file.size, file.sha256 ?? null, file.kind, file.created_at,
    );
  }

  addFiles(files: FileRow[], userId?: string, maximumStoredBytes = Number.MAX_SAFE_INTEGER): void {
    if (!files.length) return;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (userId) this.assertUserFileQuota(userId, files, maximumStoredBytes);
      for (const file of files) this.addFile(file);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  createResumableUpload(input: Omit<ResumableUploadRow, "offset" | "state" | "completed_at">, maximumStoredBytes: number): ResumableUploadRow {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const conversation = this.sqlite.prepare("SELECT user_id,archived_at,deleted_at FROM conversations WHERE id=?").get(input.conversation_id) as { user_id: string; archived_at: string | null; deleted_at: string | null } | undefined;
      if (!conversation || conversation.user_id !== input.user_id || conversation.archived_at || conversation.deleted_at) throw new Error("Upload conversation ownership mismatch");
      if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error("Upload size is invalid");
      const activeSlots = this.sqlite.prepare("SELECT count(*) AS value FROM resumable_uploads WHERE conversation_id=? AND state IN ('uploading','finalizing')").get(input.conversation_id) as { value: number };
      const draftSlots = this.sqlite.prepare("SELECT count(*) AS value FROM files WHERE composer_draft_id=?").get(input.conversation_id) as { value: number };
      if (Number(activeSlots.value) + Number(draftSlots.value) >= 12) throw new Error("DRAFT_FILE_LIMIT");
      const maximum = Number.isSafeInteger(maximumStoredBytes) && maximumStoredBytes >= 0 ? maximumStoredBytes : 0;
      if (this.sumStoredFileBytesForUser(input.user_id) + this.sumActiveResumableBytesForUser(input.user_id) + input.size > maximum) {
        throw new StorageQuotaExceededError();
      }
      this.sqlite.prepare(`
        INSERT INTO resumable_uploads(
          id,user_id,conversation_id,file_id,original_name,mime_type,size,offset,storage_name,final_name,state,created_at,updated_at,expires_at,completed_at
        ) VALUES(?,?,?,?,?,?,?,0,?,?,'uploading',?,?,?,NULL)
      `).run(
        input.id, input.user_id, input.conversation_id, input.file_id, input.original_name, input.mime_type,
        input.size, input.storage_name, input.final_name, input.created_at, input.updated_at, input.expires_at,
      );
      this.sqlite.exec("COMMIT");
      return this.getResumableUpload(input.id)!;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getResumableUpload(id: string): ResumableUploadRow | undefined {
    return this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE id=?").get(id) as ResumableUploadRow | undefined;
  }

  getResumableUploadForUser(id: string, userId: string): ResumableUploadRow | undefined {
    return this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE id=? AND user_id=?").get(id, userId) as ResumableUploadRow | undefined;
  }

  listActiveResumableUploads(conversationId?: string): ResumableUploadRow[] {
    return (conversationId
      ? this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE conversation_id=? AND state IN ('uploading','finalizing') ORDER BY created_at,id").all(conversationId)
      : this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE state IN ('uploading','finalizing') ORDER BY created_at,id").all()) as ResumableUploadRow[];
  }

  listExpiredResumableUploads(now: string): ResumableUploadRow[] {
    return this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE state IN ('uploading','finalizing') AND expires_at<=? ORDER BY expires_at,id").all(now) as ResumableUploadRow[];
  }

  sumActiveResumableBytesForUser(userId: string): number {
    const row = this.sqlite.prepare("SELECT COALESCE(sum(size),0) AS value FROM resumable_uploads WHERE user_id=? AND state IN ('uploading','finalizing')").get(userId) as { value: number };
    return Number(row.value);
  }

  updateResumableUploadOffset(id: string, offset: number, expiresAt: string): ResumableUploadRow | undefined {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE resumable_uploads SET offset=?,updated_at=?,expires_at=?
      WHERE id=? AND state='uploading' AND ? BETWEEN offset AND size
    `).run(offset, now, expiresAt, id, offset);
    return this.getResumableUpload(id);
  }

  reconcileResumableUploadOffset(id: string, offset: number, expiresAt: string): ResumableUploadRow | undefined {
    this.sqlite.prepare(`
      UPDATE resumable_uploads SET offset=?,updated_at=?,expires_at=?
      WHERE id=? AND state='uploading' AND ? BETWEEN 0 AND size
    `).run(offset, new Date().toISOString(), expiresAt, id, offset);
    return this.getResumableUpload(id);
  }

  markResumableUploadFinalizing(id: string, offset: number): ResumableUploadRow | undefined {
    this.sqlite.prepare(`
      UPDATE resumable_uploads SET state='finalizing',offset=?,updated_at=?
      WHERE id=? AND state IN ('uploading','finalizing') AND size=?
    `).run(offset, new Date().toISOString(), id, offset);
    return this.getResumableUpload(id);
  }

  completeResumableUpload(id: string, file: FileRow, maximumStoredBytes: number): ResumableUploadRow {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const upload = this.getResumableUpload(id);
      if (!upload) throw new Error("Resumable upload does not exist");
      if (upload.state === "completed") {
        this.sqlite.exec("COMMIT");
        return upload;
      }
      if (upload.state !== "finalizing" || upload.offset !== upload.size || upload.file_id !== file.id || upload.conversation_id !== file.conversation_id) {
        throw new Error("Resumable upload finalization state mismatch");
      }
      const maximum = Number.isSafeInteger(maximumStoredBytes) && maximumStoredBytes >= 0 ? maximumStoredBytes : 0;
      if (this.sumStoredFileBytesForUser(upload.user_id) + this.sumActiveResumableBytesForUser(upload.user_id) > maximum) {
        throw new StorageQuotaExceededError();
      }
      this.ensureComposerDraft(upload.conversation_id);
      if (!this.getFile(file.id)) this.addFile(file);
      const now = new Date().toISOString();
      this.sqlite.prepare("UPDATE resumable_uploads SET state='completed',offset=size,updated_at=?,completed_at=? WHERE id=?").run(now, now, id);
      this.touchComposerDraft(upload.conversation_id);
      this.sqlite.exec("COMMIT");
      return this.getResumableUpload(id)!;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  markResumableUploadTerminated(id: string, state: "cancelled" | "expired"): boolean {
    return this.sqlite.prepare(`
      UPDATE resumable_uploads SET state=?,updated_at=? WHERE id=? AND state IN ('uploading','finalizing')
    `).run(state, new Date().toISOString(), id).changes > 0;
  }

  deleteResumableUploadRecord(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM resumable_uploads WHERE id=? AND state NOT IN ('uploading','finalizing')").run(id).changes > 0;
  }

  deleteCompletedResumableUploadForFile(fileId: string): boolean {
    return this.sqlite.prepare("DELETE FROM resumable_uploads WHERE file_id=? AND state='completed'").run(fileId).changes > 0;
  }

  getFile(id: string): FileRow | undefined {
    return this.sqlite.prepare("SELECT * FROM files WHERE id=?").get(id) as FileRow | undefined;
  }

  getFileForUser(id: string, userId: string): FileRow | undefined {
    return this.sqlite.prepare("SELECT f.* FROM files f JOIN conversations c ON c.id=f.conversation_id WHERE f.id=? AND c.user_id=? AND c.deleted_at IS NULL").get(id, userId) as FileRow | undefined;
  }

  listFiles(conversationId?: string): FileRow[] {
    if (conversationId) return this.sqlite.prepare("SELECT * FROM files WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as FileRow[];
    return this.sqlite.prepare("SELECT * FROM files ORDER BY created_at,id").all() as FileRow[];
  }

  listFilesForMessage(messageId: string): FileRow[] {
    return this.sqlite.prepare("SELECT * FROM files WHERE message_id=? ORDER BY created_at,id").all(messageId) as FileRow[];
  }

  getPublicFileShare(fileId: string): PublicFileShareRow | undefined {
    return this.sqlite.prepare("SELECT * FROM public_file_shares WHERE file_id=?").get(fileId) as PublicFileShareRow | undefined;
  }

  listActivePublicFileShares(userId: string): ManagedPublicFileShareRow[] {
    return this.sqlite.prepare(`
      SELECT share.*,file.original_name AS current_file_name,file.mime_type,file.size,
        file.conversation_id,conversation.title AS conversation_title
      FROM public_file_shares share
      JOIN files file ON file.id=share.file_id
      JOIN conversations conversation ON conversation.id=file.conversation_id
      WHERE share.user_id=? AND share.enabled=1 AND file.kind='output'
        AND conversation.user_id=? AND conversation.deleted_at IS NULL AND conversation.deletion_state='active'
      ORDER BY share.enabled_at DESC,share.id DESC
    `).all(userId, userId) as ManagedPublicFileShareRow[];
  }

  getActivePublicFile(fileId: string): { share: PublicFileShareRow; file: FileRow } | undefined {
    const share = this.getPublicFileShare(fileId);
    if (!share?.enabled) return undefined;
    const file = this.getFile(fileId);
    if (!file || file.kind !== "output") return undefined;
    const conversation = this.getConversation(file.conversation_id);
    const user = this.getUser(share.user_id);
    if (!conversation || conversation.user_id !== share.user_id || conversation.deleted_at || conversation.deletion_state !== "active" || user?.status !== "active") return undefined;
    return { share, file };
  }

  listPublicFileShareAssets(shareId: string): PublicFileShareAssetRow[] {
    return this.sqlite.prepare("SELECT * FROM public_file_share_assets WHERE share_id=? ORDER BY source_ref,asset_file_id")
      .all(shareId) as PublicFileShareAssetRow[];
  }

  enablePublicFileShare(input: {
    id: string;
    file: FileRow;
    userId: string;
    assets: Array<{ sourceRef: string; assetFileId: string }>;
  }): PublicFileShareRow {
    const now = new Date().toISOString();
    const existing = this.getPublicFileShare(input.file.id);
    const shareId = existing?.id ?? input.id;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        INSERT INTO public_file_shares(id,file_id,user_id,file_name_snapshot,enabled,created_at,enabled_at,disabled_at)
        VALUES(?,?,?,?,1,?,?,NULL)
        ON CONFLICT(file_id) DO UPDATE SET
          user_id=excluded.user_id,file_name_snapshot=excluded.file_name_snapshot,
          enabled=1,enabled_at=excluded.enabled_at,disabled_at=NULL
      `).run(shareId, input.file.id, input.userId, input.file.original_name, existing?.created_at ?? now, now);
      this.sqlite.prepare("DELETE FROM public_file_share_assets WHERE share_id=?").run(shareId);
      const insertAsset = this.sqlite.prepare(`
        INSERT INTO public_file_share_assets(share_id,asset_file_id,source_ref,created_at) VALUES(?,?,?,?)
      `);
      for (const asset of input.assets) insertAsset.run(shareId, asset.assetFileId, asset.sourceRef, now);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getPublicFileShare(input.file.id)!;
  }

  disablePublicFileShare(fileId: string, userId: string): PublicFileShareRow | undefined {
    const share = this.getPublicFileShare(fileId);
    if (!share || share.user_id !== userId) return undefined;
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("UPDATE public_file_shares SET enabled=0,disabled_at=? WHERE file_id=? AND user_id=?")
        .run(now, fileId, userId);
      this.sqlite.prepare("DELETE FROM public_file_share_assets WHERE share_id=?").run(share.id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getPublicFileShare(fileId);
  }

  recordPublicShareAccess(shareId: string, ipAddress: string, viewId: string, userAgent: string | null, accessedAt = new Date().toISOString()): boolean {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.sqlite.prepare(`
        INSERT OR IGNORE INTO public_share_access_events(id,share_id,ip_address,view_id,user_agent,accessed_at)
        VALUES(?,?,?,?,?,?)
      `).run(crypto.randomUUID(), shareId, ipAddress, viewId, userAgent, accessedAt).changes > 0;
      if (inserted) {
        this.sqlite.prepare(`
          INSERT INTO public_share_access_rollups(share_id,ip_address,first_accessed_at,last_accessed_at,access_count)
          VALUES(?,?,?,?,1)
          ON CONFLICT(share_id,ip_address) DO UPDATE SET
            last_accessed_at=excluded.last_accessed_at,
            access_count=public_share_access_rollups.access_count+1
        `).run(shareId, ipAddress, accessedAt, accessedAt);
      }
      this.sqlite.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  prunePublicShareAccessEvents(before: string): number {
    return Number(this.sqlite.prepare("DELETE FROM public_share_access_events WHERE accessed_at<?").run(before).changes);
  }

  getFileForMessageSource(messageId: string, sourcePath: string): FileRow | undefined {
    return this.sqlite.prepare("SELECT * FROM files WHERE message_id=? AND source_path=? ORDER BY created_at DESC LIMIT 1").get(messageId, sourcePath) as FileRow | undefined;
  }

  updateFilePath(id: string, relativePath: string): void {
    this.sqlite.prepare("UPDATE files SET relative_path=? WHERE id=?").run(normalizeStoredRelativePath(relativePath), id);
  }

  ensureComposerDraft(conversationId: string): ComposerDraftWithFiles {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO composer_drafts(conversation_id,content,quote_excerpt,created_at,updated_at)
      VALUES(?,'',NULL,?,?) ON CONFLICT(conversation_id) DO NOTHING
    `).run(conversationId, now, now);
    return this.getComposerDraft(conversationId)!;
  }

  saveComposerDraft(conversationId: string, content: string, quoteExcerpt: string | null): ComposerDraftWithFiles | undefined {
    const existing = this.getComposerDraft(conversationId);
    if (!content && !quoteExcerpt && (!existing || existing.files.length === 0)) {
      if (existing) this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId);
      return undefined;
    }
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO composer_drafts(conversation_id,content,quote_excerpt,created_at,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET content=excluded.content,quote_excerpt=excluded.quote_excerpt,updated_at=excluded.updated_at
    `).run(conversationId, content, quoteExcerpt, now, now);
    return this.getComposerDraft(conversationId);
  }

  getComposerDraft(conversationId: string): ComposerDraftWithFiles | undefined {
    const draft = this.sqlite.prepare("SELECT * FROM composer_drafts WHERE conversation_id=?").get(conversationId) as ComposerDraftRow | undefined;
    if (!draft) return undefined;
    const files = this.sqlite.prepare("SELECT * FROM files WHERE composer_draft_id=? ORDER BY created_at,id").all(conversationId) as FileRow[];
    return { ...draft, files };
  }

  deleteComposerDraft(conversationId: string): boolean {
    return this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId).changes > 0;
  }

  touchComposerDraft(conversationId: string): void {
    this.sqlite.prepare("UPDATE composer_drafts SET updated_at=? WHERE conversation_id=?").run(new Date().toISOString(), conversationId);
  }

  pruneEmptyComposerDraft(conversationId: string): void {
    this.sqlite.prepare(`
      DELETE FROM composer_drafts
      WHERE conversation_id=? AND content='' AND quote_excerpt IS NULL
        AND NOT EXISTS (SELECT 1 FROM files WHERE composer_draft_id=?)
    `).run(conversationId, conversationId);
  }

  materializeComposerDraftAsPending(
    pendingId: string,
    conversationId: string,
    content: string,
    selection: StoredAgentSelection,
    quoteExcerpt: string | null,
    status: PendingPromptRow["status"] = "queued",
  ): PendingPromptWithFiles {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(position),0)+1 AS value FROM pending_prompts WHERE conversation_id=? AND status='queued'").get(conversationId) as { value: number };
      this.sqlite.prepare(`
        INSERT INTO pending_prompts(id,conversation_id,content,quote_excerpt,agent_model,reasoning_effort,position,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(pendingId, conversationId, content, quoteExcerpt, selection.model, selection.reasoningEffort, next.value, status, now, now);
      this.sqlite.prepare(`
        UPDATE files SET pending_prompt_id=?,composer_draft_id=NULL
        WHERE conversation_id=? AND composer_draft_id=?
      `).run(pendingId, conversationId, conversationId);
      this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId);
      if (status === "queued") {
        this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
        this.bumpConversationSidebarOrder(conversationId);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getPendingPrompt(pendingId)!;
  }

  materializeComposerDraftAsJob(
    messageId: string,
    jobId: string,
    conversationId: string,
    content: string,
    selection: StoredAgentSelection,
    quoteExcerpt: string | null,
  ): JobRow {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,'user',?,?,?)")
        .run(messageId, conversationId, content, quoteExcerpt, now);
      this.sqlite.prepare(`
        UPDATE files SET message_id=?,composer_draft_id=NULL
        WHERE conversation_id=? AND composer_draft_id=?
      `).run(messageId, conversationId, conversationId);
      this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId);
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.sqlite.prepare(`
        INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,queue_seq,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?)
      `).run(jobId, conversationId, messageId, selection.model, selection.reasoningEffort, next.value, now, now);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
      this.bumpConversationSidebarOrder(conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(jobId)!;
  }

  createPendingPrompt(id: string, conversationId: string, content: string, selection: StoredAgentSelection, quoteExcerpt: string | null = null): PendingPromptWithFiles {
    const now = new Date().toISOString();
    const next = this.sqlite.prepare("SELECT COALESCE(MAX(position),0)+1 AS value FROM pending_prompts WHERE conversation_id=? AND status='queued'").get(conversationId) as { value: number };
    this.sqlite.prepare(`
      INSERT INTO pending_prompts(id,conversation_id,content,quote_excerpt,agent_model,reasoning_effort,position,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)
    `).run(id, conversationId, content, quoteExcerpt, selection.model, selection.reasoningEffort, next.value, now, now);
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
    this.bumpConversationSidebarOrder(conversationId);
    return this.getPendingPrompt(id)!;
  }

  getPendingPrompt(id: string): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare("SELECT * FROM pending_prompts WHERE id=?").get(id) as PendingPromptRow | undefined;
    if (!prompt) return undefined;
    const files = this.sqlite.prepare("SELECT * FROM files WHERE pending_prompt_id=? ORDER BY created_at,id").all(id) as FileRow[];
    return { ...prompt, files };
  }

  getPendingPromptForUser(id: string, userId: string): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare(`
      SELECT pending.* FROM pending_prompts pending
      JOIN conversations conversation ON conversation.id=pending.conversation_id
      WHERE pending.id=? AND conversation.user_id=? AND conversation.deleted_at IS NULL
    `).get(id, userId) as PendingPromptRow | undefined;
    if (!prompt) return undefined;
    return { ...prompt, files: this.sqlite.prepare("SELECT * FROM files WHERE pending_prompt_id=? ORDER BY created_at,id").all(id) as FileRow[] };
  }

  listPendingPrompts(conversationId: string, status: PendingPromptRow["status"] = "queued"): PendingPromptWithFiles[] {
    const prompts = this.sqlite.prepare("SELECT * FROM pending_prompts WHERE conversation_id=? AND status=? ORDER BY position,id").all(conversationId, status) as PendingPromptRow[];
    const files = this.sqlite.prepare("SELECT * FROM files WHERE conversation_id=? AND pending_prompt_id IS NOT NULL ORDER BY created_at,id").all(conversationId) as FileRow[];
    return prompts.map((prompt) => ({ ...prompt, files: files.filter((file) => file.pending_prompt_id === prompt.id) }));
  }

  beginEditingPendingPrompt(id: string): PendingPromptWithFiles | undefined {
    const prompt = this.getPendingPrompt(id);
    if (!prompt || prompt.status !== "queued") return undefined;
    this.sqlite.prepare("UPDATE pending_prompts SET status='editing',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), id);
    return this.getPendingPrompt(id);
  }

  restorePendingPrompt(id: string): PendingPromptWithFiles | undefined {
    const now = new Date().toISOString();
    this.sqlite.prepare("UPDATE pending_prompts SET status='queued',updated_at=? WHERE id=? AND status='editing'").run(now, id);
    return this.getPendingPrompt(id);
  }

  updatePendingPrompt(id: string, content: string, selection: StoredAgentSelection, quoteExcerpt: string | null = null): PendingPromptWithFiles | undefined {
    const result = this.sqlite.prepare(`
      UPDATE pending_prompts SET content=?,quote_excerpt=?,agent_model=?,reasoning_effort=?,status='queued',updated_at=? WHERE id=?
    `).run(content, quoteExcerpt, selection.model, selection.reasoningEffort, new Date().toISOString(), id);
    return result.changes ? this.getPendingPrompt(id) : undefined;
  }

  updateEditingPendingPrompt(id: string, content: string, selection: StoredAgentSelection, quoteExcerpt: string | null = null): PendingPromptWithFiles | undefined {
    const result = this.sqlite.prepare(`
      UPDATE pending_prompts SET content=?,quote_excerpt=?,agent_model=?,reasoning_effort=?,updated_at=? WHERE id=? AND status='editing'
    `).run(content, quoteExcerpt, selection.model, selection.reasoningEffort, new Date().toISOString(), id);
    return result.changes ? this.getPendingPrompt(id) : undefined;
  }

  updatePendingPromptWithFiles(input: {
    id: string;
    expectedUpdatedAt: string;
    content: string;
    quoteExcerpt: string | null;
    selection: StoredAgentSelection;
    nextStatus: PendingPromptRow["status"];
    newFiles: FileRow[];
    removeFileIds?: string[];
    userId?: string;
    maximumStoredBytes?: number;
  }): PendingPromptWithFiles | undefined {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const current = this.sqlite.prepare(`
        SELECT pending.conversation_id,conversation.user_id
        FROM pending_prompts pending JOIN conversations conversation ON conversation.id=pending.conversation_id
        WHERE pending.id=? AND pending.status='editing' AND pending.updated_at=? AND conversation.deleted_at IS NULL
      `).get(input.id, input.expectedUpdatedAt) as { conversation_id: string; user_id: string } | undefined;
      if (!current) {
        this.sqlite.exec("ROLLBACK");
        return undefined;
      }
      const result = this.sqlite.prepare(`
        UPDATE pending_prompts
        SET content=?,quote_excerpt=?,agent_model=?,reasoning_effort=?,status=?,updated_at=?
        WHERE id=? AND status='editing' AND updated_at=?
      `).run(input.content, input.quoteExcerpt, input.selection.model, input.selection.reasoningEffort,
        input.nextStatus, now, input.id, input.expectedUpdatedAt);
      if (!result.changes) {
        this.sqlite.exec("ROLLBACK");
        return undefined;
      }
      const removeIds = [...new Set(input.removeFileIds ?? [])];
      let removedBytes = 0;
      const removable = this.sqlite.prepare("SELECT size FROM files WHERE id=? AND pending_prompt_id=? AND conversation_id=?");
      for (const fileId of removeIds) {
        const row = removable.get(fileId, input.id, current.conversation_id) as { size: number } | undefined;
        if (row) removedBytes += Number(row.size);
      }
      if (input.userId) {
        if (input.userId !== current.user_id) throw new Error("Pending upload user ownership mismatch");
        this.assertUserFileQuota(input.userId, input.newFiles, input.maximumStoredBytes ?? Number.MAX_SAFE_INTEGER, removedBytes);
      }
      const remove = this.sqlite.prepare("DELETE FROM files WHERE id=? AND pending_prompt_id=? AND conversation_id=?");
      for (const fileId of removeIds) remove.run(fileId, input.id, current.conversation_id);
      for (const file of input.newFiles) {
        if (file.conversation_id !== current.conversation_id || file.pending_prompt_id !== input.id || file.message_id) {
          throw new Error("Pending upload ownership mismatch");
        }
        this.addFile(file);
      }
      this.sqlite.exec("COMMIT");
      return this.getPendingPrompt(input.id);
    } catch (error) {
      if (this.sqlite.isTransaction) this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  reorderPendingPrompts(conversationId: string, orderedIds: string[]): PendingPromptWithFiles[] {
    const current = this.listPendingPrompts(conversationId, "queued").map((prompt) => prompt.id);
    if (current.length !== orderedIds.length || new Set(current).size !== new Set(orderedIds).size || current.some((id) => !orderedIds.includes(id))) {
      throw new Error("待发送队列已经变化，请刷新后重试");
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const update = this.sqlite.prepare("UPDATE pending_prompts SET position=?,updated_at=? WHERE id=? AND conversation_id=? AND status='queued'");
      const now = new Date().toISOString();
      orderedIds.forEach((id, index) => update.run(index + 1, now, id, conversationId));
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.listPendingPrompts(conversationId);
  }

  removeFile(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM files WHERE id=?").run(id).changes > 0;
  }

  deletePendingPrompt(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(id).changes > 0;
  }

  deletePendingPromptsForConversation(conversationId: string): number {
    return Number(this.sqlite.prepare("DELETE FROM pending_prompts WHERE conversation_id=?").run(conversationId).changes);
  }

  createWakePlan(input: {
    id: string;
    conversationId: string;
    createdByJobId?: string | null;
    mode: WakePlanMode;
    label: string;
    runId?: string | null;
    deadlineAt: string;
    successPrompt: string;
    failurePrompt: string;
    timeoutPrompt: string;
    newConversation?: boolean;
    selection: StoredAgentSelection;
    eventTokenHash?: string | null;
  }): WakePlanRow {
    const sourceConversation = this.getConversation(input.conversationId);
    if (!sourceConversation || sourceConversation.deleted_at || sourceConversation.archived_at) throw new Error("会话不存在或已归档");
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      let planConversation = sourceConversation;
      let targetConversationId: string | null = null;
      if (input.newConversation) {
        planConversation = this.createConversation(
          crypto.randomUUID(),
          continuationConversationTitle(input.label, input.deadlineAt),
          input.selection,
          sourceConversation.user_id,
          sourceConversation.project_id ?? undefined,
        );
        targetConversationId = planConversation.id;
        this.sqlite.prepare("UPDATE conversations SET title_source='manual' WHERE id=?").run(planConversation.id);
        planConversation = this.getConversation(planConversation.id)!;
        this.sqlite.prepare("UPDATE conversations SET pinned_at=NULL WHERE id=?").run(sourceConversation.id);
      }
      this.sqlite.prepare(`
        INSERT INTO wake_plans(
          id,conversation_id,created_by_job_id,mode,state,label,run_id,deadline_at,
          success_prompt,failure_prompt,timeout_prompt,new_conversation,target_conversation_id,
          agent_model,reasoning_effort,event_token_hash,created_at,updated_at
        ) VALUES(?,?,?,?,'armed',?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        input.id, planConversation.id, input.createdByJobId ?? null, input.mode, input.label,
        input.runId ?? null, input.deadlineAt, input.successPrompt, input.failurePrompt, input.timeoutPrompt,
        input.newConversation ? 1 : 0, targetConversationId, input.selection.model, input.selection.reasoningEffort,
        input.eventTokenHash ?? null, now, now,
      );
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, planConversation.id);
      this.sqlite.exec("COMMIT");
      return this.getWakePlan(input.id)!;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getWakePlan(id: string): WakePlanRow | undefined {
    return this.sqlite.prepare("SELECT * FROM wake_plans WHERE id=?").get(id) as WakePlanRow | undefined;
  }

  getWakePlanForUser(id: string, userId: string): WakePlanRow | undefined {
    return this.sqlite.prepare(`
      SELECT wake.* FROM wake_plans wake
      JOIN conversations conversation ON conversation.id=wake.conversation_id
      WHERE wake.id=? AND conversation.user_id=? AND conversation.deleted_at IS NULL
    `).get(id, userId) as WakePlanRow | undefined;
  }

  getActiveWakePlan(conversationId: string): WakePlanRow | undefined {
    return this.sqlite.prepare("SELECT * FROM wake_plans WHERE conversation_id=? AND state='armed' ORDER BY created_at DESC,id DESC LIMIT 1")
      .get(conversationId) as WakePlanRow | undefined;
  }

  listDueWakePlans(now: string, limit = 100): WakePlanRow[] {
    return this.sqlite.prepare(`
      SELECT wake.* FROM wake_plans wake
      JOIN conversations conversation ON conversation.id=wake.conversation_id
      WHERE wake.state='armed' AND wake.deadline_at<=? AND conversation.deleted_at IS NULL AND conversation.archived_at IS NULL
      ORDER BY wake.deadline_at,wake.id LIMIT ?
    `).all(now, Math.max(1, Math.min(500, Math.trunc(limit)))) as WakePlanRow[];
  }

  listWakeEvents(wakePlanId: string, limit = 100): WakeEventRow[] {
    return this.sqlite.prepare("SELECT * FROM wake_events WHERE wake_plan_id=? ORDER BY created_at,event_id LIMIT ?")
      .all(wakePlanId, Math.max(1, Math.min(500, Math.trunc(limit)))) as WakeEventRow[];
  }

  cancelWakePlan(id: string): WakePlanRow | undefined {
    const plan = this.getWakePlan(id);
    if (!plan || plan.state !== "armed") return undefined;
    const now = new Date().toISOString();
    const result = this.sqlite.prepare("UPDATE wake_plans SET state='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND state='armed'")
      .run(now, now, id);
    if (!result.changes) return undefined;
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, plan.conversation_id);
    return this.getWakePlan(id);
  }

  cancelArmedWakePlansForConversation(conversationId: string): number {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare(`
      UPDATE wake_plans SET state='cancelled',cancelled_at=?,updated_at=?
      WHERE conversation_id=? AND state='armed'
    `).run(now, now, conversationId);
    if (result.changes) {
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
    }
    return Number(result.changes);
  }

  rescheduleWakePlan(id: string, deadlineAt: string): WakePlanRow | undefined {
    const plan = this.getWakePlan(id);
    if (!plan || plan.state !== "armed") return undefined;
    const now = new Date().toISOString();
    const result = this.sqlite.prepare("UPDATE wake_plans SET deadline_at=?,updated_at=? WHERE id=? AND state='armed'")
      .run(deadlineAt, now, id);
    if (!result.changes) return undefined;
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, plan.conversation_id);
    return this.getWakePlan(id);
  }

  updateWakePlanPrompts(input: {
    id: string;
    expectedRevision: number;
    successPrompt: string;
    failurePrompt: string;
    timeoutPrompt: string;
    selection?: StoredAgentSelection;
  }): WakePlanRow | undefined {
    const plan = this.getWakePlan(input.id);
    if (!plan || plan.state !== "armed") return undefined;
    const now = new Date().toISOString();
    const result = this.sqlite.prepare(`
      UPDATE wake_plans
      SET success_prompt=?,failure_prompt=?,timeout_prompt=?,
          agent_model=COALESCE(?, agent_model),
          reasoning_effort=COALESCE(?, reasoning_effort),
          revision=revision+1,updated_at=?
      WHERE id=? AND state='armed' AND revision=?
    `).run(
      input.successPrompt,
      input.failurePrompt,
      input.timeoutPrompt,
      input.selection?.model ?? null,
      input.selection?.reasoningEffort ?? null,
      now,
      input.id,
      input.expectedRevision,
    );
    if (!result.changes) return undefined;
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, plan.conversation_id);
    return this.getWakePlan(input.id);
  }

  recordWakeEvent(
    wakePlanId: string,
    eventId: string,
    kind: WakeEventKind,
    summary: string | null,
    pendingPromptId: string,
  ): WakeTriggerResult {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const plan = this.getWakePlan(wakePlanId);
      if (!plan) {
        this.sqlite.exec("COMMIT");
        return { status: "missing" };
      }
      const duplicate = this.sqlite.prepare("SELECT 1 AS found FROM wake_events WHERE wake_plan_id=? AND event_id=?")
        .get(wakePlanId, eventId) as { found: number } | undefined;
      if (duplicate) {
        this.sqlite.exec("COMMIT");
        return { status: "duplicate", plan };
      }
      if (plan.state !== "armed") {
        this.sqlite.exec("COMMIT");
        return { status: "stale", plan };
      }
      this.sqlite.prepare("INSERT INTO wake_events(wake_plan_id,event_id,kind,summary,accepted,created_at) VALUES(?,?,?,?,0,?)")
        .run(wakePlanId, eventId, kind, summary, now);
      if (kind === "heartbeat") {
        this.sqlite.prepare(`
          UPDATE wake_plans SET last_heartbeat_at=?,last_event_at=?,last_event_kind=?,last_event_summary=?,updated_at=? WHERE id=?
        `).run(now, now, kind, summary, now, wakePlanId);
        this.sqlite.prepare("UPDATE wake_events SET accepted=1 WHERE wake_plan_id=? AND event_id=?").run(wakePlanId, eventId);
        this.sqlite.exec("COMMIT");
        return { status: "heartbeat", plan: this.getWakePlan(wakePlanId) };
      }
      const cause = kind as WakeTriggerCause;
      const prompt = cause === "success"
        ? plan.success_prompt
        : cause === "failure"
        ? plan.failure_prompt
        : plan.mode === "time"
        ? plan.success_prompt
        : plan.timeout_prompt;
      const sourceConversation = this.getConversation(plan.conversation_id);
      if (!sourceConversation || sourceConversation.deleted_at || sourceConversation.archived_at) {
        throw new Error("等待计划所属会话不存在或已归档");
      }
      let targetConversation = sourceConversation;
      if (plan.new_conversation) {
        const existingTarget = plan.target_conversation_id
          ? this.getConversation(plan.target_conversation_id)
          : undefined;
        if (existingTarget && !existingTarget.deleted_at && !existingTarget.archived_at) {
          targetConversation = existingTarget;
        } else if (!plan.target_conversation_id) {
          // Compatibility for waits armed before immediate target creation was introduced.
          targetConversation = this.createConversation(
            crypto.randomUUID(),
            continuationConversationTitle(sourceConversation.title, now),
            { model: plan.agent_model, reasoningEffort: plan.reasoning_effort },
            sourceConversation.user_id,
            sourceConversation.project_id ?? undefined,
          );
          this.sqlite.prepare("UPDATE conversations SET title_source='manual' WHERE id=?").run(targetConversation.id);
          this.sqlite.prepare("UPDATE conversations SET pinned_at=NULL WHERE id=?").run(sourceConversation.id);
          targetConversation = this.getConversation(targetConversation.id)!;
        } else {
          throw new Error("等待计划的目标会话不存在或已归档");
        }
      }
      // A triggered continuation belongs to the task that was already waiting,
      // so it must resume before user prompts queued during that wait.
      this.sqlite.prepare(`
        UPDATE pending_prompts SET position=position+1
        WHERE conversation_id=? AND status='queued'
      `).run(targetConversation.id);
      this.sqlite.prepare(`
        INSERT INTO pending_prompts(id,conversation_id,content,quote_excerpt,agent_model,reasoning_effort,position,status,created_at,updated_at)
        VALUES(?,?,?,NULL,?,?,?,'queued',?,?)
      `).run(pendingPromptId, targetConversation.id, prompt, plan.agent_model, plan.reasoning_effort, 1, now, now);
      this.sqlite.prepare(`
        UPDATE wake_plans SET state='triggered',trigger_cause=?,triggered_at=?,pending_prompt_id=?,
          target_conversation_id=?,last_event_at=?,last_event_kind=?,last_event_summary=?,updated_at=?
        WHERE id=? AND state='armed'
      `).run(cause, now, pendingPromptId, targetConversation.id, now, kind, summary, now, wakePlanId);
      this.sqlite.prepare("UPDATE wake_events SET accepted=1 WHERE wake_plan_id=? AND event_id=?").run(wakePlanId, eventId);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, targetConversation.id);
      this.bumpConversationSidebarOrder(targetConversation.id);
      this.sqlite.exec("COMMIT");
      return {
        status: "triggered",
        plan: this.getWakePlan(wakePlanId),
        pendingPrompt: this.getPendingPrompt(pendingPromptId),
        targetConversation: this.getConversation(targetConversation.id),
      };
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getNextDispatchablePendingPrompt(): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare(`
      SELECT pending.* FROM pending_prompts pending
      JOIN conversations conversation ON conversation.id=pending.conversation_id
      WHERE pending.status='queued' AND conversation.deleted_at IS NULL AND conversation.external_status<>'running'
        AND NOT EXISTS (
          SELECT 1 FROM jobs active
          WHERE active.conversation_id=pending.conversation_id AND active.status IN ('queued','running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM wake_plans wake
          WHERE wake.conversation_id=pending.conversation_id AND wake.state='armed'
        )
      -- Position is the user-controlled order within each conversation. Putting
      -- it first is essential: created_at would otherwise make drag reordering
      -- cosmetic while the original insertion order kept dispatching.
      ORDER BY pending.position,pending.created_at,pending.id
      LIMIT 1
    `).get() as PendingPromptRow | undefined;
    return prompt ? this.getPendingPrompt(prompt.id) : undefined;
  }

  listDispatchablePendingPrompts(limit = 100): PendingPromptWithFiles[] {
    const prompts = this.sqlite.prepare(`
      SELECT pending.* FROM pending_prompts pending
      JOIN conversations conversation ON conversation.id=pending.conversation_id
      WHERE pending.status='queued' AND conversation.deleted_at IS NULL AND conversation.external_status<>'running'
        AND NOT EXISTS (
          SELECT 1 FROM jobs active
          WHERE active.conversation_id=pending.conversation_id AND active.status IN ('queued','running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM wake_plans wake
          WHERE wake.conversation_id=pending.conversation_id AND wake.state='armed'
        )
      ORDER BY pending.position,pending.created_at,pending.id
      LIMIT ?
    `).all(Math.max(1, Math.min(500, limit))) as PendingPromptRow[];
    return prompts.map((prompt) => this.getPendingPrompt(prompt.id)!).filter(Boolean);
  }

  materializePendingPrompt(pendingId: string, messageId: string, jobId: string): JobRow | undefined {
    const prompt = this.getPendingPrompt(pendingId);
    if (!prompt || prompt.status !== "queued") return undefined;
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const scheduled = this.sqlite.prepare(`
        SELECT 1 AS value FROM wake_plans
        WHERE pending_prompt_id=? AND state='triggered'
      `).get(pendingId) as { value: number } | undefined;
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,is_scheduled,created_at) VALUES(?,?,'user',?,?,?,?)")
        .run(messageId, prompt.conversation_id, prompt.content, prompt.quote_excerpt, scheduled ? 1 : 0, now);
      this.sqlite.prepare("UPDATE files SET message_id=?,pending_prompt_id=NULL WHERE pending_prompt_id=?").run(messageId, pendingId);
      this.sqlite.prepare("UPDATE voice_transcriptions SET message_id=?,pending_prompt_id=NULL WHERE pending_prompt_id=?").run(messageId, pendingId);
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.sqlite.prepare(`
        INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,queue_seq,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?)
      `).run(jobId, prompt.conversation_id, messageId, prompt.agent_model, prompt.reasoning_effort, next.value, now, now);
      this.sqlite.prepare("UPDATE wake_plans SET job_id=?,pending_prompt_id=NULL,updated_at=? WHERE pending_prompt_id=?")
        .run(jobId, now, pendingId);
      this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(pendingId);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, prompt.conversation_id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(jobId);
  }

  materializeSteeredPrompt(pendingId: string, messageId: string): MessageRow | undefined {
    const prompt = this.getPendingPrompt(pendingId);
    if (!prompt || prompt.status !== "queued") return undefined;
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,'user',?,?,?)")
        .run(messageId, prompt.conversation_id, prompt.content, prompt.quote_excerpt, now);
      this.sqlite.prepare("UPDATE files SET message_id=?,pending_prompt_id=NULL WHERE pending_prompt_id=?").run(messageId, pendingId);
      this.sqlite.prepare("UPDATE voice_transcriptions SET message_id=?,pending_prompt_id=NULL WHERE pending_prompt_id=?").run(messageId, pendingId);
      this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(pendingId);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, prompt.conversation_id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getMessage(messageId);
  }

  getAgentSelectionPreference(userId = LEGACY_USER_ID): StoredAgentSelection | undefined {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='agent_selection'").get(userId) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value) as Partial<StoredAgentSelection>;
      if (typeof value.model === "string" && typeof value.reasoningEffort === "string") return { model: value.model, reasoningEffort: value.reasoningEffort };
    } catch {
      // Invalid or manually edited preference is repaired by the caller.
    }
    return undefined;
  }

  setAgentSelectionPreference(selection: StoredAgentSelection, userId = LEGACY_USER_ID): void {
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'agent_selection',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, JSON.stringify(selection), new Date().toISOString());
  }

  getChatFontSize(userId = LEGACY_USER_ID): number {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='chat_font_size'").get(userId) as { value: string } | undefined;
    return normalizeChatFontSize(row?.value, CHAT_FONT_SIZE_DEFAULT);
  }

  setChatFontSize(value: unknown, userId = LEGACY_USER_ID): number {
    const fontSize = normalizeChatFontSize(value, CHAT_FONT_SIZE_DEFAULT);
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'chat_font_size',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, String(fontSize), new Date().toISOString());
    return fontSize;
  }

  createJob(id: string, conversationId: string, messageId?: string, selection?: StoredAgentSelection): JobRow {
    const now = new Date().toISOString();
    const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
    this.sqlite.prepare("INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,queue_seq,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)").run(
      id, conversationId, messageId ?? null, selection?.model ?? null, selection?.reasoningEffort ?? null, next.value, now, now,
    );
    this.bumpConversationSidebarOrder(conversationId);
    return this.getJob(id)!;
  }

  createJobWithMessageAndFiles(
    id: string,
    message: MessageRow,
    files: FileRow[],
    selection: StoredAgentSelection,
    userId?: string,
    maximumStoredBytes = Number.MAX_SAFE_INTEGER,
  ): JobRow {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const conversation = this.sqlite.prepare("SELECT user_id,deleted_at FROM conversations WHERE id=?")
        .get(message.conversation_id) as { user_id: string; deleted_at: string | null } | undefined;
      if (!conversation || conversation.deleted_at) throw new Error("Conversation is unavailable");
      if (userId) {
        if (conversation.user_id !== userId) throw new Error("Upload user ownership mismatch");
        this.assertUserFileQuota(userId, files, maximumStoredBytes);
      }
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,?,?,?,?)").run(
        message.id, message.conversation_id, message.role, message.content, message.quote_excerpt ?? null, message.created_at,
      );
      for (const file of files) {
        if (file.conversation_id !== message.conversation_id || file.message_id !== message.id) throw new Error("Upload ownership mismatch");
        this.addFile(file);
      }
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.sqlite.prepare("INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,queue_seq,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)").run(
        id, message.conversation_id, message.id, selection.model, selection.reasoningEffort, next.value, now, now,
      );
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(message.created_at, message.conversation_id);
      this.bumpConversationSidebarOrder(message.conversation_id);
      this.sqlite.exec("COMMIT");
      return this.getJob(id)!;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getJob(id: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
  }

  getJobForUser(id: string, userId: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=? AND c.user_id=? AND c.deleted_at IS NULL").get(id, userId) as JobRow | undefined;
  }

  getRunningJob(): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE status='running' ORDER BY queue_seq LIMIT 1").get() as JobRow | undefined;
  }

  listRunningJobSummaries(): RunningJobSummary[] {
    return this.sqlite.prepare(`
      SELECT job.id,conversation.title,job.created_at,job.updated_at
      FROM jobs job
      JOIN conversations conversation ON conversation.id=job.conversation_id
      WHERE job.status='running' AND conversation.deleted_at IS NULL
      ORDER BY job.queue_seq,job.id
    `).all() as RunningJobSummary[];
  }

  listRunningJobs(): JobRow[] {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE status='running' ORDER BY queue_seq, id").all() as JobRow[];
  }

  listTerminalJobRuntimes(): TerminalJobRuntimeRow[] {
    return this.sqlite.prepare(`
      SELECT job.id AS job_id,job.conversation_id,conversation.user_id
      FROM jobs job
      JOIN conversations conversation ON conversation.id=job.conversation_id
      WHERE job.status IN ('completed','failed','cancelled','interrupted')
      ORDER BY job.updated_at,job.id
    `).all() as TerminalJobRuntimeRow[];
  }

  getNextQueuedJob(): JobRow | undefined {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status='queued' AND c.deleted_at IS NULL ORDER BY j.queue_seq LIMIT 1").get() as JobRow | undefined;
  }

  getNextRunnableQueuedJob(): JobRow | undefined {
    return this.sqlite.prepare(`
      SELECT queued.* FROM jobs queued JOIN conversations conversation ON conversation.id=queued.conversation_id
      WHERE queued.status='queued'
        AND conversation.deleted_at IS NULL
        AND conversation.external_status<>'running'
        AND NOT EXISTS (
          SELECT 1 FROM jobs running
          WHERE running.conversation_id=queued.conversation_id AND running.status='running'
        )
      ORDER BY queued.queue_seq
      LIMIT 1
    `).get() as JobRow | undefined;
  }

  listRunnableQueuedJobs(limit = 100): JobRow[] {
    return this.sqlite.prepare(`
      SELECT queued.* FROM jobs queued JOIN conversations conversation ON conversation.id=queued.conversation_id
      WHERE queued.status='queued' AND conversation.deleted_at IS NULL AND conversation.external_status<>'running'
        AND NOT EXISTS (
          SELECT 1 FROM jobs running
          WHERE running.conversation_id=queued.conversation_id AND running.status='running'
        )
      ORDER BY queued.queue_seq
      LIMIT ?
    `).all(Math.max(1, Math.min(500, limit))) as JobRow[];
  }

  countRunningJobsForExecutor(executorId: string): number {
    const row = this.sqlite.prepare(`
      SELECT count(*) AS value FROM jobs job
      JOIN conversations conversation ON conversation.id=job.conversation_id
      JOIN projects project ON project.id=conversation.project_id
      WHERE job.status='running' AND project.executor_id=?
    `).get(executorId) as { value: number };
    return Number(row.value);
  }

  countRunningCodexThreadsForExecutor(executorId: string): number {
    const row = this.sqlite.prepare(`
      SELECT count(*) AS value FROM conversations conversation
      JOIN projects project ON project.id=conversation.project_id
      WHERE conversation.deleted_at IS NULL AND conversation.external_status='running' AND project.executor_id=?
    `).get(executorId) as { value: number };
    return Number(row.value);
  }

  countRunningJobsForExecutorExcludingUser(executorId: string, userId: string): number {
    const row = this.sqlite.prepare(`
      SELECT count(*) AS value FROM jobs job
      JOIN conversations conversation ON conversation.id=job.conversation_id
      JOIN projects project ON project.id=conversation.project_id
      WHERE job.status='running' AND project.executor_id=? AND conversation.user_id<>?
    `).get(executorId, userId) as { value: number };
    return Number(row.value);
  }

  countRunningJobs(): number {
    const row = this.sqlite.prepare("SELECT count(*) AS value FROM jobs WHERE status='running'").get() as { value: number };
    return Number(row.value);
  }

  countRunningJobsExcludingUser(userId: string): number {
    const row = this.sqlite.prepare(`
      SELECT count(*) AS value FROM jobs job
      JOIN conversations conversation ON conversation.id=job.conversation_id
      WHERE job.status='running' AND conversation.user_id<>?
    `).get(userId) as { value: number };
    return Number(row.value);
  }

  countRunningJobsForUser(userId: string): number {
    const row = this.sqlite.prepare(`
      SELECT count(*) AS value FROM jobs job
      JOIN conversations conversation ON conversation.id=job.conversation_id
      WHERE job.status='running' AND conversation.user_id=?
    `).get(userId) as { value: number };
    return Number(row.value);
  }

  sumStoredFileBytesForUser(userId: string): number {
    const row = this.sqlite.prepare(`
      SELECT COALESCE(sum(file.size),0) AS value FROM files file
      JOIN conversations conversation ON conversation.id=file.conversation_id
      WHERE conversation.user_id=?
    `).get(userId) as { value: number };
    return Number(row.value);
  }

  private assertUserFileQuota(userId: string, files: FileRow[], maximumStoredBytes: number, removedBytes = 0): void {
    const maximum = Number.isSafeInteger(maximumStoredBytes) && maximumStoredBytes >= 0 ? maximumStoredBytes : 0;
    let addedBytes = 0;
    for (const file of files) {
      if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Upload size is invalid");
      const owner = this.sqlite.prepare("SELECT user_id FROM conversations WHERE id=?").get(file.conversation_id) as { user_id: string } | undefined;
      if (!owner || owner.user_id !== userId) throw new Error("Upload user ownership mismatch");
      addedBytes += file.size;
    }
    if (!Number.isSafeInteger(addedBytes) || this.sumStoredFileBytesForUser(userId) + this.sumActiveResumableBytesForUser(userId) - removedBytes + addedBytes > maximum) {
      throw new StorageQuotaExceededError();
    }
  }

  listQueuedJobs(): JobRow[] {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status='queued' AND c.deleted_at IS NULL ORDER BY j.queue_seq").all() as JobRow[];
  }

  getActiveJob(): JobRow | undefined {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status IN ('running','queued') AND c.deleted_at IS NULL ORDER BY CASE j.status WHEN 'running' THEN 0 ELSE 1 END,j.queue_seq LIMIT 1").get() as JobRow | undefined;
  }

  getActiveJobForConversation(conversationId: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE conversation_id=? AND status IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 1").get(conversationId) as JobRow | undefined;
  }

  listActiveJobsForConversation(conversationId: string): JobRow[] {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE conversation_id=? AND status IN ('queued','running') ORDER BY queue_seq,id").all(conversationId) as JobRow[];
  }

  getLatestJobForConversation(conversationId: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(conversationId) as JobRow | undefined;
  }

  getQueuePosition(jobId: string): number | undefined {
    const job = this.getJob(jobId);
    if (!job || !["queued", "running"].includes(job.status)) return undefined;
    if (job.status === "running") return 0;
    const row = this.sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM jobs WHERE conversation_id=? AND status='running') +
        (SELECT COUNT(*) FROM jobs WHERE conversation_id=? AND status='queued' AND queue_seq<=?) AS position
    `).get(job.conversation_id, job.conversation_id, job.queue_seq) as { position: number };
    return row.position;
  }

  updateJob(id: string, status: JobStatus, error: string | null = null): void {
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)) {
      this.sqlite.prepare(`
        UPDATE jobs
        SET status=?,error=?,
          finalization_state=CASE
            WHEN finalization_state='published' OR (finalization_state='staging' AND finalization_payload IS NULL) THEN 'published'
            ELSE finalization_state
          END,
          finalization_payload=CASE WHEN finalization_state='published' THEN NULL ELSE finalization_payload END,
          finalization_error=CASE
            WHEN finalization_state='published' OR (finalization_state='staging' AND finalization_payload IS NULL) THEN NULL
            ELSE finalization_error
          END,
          updated_at=?
        WHERE id=?
      `).run(status, error, new Date().toISOString(), id);
      return;
    }
    this.sqlite.prepare("UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=?").run(status, error, new Date().toISOString(), id);
  }

  stageJobFinalization(id: string, payload: JobFinalizationPayload): void {
    const result = this.sqlite.prepare(`
      UPDATE jobs SET finalization_state='staging',finalization_payload=?,finalization_error=NULL,updated_at=?
      WHERE id=? AND status='running' AND finalization_state='staging'
    `).run(JSON.stringify(payload), new Date().toISOString(), id);
    if (!result.changes) {
      const existing = this.getJob(id);
      if (!existing || existing.finalization_state !== "staging" || existing.finalization_payload !== JSON.stringify(payload)) {
        throw new Error("Job finalization is not in staging state");
      }
    }
  }

  markJobFilesReady(id: string, payload: JobFinalizationPayload): void {
    const result = this.sqlite.prepare(`
      UPDATE jobs SET finalization_state='files_ready',finalization_payload=?,finalization_error=NULL,updated_at=?
      WHERE id=? AND finalization_state='staging'
    `).run(JSON.stringify(payload), new Date().toISOString(), id);
    if (!result.changes && this.getJob(id)?.finalization_state !== "files_ready") {
      throw new Error("Job finalization files could not be marked ready");
    }
  }

  finalizeJob(id: string, conversationId: string, payload: JobFinalizationPayload): void {
    const job = this.getJob(id);
    if (!job || job.conversation_id !== conversationId) throw new Error("Job finalization target is invalid");
    if (["db_committed", "published"].includes(job.finalization_state)) return;
    if (job.finalization_state !== "files_ready") throw new Error("Job finalization files are not ready");
    if (payload.message.conversation_id !== conversationId || payload.files.some((file) => file.conversation_id !== conversationId || file.message_id !== payload.message.id)) {
      throw new Error("Job finalization payload ownership is invalid");
    }
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const conversation = this.sqlite.prepare("SELECT deleted_at FROM conversations WHERE id=?").get(conversationId) as { deleted_at: string | null } | undefined;
      if (!conversation || conversation.deleted_at) throw new Error("Conversation is unavailable during finalization");
      this.sqlite.prepare(`
        INSERT OR IGNORE INTO messages(id,conversation_id,role,content,quote_excerpt,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(payload.message.id, conversationId, payload.message.role, payload.message.content, payload.message.quote_excerpt ?? null, payload.message.created_at);
      const insertFile = this.sqlite.prepare(`
        INSERT OR IGNORE INTO files(
          id,conversation_id,message_id,pending_prompt_id,composer_draft_id,original_name,
          relative_path,source_path,mime_type,size,sha256,kind,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const file of payload.files) insertFile.run(
        file.id, conversationId, file.message_id, file.pending_prompt_id ?? null, file.composer_draft_id ?? null,
        file.original_name, normalizeStoredRelativePath(file.relative_path), file.source_path ?? null,
        file.mime_type, file.size, file.sha256 ?? null, file.kind, file.created_at,
      );
      this.sqlite.prepare(`
        UPDATE jobs SET status='completed',error=NULL,finalization_state='db_committed',
          finalization_payload=?,finalization_error=NULL,updated_at=? WHERE id=?
      `).run(JSON.stringify(payload), now, id);
      this.sqlite.prepare(`
        UPDATE conversations
        SET status='idle',has_unread_result=1,unread_anchor_message_id=COALESCE(unread_anchor_message_id,?),
          last_active_at=CASE WHEN ?=1 THEN ? ELSE last_active_at END,updated_at=?
        WHERE id=?
      `).run(payload.message.id, payload.files.some((file) => file.kind === "output" && /^image\//i.test(file.mime_type)) ? 1 : 0, now, now, conversationId);
      this.bumpConversationSidebarOrder(conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  publishJobFinalization(id: string): void {
    const result = this.sqlite.prepare(`
      UPDATE jobs SET finalization_state='published',finalization_payload=NULL,finalization_error=NULL,updated_at=?
      WHERE id=? AND finalization_state IN ('db_committed','published')
    `).run(new Date().toISOString(), id);
    if (!result.changes && this.getJob(id)?.finalization_state !== "published") {
      throw new Error("Job finalization was not database-committed");
    }
  }

  failJobFinalization(id: string, message: string): void {
    this.sqlite.prepare("UPDATE jobs SET finalization_error=?,updated_at=? WHERE id=? AND finalization_state<>'published'")
      .run(message.slice(0, 2_000), new Date().toISOString(), id);
  }

  abandonJobFinalization(id: string, message: string): void {
    this.sqlite.prepare(`
      UPDATE jobs SET finalization_state='staging',finalization_payload=NULL,finalization_error=?,updated_at=?
      WHERE id=? AND finalization_state='staging'
    `).run(message.slice(0, 2_000), new Date().toISOString(), id);
  }

  listRecoverableJobFinalizations(): JobRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM jobs
      WHERE finalization_payload IS NOT NULL AND finalization_state IN ('staging','files_ready','db_committed')
      ORDER BY updated_at,id
    `).all() as JobRow[];
  }

  cancelQueuedJob(id: string): boolean {
    const result = this.sqlite.prepare(`
      UPDATE jobs
      SET status='cancelled',error='任务已停止',finalization_state='published',
        finalization_payload=NULL,finalization_error=NULL,updated_at=?
      WHERE id=? AND status='queued'
    `).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  finishJob(id: string, conversationId: string, status: Exclude<JobStatus, "queued" | "running">, error: string | null = null, assistantNotice?: string): void {
    const now = new Date().toISOString();
    const assistantNoticeId = assistantNotice ? crypto.randomUUID() : null;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        UPDATE jobs
        SET status=?,error=?,
          finalization_state=CASE
            WHEN finalization_state='published' OR (finalization_state='staging' AND finalization_payload IS NULL) THEN 'published'
            ELSE finalization_state
          END,
          finalization_payload=CASE WHEN finalization_state='published' THEN NULL ELSE finalization_payload END,
          finalization_error=CASE
            WHEN finalization_state='published' OR (finalization_state='staging' AND finalization_payload IS NULL) THEN NULL
            ELSE finalization_error
          END,
          updated_at=?
        WHERE id=? AND conversation_id=?
      `).run(status, error, now, id, conversationId);
      if (assistantNotice) this.sqlite.prepare(`
        INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at)
        VALUES(?,?,'assistant',?,NULL,?)
      `).run(assistantNoticeId, conversationId, assistantNotice, now);
      this.sqlite.prepare(`
        UPDATE conversations
        SET status='idle',
          has_unread_result=CASE WHEN ?='completed' OR ? IS NOT NULL THEN 1 ELSE has_unread_result END,
          unread_anchor_message_id=CASE
            WHEN ?='completed' OR ? IS NOT NULL THEN COALESCE(
              unread_anchor_message_id,
              ?,
              (
                SELECT assistant.id
                FROM messages assistant
                JOIN jobs job ON job.id=?
                JOIN messages user_message ON user_message.id=job.message_id
                WHERE assistant.conversation_id=? AND assistant.role='assistant'
                  AND (assistant.created_at>user_message.created_at OR (assistant.created_at=user_message.created_at AND assistant.id>user_message.id))
                ORDER BY assistant.created_at,assistant.id LIMIT 1
              )
            )
            ELSE unread_anchor_message_id
          END,
          updated_at=?
        WHERE id=?
      `).run(
        status, assistantNotice ?? null, status, assistantNotice ?? null,
        assistantNoticeId, id, conversationId, now, conversationId,
      );
      if (status === "completed" || assistantNotice) this.bumpConversationSidebarOrder(conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(jobId: string, eventType: string, payload: unknown): number {
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM job_events WHERE job_id=?").get(jobId) as { seq: number };
    const now = new Date().toISOString();
    this.sqlite.prepare("INSERT INTO job_events(job_id,seq,event_type,payload,created_at) VALUES(?,?,?,?,?)").run(jobId, row.seq, eventType, JSON.stringify(payload), now);
    this.sqlite.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(now, jobId);
    return row.seq;
  }

  listEvents(jobId: string, after = 0): JobEventRow[] {
    return this.sqlite.prepare("SELECT seq,event_type,payload,created_at FROM job_events WHERE job_id=? AND seq>? ORDER BY seq").all(jobId, after) as JobEventRow[];
  }

  listRecentEvents(jobId: string, limit: number): JobEventRow[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.sqlite.prepare(`
      SELECT seq,event_type,payload,created_at
      FROM (
        SELECT seq,event_type,payload,created_at
        FROM job_events
        WHERE job_id=?
        ORDER BY seq DESC
        LIMIT ?
      )
      ORDER BY seq
    `).all(jobId, boundedLimit) as JobEventRow[];
  }

  listRecentEventsWithRetainedUpdates(jobId: string, limit: number, retainedUpdateLimit: number): JobEventRow[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const boundedRetainedLimit = Math.max(0, Math.min(20, Math.floor(retainedUpdateLimit)));
    const recent = this.listRecentEvents(jobId, boundedLimit);
    if (boundedRetainedLimit === 0 || recent.length < boundedLimit) return recent;
    const oldestRecentSeq = recent[0]?.seq;
    if (oldestRecentSeq === undefined) return recent;
    const retained = this.sqlite.prepare(`
      SELECT seq,event_type,payload,created_at
      FROM job_events
      WHERE job_id=? AND seq<? AND json_valid(payload)
        AND json_extract(payload,'$.kind')='update'
      ORDER BY seq DESC
      LIMIT ?
    `).all(jobId, oldestRecentSeq, boundedRetainedLimit) as JobEventRow[];
    return [...retained.reverse(), ...recent];
  }

  hasJobEvent(jobId: string, eventType: string): boolean {
    return Boolean(this.sqlite.prepare("SELECT 1 AS found FROM job_events WHERE job_id=? AND event_type=? LIMIT 1").get(jobId, eventType));
  }

  createSession(tokenHash: string, csrfToken: string, expiresAt: string, userId = LEGACY_USER_ID): void {
    const now = new Date().toISOString();
    this.sqlite.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
    this.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)").run(tokenHash, userId, csrfToken, now, expiresAt);
  }

  getSession(tokenHash: string): SessionRow | undefined {
    return this.sqlite.prepare(`
      SELECT s.token_hash,s.csrf_token,s.expires_at,s.user_id,u.username,u.display_name,u.role
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'
    `).get(tokenHash, new Date().toISOString()) as SessionRow | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  }

  close(): void {
    this.sqlite.close();
  }
}

function safeJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function continuationConversationTitle(sourceTitle: string, triggeredAt: string): string {
  const suffix = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(triggeredAt)).replace(/\//g, "-").replace(/\s+/, " ");
  const base = sourceTitle.trim().replace(/ · \d{2}-\d{2} \d{2}:\d{2}$/, "") || "自动续跑";
  const marker = ` · ${suffix}`;
  return `${base.slice(0, Math.max(1, 80 - marker.length)).trimEnd()}${marker}`;
}
