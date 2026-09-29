import { useEffect, useState } from "react";
import type { DeploymentStatus } from "./api";
import { DEPLOYMENT_STEP_LABELS } from "../server/deployment-progress";

export function deploymentStepLabel(status: DeploymentStatus): string | null {
  const step = status.stepHistory?.at(-1);
  return status.phase === "promoting" && step && !step.finishedAt ? DEPLOYMENT_STEP_LABELS[step.step] : null;
}

function elapsed(start: string | null | undefined, end: number): string {
  if (!start || !Number.isFinite(Date.parse(start))) return "运行时间待确认";
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function DeploymentDetails({ status }: { status: DeploymentStatus }) {
  const [now, setNow] = useState(Date.now);
  const active = !["deployed", "failed", "deferred", "conflict", "superseded"].includes(status.phase);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return <div className="deployment-details">
    {status.stepHistory?.length ? <div className="deployment-substeps" aria-label="生产切换明细">
      {status.stepHistory.map((step, index) => <div className={`deployment-step-row ${step.outcome === "failed" ? "step-failed" : ""}`} key={`${step.step}-${index}`}>
        <div><strong>{DEPLOYMENT_STEP_LABELS[step.step]}</strong><small>{step.outcome === "failed" ? "失败 · " : step.finishedAt ? "完成 · " : "进行中 · "}{elapsed(step.startedAt, step.finishedAt ? Date.parse(step.finishedAt) : now)}</small></div>
        {step.step === "database_backup" && step.totalUnits !== undefined && step.completedUnits !== undefined && <div className="deployment-copy-progress">
          <progress max={step.totalUnits} value={step.completedUnits} aria-label="数据库页复制进度" />
          <small>{Math.floor(step.completedUnits / step.totalUnits * 100)}% · {step.completedUnits.toLocaleString()} / {step.totalUnits.toLocaleString()} 页</small>
        </div>}
      </div>)}
    </div> : null}
    {status.runningJobCount !== undefined && <div className="deployment-blockers">
      <strong>{status.phase === "waiting_for_jobs" ? "等待完成" : "切换前需等待"}：{status.runningJobCount} 个任务</strong>
      {(status.blockers ?? []).map((job) => <div key={job.jobId} className="deployment-blocker"><span>{job.title}</span><small>{job.executor} · {elapsed(job.startedAt, now)}</small></div>)}
      {status.runningJobCount > 0 && <p>当前任务会继续运行；等待时限由部署协调器配置，超时将延期发布。</p>}
    </div>}
  </div>;
}
