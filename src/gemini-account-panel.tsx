import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, LoaderCircle, RefreshCw, Trash2, UserRound } from "lucide-react";
import { api, type GeminiAccount, type GeminiAccountLogin, type GeminiAccountsState } from "./api";
import { AntigravityUsagePanel } from "./antigravity-usage-panel";

const pending = (login: GeminiAccountLogin | null) => Boolean(login && ["starting", "waiting"].includes(login.status));

export function useGeminiAccounts(executorId: string, onComplete: () => void) {
  const [state, setState] = useState<GeminiAccountsState | null>(null);
  const [login, setLogin] = useState<GeminiAccountLogin | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const activeLogin = useRef<{ executorId: string; login: GeminiAccountLogin } | null>(null);
  const completed = useRef(onComplete);
  completed.current = onComplete;

  const changed = useCallback(() => window.dispatchEvent(new CustomEvent("codex-web-models-changed", { detail: { executorId } })), [executorId]);
  const refresh = useCallback(async () => {
    const current = generation.current;
    setRefreshing(true);
    try {
      const result = await api.geminiAccounts(executorId);
      if (generation.current === current) { setState(result); setError(""); changed(); return result; }
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : "Gemini 账号读取失败");
    } finally {
      if (generation.current === current) setRefreshing(false);
    }
    return null;
  }, [executorId, changed]);

  useEffect(() => {
    generation.current += 1;
    setState(null); setLogin(null); setError(""); setNotice(""); setBusy("");
    void refresh();
    return () => {
      generation.current += 1;
      const active = activeLogin.current;
      activeLogin.current = null;
      if (active && pending(active.login)) void api.cancelGeminiAccountLogin(active.executorId, active.login.id).catch(() => undefined);
    };
  }, [executorId, refresh]);

  function receiveLogin(current: GeminiAccountLogin) {
    setLogin(current);
    activeLogin.current = pending(current) ? { executorId, login: current } : null;
    if (current.status === "completed") {
      const currentGeneration = generation.current;
      setNotice("Google 账号已保存，正在确认当前机器的启用状态…");
      void refresh().then((result) => {
        if (generation.current !== currentGeneration) return;
        const account = result?.accounts.find((item) => item.id === current.accountId);
        setNotice(account?.authenticated && account.active
          ? "Google 账号已登录并启用，正在刷新当前机器的可用模型。"
          : account?.authenticated
            ? "Google 账号已登录，但尚未启用。请在账号列表中启用后再选择 Antigravity 模型。"
            : "Google 账号已保存，请刷新账号状态确认是否已启用。");
      });
      completed.current();
    }
  }

  useEffect(() => {
    if (!pending(login)) return;
    const current = generation.current;
    let disposed = false;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void api.geminiAccountLoginStatus(executorId, login!.id).then(({ login: next }) => {
        if (!disposed && generation.current === current) { setError(""); receiveLogin(next); }
      }).catch((reason) => {
        if (!disposed && generation.current === current) setError(reason instanceof Error ? reason.message : "Google 登录状态读取失败");
      }).finally(() => { polling = false; });
    }, 1_500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [executorId, login, refresh, changed]);

  async function loginAction(action: string, request: () => Promise<{ login: GeminiAccountLogin }>) {
    if (busy) return;
    const current = generation.current;
    setBusy(action); setError(""); setNotice("");
    try {
      const result = await request();
      if (current === generation.current) receiveLogin(result.login);
      else if (pending(result.login)) void api.cancelGeminiAccountLogin(executorId, result.login.id).catch(() => undefined);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Google 登录操作失败");
    } finally {
      if (current === generation.current) setBusy("");
    }
  }

  async function cancel() {
    const active = activeLogin.current;
    if (!active) return;
    await loginAction("cancel", () => api.cancelGeminiAccountLogin(active.executorId, active.login.id));
  }

  async function accountAction(account: GeminiAccount, action: "activate" | "delete") {
    if (busy || pending(login)) return;
    const message = action === "activate"
      ? `将“${account.label}”用于当前机器之后启动的 Antigravity 任务？`
      : `从当前机器删除“${account.label}”的登录凭据？这不会删除 Google 账号。`;
    if (!window.confirm(message)) return;
    const current = generation.current;
    setBusy(`${action}:${account.id}`); setError(""); setNotice("");
    try {
      const result = action === "activate" ? await api.activateGeminiAccount(executorId, account.id) : await api.deleteGeminiAccount(executorId, account.id);
      if (current === generation.current) { setState(result); setNotice(action === "activate" ? "当前机器的 Gemini 账号已启用，正在刷新可用模型。" : "Google 账号凭据已移除。"); changed(); }
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Gemini 账号操作失败");
    } finally {
      if (current === generation.current) setBusy("");
    }
  }

  return {
    state, login, error, notice, busy, refreshing, executorId, active: pending(login), refresh, cancel,
    resetLogin: () => { if (!pending(login) && !busy) setLogin(null); },
    begin: (label: string) => loginAction("login", () => api.beginGeminiAccountLogin(executorId, label.trim())),
    submitCode: (code: string) => login ? loginAction("code", () => api.submitGeminiAccountLoginCode(executorId, login.id, code.trim())) : Promise.resolve(),
    activate: (account: GeminiAccount) => accountAction(account, "activate"),
    remove: (account: GeminiAccount) => accountAction(account, "delete"),
  };
}

type GeminiManagement = ReturnType<typeof useGeminiAccounts>;

function AccountUsage({ executorId, account }: { executorId: string; account: GeminiAccount }) {
  const [expanded, setExpanded] = useState(account.active);
  useEffect(() => { if (account.active) setExpanded(true); }, [account.active]);
  return <details className="antigravity-account-usage" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>额度与重置时间</summary>
    {expanded && <AntigravityUsagePanel executorId={executorId} accountId={account.id} />}
  </details>;
}

export function GeminiAccountList({ management, disabled }: { management: GeminiManagement; disabled: boolean }) {
  const { state, error, notice, busy, refreshing, active } = management;
  return <section aria-label="Gemini 账号">
    <div className="codex-account-section-title">
      <div><h3 className="dialog-section-heading">Gemini <span className="codex-account-count" aria-label={`已保存 ${state?.accounts.length ?? "—"} 个 Gemini 账号`}>{state?.accounts.length ?? "—"}</span></h3><p className="dialog-description">登录并启用 Google 账号后，按当前机器的可用权限显示 Antigravity 模型与思考深度</p></div>
      <div className="codex-account-toolbar"><button type="button" disabled={disabled || Boolean(busy) || refreshing || active} onClick={() => void management.refresh()}>{refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}刷新 Gemini 账号</button></div>
    </div>
    {error && <div className="codex-account-alert error" role="alert">{error}</div>}
    {notice && <div className="codex-account-alert success" role="status"><Check size={16} />{notice}</div>}
    {!state && !error && <div className="codex-account-loading"><LoaderCircle className="spin" size={18} />正在读取 Gemini 账号…</div>}
    {state && !state.runtimeAvailable && <p className="codex-account-empty">{state.loginAvailable ? "新增 Google 账号时会自动准备这台机器的 Gemini 服务。" : state.error || "这台机器暂未准备好 Gemini 登录服务。"}</p>}
    {state?.runtimeAvailable && state.error && <div className="codex-account-alert error" role="alert">{state.error}</div>}
    {state?.accounts.some((account) => account.authenticated) && !state.accounts.some((account) => account.authenticated && account.active) && <p className="codex-account-empty" role="status">Google 账号已登录，但当前机器尚未启用账号。点击“启用”后会读取可用模型和思考深度。</p>}
    <div className="codex-account-list">
      {state?.runtimeAvailable && state.accounts.length === 0 && <p className="codex-account-empty">尚未添加 Google 账号。新增账号时选择 Gemini，完成登录并启用后可选 Antigravity 模型。</p>}
      {state?.accounts.map((account) => <article key={account.id} className={`codex-account-card ${account.active ? "active" : ""}`}>
        <div className="codex-account-identity"><span className="codex-account-avatar"><UserRound size={20} /></span><div className="codex-account-copy">
          <div className="codex-account-name"><h4>{account.label}</h4>{account.active && <span className="codex-account-active"><Check size={14} />当前机器使用中</span>}</div>
          <p>{account.email || "Google 账号"} · {account.authenticated ? account.active ? "已登录" : "已登录 · 未启用" : state.error ? "状态待确认，请刷新" : "需要重新登录"}</p>
        </div></div>
        <AccountUsage key={`${management.executorId}:${account.id}`} executorId={management.executorId} account={account} />
        <div className="codex-account-actions">
          {account.active ? <span className="codex-account-current">新的 Antigravity 任务使用此账号</span> : <button type="button" className="primary" disabled={disabled || Boolean(busy) || active || !account.authenticated} onClick={() => void management.activate(account)}>{busy === `activate:${account.id}` ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{state.activeAccountId ? "切换" : "启用"}</button>}
          <button type="button" className="danger" aria-label={`删除 Gemini 账号 ${account.label}`} title={account.active ? "请先切换到其他 Gemini 账号" : "删除 Google 账号凭据"} disabled={disabled || account.active || Boolean(busy) || active} onClick={() => void management.remove(account)}><Trash2 size={16} /></button>
        </div>
      </article>)}
    </div>
  </section>;
}

export function GeminiLoginFlow({ management }: { management: GeminiManagement }) {
  const [code, setCode] = useState("");
  const { login, active, busy } = management;
  useEffect(() => setCode(""), [login?.id]);
  if (!login) return null;
  return <div className="codex-login-flow gemini-login-flow">
    <ol>
      <li className={login.verificationUrl ? "done" : "current"}><span>1</span><div><strong>生成 Google 登录链接</strong><small>{login.verificationUrl ? "已准备" : "正在连接登录服务…"}</small></div></li>
      <li className={login.status === "completed" ? "done" : login.verificationUrl ? "current" : ""}><span>2</span><div><strong>登录 Google 账号</strong><small>在官方页面选择用于 Gemini 的账号并完成授权</small></div></li>
      <li className={login.status === "completed" ? "done" : ""}><span>3</span><div><strong>保存到目标机器</strong><small>{login.requiresCode ? "把官方页面提供的一次性授权码粘贴到下方" : "本页自动确认并更新模型列表"}</small></div></li>
    </ol>
    {login.verificationUrl && active && <div className="codex-device-code gemini-login-link"><a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">打开 Google 登录页面<ExternalLink size={16} /></a></div>}
    {active && login.requiresCode && <form className="gemini-login-code" onSubmit={(event) => { event.preventDefault(); if (code.trim()) void management.submitCode(code).then(() => setCode("")); }}>
      <label>Google 一次性授权码<input autoComplete="off" spellCheck={false} type="password" value={code} onChange={(event) => setCode(event.target.value)} placeholder="粘贴授权页面提供的代码" disabled={Boolean(busy)} /></label>
      <button type="submit" className="codex-login-start" disabled={!code.trim() || Boolean(busy)}>{busy === "code" && <LoaderCircle className="spin" size={16} />}确认授权码</button>
    </form>}
    {login.message && <p className="dialog-description" role={login.status === "failed" ? "alert" : "status"}>{login.message}</p>}
    {login.status === "completed" && <div className="codex-login-complete"><Check size={18} /><strong>Google 账号验证完成</strong></div>}
    <div className="codex-login-footer">
      {active && <><span><LoaderCircle className="spin" size={16} />等待 Google 账号验证</span><button type="button" disabled={Boolean(busy)} onClick={() => void management.cancel()}>取消</button></>}
      {["failed", "cancelled"].includes(login.status) && <button type="button" disabled={Boolean(busy)} onClick={management.resetLogin}>重新发起</button>}
    </div>
  </div>;
}
