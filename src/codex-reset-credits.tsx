import type { CodexResetCredits } from "../remote-worker/src/codex-reset-credits.js";

export function CodexResetCreditDetails({ value, now = Date.now() }: { value?: CodexResetCredits | null; now?: number }) {
  if (!value || value.availableCount === null) {
    const status = value?.state === "auth_required" ? "登录状态待更新" : value?.state === "error" ? "查询失败，请刷新" : "暂无数据";
    return <div className="codex-account-reset-credits"><span>重置卡 {status}</span></div>;
  }
  const expired = value.earliestExpiresAt && Date.parse(value.earliestExpiresAt) <= now;
  const stale = value.state !== "ok" || !value.updatedAt || now - Date.parse(value.updatedAt) > 5 * 60_000 || expired;
  return <div className="codex-account-reset-credits">
    <span>{stale ? "上次查询重置卡剩余" : "重置卡剩余"} <strong>{value.availableCount} 次</strong></span>
    {value.availableCount > 0 && <span>{value.earliestExpiresAt
      ? `${value.expiryStatus === "complete" ? "最早到期" : "已知最早到期"} ${formatDate(value.earliestExpiresAt)}`
      : value.expiryStatus === "complete" ? "无到期限制" : "到期时间暂无数据"}</span>}
    {value.updatedAt && <small>更新于 {formatDate(value.updatedAt)}{value.state === "auth_required" ? " · 登录状态待更新" : value.state !== "ok" ? " · 暂未取得最新数据" : expired ? " · 已到期，请刷新" : stale ? " · 待刷新" : ""}</small>}
  </div>;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
