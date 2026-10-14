import type { RecurringTask } from './recurring-types.js';
export type OpportunityTopic = {
  id: string; user_id: string; project_id: string; task_id: string | null; name: string; goal: string;
  questions: string; constraints: string; limit_count: number; exploration: number; read_recent: number;
  context_watermark: number; revision: number; archived_at: string | null; deleted_at: string | null;
  created_at: string; updated_at: string; task?: RecurringTask | null;
};
export type OpportunityEvidence = { title: string; url: string; date: string; finding: string };
export type OpportunityContent = {
  title: string; summary: string; audience: string; problem: string; mechanism: string; value: string;
  fit: string; facts: string; assumptions: string; doubt: string; validation: string; difference: string;
  interaction: string; loop: string; english: string; expansion: string; maturity: string;
  category: string; keywords: string[]; sources: OpportunityEvidence[];
};
export type OpportunityState = 'pending' | 'reserve' | 'recommended' | 'kept' | 'later' | 'dismissed' | 'internal_rejected' | 'expired' | 'project' | 'duplicate';
export type OpportunityIdea = {
  id: string; user_id: string; topic_id: string; content: OpportunityContent; state: OpportunityState;
  score: number | null; quality: number; review_reason: string; state_reason: string; rating: number | null; note: string;
  fingerprint: string; duplicate_of: string | null; first_created_at: string; last_reviewed_at: string | null;
  first_recommended_at: string | null; recommended_batch_id: string | null; source_batch_id: string;
  source_conversation_id: string; project_id: string; task_id: string | null; para_project_id: string | null;
  manual_processed: number; revision: number; updated_at: string;
};
export type OpportunityBatch = {
  id: string; user_id: string; topic_id: string; day: string; status: 'generating' | 'reviewing' | 'completed' | 'failed';
  conversation_id: string; job_id: string | null; project_id: string; task_id: string | null;
  attempts: number; context_watermark: number; feedback_snapshot: string; summary: string; error: string;
  created_at: string; completed_at: string | null;
};
export type OpportunityFeedback = { id: string; idea_id: string; action: string; reason: string; rating: number | null; note: string; actor: string; created_at: string; previous_json: string };
export type OpportunityPreference = { id: string; topic_id: string; text: string; kind: 'explicit' | 'inferred'; scope: 'topic' | 'project' | 'account'; source: string; active: number; created_at: string; updated_at: string };
export type OpportunityResearch = { id: string; idea_id: string; conversation_id: string; status: string; result: string; created_at: string; updated_at: string };
export type OpportunityDetail = { sourceBatch: OpportunityBatch; recommendedBatch: OpportunityBatch | null; availableConversations: string[]; idea: OpportunityIdea; feedback: OpportunityFeedback[]; versions: Array<{ id: string; reason: string; created_at: string; conversation_id: string; project_id?: string | null; content_json: string }>; research: OpportunityResearch[] };
export type OpportunityView = { topics: OpportunityTopic[]; ideas: OpportunityIdea[]; batches: OpportunityBatch[]; preferences: OpportunityPreference[]; total: number; nextOffset: number | null };
