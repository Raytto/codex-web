import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, LoaderCircle, Monitor, Plus, RefreshCw, Server, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import { api, type CodexAccount, type CodexAccountLogin, type CodexAccountsState, type Executor } from "./api";

const SERVER_EXECUTOR_ID = "local-host";

export function CodexAccountDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<CodexAccountsState | null>(null);
  const [executors, setExecutors] = useState<Executor[]>([]);
  const [executorId, setExecutorId] = useState(SERVER_EXECUTOR_ID);
  const [login, setLogin] = useState<CodexAccountLogin | null>(null);
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (targetExecutorId: string) => {
    try {
      setError("");
      setState(await api.codexAccounts(targetExecutorId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "账号列表读取失败");
    }
  }, []);

  useEffect(() => {
    void api.executors().then(({ executors: available }) => {
      setExecutors(available.filter((executor) => executor.kind !== "tenant_container"));
      const initial = available.find((executor) => executor.id === SERVER_EXECUTOR_ID) ?? available[0];
      if (initial) { setExecutorId(initial.id); void load(initial.id); }
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "执行机器读取失败"));
    closeButton.current?.focus();
  }, [load]);

  useEffect(() => {
    if (!login || !["starting", "waiting_for_user"].includes(login.status)) return;
    const timer = window.setInterval(() => {
      void api.codexAccountLoginStatus(executorId, login.id).then(({ login: current }) => {
        setLogin(current);
        if (current.status === "succeeded") {
          setNotice(`${current.account?.label ?? "Codex 账号"} 已添加，可随时切换为全局账号。`);
          setAdding(false);
          void load(executorId);
        }
      }).catch((reason) => setError(reason instanceof Error ? reason.message : "登录状态读取失败"));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [executorId, load, login]);

  useEffect(() => {
    const changed = (event: Event) => {
      const target = (event as CustomEvent<{ executorId?: string }>).detail?.executorId;
      if (target === executorId) void load(executorId);
    };
    window.addEventListener("codex-web-executor-quota-changed", changed);
    return () => window.removeEventListener("codex-web-executor-quota-changed", changed);
  }, [executorId, load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function close() {
    if (login && ["starting", "waiting_for_user"].includes(login.status)) {
      try { await api.cancelCodexAccountLogin(executorId, login.id); } catch { /* Server expiry also cleans the isolated login home. */ }
    }
    onClose();
  }

  async function beginLogin() {
    setError("");
    setNotice("");
    setCopied(false);
    setBusyId("login");
    try {
      const result = await api.beginCodexAccountLogin(executorId, label.trim());
      setLogin(result.login);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录验证无法发起");
    } finally {
      setBusyId("");
    }
  }

  async function cancelLogin() {
    if (!login) return;
    setBusyId("cancel-login");
    try {
      setLogin((await api.cancelCodexAccountLogin(executorId, login.id)).login);
      setAdding(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录验证取消失败");
    } finally {
      setBusyId("");
    }
  }

  async function activate(account: CodexAccount) {
    if (account.active || !window.confirm(`确定把“${account.label}”切换为 ${selectedExecutor?.machineName ?? "当前机器"} 的 Codex 账号吗？\n\n之后启动的新任务会使用它；正在执行的任务存在时系统会安全拒绝切换。`)) return;
    setBusyId(account.id);
    setError("");
    setNotice("");
    try {
      setState(await api.activateCodexAccount(executorId, account.id));
      setNotice(`已切换到 ${account.label}，之后由当前机器启动的任务将使用此账号。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "账号切换失败");
    } finally {
      setBusyId("");
    }
  }

  async function remove(account: CodexAccount) {
    if (account.active || !window.confirm(`从 ${selectedExecutor?.machineName ?? "当前机器"} 删除“${account.label}”的登录凭据？\n\n此操作不会注销 ChatGPT 网站，也不会删除 OpenAI 账号。`)) return;
    setBusyId(account.id);
    setError("");
    setNotice("");
    try {
      setState(await api.deleteCodexAccount(executorId, account.id));
      setNotice(`${account.label} 已从 Codex Web 移除。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "账号删除失败");
    } finally {
      setBusyId("");
    }
  }

  async function copyCode() {
    if (!login?.userCode) return;
    try {
      await navigator.clipboard.writeText(login.userCode);
      setCopied(true);
    } catch {
      setError("复制失败，请长按验证码手动复制。");
    }
  }

  const loginActive = Boolean(login && ["starting", "waiting_for_user"].includes(login.status));
  const selectedExecutor = executors.find((executor) => executor.id === executorId) ?? null;
  const remote = selectedExecutor?.kind === "remote_worker";

  async function chooseExecutor(nextId: string) {
    if (nextId === executorId) return;
    if (loginActive && login) {
      try { await api.cancelCodexAccountLogin(executorId, login.id); } catch {}
    }
    setExecutorId(nextId); setState(null); setLogin(null); setAdding(false); setLabel(""); setError(""); setNotice("");
    void load(nextId);
  }

  return <div className="codex-account-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void close(); }}>
    <section className="codex-account-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-account-title">
      <header>
        <div><ShieldCheck size={20} /><div><h2 id="codex-account-title">Codex 账号管理</h2><p>选择机器并管理该机器使用的 Codex 账号</p></div></div>
        <button ref={closeButton} type="button" aria-label="关闭 Codex 账号管理" onClick={() => void close()}><X size={19} /></button>
      </header>

      <div className="codex-account-body">
        <label className="codex-account-executor">目标机器
          <select value={executorId} disabled={loginActive || Boolean(busyId)} onChange={(event) => void chooseExecutor(event.target.value)}>
            {executors.map((executor) => <option key={executor.id} value={executor.id} disabled={executor.status !== "online" || !executor.codexAccountManagementCapable}>
              {executor.machineName} · {executor.status === "online" ? executor.codexAccountManagementCapable ? "可管理" : "需升级 Worker" : "离线"}
            </option>)}
          </select>
        </label>
        {selectedExecutor && <div className="codex-account-machine">
          <span>{remote ? <Monitor size={18} /> : <Server size={18} />}</span>
          <div><strong>{selectedExecutor.machineName}</strong><small>{remote ? `Windows Remote Worker · ${selectedExecutor.status === "online" ? "在线" : "离线"}` : "Codex Web 服务器 · 在线"}</small></div>
          <em>{selectedExecutor.codexAccountManagementCapable ? "账号保存在本机" : "需要升级 Worker"}</em>
        </div>}
        <div className="codex-account-summary">
          <div><strong>{state?.accounts.length ?? "—"}</strong><span>已保存账号</span></div>
          <p><ShieldCheck size={15} />登录凭据仅保存在所选机器的受保护目录中，不会返回浏览器或传到其他机器。</p>
        </div>

        {error && <div className="codex-account-alert error" role="alert">{error}</div>}
        {notice && <div className="codex-account-alert success" role="status"><Check size={15} />{notice}</div>}

        <div className="codex-account-section-title"><div><strong>账号列表</strong><small>当前账号用于这台机器之后启动的 Codex Web 任务</small></div><button type="button" onClick={() => { setAdding(true); setLogin(null); setError(""); setNotice(""); }} disabled={loginActive || !selectedExecutor?.codexAccountManagementCapable}><Plus size={15} />新增账号</button></div>

        {!state && !error && <div className="codex-account-loading"><LoaderCircle className="spin" size={18} />正在读取账号…</div>}
        <div className="codex-account-list">
          {state?.accounts.map((account) => <article key={account.id} className={`codex-account-card ${account.active ? "active" : ""}`}>
            <span className="codex-account-avatar"><UserRound size={18} /></span>
            <div className="codex-account-copy">
              <div><strong>{account.label}</strong>{account.active && <span className="codex-account-active"><Check size={12} />当前机器使用中</span>}</div>
              <small>{account.email || "已验证的 ChatGPT 账号"} · {account.accountHint}</small>
              <small>{account.lastUsedAt ? `最近启用 ${formatDate(account.lastUsedAt)}` : `添加于 ${formatDate(account.createdAt)}`}</small>
              <div className="codex-account-quota">
                <span>剩余额度 {account.quotaRemainingPercent === null || account.quotaRemainingPercent === undefined ? "暂无数据" : `${Math.round(account.quotaRemainingPercent)}%`}</span>
                <span>重置时间 {account.quotaResetAt ? formatDate(account.quotaResetAt) : "暂无数据"}</span>
              </div>
            </div>
            <div className="codex-account-actions">
              {account.active
                ? <button type="button" className="primary active" disabled><Check size={14} />使用中</button>
                : <button type="button" className="primary" disabled={Boolean(busyId)} onClick={() => void activate(account)}>{busyId === account.id ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}切换</button>}
              <button type="button" className="danger" aria-label={`删除 ${account.label}`} title={account.active ? "请先切换到其他账号" : "删除账号"} disabled={account.active || Boolean(busyId)} onClick={() => void remove(account)}><Trash2 size={15} /></button>
            </div>
          </article>)}
        </div>

        {adding && <section className="codex-login-panel" aria-label="新增 Codex 账号">
          <div className="codex-login-heading"><div><strong>新增 Codex 账号</strong><small>使用设备码在你自己的浏览器中完成登录</small></div>{!loginActive && <button type="button" aria-label="收起新增账号" onClick={() => setAdding(false)}><X size={16} /></button>}</div>
          {!login && <>
            <label>账号备注（可选）<input value={label} maxLength={60} placeholder="例如：个人 Plus、公司账号" onChange={(event) => setLabel(event.target.value)} /></label>
            <button type="button" className="codex-login-start" disabled={busyId === "login"} onClick={() => void beginLogin()}>{busyId === "login" ? <LoaderCircle className="spin" size={16} /> : <ExternalLink size={16} />}生成登录验证链接</button>
          </>}
          {login && <div className="codex-login-flow">
            <ol>
              <li className={login.verificationUrl ? "done" : "current"}><span>1</span><div><strong>生成验证信息</strong><small>{login.verificationUrl ? "已准备" : "正在连接登录服务…"}</small></div></li>
              <li className={login.status === "succeeded" ? "done" : login.verificationUrl ? "current" : ""}><span>2</span><div><strong>在浏览器完成验证</strong><small>打开链接，登录目标 ChatGPT 账号并输入一次性代码</small></div></li>
              <li className={login.status === "succeeded" ? "done" : ""}><span>3</span><div><strong>目标机器自动确认并保存</strong><small>本页会自动更新，无需粘贴任何 token</small></div></li>
            </ol>
            {login.verificationUrl && login.userCode && login.status !== "succeeded" && <div className="codex-device-code">
              <div><small>一次性验证码</small><strong>{login.userCode}</strong></div>
              <button type="button" onClick={() => void copyCode()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "已复制" : "复制"}</button>
              <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">打开验证页面<ExternalLink size={14} /></a>
            </div>}
            {login.status === "succeeded" && <div className="codex-login-complete"><Check size={18} /><div><strong>账号验证完成</strong><small>{login.account?.label} 已安全保存，可在上方切换。</small></div></div>}
            {(login.status === "failed" || login.status === "cancelled") && <div className="codex-account-alert error">{login.error || "登录验证未完成"}</div>}
            <div className="codex-login-footer">
              {loginActive && <><span><LoaderCircle className="spin" size={14} />等待账号验证，链接约 15 分钟有效</span><button type="button" disabled={busyId === "cancel-login"} onClick={() => void cancelLogin()}>取消</button></>}
              {(login.status === "failed" || login.status === "cancelled") && <button type="button" onClick={() => setLogin(null)}>重新发起</button>}
            </div>
          </div>}
        </section>}

        <p className="codex-account-footnote">账号切换按机器隔离：服务器、COM、home 各自保管自己的登录。切换仅影响所选机器之后启动的任务；有任务运行时会安全拒绝。</p>
      </div>
    </section>
  </div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
