export const DEPLOYMENT_STEP_LABELS = {
  stop_host: "停止宿主服务",
  database_backup: "备份数据库",
  file_backup: "复制恢复文件",
  backup_check: "校验备份",
  start_host: "启动宿主服务",
  container_switch: "切换应用容器",
} as const;
export type DeploymentStep = keyof typeof DEPLOYMENT_STEP_LABELS;
export type DeploymentStepStatus = {
  step: DeploymentStep;
  startedAt: string;
  finishedAt?: string;
  updatedAt?: string;
  outcome?: "completed" | "failed";
  completedUnits?: number;
  totalUnits?: number;
};
export type DeploymentBlocker = { jobId: string; title: string; executor: string; startedAt: string | null };

export function parseDeploymentSteps(input: unknown): DeploymentStepStatus[] {
  if (!Array.isArray(input)) return [];
  const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
  return input.slice(-16).flatMap((entry): DeploymentStepStatus[] => {
    if (!entry || typeof entry !== "object" || !Object.hasOwn(DEPLOYMENT_STEP_LABELS, entry.step) || !date(entry.startedAt)) return [];
    const result: DeploymentStepStatus = { step: entry.step, startedAt: entry.startedAt };
    if (date(entry.finishedAt)) result.finishedAt = entry.finishedAt;
    if (date(entry.updatedAt)) result.updatedAt = entry.updatedAt;
    if (entry.outcome === "completed" || entry.outcome === "failed") result.outcome = entry.outcome;
    if (Number.isSafeInteger(entry.completedUnits) && Number.isSafeInteger(entry.totalUnits)
      && entry.completedUnits >= 0 && entry.totalUnits > 0 && entry.completedUnits <= entry.totalUnits) {
      result.completedUnits = entry.completedUnits;
      result.totalUnits = entry.totalUnits;
    }
    return [result];
  });
}
