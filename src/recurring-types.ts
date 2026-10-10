export type Recurrence = { kind: "interval" | "daily" | "weekly" | "monthly"; timeZone: string; time: string; intervalMinutes: number; weekdays: number[]; monthDay: number };
export type RecurringTask = { id: string; project_id: string; name: string; prompt: string; model: string; reasoningEffort: string; schedule: Recurrence; maxRuns: number | null; runCount: number; state: "active" | "paused" | "completed"; nextRunAt: string | null; revision: number; createdAt: string };
export type RecurringInput = Pick<RecurringTask, "name" | "prompt" | "model" | "reasoningEffort" | "schedule" | "maxRuns">;
export type RecurringRun = { id: string; scheduled_at: string; created_at: string; conversation_id: string | null; status: string; reason: string | null };
