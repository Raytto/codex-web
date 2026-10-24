import { useEffect, useState } from "react";
import { api } from "./api";
import type { AutoResetRecord } from "../server/codex-reset-auto-use.js";

const outcomes = { reset: "已使用重置卡", alreadyRedeemed: "已确认使用，未重复消费", nothingToReset: "当前无可重置额度", noCredit: "没有可用重置卡", notDue: "到期卡已变化或过期，已跳过" };
function resultText(record: AutoResetRecord): string {
  if (record.state === "completed" && record.outcome) return outcomes[record.outcome];
  return { pending: "正在确认", failed: "尚未确认，5 分钟后重试同一次操作", unconfirmed: "自动确认已停止，请核查账号", completed: "已完成" }[record.state];
}
export function CodexAutoResetHistory({ executorId }: { executorId: string }) {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.codexResetHistory>> | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () => void api.codexResetHistory(executorId).then(value => { if (active) { setState(value); setError(false); } }, () => { if (active) setError(true); });
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [executorId, refresh]);
  return <details className="codex-auto-reset-history">
    <summary>Codex 自动使用重置卡 · 记录</summary>
    <p className="dialog-description">每分钟检查已保存的 Codex 账号，在最早到期卡失效前一小时内使用。同一账号同一到期时间最多自动使用一张，多台机器不会重复使用。仅在机器在线、登录有效且到期信息完整时执行。</p>
    {state && <p className="dialog-description">{!state.enabled ? "自动检查尚未启用。" : !state.supported ? "此机器需升级 Worker 后才能自动使用。" : "自动检查已启用。"}</p>}
    <button type="button" className="codex-account-refresh" onClick={() => setRefresh(value => value + 1)}>刷新记录</button>
    {error ? <p role="alert">记录读取失败，请重试。</p> : !state ? <p role="status">正在读取记录…</p> : state.records.length === 0 ? <p className="dialog-description">暂无自动使用记录。</p> : <ul>
      {state.records.map(record => <li key={record.id}>
        <strong>{record.account_label} · {resultText(record)}</strong>
        <p className="dialog-description">{new Date(record.updated_at).toLocaleString()} · 已尝试 {record.attempts} 次</p>
        <p className="dialog-description">卡片到期：{new Date(record.expires_at).toLocaleString()}</p>
      </li>)}
    </ul>}
  </details>;
}
