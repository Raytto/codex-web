import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge, LoaderCircle, RefreshCw } from "lucide-react";
import { api, type AntigravityUsage } from "./api";
import { quotaGroup, quotaRemaining, quotaReset, quotaTime, quotaWindow } from "./antigravity-usage-format";

/** Only mounted while its menu/account view is visible. Each node and account
 * gets a separate generation; a late response cannot leak into another view. */
export function AntigravityUsagePanel({ executorId, accountId, refreshKey = 0 }: { executorId: string; accountId?: string; refreshKey?: number }) {
  const key = `${executorId}:${accountId ?? "active"}`;
  const [snapshot, setSnapshot] = useState<{ key: string; value: AntigravityUsage } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0), pending = useRef(false);
  const refresh = useCallback(async (force = false) => {
    if (pending.current) return;
    const current = generation.current;
    pending.current = true; setLoading(true);
    try {
      const value = await api.geminiUsage(executorId, accountId, force);
      if (current === generation.current) { setSnapshot({ key, value }); setError(""); }
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Antigravity 用量查询失败，请稍后刷新。");
    } finally {
      if (current === generation.current) { pending.current = false; setLoading(false); }
    }
  }, [executorId, accountId, key]);

  useEffect(() => {
    generation.current++; pending.current = false; setSnapshot(null); setError("");
    void refresh(refreshKey > 0);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ executorId?: string }>).detail?.executorId !== executorId) return;
      generation.current++; pending.current = false; setSnapshot(null); void refresh();
    };
    const timer = window.setInterval(visible, 60_000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("codex-web-models-changed", changed);
    return () => { generation.current++; pending.current = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("codex-web-models-changed", changed); };
  }, [refresh, refreshKey, executorId]);

  const value = snapshot?.key === key ? snapshot.value : null;
  return <section className="antigravity-usage" aria-label="Antigravity 用量">
    <div className="antigravity-usage-heading"><span><Gauge size={15} />Antigravity 额度</span><button type="button" aria-label="刷新 Antigravity 用量" title="刷新用量" disabled={loading} onClick={() => void refresh(true)}>{loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button></div>
    {!value && !error && <p role="status">正在读取用量…</p>}
    {(error || value?.error) && <p className="antigravity-usage-error" role="status">{error || value?.error}{error && value ? " 以下为上次成功查询数据。" : ""}</p>}
    {value && value.state !== "unavailable" && <>
      {value.groups.map((group, index) => <div className="antigravity-usage-group" key={`${group.label}:${index}`}>
        <h4>{quotaGroup(group.label)}</h4>
        {group.buckets.map(bucket => <div className="antigravity-usage-bucket" key={bucket.id}>
          <div><span>{quotaWindow(bucket)}</span><strong aria-label={`${quotaGroup(group.label)} ${quotaWindow(bucket)} 剩余 ${quotaRemaining(bucket)}`}>剩余 {quotaRemaining(bucket)}</strong></div>
          <small title={bucket.resetAt ? `${new Date(bucket.resetAt).toLocaleString()}（本地时间）` : undefined}>{quotaReset(bucket.resetAt)}</small>
        </div>)}
      </div>)}
      {!value.groups.length && <p>服务暂未提供模型额度</p>}
      <div className="antigravity-usage-credits"><span>AI credits</span><strong>{value.remainingCredits === null ? "暂未提供" : `剩余 ${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value.remainingCredits)}`}</strong></div>
      <p className="antigravity-usage-timestamp">额度更新：{value.quotaUpdatedAt ? quotaTime(value.quotaUpdatedAt) : "暂无成功记录"}<br />Credits 更新：{value.creditsUpdatedAt ? quotaTime(value.creditsUpdatedAt) : "暂无成功记录"}<br />时间按本地时区显示</p>
    </>}
  </section>;
}
