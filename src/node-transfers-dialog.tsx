import { useCallback, useEffect, useRef, useState } from "react";
import { X, RefreshCw } from "lucide-react";
import { request } from "./api";
type Node = { id: string; name: string; status: string; capable: boolean };
type Transfer = {
  id: string;
  state: string;
  outcome: string | null;
  source: { executorId: string; path: string };
  target: { executorId: string; path: string };
  bytes: number;
  size: number | null;
  actualRoute: string | null;
  committed: boolean;
  cleaned: { source: boolean; target: boolean };
  error: string | null;
};
const states: Record<string, string> = {
  queued: "排队中",
  connecting: "连接中",
  preparing: "正在读取源文件",
  transferring: "正在传输",
  paused: "等待重连",
  verifying: "正在校验",
  cleanup_pending: "正在清理临时数据",
  completed: "已完成 · 校验通过 · 临时数据已清理",
  failed: "传输失败 · 临时数据已清理",
  cancelled: "已取消 · 临时数据已清理",
};
const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(2)} GiB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MiB`
      : `${n} B`;
export function NodeTransfersDialog({ onClose }: { onClose: () => void }) {
  const [nodes, setNodes] = useState<Node[]>([]),
    [transfers, setTransfers] = useState<Transfer[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [source, setSource] = useState(""),
    [target, setTarget] = useState(""),
    [sourcePath, setSourcePath] = useState(""),
    [targetPath, setTargetPath] = useState("");
  const key = useRef(crypto.randomUUID());
  const dialog = useRef<HTMLElement>(null);
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        request<{ nodes: Node[] }>("/transfers/nodes"),
        request<{ transfers: Transfer[] }>("/transfers"),
      ]);
      setNodes(a.nodes);
      setTransfers(b.transfers);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      clearInterval(timer);
      previous?.focus();
    };
  }, [load]);
  async function create() {
    setBusy(true);
    setError("");
    try {
      await request("/transfers", {
        method: "POST",
        body: JSON.stringify({
          source: { executorId: source, path: sourcePath },
          target: { executorId: target, path: targetPath },
          idempotencyKey: key.current,
        }),
      });
      key.current = crypto.randomUUID();
      setSourcePath("");
      setTargetPath("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    setBusy(true);
    try {
      await request(`/transfers/${id}/cancel`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function change(f: () => void) {
    key.current = crypto.randomUUID();
    f();
  }
  const name = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  return (
    <div
      className="project-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="node-transfers-dialog ui-dialog"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-transfers-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const elements = [
              ...e.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),select:not(:disabled)",
              ),
            ];
            const first = elements[0],
              last = elements.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <div>
            <h2 id="node-transfers-title" className="dialog-title">
              节点文件传输
            </h2>
            <p className="dialog-description">
              由服务器统一管理；优先直连，必要时中继。源文件保留，传输临时数据自动清理。
            </p>
          </div>
          <button type="button" aria-label="关闭节点传输" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="node-transfers-body">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="node-transfers-pair">
              {(["source", "target"] as const).map((role) => (
                <fieldset key={role}>
                  <legend>{role === "source" ? "发送端" : "接收端"}</legend>
                  <label>
                    {role === "source" ? "源节点" : "目标节点"}
                    <select
                      required
                      value={role === "source" ? source : target}
                      onChange={(e) =>
                        change(() =>
                          role === "source"
                            ? setSource(e.target.value)
                            : setTarget(e.target.value),
                        )
                      }
                    >
                      <option value="">选择节点</option>
                      {nodes.map((n) => (
                        <option
                          key={n.id}
                          value={n.id}
                          disabled={!n.capable || n.status !== "online"}
                        >
                          {n.name}
                          {!n.capable
                            ? " · 需升级"
                            : n.status !== "online"
                              ? " · 离线"
                              : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {role === "source" ? "源文件完整路径" : "目标文件完整路径"}
                    <input
                      required
                      value={role === "source" ? sourcePath : targetPath}
                      onChange={(e) =>
                        change(() =>
                          role === "source"
                            ? setSourcePath(e.target.value)
                            : setTargetPath(e.target.value),
                        )
                      }
                      placeholder={
                        role === "source"
                          ? "输入文件路径"
                          : "输入含文件名的保存路径"
                      }
                    />
                  </label>
                </fieldset>
              ))}
            </div>
            <p className="dialog-description">
              目标文件夹须已存在；同名文件不会被覆盖。批量传输可交给 Agent
              使用节点互传技能创建任务。
            </p>
            <button
              className="primary-button"
              type="submit"
              disabled={
                busy ||
                !source ||
                !target ||
                source === target ||
                !sourcePath ||
                !targetPath
              }
            >
              开始传输
            </button>
          </form>
          <div className="node-transfers-list-heading">
            <h3 className="dialog-section-heading">传输任务</h3>
            <button type="button" disabled={busy} onClick={() => void load()}>
              <RefreshCw size={16} />
              刷新
            </button>
          </div>
          {error && (
            <p className="project-dialog-error" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p role="status">正在读取传输任务…</p>
          ) : !transfers.length ? (
            <p className="dialog-description">还没有传输任务。</p>
          ) : (
            transfers.map((t) => (
              <article key={t.id} className="node-transfer-row">
                <h4>
                  {name(t.source.executorId)} → {name(t.target.executorId)}
                </h4>
                <p role="status">{states[t.state] ?? t.state}</p>
                <p>
                  {t.actualRoute === "direct"
                    ? "节点直连"
                    : t.actualRoute === "relay"
                      ? "服务器中继 · 不保存中转文件"
                      : "等待选择连接方式"}{" "}
                  · {bytes(t.bytes)}
                  {t.size !== null ? ` / ${bytes(t.size)}` : ""}
                </p>
                <details>
                  <summary>文件与状态详情</summary>
                  <p>来源：{t.source.path}</p>
                  <p>目标：{t.target.path}</p>
                  <p>任务 ID：{t.id}</p>
                  <p>
                    目标文件：{t.committed ? "已提交" : "尚未提交"}；清理确认：
                    {Number(t.cleaned.source) + Number(t.cleaned.target)} / 2
                  </p>
                  {t.error && <p>最近原因：{t.error}</p>}
                </details>
                {!["completed", "failed", "cancelled"].includes(t.state) && (
                  <button
                    type="button"
                    disabled={busy || t.state === "cleanup_pending"}
                    onClick={() => void cancel(t.id)}
                  >
                    取消传输
                  </button>
                )}
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
