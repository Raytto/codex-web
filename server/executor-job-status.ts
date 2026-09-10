import { DatabaseSync } from "node:sqlite";

export const COUNT_RUNNING_JOBS_FOR_EXECUTOR_SQL = `
  SELECT count(*) AS value FROM jobs job
  JOIN conversations conversation ON conversation.id=job.conversation_id
  JOIN projects project ON project.id=conversation.project_id
  WHERE job.status='running' AND project.executor_id=?
`;

export function countRunningJobsForExecutorInDatabase(databasePath: string, executorId: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=10000");
    const row = database.prepare(COUNT_RUNNING_JOBS_FOR_EXECUTOR_SQL).get(executorId) as { value?: unknown } | undefined;
    const value = Number(row?.value);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid running Job count");
    return value;
  } finally {
    database.close();
  }
}
