import { useFeatureSelection } from "./feature-selection-context";
import {
  useEffect,
  useState,
  useRef,
  useCallback,
  type ReactNode,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { ParaSidebarProjects } from "./para-sidebar-projects";
import { ParaVoiceField, paraVoiceBusy, useParaVoiceInput } from "./para-voice-field";
import { ParaStageMenu, PARA_STAGES as STAGES } from "./para-stage-menu";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Plus,
  X,
  ArrowLeft,
  LayoutDashboard,
  Folder,
  Menu,
  ArrowRight,
  MessageSquare,
  Paperclip,
  Pause,
  Archive,
  Check,
  FileText,
  Link as LinkIcon,
  LoaderCircle,
  Download,
  Settings2,
  MoreHorizontal,
  RotateCcw,
  Pencil,
  GripVertical,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { para, newKey, type BoardData, type ParaLink } from "./para-api";
import { type Project, type Conversation } from "./api";
import type {
  ParaBoard,
  ParaSidebarProject,
  ParaProject,
  ParaResource,
  ParaDetail,
  ParaStage,
  ParaBrief,
  ParaConversation,
} from "../server/para-types";
import { FLOW, LifecycleForm, KanbanLimitSettings, KanbanAttention, projectAttention, actionTitle, type LifecycleAction } from "./kanban-lifecycle";
import type { KanbanSummary } from "../server/para-types";
import "./para.css";

const BRIEF: Record<keyof ParaBrief, string> = {
  goal: "目标",
  success: "完成标准",
  constraints: "约束",
  decisions: "已确认决定",
  questions: "待解决问题",
  next: "下一步",
};
const blankBrief: ParaBrief = {
  goal: "",
  success: "",
  constraints: "",
  decisions: "",
  questions: "",
  next: "",
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试。";
function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div className="para-error" role="alert">
      {error}
    </div>
  ) : null;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="para-empty">{children}</div>;
}
function Dialog({
  title,
  children,
  onClose,
  closeDisabled = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return createPortal(
    <dialog
      className={`para-dialog ${className}`}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !closeDisabled) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button type="button" onClick={onClose} disabled={closeDisabled} aria-label="关闭对话框">
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>,
    document.body,
  );
}
function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };
  return { busy, error, setError, run };
}
function useDraft(key: string) {
  const [value, set] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  const update = (v: string) => {
    set(v);
    try {
      if (v) localStorage.setItem(key, v);
      else localStorage.removeItem(key);
    } catch {
      /* Keep in-memory draft if storage is unavailable. */
    }
  };
  return [value, update] as const;
}
function EngineSelect({
  engines,
  value,
  onChange,
  inherit = "沿用默认工程",
  label = "默认工作工程",
}: {
  engines: Project[];
  value: string;
  onChange: (v: string) => void;
  inherit?: string;
  label?: string;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{inherit}</option>
        {value && !engines.some((e) => e.id === value) && (
          <option value={value}>原工程不可用，请重新选择</option>
        )}
        {engines.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} · {e.machine_name}
            {e.executor_status === "offline" ? "（离线）" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
export function NewProjectChoice({
  engines,
  onFolder,
  onBoard,
  onClose,
}: {
  engines: Project[];
  onFolder: () => void;
  onBoard: (b: ParaBoard) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<"folder" | "board">("board"),
    [name, setName] = useState(""),
    [engine, setEngine] = useState("");
  const action = useAction(),
    key = useRef(newKey());
  return (
    <Dialog
      title="新建项目"
      onClose={() => {
        if (!action.busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (type === "folder") {
            onFolder();
            return;
          }
          void action.run(async () => {
            const r = await para.createBoard({
              key: key.current,
              name,
              default_project_id: engine || null,
            });
            onBoard(r.board);
          });
        }}
      >
        <div className="para-type-options">
          <button
            type="button"
            className={type === "folder" ? "selected" : ""}
            onClick={() => setType("folder")}
          >
            <Folder />
            <strong>文件夹工程</strong>
            <span>在指定工作目录中创建会话、执行任务</span>
          </button>
          <button
            type="button"
            className={type === "board" ? "selected" : ""}
            onClick={() => setType("board")}
          >
            <LayoutDashboard />
            <strong>项目看板</strong>
            <span>从想法、推进到验收，管理项目完整生命周期</span>
          </button>
        </div>
        {type === "board" && (
          <>
            <label>
              看板名称
              <input
                autoFocus
                required
                maxLength={180}
                placeholder="例如：我的项目"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <EngineSelect
              engines={engines}
              value={engine}
              onChange={setEngine}
              inherit="稍后设置（发起会话时可选）"
            />
            <p className="para-hint">
              看板本身没有执行目录，每个项目可以单独指定工作工程。
            </p>
          </>
        )}
        <ErrorBox error={action.error} />
        <footer>
          <button type="button" onClick={onClose} disabled={action.busy}>
            取消
          </button>
          <button className="para-primary" disabled={action.busy}>
            {action.busy
              ? "正在创建…"
              : type === "folder"
                ? "选择目录"
                : "创建看板"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
function BoardRenameForm({ board, onClose }: { board: ParaBoard; onClose: () => void }) {
  const [name, setName] = useState(board.name);
  const action = useAction();
  return <Dialog title="改名看板" onClose={onClose} closeDisabled={action.busy}>
    <form onSubmit={(event) => {
      event.preventDefault();
      void action.run(async () => {
        await para.updateBoard(board.id, { revision: board.revision, name: name.trim() });
        onClose();
      });
    }}>
      <label>看板名称<input autoFocus required maxLength={180} value={name} onChange={(event) => setName(event.target.value)} disabled={action.busy} /></label>
      <ErrorBox error={action.error} />
      <footer><button type="button" onClick={onClose} disabled={action.busy}>取消</button><button className="para-primary" disabled={action.busy || !name.trim()}>保存名称</button></footer>
    </form>
  </Dialog>;
}
function BoardDeleteForm({ board, onClose, onDeleted }: { board: ParaBoard; onClose: () => void; onDeleted: () => void }) {
  const action = useAction();
  return <Dialog title="删除看板" onClose={onClose} closeDisabled={action.busy}>
    <form onSubmit={(event) => {
      event.preventDefault();
      void action.run(async () => { await para.deleteBoard(board.id, board.revision); onDeleted(); });
    }}>
      <p>确定删除“{board.name}”？删除后无法恢复。</p>
      <p className="para-hint">只能删除没有项目与资料的看板。非空看板可以保留归档，内容不会丢失。</p>
      <ErrorBox error={action.error} />
      <footer><button type="button" onClick={onClose} disabled={action.busy}>取消</button><button className="para-danger" disabled={action.busy}>确认删除</button></footer>
    </form>
  </Dialog>;
}
function SidebarProjectForm({ project, mode, onClose, onDeleted }: { project: ParaSidebarProject; mode: "rename" | "archive" | "delete"; onClose: () => void; onDeleted: () => void }) {
  const [title, setTitle] = useState(project.title);
  const action = useAction();
  const label = mode === "rename" ? "改名项目" : mode === "delete" ? "删除项目" : project.archived_at ? "恢复项目" : "归档项目";
  return <Dialog title={label} onClose={onClose} closeDisabled={action.busy}>
    <form onSubmit={(event) => {
      event.preventDefault();
      void action.run(async () => {
        if (mode === "delete") { await para.deleteProject(project.id, project.revision); onDeleted(); }
        else await para.updateProject(project.id, mode === "rename" ? { revision: project.revision, title: title.trim() } : { revision: project.revision, archived: !project.archived_at, confirm_running: true });
        onClose();
      });
    }}>
      {mode === "rename" ? <label>项目名称<input autoFocus required maxLength={180} value={title} onChange={(event) => setTitle(event.target.value)} disabled={action.busy} /></label>
        : <><p>确定{label.slice(0, 2)}“{project.title}”？</p><p className="para-hint">{mode === "delete" ? "项目简报和关联会被永久移除，已有会话和资料原件保留。此操作无法恢复。" : project.archived_at ? "恢复后，项目会重新出现在看板和侧栏。" : "归档后可随时恢复。已关联的运行会话和自动续跑会继续执行。"}</p></>}
      <ErrorBox error={action.error} />
      <footer><button type="button" onClick={onClose} disabled={action.busy}>取消</button><button className={mode === "delete" ? "para-danger" : "para-primary"} disabled={action.busy || (mode === "rename" && !title.trim())}>{mode === "rename" ? "保存名称" : mode === "delete" ? "确认删除" : label}</button></footer>
    </form>
  </Dialog>;
}
export function ParaSidebar({
  selected,
  selectedProject,
  query,
  accountId,
  onOpen,
  onCreate,
  onDeleted,
}: {
  selected: string | null;
  selectedProject: string | null;
  query: string;
  accountId: string;
  onOpen: (id: string, projectId?: string | null) => void;
  onCreate: () => void;
  onDeleted: (id: string) => void;
}) {
  const [boards, setBoards] = useState<ParaBoard[]>([]),
    [error, setError] = useState(""),
    [archives, setArchives] = useState(false),
    [menu, setMenu] = useState<{ id: string; top: number; left: number; anchorTop: number; project?: ParaSidebarProject } | null>(null),
    [renaming, setRenaming] = useState<ParaBoard | null>(null),
    [deleting, setDeleting] = useState<ParaBoard | null>(null),
    [dragging, setDragging] = useState<string | null>(null),
    [drop, setDrop] = useState<{ id: string; placement: "before" | "after" } | null>(null);
  const drag = useRef<{ source: string; target?: string; placement?: "before" | "after" } | null>(null);
  const [projectForm, setProjectForm] = useState<{ project: ParaSidebarProject; mode: "rename" | "archive" | "delete" } | null>(null);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const storageKey = `para-sidebar-expanded:${accountId}`;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "{}") ?? {}; } catch { return {}; }
  });
  const search = query.trim().slice(0, 180);
  const [searchCollapsed, setSearchCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => { setSearchCollapsed({}); setMenu(null); }, [search, archives]);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(expanded)); } catch { /* Expansion still works without storage. */ } }, [storageKey, expanded]);
  function toggle(id: string) {
    if (search) setSearchCollapsed((value) => ({ ...value, [id]: !value[id] }));
    else setExpanded((value) => ({ ...value, [id]: !value[id] }));
  }
  const refreshGeneration = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const action = useAction();
  const menuBoard = boards.find((board) => board.id === menu?.id);
  function openMenu(id: string, target: HTMLButtonElement, project?: ParaSidebarProject) {
    const anchor = target.getBoundingClientRect();
    menuTrigger.current = target;
    action.setError("");
    setMenu(menu?.id === id ? null : { id, top: Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - (project ? 194 : 156))), left: Math.max(8, Math.min(anchor.right - 176, window.innerWidth - 184)), anchorTop: anchor.top, project });
  }
  function moveBoard(source: string, target: string, placement: "before" | "after") {
    if (source === target) return;
    void action.run(async () => {
      const result = await para.reorderBoards(source, target, placement);
      if (!search) { refreshGeneration.current += 1; setBoards(result.boards.filter((b) => archives || !b.archived_at)); }
    });
  }
  function endDrag() {
    const moving = drag.current;
    drag.current = null;
    setDragging(null);
    setDrop(null);
    if (moving?.target && moving.placement) moveBoard(moving.source, moving.target, moving.placement);
  }
  function moveTouch(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag.current || event.pointerType === "mouse") return;
    event.preventDefault();
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".para-sidebar-row");
    const target = row?.dataset.boardId;
    if (target && target !== drag.current.source) {
      const rect = row!.getBoundingClientRect();
      const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      drag.current.target = target;
      drag.current.placement = placement;
      setDrop({ id: target, placement });
    } else { delete drag.current.target; setDrop(null); }
    const scroll = event.currentTarget.closest<HTMLElement>(".sidebar-content");
    if (scroll) {
      const rect = scroll.getBoundingClientRect();
      if (event.clientY < rect.top + 35) scroll.scrollTop -= 14;
      if (event.clientY > rect.bottom - 35) scroll.scrollTop += 14;
    }
  }
  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuTrigger.current?.contains(event.target as Node)) setMenu(null);
    };
    const closeEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { setMenu(null); menuTrigger.current?.focus(); }
    };
    const closeMoved = (event: Event) => {
      // A click can scroll its trigger into view before opening the menu; that
      // scroll event may arrive afterward. Close only if the anchor moved.
      const anchor = menuTrigger.current?.getBoundingClientRect();
      if (event.type === "resize" || !anchor || Math.abs(anchor.top - menu.anchorTop) > 1) setMenu(null);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    window.addEventListener("resize", closeMoved);
    window.addEventListener("scroll", closeMoved, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeEscape);
      window.removeEventListener("resize", closeMoved);
      window.removeEventListener("scroll", closeMoved, true);
    };
  }, [menu]);
  useEffect(() => {
    let live = true;
    const refresh = (event?: Event) => {
      const project = (event as CustomEvent<{ project?: ParaSidebarProject }> | undefined)?.detail?.project;
      if (project) setMenu((current) => current?.project?.id === project.id ? { ...current, project } : current);
      const generation = ++refreshGeneration.current;
      void para
        .sidebar(search, archives)
        .then((r) => {
          if (live && generation === refreshGeneration.current) {
            setBoards(r.boards);
            setLoadedQuery(search);
            setError("");
          }
        })
        .catch((e) => {
          if (live && generation === refreshGeneration.current) setError(message(e));
        });
    };
    setError("");
    const debounce = window.setTimeout(refresh, search ? 180 : 0);
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 15000);
    window.addEventListener("para-updated", refresh);
    return () => {
      live = false;
      window.clearTimeout(debounce);
      window.clearInterval(timer);
      window.removeEventListener("para-updated", refresh);
    };
  }, [search, archives, retry]);
  return (
    <section className="para-sidebar">
      <div className="section-label project-label">
        <span>项目看板</span>
        <button type="button" aria-label="看板操作" title="看板操作" aria-haspopup="menu" aria-expanded={menu?.id === "section"} onClick={(event) => openMenu("section", event.currentTarget)}>
          <MoreHorizontal size={15} />
        </button>
      </div>
      {loadedQuery !== search && !error && <div className="list-loading" role="status"><LoaderCircle className="spin" size={14} /><span>正在搜索…</span></div>}
      {loadedQuery === search && boards
        .map((b) => {
          const isExpanded = search ? !searchCollapsed[b.id] : Boolean(expanded[b.id]);
          return <div className="para-sidebar-board" key={b.id}>
          <div
            key={b.id}
            data-board-id={b.id}
            className={`para-sidebar-row ${selected === b.id && !selectedProject ? "selected" : ""} ${dragging === b.id ? "dragging" : ""} ${drop?.id === b.id ? `drop-${drop.placement}` : ""}`}
            draggable={!action.busy && !search}
            onDragStart={(event) => { drag.current = { source: b.id }; setDragging(b.id); setMenu(null); event.dataTransfer.setData("application/x-para-board", b.id); event.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(event) => {
              if (!drag.current || drag.current.source === b.id) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
              drag.current.target = b.id; drag.current.placement = placement;
              setDrop({ id: b.id, placement });
            }}
            onDrop={(event) => { if (drag.current) { event.preventDefault(); event.stopPropagation(); endDrag(); } }}
            onDragEnd={() => { drag.current = null; setDragging(null); setDrop(null); }}
          >
            <button type="button" className="para-board-grip" disabled={action.busy || Boolean(search)} aria-label={`拖动看板 ${b.name}`} title="拖动排序，也可用上下方向键调整"
              onPointerDown={(event) => {
                if (event.pointerType === "mouse" || action.busy || search) return;
                event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { source: b.id }; setDragging(b.id); setMenu(null);
              }} onPointerMove={moveTouch}
              onPointerUp={(event) => { if (event.pointerType !== "mouse" && drag.current) { event.preventDefault(); endDrag(); } }}
              onPointerCancel={() => { drag.current = null; setDragging(null); setDrop(null); }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const visible = boards.filter((board) => archives || !board.archived_at);
                const index = visible.findIndex((board) => board.id === b.id);
                const target = visible[index + (event.key === "ArrowUp" ? -1 : 1)];
                if (target) moveBoard(b.id, target.id, event.key === "ArrowUp" ? "before" : "after");
              }}><GripVertical size={12} /></button>
            <button type="button" className="para-sidebar-item" aria-expanded={isExpanded} onClick={() => { setMenu(null); toggle(b.id); onOpen(b.id); }}>
              <LayoutDashboard size={17} /><span>{b.name}</span>{b.archived_at && <Archive size={13} aria-label="已归档" />}
            </button>
            <button type="button" className="para-sidebar-toggle" aria-label={`${isExpanded ? "收起" : "展开"}看板 ${b.name}`} aria-expanded={isExpanded} onClick={() => toggle(b.id)}><ChevronDown size={14} /></button>
            <button type="button" className="para-sidebar-more" aria-label={`看板 ${b.name} 操作`} title="看板操作"
              aria-haspopup="menu" aria-expanded={menu?.id === b.id} disabled={action.busy}
              onClick={(event) => openMenu(b.id, event.currentTarget)}><MoreHorizontal size={16} /></button>
          </div>
          {isExpanded && <ParaSidebarProjects boardId={b.id} query={search} archives={archives} selected={selected === b.id ? selectedProject : null} disabled={Boolean(b.archived_at)} menuProjectId={menu?.project?.id ?? null}
            onOpen={(id) => onOpen(b.id, id)} onMenu={(p, target) => openMenu(`project:${p.id}`, target, p)} />}
          </div>;
        })}
      {loadedQuery === search && !boards.length && search && !error && <div className="project-empty">没有匹配看板或项目</div>}
      {loadedQuery === search && !boards.length && !search && !error && (
        <button className="para-sidebar-empty" onClick={onCreate}>
          从一个想法开始
        </button>
      )}
      {(
        <button
          className="para-sidebar-empty"
          onClick={() => setArchives(!archives)}
        >
          {archives ? "隐藏归档看板与项目" : "查看归档看板与项目"}
        </button>
      )}
      {error && <div className="para-sidebar-load-error" role="alert">{error}<button onClick={() => setRetry((n) => n + 1)}>重试</button></div>}
      {action.error && <small role="alert">{action.error}</small>}
      {menu && (menuBoard || menu.project || menu.id === "section") && createPortal(<div ref={menuRef} className="project-menu-panel para-board-menu" role="menu"
        aria-label={menu.project ? `看板内项目 ${menu.project.title} 操作` : menuBoard ? `看板 ${menuBoard.name} 操作` : "看板操作"} style={{ top: menu.top, left: menu.left }}
        onKeyDown={(event) => {
          if (event.key === "Tab") setMenu(null);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }
        }}>
        {menu.project ? <>
          <button type="button" role="menuitem" onClick={() => { onOpen(menu.project!.board_id, menu.project!.id); setMenu(null); }}><ArrowRight size={16} /><span>打开项目</span></button>
          <button type="button" role="menuitem" onClick={() => { setProjectForm({ project: menu.project!, mode: "rename" }); setMenu(null); }}><Pencil size={16} /><span>改名</span></button>
          <button type="button" role="menuitem" onClick={() => { setProjectForm({ project: menu.project!, mode: "archive" }); setMenu(null); }}>{menu.project.archived_at ? <RotateCcw size={16} /> : <Archive size={16} />}<span>{menu.project.archived_at ? "恢复项目" : "归档项目"}</span></button>
          {menu.project.archived_at && <button type="button" role="menuitem" className="danger" onClick={() => { setProjectForm({ project: menu.project!, mode: "delete" }); setMenu(null); }}><Trash2 size={16} /><span>删除项目</span></button>}
        </> : menuBoard ? <>
        <button type="button" role="menuitem" disabled={action.busy} onClick={() => { setRenaming(menuBoard); setMenu(null); }}><Pencil size={16} /><span>改名</span></button>
        <button type="button" role="menuitem" className={menuBoard.archived_at ? undefined : "danger"} disabled={action.busy}
          onClick={() => void action.run(async () => {
            await para.updateBoard(menuBoard.id, { revision: menuBoard.revision, archived: !menuBoard.archived_at });
            setMenu(null);
          })}>{menuBoard.archived_at ? <RotateCcw size={16} /> : <Archive size={16} />}<span>{menuBoard.archived_at ? "恢复看板" : "归档看板"}</span></button>
        {menuBoard.archived_at && <button type="button" role="menuitem" className="danger" onClick={() => { setDeleting(menuBoard); setMenu(null); }}><Trash2 size={16} /><span>删除看板</span></button>}
        </> : <button type="button" role="menuitem" onClick={() => { setMenu(null); onCreate(); }}><Plus size={16} /><span>新建看板</span></button>}
      </div>, document.body)}
      {projectForm && <SidebarProjectForm {...projectForm} onClose={() => setProjectForm(null)} onDeleted={() => { if (selectedProject === projectForm.project.id) onOpen(projectForm.project.board_id); }} />}
      {renaming && <BoardRenameForm board={renaming} onClose={() => setRenaming(null)} />}
      {deleting && <BoardDeleteForm board={deleting} onClose={() => setDeleting(null)} onDeleted={() => { onDeleted(deleting.id); setDeleting(null); }} />}
    </section>
  );
}
export function ParaWorkspace({
  boardId,
  openProjectId,
  navigationKey,
  onNavigate,
  visible,
  accountId,
  engines,
  onMenu,
  onOpenConversation,
}: {
  boardId: string;
  openProjectId: string | null;
  navigationKey: number;
  onNavigate: (b: string, p: string | null) => void;
  visible: boolean;
  accountId: string;
  engines: Project[];
  onMenu: () => void;
  onOpenConversation: (id: string, engineId: string) => void;
}) {
  const [summary, setSummary] = useState<KanbanSummary | null>(null);
  const [attentionFilter, setAttentionFilter] = useState("attention");
  const [transitionBusy, setTransitionBusy] = useState(false);
  const [transition, setTransition] = useState<{ project: ParaProject; action: LifecycleAction; position?: number } | null>(null);
  const [data, setData] = useState<BoardData | null>(null),
    [detail, setDetail] = useState<ParaDetail | null>(null),
    [pid, setPid] = useState<string | null>(openProjectId),
    [tab, setTab] = useState("projects"),
    [detailTab, setDetailTab] = useState("overview");
  const [stage, setStage] = useState("all"),
    [sort, setSort] = useState("manual"),
    [view, setView] = useState("board");
  const [modal, setModal] = useState<
      "idea" | "edit" | "resource" | "link" | "new" | "settings" | null
    >(null),
    [addStage, setAddStage] = useState<ParaStage>("idea"),
    [template, setTemplate] = useState(""),
    [resource, setResource] = useState<ParaResource | null>(null);
  const [notice, setNotice] = useState(""),
    [undo, setUndo] = useState<{
      id: string;
      revision: number;
      stage: ParaStage;
      outcome: string;
    } | null>(null);
  const action = useAction(),
    scroll = useRef<HTMLDivElement>(null),
    listScroll = useRef(0),
    dragged = useRef<ParaProject | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 10000);
    return () => window.clearTimeout(timer);
  }, [undo]);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    const [b, d, overview] = await Promise.all([
      para.board(boardId),
      pid ? para.project(pid) : Promise.resolve(null),
      para.summary(),
    ]);
    if (gen === generation.current) {
      setData(b);
      setDetail(d);
      setSummary(overview);
    }
  }, [boardId, pid, navigationKey]);
  useEffect(() => {
    void refresh().catch((e) => action.setError(message(e)));
  }, [refresh]);
  useEffect(() => {
    if (!visible) return;
    const reload = () => {
      void refresh().catch(() => {});
    };
    window.addEventListener("para-updated", reload);
    const timer = window.setInterval(reload, 15000);
    return () => {
      window.removeEventListener("para-updated", reload);
      window.clearInterval(timer);
    };
  }, [visible, refresh]);
  useEffect(() => {
    setPid(openProjectId);
    setDetail(null);
    setDetailTab("overview");
  }, [navigationKey]);
  function open(p: ParaProject) {
    listScroll.current = scroll.current?.scrollTop ?? 0;
    setPid(p.id);
    onNavigate(boardId, p.id);
    setDetailTab("overview");
    if (scroll.current) scroll.current.scrollTop = 0;
  }
  function back() {
    onNavigate(boardId, null);
    setPid(null);
    setDetail(null);
    requestAnimationFrame(() => {
      if (scroll.current) scroll.current.scrollTop = listScroll.current;
    });
  }
  function acceptProject(project: ParaProject) {
    // A write receipt is immediately authoritative. Discard reads started
    // before it so the next action cannot submit an already stale revision.
    generation.current++;
    setUndo(previous => previous?.id === project.id && previous.revision !== project.revision ? null : previous);
    setDetail((d) =>
      d?.project.id === project.id ? { ...d, project } : d,
    );
    setData((b) =>
      b
        ? {
            ...b,
            projects: b.projects
              .map((p) => (p.id === project.id ? project : p))
              .filter((p) => p.board_id === b.board.id),
          }
        : b,
    );
  }
  async function patch(p: ParaProject, change: Record<string, unknown>) {
    if (change.stage && change.stage !== p.stage) {
      const stage = change.stage as ParaStage;
      if (["active", "review", "done", "stopped"].includes(stage)) {
        setTransition({ project: p, action: stage, position: typeof change.position === "number" ? change.position : undefined });
        return;
      }
    }
    const result = await para.updateProject(p.id, {
      revision: p.revision,
      ...change,
    });
    acceptProject(result.project);
    if (change.stage)
      setUndo({ id: p.id, revision: result.project.revision, stage: p.stage, outcome: p.outcome });
    await refresh();
  }
  function addIdea(s: ParaStage) {
    setAddStage(s);
    setModal("idea");
  }
  function newChat(prompt: string) {
    setTemplate(prompt);
    setModal("new");
  }
  function renderCards(items: ParaProject[]) {
    return items.map((p) => (
      <article
        key={p.id}
        className={`para-card stage-${p.stage}`}
        data-project-id={p.id}
        draggable={!p.archived_at && !action.busy}
        onDragStart={(e) => {
          dragged.current = p;
          e.dataTransfer.setData("text/plain", p.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          dragged.current = null;
        }}
        onDragOver={(e) => {
          if (sort === "manual" && dragged.current) e.preventDefault();
        }}
        onDrop={(e) => {
          if (sort !== "manual") return;
          e.preventDefault();
          e.stopPropagation();
          const source = dragged.current;
          dragged.current = null;
          if (source && source.id !== p.id)
            void action.run(() =>
              patch(source, { stage: p.stage, position: p.position - 0.5 }),
            );
        }}
      >
        <div className="para-card-header">
          <ParaStageMenu label={`${p.title} 的阶段`} value={p.stage} disabled={action.busy}
            onChange={(stage) => void action.run(() => patch(p, { stage }))} />
          {p.archived_at && <button disabled={action.busy} onClick={() => void action.run(() => patch(p, { archived: false }))}>恢复</button>}
        </div>
        <button className="para-card-body" onClick={() => open(p)}>
          <h3>{p.title}</h3>
          {(p.paused || p.waiting_for || (p.stage === "incubating" && p.ready) || p.review_on) && !["done", "stopped"].includes(p.stage) && <span className="para-card-eyebrow">
            {Boolean(p.paused) && <span>已暂停</span>}
            {Boolean(p.waiting_for) && <span>等待中</span>}
            {p.stage === "incubating" && Boolean(p.ready) && <span>已就绪</span>}
            {p.review_on && <span>回顾 {p.review_on}</span>}
          </span>}
          {(p.outcome || p.waiting_for || (p.paused && p.hold_reason) || p.brief.next || p.brief.goal) && <p>
            {["done", "stopped"].includes(p.stage) ? p.outcome : p.waiting_for ? `等待：${p.waiting_for}` : p.paused && p.hold_reason ? `暂停：${p.hold_reason}` : p.brief.next
              ? `下一步：${p.brief.next}`
              : p.brief.goal}
          </p>}
          {Boolean(p.resource_count || p.conversation_count) && <span className="para-card-count">
            {Boolean(p.resource_count) && <span>
              <Paperclip size={13} />
              {p.resource_count ?? 0} 份资料
            </span>}
            {Boolean(p.conversation_count) && <span>
              <MessageSquare size={13} />
              {p.conversation_count ?? 0} 个会话
            </span>}
          </span>}
          {Boolean(p.unread_count || p.running_count) && (
            <span className="para-activity">
              {p.running_count
                ? `${p.running_count} 个会话运行中`
                : `${p.unread_count} 条新回复`}
            </span>
          )}
        </button>
      </article>
    ));
  }
  if (!data)
    return (
      <main
        className={`workspace para-workspace ${!visible ? "para-hidden" : ""}`}
      >
        <button onClick={onMenu} className="mobile-only">
          打开侧栏
        </button>
        <ErrorBox error={action.error} />
        <Empty>
          {action.error ? <><span>暂时无法打开这个看板。</span><button onClick={() => { action.setError(""); void refresh().catch(e => action.setError(message(e))); }}>重新加载</button>{pid && <button onClick={back}>返回看板</button>}</> : <><LoaderCircle className="spin" />正在加载看板…</>}
        </Empty>
      </main>
    );
  const current = detail?.project,
    shown = data.projects
      .filter(
        (p) =>
          !p.archived_at &&
          (stage === "all" ? p.stage !== "stopped" : p.stage === stage),
      )
      .sort((a, b) =>
        sort === "updated"
          ? b.updated_at.localeCompare(a.updated_at)
          : a.position - b.position,
      );
  const hasFilters = stage !== "all";
  const clearFilters = () => setStage("all");
  return (
    <main
      className={`workspace para-workspace ${!visible ? "para-hidden" : ""}`}
    >
      <header className="para-header">
        <div>
          <button
            className="mobile-only"
            onClick={onMenu}
            aria-label="打开侧栏"
          >
            <Menu size={20} />
          </button>
          {pid ? (
            <button onClick={back}>
              <ArrowLeft size={18} />
              <span>{data.board.name}</span>
            </button>
          ) : (
            <span className="para-kicker">
              <LayoutDashboard size={18} />
              项目看板
            </span>
          )}
        </div>
        <button onClick={() => setModal("settings")} aria-label="看板设置">
          <Settings2 size={19} />
        </button>
      </header>
      <div className={`para-scroll ${!pid ? "para-board-scroll" : ""}`} ref={scroll}>
        <ErrorBox error={action.error} />
        {notice && (
          <div className="para-notice" role="status">
            {notice}
            <button onClick={() => setNotice("")}>关闭</button>
          </div>
        )}
        {undo && (
          <div className="para-notice" role="status">
            阶段已保存
            <button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const result = await para.updateProject(undo.id, {
                    revision: undo.revision,
                    stage: undo.stage,
                    outcome: undo.outcome,
                  });
                  acceptProject(result.project);
                  setUndo(null);
                  await refresh();
                })
              }
            >
              撤销
            </button>
            <button onClick={() => setUndo(null)} aria-label="关闭撤销提示">
              <X size={14} />
            </button>
          </div>
        )}
        {pid && current ? (
          <>
            <div className="para-title-row">
              <div>
                <span className="para-kicker">项目档案</span>
                <h1>{current.title}</h1>
                <p>
                  {projectAttention(current)} · 默认工程：
                  {engines.find(
                    (e) =>
                      e.id ===
                      (current.default_project_id ??
                        data.board.default_project_id),
                  )?.name ||
                    (current.default_project_id || data.board.default_project_id
                      ? "原工程不可用"
                      : "沿用账号默认")}
                </p>
              </div>
              <div className="para-actions">
                <ParaStageMenu label="项目阶段" value={current.stage} disabled={action.busy}
                  onChange={(stage) => void action.run(() => patch(current, { stage }))} />
                <button disabled={action.busy} onClick={() => setModal("edit")}>
                  编辑项目
                </button>
              </div>
            </div>
            {current.archived_at && (
              <div className="para-notice">
                项目已归档。关联会话仍保持原来的状态。
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() => patch(current, { archived: false }))
                  }
                >
                  恢复项目
                </button>
              </div>
            )}
            {data.board.archived_at && <div className="para-notice">所属看板已归档，请先恢复再继续推进。<button disabled={action.busy} onClick={() => void action.run(async () => { await para.updateBoard(boardId, { revision: data.board.revision, archived: false }); await refresh(); })}>恢复所属看板</button></div>}
            <section className="kanban-project-focus" aria-label="项目推进状态" aria-busy={action.busy}>
              <ol className="kanban-steps">{FLOW.map(s => <li key={s} className={current.stage === s ? "current" : ""} aria-current={current.stage === s ? "step" : undefined}>{STAGES[s]}</li>)}</ol>
              {current.stage === "stopped" ? <h2>已终止：{current.outcome}</h2> : current.stage === "done" ? <h2>验收结论：{current.outcome || "已完成"}</h2> : <>
                <span className="para-kicker">{current.waiting_for ? "当前等待" : current.paused ? "暂时停一停" : current.stage === "review" ? "待我验收" : "当前下一步"}</span>
                <h2>{current.waiting_for || (current.paused ? current.hold_reason : current.brief.next) || "写下接下来能执行的一件事"}</h2>
              </>}
              {current.stage === "review" && <><p>完成标准：{current.brief.success || "尚未填写"}</p><p className="kanban-evidence">{current.acceptance || "补充成果入口、已验证项和未验证项，让验收有据可查。"}</p><button disabled={action.busy} onClick={() => setTransition({ project: current, action: "review" })}>编辑验收说明</button><button disabled={action.busy} onClick={() => setDetailTab("outputs")}>查看成果 · {detail.resources.filter(r => r.is_output && !r.archived_at).length}</button></>}
              {current.review_on && <p>下次回顾：{current.review_on}</p>}
              {current.effort && <p>投入边界：{current.effort}</p>}
              {(current.started_at || current.ended_at || current.reviewed_at) && <p className="para-hint">{current.started_at && `开始于 ${new Date(current.started_at).toLocaleDateString("zh-CN")} · `}{current.ended_at ? `结束于 ${new Date(current.ended_at).toLocaleDateString("zh-CN")}` : current.reviewed_at ? `最近回顾 ${new Date(current.reviewed_at).toLocaleDateString("zh-CN")}` : "尚未结束"}</p>}
              <div className="para-actions">
                {!current.archived_at && !data.board.archived_at && <>
                  {current.stage === "idea" && <button disabled={action.busy} className="para-primary" onClick={() => void action.run(() => patch(current, { stage: "incubating" }))}>开始准备</button>}
                  {current.stage === "incubating" && <><button disabled={action.busy} className="para-primary" onClick={() => setTransition({ project: current, action: "active" })}>开始推进</button><button disabled={action.busy} onClick={() => void action.run(() => patch(current, { ready: !current.ready }))}>{current.ready ? "已准备好 ✓" : "标记准备就绪"}</button></>}
                  {current.stage === "active" && !current.waiting_for && !current.paused && <><button disabled={action.busy} className="para-primary" onClick={() => newChat(current.brief.next || "根据项目简报与选定资料，明确并推进下一步。")}>推进下一步</button><button disabled={action.busy} onClick={() => setTransition({ project: current, action: "review" })}>提交验收</button></>}
                  {current.stage === "review" && <><button disabled={action.busy} className="para-primary" onClick={() => setTransition({ project: current, action: "done" })}>确认完成</button><button disabled={action.busy} onClick={() => setTransition({ project: current, action: "active" })}>退回修改</button></>}
                  {["done", "stopped"].includes(current.stage) ? <><button disabled={action.busy} onClick={() => void action.run(() => patch(current, { stage: "incubating" }))}>重新打开</button><button disabled={action.busy} onClick={() => setTransition({ project: current, action: current.stage })}>补充结论</button></> : <>
                    {Boolean(current.waiting_for) && <button disabled={action.busy} onClick={() => void action.run(() => patch(current, { waiting_for: "" }))}>解除等待</button>}
                    {Boolean(current.paused) && <button disabled={action.busy} onClick={() => void action.run(() => patch(current, { paused: false }))}>恢复推进</button>}
                    <button disabled={action.busy} onClick={() => setTransition({ project: current, action: "recap" })}>回顾 / 更新下一步</button>
                  </>}
                </>}
              </div>
              {action.busy && <p className="para-hint" role="status">正在保存项目…</p>}
            </section>
            <nav className="para-tabs" aria-label="项目内容">
              {[
                ["overview", "概览"],
                ["resources", `资料 ${detail.resources.length}`],
                ["conversations", `会话 ${detail.conversations.length}`],
                [
                  "outputs",
                  `成果 ${detail.resources.filter((r) => r.is_output).length}`,
                ],
                ["history", "记录"],
              ].map(([v, n]) => (
                <button
                  key={v}
                  className={detailTab === v ? "active" : ""}
                  onClick={() => setDetailTab(v)}
                >
                  {n}
                </button>
              ))}
            </nav>
            {detailTab === "overview" && (
              <div className="para-detail-grid">
                <div>
                  <section className="para-panel">
                    <div className="para-section-title">
                      <h2>项目简报</h2>
                      <button
                        disabled={action.busy}
                        onClick={() => setModal("edit")}
                      >
                        编辑 · v{current.revision}
                      </button>
                    </div>
                    {(Object.keys(BRIEF) as (keyof ParaBrief)[])
                      .filter((k) => k !== "next")
                      .map((k) => (
                        <div className="para-brief-field" key={k}>
                          <h3>{BRIEF[k]}</h3>
                          <p>{current.brief[k] || "待补充"}</p>
                        </div>
                      ))}
                  </section>
                  <section className="para-next">
                    <span>下一步</span>
                    <h2>{current.brief.next || "想清楚接下来要做的一件事"}</h2>
                    <button
                      onClick={() =>
                        newChat(
                          "根据项目简报和选定资料，帮我确定范围，列出需要决定的问题，并整理下一步。",
                        )
                      }
                    >
                      帮我理清下一步
                      <ArrowRight size={16} />
                    </button>
                  </section>
                  <ConversationRows
                    rows={detail.conversations.slice(0, 4)}
                    engines={engines}
                    onOpen={onOpenConversation}
                  />
                </div>
                <aside>
                  <section className="para-panel">
                    <h2>下一步怎么推进</h2>
                    <button
                      className="para-wide para-primary"
                      onClick={() =>
                        newChat(
                          "根据项目目标帮我搜集资料，保留来源，区分事实和推测。",
                        )
                      }
                    >
                      帮我找资料
                      <ArrowRight size={16} />
                    </button>
                    <button
                      className="para-wide"
                      onClick={() =>
                        newChat(
                          "根据项目简报和选定资料，继续推进当前下一步，完成后说明结果与证据。",
                        )
                      }
                    >
                      新建工作会话
                      <Plus size={16} />
                    </button>
                    <button
                      className="para-wide"
                      onClick={() => setModal("link")}
                    >
                      关联已有会话
                      <MessageSquare size={16} />
                    </button>
                    <p className="para-hint">
                      创建后进入草稿，确认开场内容再发送。
                    </p>
                  </section>
                  <section className="para-panel">
                    <div className="para-section-title">
                      <h2>置顶资料</h2>
                      <button onClick={() => setModal("resource")}>添加</button>
                    </div>
                    <ResourceRows
                      resources={detail.resources.filter(
                        (r) => r.pinned && !r.archived_at,
                      )}
                      onOpen={setResource}
                    />
                  </section>
                  <div className="para-actions">
                    {!["done", "stopped"].includes(current.stage) && <>
                      <button disabled={action.busy} onClick={() => setTransition({ project: current, action: "wait" })}>记录等待</button>
                      <button disabled={action.busy} onClick={() => setTransition({ project: current, action: "pause" })}><Pause size={14} />暂停项目</button>
                      <button disabled={action.busy} onClick={() => setTransition({ project: current, action: "stopped" })}>终止项目</button>
                    </>}
                    <button
                      disabled={action.busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "归档后可恢复。关联会话及自动续跑会继续，不会被停止。",
                          )
                        )
                          void action.run(() =>
                            patch(current, {
                              archived: !current.archived_at,
                              confirm_running: true,
                            }),
                          );
                      }}
                    >
                      <Archive size={14} />
                      {current.archived_at ? "恢复" : "归档"}
                    </button>
                  </div>
                </aside>
              </div>
            )}
            {["resources", "outputs"].includes(detailTab) && (
              <section className="para-panel">
                <div className="para-section-title">
                  <h2>{detailTab === "outputs" ? "项目成果" : "项目资料"}</h2>
                  <button
                    className="para-primary"
                    onClick={() => setModal("resource")}
                  >
                    <Plus size={16} />
                    添加资料
                  </button>
                </div>
                <ResourceRows
                  resources={detail.resources.filter(
                    (r) =>
                      !r.archived_at &&
                      (detailTab !== "outputs" || r.is_output),
                  )}
                  onOpen={setResource}
                  projectId={current.id}
                  onChange={() => void refresh()}
                />
              </section>
            )}
            {detailTab === "conversations" && (
              <section className="para-panel">
                <div className="para-section-title">
                  <h2>关联会话</h2>
                  <div className="para-actions">
                    <button onClick={() => setModal("link")}>关联已有</button>
                    <button
                      className="para-primary"
                      onClick={() =>
                        newChat("根据项目简报与选定资料，继续推进下一步。")
                      }
                    >
                      新建会话
                    </button>
                  </div>
                </div>
                <ConversationRows
                  rows={detail.conversations}
                  engines={engines}
                  onOpen={onOpenConversation}
                  projectId={current.id}
                  onChange={() => void refresh()}
                />
              </section>
            )}
            {detailTab === "history" && (
              <section className="para-panel">
                <h2>项目记录</h2>
                {detail.events.map((e) => (
                  <div className="para-event" key={e.id}>
                    <span>
                      {e.action} · v{e.revision}
                    </span>
                    <time>
                      {new Date(e.created_at).toLocaleString("zh-CN")}
                    </time>
                  </div>
                ))}
              </section>
            )}
          </>
        ) : pid ? (
          <Empty>正在加载项目…</Empty>
        ) : (
          <>
            <div className="para-title-row para-board-title">
              <div>
                <h1>{data.board.name}</h1>
              </div>
              <button className="para-primary" onClick={() => addIdea("idea")}>
                <Plus size={18} />
                记个想法
              </button>
            </div>
            {data.board.archived_at && (
              <div className="para-notice">
                看板已归档
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await para.updateBoard(boardId, {
                        revision: data.board.revision,
                        archived: false,
                      });
                      await refresh();
                    })
                  }
                >
                  恢复看板
                </button>
              </div>
            )}
            <nav className="para-tabs" aria-label="看板内容">
              {[
                ["projects", "项目推进"],
                ["attention", "待我处理"],
                ["resources", "项目资料"],
                ["stopped", "已终止"],
                ["archive", "归档"],
              ].map(([v, n]) => (
                <button
                  key={v}
                  className={tab === v ? "active" : ""}
                  aria-current={tab === v ? "page" : undefined}
                  onClick={() => setTab(v)}
                >
                  {n}
                </button>
              ))}
            </nav>
            {tab === "attention" && summary && <KanbanAttention summary={summary} filter={attentionFilter} setFilter={setAttentionFilter} onOpen={(b, p) => { if (b === boardId) { const item = data.projects.find(item => item.id === p); if (item) open(item); } else onNavigate(b, p); }} />}
            {tab === "stopped" && <section className="para-panel"><h2>已终止</h2><p className="para-hint">保留原因与已有成果，需要时可重新打开。</p><div className="para-area-grid">{renderCards(data.projects.filter(p => p.stage === "stopped" && !p.archived_at))}</div>{!data.projects.some(p => p.stage === "stopped" && !p.archived_at) && <Empty>没有已终止的项目。</Empty>}</section>}
            {tab === "projects" && (
              <>
                <div className="para-filters">
                  <ParaStageMenu filter label="阶段筛选" value={stage} onChange={setStage} />
                  <select
                    aria-label="项目排序"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="manual">手动排序</option>
                    <option value="updated">最近更新</option>
                  </select>
                  <button
                    aria-label={view === "board" ? "切换为列表视图" : "切换为看板视图"}
                    onClick={() => setView(view === "board" ? "list" : "board")}
                  >
                    {view === "board" ? "列表视图" : "看板视图"}
                  </button>
                  {hasFilters && <button className="para-clear-filters" onClick={clearFilters}><X size={14} />清除筛选</button>}
                </div>
                {hasFilters && shown.length === 0 ? <div className="para-filter-empty" role="status">
                  <LayoutDashboard size={22} aria-hidden="true" /><p>这个阶段还没有项目</p><button onClick={clearFilters}>查看全部项目</button>
                </div> :
                <div
                  className={`para-board ${view === "list" ? "para-list-view" : ""} ${stage !== "all" ? "para-filtered-board" : ""}`}
                >
                  {(stage === "stopped" ? ["stopped" as ParaStage] : [...FLOW])
                    .filter(s => stage === "all" || s === stage)
                    .map(s => (
                      <section
                        key={s}
                        className={`para-column stage-${s}`}
                        onDragOver={(e) => {
                          if (dragged.current) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const p = dragged.current;
                          dragged.current = null;
                          if (p) void action.run(() => patch(p, { stage: s }));
                        }}
                      >
                        <h2>
                          <span className="para-stage-dot" aria-hidden="true" />
                          {STAGES[s]}
                          <small>
                            {shown.filter((p) => p.stage === s).length}
                          </small>
                        </h2>
                        {renderCards(shown.filter((p) => p.stage === s))}
                        {!["done", "stopped", "review"].includes(s) && <button
                          className="para-add-card"
                          onClick={() => addIdea(s as ParaStage)}
                        >
                          <Plus size={15} />
                          {s === "idea" ? "添加想法" : "添加项目"}
                        </button>}
                      </section>
                    ))}
                </div>}
              </>
            )}
            {tab === "resources" && (
              <section className="para-panel">
                <div className="para-section-title">
                  <h2>资源库</h2>
                  <button
                    className="para-primary"
                    onClick={() => setModal("resource")}
                  >
                    <Plus size={16} />
                    添加资料
                  </button>
                </div>
                <p className="para-hint">
                  文字、链接、摘录和文件独立保存。尚未关联项目的资料也会留在这里。
                </p>
                <ResourceRows
                  resources={data.resources.filter((r) => !r.archived_at)}
                  onOpen={setResource}
                />
              </section>
            )}
            {tab === "archive" && (
              <>
                <h2>已归档项目</h2>
                <div className="para-area-grid">
                  {renderCards(data.projects.filter((p) => p.archived_at))}
                </div>
                {data.areas.length > 0 && <h2>原有分类笔记</h2>}
                {data.areas
                  .map((a) => (
                    <div className="para-resource-row" key={a.id}>
                      <span>{a.title}</span>
                      <p>{a.body}</p>
                    </div>
                  ))}
                <h2>已归档资料</h2>
                <ResourceRows
                  resources={data.resources.filter((r) => r.archived_at)}
                  onOpen={setResource}
                />
              </>
            )}
          </>
        )}
      </div>
      {pid && current && (
        <div className="para-mobile-actions">
          <button onClick={() => setModal("resource")}>
            <Plus size={17} />
            资料
          </button>
          <button
            className="para-primary"
            onClick={() => newChat("根据项目简报和选定资料，继续推进下一步。")}
          >
            <Plus size={17} />
            会话
          </button>
        </div>
      )}
      {transition && <Dialog title={actionTitle(transition.action)} closeDisabled={transitionBusy} onClose={() => setTransition(null)}>
        <LifecycleForm position={transition.position} onBusyChange={setTransitionBusy} project={transition.project} action={transition.action} summary={summary} onClose={() => setTransition(null)} onSaved={p => { acceptProject(p); setTransition(null); setNotice("项目已更新"); void refresh().catch(e => action.setError(message(e))); }} />
      </Dialog>}
      {modal === "idea" && (
        <IdeaForm
          accountId={accountId}
          boardId={boardId}
          stage={addStage}
          onClose={() => setModal(null)}
          onCreated={(p) => {
            setModal(null);
            open(p);
            void refresh();
          }}
        />
      )}
      {modal === "edit" && current && (
        <ProjectForm
          project={current}
          data={data}
          engines={engines}
          onClose={() => setModal(null)}
          onSaved={(project) => {
            acceptProject(project);
            setModal(null);
            if (project.board_id !== boardId)
              onNavigate(project.board_id, project.id);
            else void refresh();
          }}
        />
      )}
      {modal === "resource" && (
        <ResourceForm
          accountId={accountId}
          data={data}
          projectId={current?.id}
          output={detailTab === "outputs" && Boolean(current)}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void refresh();
          }}
        />
      )}

      {modal === "link" && current && (
        <LinkConversations
          projectId={current.id}
          engines={engines}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void refresh();
          }}
        />
      )}
      {modal === "new" && detail && (
        <NewConversation
          detail={detail}
          board={data.board}
          engines={engines}
          prompt={template}
          onClose={() => setModal(null)}
          onCreated={(c) => {
            setModal(null);
            onOpenConversation(c.id, c.project_id!);
          }}
        />
      )}
      {modal === "settings" && (
        <BoardSettings
          board={data.board}
          engines={engines}
          summary={summary}
          onPreferencesChanged={refresh}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void refresh();
          }}
        />
      )}
      {resource && (
        <ResourceViewer
          resource={resource}
          onClose={() => setResource(null)}
          onChanged={(r) => {
            setResource(r);
            void refresh();
          }}
        />
      )}
    </main>
  );
}
function IdeaForm({
  accountId,
  boardId,
  stage,
  onClose,
  onCreated,
}: {
  accountId: string;
  boardId: string;
  stage: ParaStage;
  onClose: () => void;
  onCreated: (p: ParaProject) => void;
}) {
  const [title, setTitle] = useDraft(`para:${accountId}:${boardId}:idea`),
    key = useRef(newKey()),
    action = useAction();
  const voice = useParaVoiceInput({ accountId, scope: `para:${boardId}:idea`, value: title, onChange: setTitle, disabled: action.busy });
  const savingBlocked = action.busy || paraVoiceBusy(voice) || title.length > 180;
  const closeDisabled = action.busy || voice.state === "transcribing";
  return (
    <Dialog
      title="记个想法"
      closeDisabled={closeDisabled}
      onClose={() => {
        if (!action.busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (savingBlocked) return;
          void action.run(async () => {
            const r = await para.createProject(boardId, {
              key: key.current,
              title,
              stage,
            });
            setTitle("");
            onCreated(r.project);
          });
        }}
      >
        <ParaVoiceField label="一句话记录" required maxLength={180}
          placeholder="你想做什么？打字或说出来…" value={title} onChange={setTitle}
          voice={voice} disabled={action.busy} />
        <p className="para-hint">
          只需一句话，之后再明确目标与下一步。{title ? "文字已保存在本机草稿。" : ""}
        </p>
        <ErrorBox error={action.error} />
        <footer>
          <button type="button" onClick={onClose} disabled={closeDisabled}>
            稍后继续
          </button>
          <button className="para-primary" disabled={savingBlocked || !title.trim()}>
            保存想法
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
function ProjectForm({
  project,
  data,
  engines,
  onClose,
  onSaved,
}: {
  project: ParaProject;
  data: BoardData;
  engines: Project[];
  onClose: () => void;
  onSaved: (project: ParaProject) => void;
}) {
  const [title, setTitle] = useState(project.title),
    [brief, setBrief] = useState(project.brief),
    [effort, setEffort] = useState(project.effort),
    [briefTemplate, setBriefTemplate] = useState("general"),
    [engine, setEngine] = useState(project.default_project_id ?? ""),
    [area] = useState(project.area_id ?? ""),
    [board, setBoard] = useState(project.board_id),
    [boards, setBoards] = useState<ParaBoard[]>([]);
  const action = useAction(),
    expectedRevision = useRef(project.revision),
    [latest, setLatest] = useState<ParaProject | null>(null);
  useEffect(() => {
    void para
      .boards()
      .then((r) => setBoards(r.boards))
      .catch(() => {});
  }, []);
  return (
    <Dialog
      title="编辑项目简报"
      onClose={() => {
        if (
          !action.busy &&
          (!action.error || window.confirm("未提交的编辑将被关闭，确认离开？"))
        )
          onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const result = await para.updateProject(project.id, {
              revision: expectedRevision.current,
              title,
              brief,
              effort,
              default_project_id: engine || null,
              area_id: board === project.board_id ? area || null : null,
              board_id: board,
            });
            onSaved(result.project);
          });
        }}
      >
        <label>
          项目名称
          <input
            required
            maxLength={180}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>简报模板<select aria-label="简报模板" value={briefTemplate} onChange={e => setBriefTemplate(e.target.value)}><option value="general">通用项目</option><option value="build">开发 / 制作</option><option value="explore">探索 / 验证</option></select></label>
        <p className="para-hint">{briefTemplate === "build" ? "先明确交付范围、这次不做什么，以及愿意投入多少。" : briefTemplate === "explore" ? "先写要验证的假设、最小实验与判断依据；否定假设也可以是有效成果。" : "用三句话说明目标、怎样算完成，以及接下来做什么。"}切换模板只改变填写提示，已有内容保留。</p>
        {(["goal", "success", "next"] as const).map(k => <label key={k}>{BRIEF[k]}<textarea aria-label={BRIEF[k]} rows={2} maxLength={50000} value={brief[k]} onChange={e => setBrief({ ...brief, [k]: e.target.value })} placeholder={k === "next" ? "动作 + 对象 + 预期结果" : briefTemplate === "explore" ? (k === "goal" ? "这次要验证的关键假设是什么？" : "用什么实验与证据判断结果？") : (k === "goal" ? "要交付什么结果？" : "满足哪些条件就可以结束？")} /></label>)}
        <details className="kanban-brief-more"><summary>范围、投入与决定（可选）</summary>
          <label>投入边界<input aria-label="投入边界" value={effort} maxLength={400} onChange={e => setEffort(e.target.value)} placeholder="例如：一个晚上，只完成第一版" /></label>
          {(["constraints", "decisions", "questions"] as const).map(k => <label key={k}>{BRIEF[k]}<textarea aria-label={BRIEF[k]} rows={3} maxLength={50000} value={brief[k]} onChange={e => setBrief({ ...brief, [k]: e.target.value })} placeholder={k === "constraints" ? "本次范围、明确不做的内容和约束" : undefined} /></label>)}
        </details>
        <EngineSelect
          engines={engines}
          value={engine}
          onChange={setEngine}
          inherit="继承看板默认工程"
        />
        <label>
          所属看板
          <select value={board} onChange={(e) => setBoard(e.target.value)}>
            {boards
              .filter((b) => !b.archived_at)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </label>
        {board !== project.board_id && (
          <p className="para-hint">
            移动会保留项目身份、资料和会话。继承默认工程的项目会沿用新看板设置。
          </p>
        )}
        <p className="para-hint">
          编辑基于版本 v{expectedRevision.current}
          。简报由你确认；会话回复不会自动覆盖这里。
        </p>
        <ErrorBox error={action.error} />
        {action.error.includes("其他窗口") && (
          <button
            type="button"
            onClick={() =>
              void para
                .project(project.id)
                .then((d) => setLatest(d.project))
                .catch((e) => action.setError(message(e)))
            }
          >
            查看服务器最新版本
          </button>
        )}
        {latest && (
          <section className="para-context-preview">
            <strong>
              服务器版本 v{latest.revision}：{latest.title}
            </strong>
            {(Object.keys(BRIEF) as (keyof ParaBrief)[]).map((k) => (
              <p key={k}>
                {BRIEF[k]}：{latest.brief[k] || "未填写"}
              </p>
            ))}
            <p>上方输入保留你的编辑。请对照合并后，再确认保存。</p>
            <button
              type="button"
              onClick={() => {
                expectedRevision.current = latest.revision;
                setLatest(null);
                action.setError("");
              }}
            >
              已合并，使用这个版本保存
            </button>
          </section>
        )}
        <footer>
          <button type="button" onClick={onClose} disabled={action.busy}>
            取消
          </button>
          <button className="para-primary" disabled={action.busy}>
            保存简报
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
function BoardSettings({
  board,
  engines,
  summary,
  onPreferencesChanged,
  onClose,
  onSaved,
}: {
  board: ParaBoard;
  engines: Project[];
  summary: KanbanSummary | null;
  onPreferencesChanged: () => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(board.name),
    [engine, setEngine] = useState(board.default_project_id ?? "");
  const action = useAction(),
    expectedRevision = useRef(board.revision);
  const [limitBusy, setLimitBusy] = useState(false);
  return (
    <Dialog title="看板设置" className="ui-dialog para-board-settings" closeDisabled={action.busy || limitBusy} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (limitBusy) return;
          void action.run(async () => {
            await para.updateBoard(board.id, {
              revision: expectedRevision.current,
              name,
              default_project_id: engine || null,
            });
            onSaved();
          });
        }}
      >
        <label>
          看板名称
          <input
            required
            maxLength={180}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <EngineSelect
          engines={engines}
          value={engine}
          onChange={setEngine}
          inherit="继承账号默认工程"
        />
        <p className="para-hint">
          只影响仍继承看板设置的项目之后创建的新会话。已有会话继续使用原工程。
        </p>
        <ErrorBox error={action.error} />
        <footer>
          <button
            type="button"
            disabled={action.busy || limitBusy}
            onClick={() => {
              if (
                window.confirm(
                  "归档看板不会停止任何关联会话或自动续跑，可随时恢复。",
                )
              )
                void action.run(async () => {
                  await para.updateBoard(board.id, {
                    revision: expectedRevision.current,
                    archived: !board.archived_at,
                  });
                  onSaved();
                });
            }}
          >
            {board.archived_at ? "恢复看板" : "归档看板"}
          </button>
          <button className="para-primary" disabled={action.busy || limitBusy}>
            保存设置
          </button>
        </footer>
      </form>
      {summary && <KanbanLimitSettings summary={summary} disabled={action.busy} onBusyChange={setLimitBusy} onChange={onPreferencesChanged} />}
    </Dialog>
  );
}
function ResourceForm({
  accountId,
  data,
  projectId,
  output = false,
  onClose,
  onSaved,
}: {
  accountId: string;
  data: BoardData;
  projectId?: string;
  output?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [body, setBody] = useDraft(
      `para:${accountId}:${projectId ?? data.board.id}:resource`,
    ),
    [title, setTitle] = useState(""),
    [url, setUrl] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [area] = useState(""),
    [progress, setProgress] = useState(0),
    [isOutput, setOutput] = useState(output),
    [existing, setExisting] = useState("");
  const action = useAction(),
    key = useRef(newKey());
  const voice = useParaVoiceInput({ accountId, scope: `para:${projectId ?? data.board.id}:resource`, value: body, onChange: setBody, disabled: action.busy || Boolean(existing) });
  const savingBlocked = action.busy || paraVoiceBusy(voice) || body.length > 50000;
  const closeDisabled = action.busy || voice.state === "transcribing";
  return (
    <Dialog
      title={output ? "保存项目成果" : "添加资料"}
      closeDisabled={closeDisabled}
      onClose={() => {
        if (!action.busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (savingBlocked) return;
          void action.run(async () => {
            if (existing && projectId)
              await para.linkResource(projectId, existing, {
                is_output: isOutput,
              });
            else {
              const form = new FormData();
              form.set("key", key.current);
              if (title.trim()) form.set("title", title);
              form.set("body", body);
              form.set("url", url);
              form.set("is_output", String(isOutput));
              if (projectId) form.set("projectId", projectId);
              if (area) form.set("area_id", area);
              if (file) form.set("file", file);
              await para.upload(data.board.id, form, setProgress);
            }
            setBody("");
            onSaved();
          });
        }}
      >
        {projectId && (
          <label>
            从资源库引用
            <select
              value={existing}
              disabled={action.busy || paraVoiceBusy(voice)}
              onChange={(e) => setExisting(e.target.value)}
            >
              <option value="">新建资料</option>
              {data.resources
                .filter((r) => !r.archived_at)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        {!existing && (
          <>
            <label>
              资料标题（可选）
              <input
                maxLength={180}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="保存后可改名"
              />
            </label>
            <ParaVoiceField label="文字或摘录" rows={7} maxLength={50000}
              placeholder="记一点什么，或粘贴资料…" value={body} onChange={setBody}
              voice={voice} disabled={action.busy} />
            <label>
              网页链接
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://"
              />
            </label>
            <label>
              文件或图片
              <input
                type="file"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setProgress(0);
                }}
              />
            </label>
            <p className="para-hint">
              每份文件最大 64 MiB。链接保留网址与备注，不自动抓取网页正文。
            </p>

          </>
        )}
        {projectId && (
          <label className="para-checkbox">
            <input
              type="checkbox"
              checked={isOutput}
              onChange={(e) => setOutput(e.target.checked)}
            />
            同时收进成果
          </label>
        )}
        {body && (
          <p className="para-hint">
            正文已保存在本机草稿；附件需要在本次上传完成后保存。
          </p>
        )}
        {action.busy && (
          <div role="status" className="para-hint">
            {file
              ? progress < 100
                ? `上传中 · ${progress}%`
                : "上传完成，正在校验与保存…"
              : "正在保存…"}
          </div>
        )}
        <ErrorBox error={action.error} />
        <footer>
          <button type="button" disabled={closeDisabled} onClick={onClose}>
            稍后继续
          </button>
          <button className="para-primary" disabled={savingBlocked}>
            {action.error ? "重试保存" : "收进资料库"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
function ResourceRows({
  resources,
  onOpen,
  projectId,
  onChange,
}: {
  resources: ParaResource[];
  onOpen: (r: ParaResource) => void;
  projectId?: string;
  onChange?: () => void;
}) {
  const action = useAction();
  return (
    <>
      <ErrorBox error={action.error} />
      {!resources.length && (
        <Empty>还没有资料。记录文字、粘贴链接，或收录一份文件。</Empty>
      )}
      {resources.map((r) => (
        <div className="para-resource-row" key={r.id}>
          <button className="para-resource-open" onClick={() => onOpen(r)}>
            {r.kind === "link" ? (
              <LinkIcon size={19} />
            ) : r.kind === "file" ? (
              <Paperclip size={19} />
            ) : (
              <FileText size={19} />
            )}
            <span>
              <strong>{r.title}</strong>
              <small>
                {r.kind === "file"
                  ? `${(r.size / 1024).toFixed(1)} KB`
                  : r.kind === "link"
                    ? "链接"
                    : r.kind === "excerpt"
                      ? "摘录"
                      : "笔记"}{" "}
                · v{r.revision}
                {r.is_output ? " · 成果" : ""}
                {r.pinned ? " · 已置顶" : ""}
              </small>
            </span>
          </button>
          {projectId && (
            <details>
              <summary aria-label={`${r.title} 的资料操作`}>
                <MoreHorizontal size={18} />
              </summary>
              <div className="para-inline-menu">
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await para.linkResource(projectId, r.id, {
                        is_output: !r.is_output,
                        pinned: Boolean(r.pinned),
                      });
                      onChange?.();
                    })
                  }
                >
                  {r.is_output ? "移出成果" : "保存为成果"}
                </button>
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await para.linkResource(projectId, r.id, {
                        is_output: Boolean(r.is_output),
                        pinned: !r.pinned,
                      });
                      onChange?.();
                    })
                  }
                >
                  {r.pinned ? "取消置顶" : "置顶资料"}
                </button>
                <button
                  disabled={action.busy}
                  onClick={() => {
                    if (
                      window.confirm("只移除本项目的引用，资料仍保留在资源库。")
                    )
                      void action.run(async () => {
                        await para.unlinkResource(projectId, r.id);
                        onChange?.();
                      });
                  }}
                >
                  移除引用
                </button>
              </div>
            </details>
          )}
        </div>
      ))}
    </>
  );
}
function ResourceViewer({
  resource,
  onClose,
  onChanged,
}: {
  resource: ParaResource;
  onClose: () => void;
  onChanged: (r: ParaResource) => void;
}) {
  const [content, setContent] = useState<string | null>(null),
    [blob, setBlob] = useState(""),
    [loading, setLoading] = useState(true),
    [edit, setEdit] = useState(false),
    [title, setTitle] = useState(resource.title),
    [body, setBody] = useState(resource.body),
    [url, setUrl] = useState(resource.url);
  const action = useAction();
  useEffect(() => {
    let live = true,
      objectUrl = "";
    setLoading(true);
    void para
      .preview(resource.id)
      .then(async (r) => {
        if (live) setContent(r.content);
        if (
          r.content === null &&
          /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(
            resource.mime_type ?? "",
          )
        ) {
          const response = await fetch(para.contentUrl(resource.id));
          if (!response.ok) throw new Error("文件读取失败");
          objectUrl = URL.createObjectURL(
            new Blob([await response.blob()], { type: resource.mime_type! }),
          );
          if (live) setBlob(objectUrl);
          else URL.revokeObjectURL(objectUrl);
        }
      })
      .catch((e) => {
        if (live) action.setError(message(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [resource.id, resource.revision]);
  return (
    <Dialog title={edit ? "编辑资料" : resource.title} onClose={onClose}>
      <div className="para-resource-view">
        <ErrorBox error={action.error} />
        {edit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const r = await para.updateResource(resource.id, {
                  revision: resource.revision,
                  title,
                  body,
                  url,
                });
                onChanged(r.resource);
                setEdit(false);
              });
            }}
          >
            <label>
              资料标题
              <input
                required
                maxLength={180}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              正文或备注
              <textarea
                aria-label="正文或备注"
                rows={10}
                maxLength={50000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <label>
              链接
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <footer>
              <button type="button" onClick={() => setEdit(false)}>
                取消
              </button>
              <button className="para-primary" disabled={action.busy}>
                保存资料
              </button>
            </footer>
          </form>
        ) : (
          <>
            {resource.url && (
              <p>
                <a href={resource.url} target="_blank" rel="noreferrer">
                  {resource.url}
                </a>
              </p>
            )}
            {loading ? (
              <Empty>正在读取资料…</Empty>
            ) : content !== null ? (
              <div className="para-resource-content">
                {/\.html?$/i.test(resource.file_name ?? "") ? (
                  <iframe
                    title="资料预览"
                    sandbox=""
                    srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><meta charset="utf-8">${content}`}
                  />
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {content}
                  </ReactMarkdown>
                )}
              </div>
            ) : blob ? (
              resource.mime_type === "application/pdf" ? (
                <iframe title="PDF 资料预览" src={blob} />
              ) : (
                <img src={blob} alt={resource.title} />
              )
            ) : (
              <Empty>这类文件可下载后打开，或选作工作会话的附件。</Empty>
            )}
            {resource.kind === "file" && resource.body && (
              <p>{resource.body}</p>
            )}
            {resource.source_title && (
              <p className="para-hint">
                来源：{resource.source_title}
                {resource.source_conversation_id
                  ? ""
                  : "（原会话已删除，资料已独立保留）"}
              </p>
            )}
            <footer>
              <button onClick={() => setEdit(true)}>编辑资料</button>
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const r = await para.updateResource(resource.id, {
                      revision: resource.revision,
                      archived: !resource.archived_at,
                    });
                    onChanged(r.resource);
                  })
                }
              >
                {resource.archived_at ? "恢复资料" : "归档资料"}
              </button>
              {resource.kind === "file" && (
                <a
                  className="para-button para-primary"
                  href={para.contentUrl(resource.id)}
                  download
                >
                  <Download size={16} />
                  下载文件
                </a>
              )}
            </footer>
          </>
        )}
      </div>
    </Dialog>
  );
}
function ConversationRows({
  rows,
  engines,
  onOpen,
  projectId,
  onChange,
}: {
  rows: ParaConversation[];
  engines: Project[];
  onOpen: (id: string, engine: string) => void;
  projectId?: string;
  onChange?: () => void;
}) {
  const action = useAction();
  return (
    <>
      <ErrorBox error={action.error} />
      {!rows.length && (
        <Empty>还没有关联会话。可以新建工作会话，或关联已有讨论。</Empty>
      )}
      {rows.map((c) => (
        <div className="para-conversation-row" key={c.id}>
          <button
            className="para-resource-open"
            onClick={() => {
              if (c.project_id) onOpen(c.id, c.project_id);
            }}
          >
            <MessageSquare size={18} />
            <span>
              <strong>{c.title}</strong>
              <small>
                {c.project_name} ·{" "}
                {engines.find((e) => e.id === c.project_id)?.machine_name ??
                  c.executor_id}{" "}
                · {c.relation === "primary" ? "主工作项目" : "参考关联"}
              </small>
              <small>
                {c.status === "running" || c.external_status === "running"
                  ? "运行中"
                  : c.has_unread_result
                    ? "有新回复"
                    : "会话已保存"}
                {c.active_wake_count
                  ? ` · ${c.active_wake_count} 个自动续跑`
                  : ""}
                {c.cold_storage_state !== "local" ? " · 打开时恢复历史" : ""}
              </small>
            </span>
            <ArrowRight size={15} />
          </button>
          {projectId && (
            <details>
              <summary aria-label={`${c.title} 的关联操作`}>
                <MoreHorizontal size={18} />
              </summary>
              <div className="para-inline-menu">
                {c.relation === "reference" && (
                  <button
                    disabled={action.busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "改为主工作项目后，后续发送将使用本项目背景。当前运行输入不变。",
                        )
                      )
                        void action.run(async () => {
                          await para.linkConversations(projectId, [c.id], true);
                          onChange?.();
                        });
                    }}
                  >
                    设为主工作项目
                  </button>
                )}
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await para.unlinkConversation(projectId, c.id);
                      onChange?.();
                    })
                  }
                >
                  移除关联
                </button>
              </div>
            </details>
          )}
        </div>
      ))}
    </>
  );
}
function LinkConversations({
  projectId,
  engines,
  onClose,
  onSaved,
}: {
  projectId: string;
  engines: Project[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [q, setQ] = useState(""),
    [engine, setEngine] = useState(""),
    [rows, setRows] = useState<ParaConversation[]>([]),
    [ids, setIds] = useState<string[]>([]),
    [loading, setLoading] = useState(false);
  const action = useAction();
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void para
        .searchConversations(q, engine)
        .then((r) => {
          if (live) setRows(r.conversations);
        })
        .catch((e) => {
          if (live) action.setError(message(e));
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, engine]);
  return (
    <Dialog title="关联已有会话" onClose={onClose}>
      <div className="para-form">
        <label>
          搜索会话标题
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="输入标题关键词"
          />
        </label>
        <EngineSelect
          engines={engines}
          value={engine}
          onChange={setEngine}
          label="来源工程与机器"
          inherit="所有工程"
        />
        <p className="para-hint">
          已有主工作项目的会话会作为参考关联。关联不会移动工程或改变本轮输入。
        </p>
        {loading && <p role="status">正在搜索…</p>}
        <div className="para-picker-list">
          {rows.map((c) => (
            <label className="para-picker-row" key={c.id}>
              <input
                type="checkbox"
                checked={ids.includes(c.id)}
                onChange={(e) =>
                  setIds(
                    e.target.checked
                      ? [...ids, c.id]
                      : ids.filter((id) => id !== c.id),
                  )
                }
              />
              <span>
                <strong>{c.title}</strong>
                <small>
                  {c.project_name} ·{" "}
                  {engines.find((e) => e.id === c.project_id)?.machine_name ??
                    c.executor_id}{" "}
                  ·{" "}
                  {c.status === "running" || c.external_status === "running"
                    ? "运行中"
                    : "空闲"}{" "}
                  · {new Date(c.updated_at).toLocaleDateString("zh-CN")}
                </small>
                {c.main_title && (
                  <small>主项目：{c.main_title} · 将作为参考关联</small>
                )}
              </span>
            </label>
          ))}
        </div>
        <ErrorBox error={action.error} />
        <footer>
          <span>已选 {ids.length} 条</span>
          <button
            className="para-primary"
            disabled={!ids.length || action.busy}
            onClick={() =>
              void action.run(async () => {
                await para.linkConversations(projectId, ids);
                onSaved();
              })
            }
          >
            确认关联
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
function NewConversation({
  detail,
  board,
  engines,
  prompt: initial,
  onClose,
  onCreated,
}: {
  detail: ParaDetail;
  board: ParaBoard;
  engines: Project[];
  prompt: string;
  onClose: () => void;
  onCreated: (c: Conversation) => void;
}) {
  const [title, setTitle] = useState(detail.project.title + " · 工作会话"),
    [engine, setEngine] = useState(
      detail.project.default_project_id ?? board.default_project_id ?? "",
    ),
    [setDefault, setSetDefault] = useState(false),
    [prompt, setPrompt] = useState(initial),
    [ids, setIds] = useState<string[]>(
      detail.resources
        .filter((r) => r.pinned && !r.archived_at)
        .slice(0, 12)
        .map((r) => r.id),
    );
  const action = useAction(),
    key = useRef(newKey());
  const chosen = detail.resources.filter((r) => ids.includes(r.id));
  const remote = engines
    .find((e) => e.id === engine)
    ?.executor_id.startsWith("remote:");
  return (
    <Dialog
      title="新建工作会话"
      onClose={() => {
        if (!action.busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const r = await para.newConversation(detail.project.id, {
              key: key.current,
              title,
              projectId: engine || undefined,
              setDefault,
              resourceIds: ids,
              prompt,
            });
            onCreated(r.conversation);
          });
        }}
      >
        <p className="para-hint">项目：{detail.project.title}</p>
        <label>
          会话标题
          <input
            required
            maxLength={180}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <EngineSelect
          engines={engines}
          value={engine}
          onChange={setEngine}
          label="本次工作工程"
          inherit="账号默认工程"
        />
        <label className="para-checkbox">
          <input
            type="checkbox"
            checked={setDefault}
            onChange={(e) => setSetDefault(e.target.checked)}
          />
          将本次选择设为项目默认
        </label>
        <details className="para-context-preview">
          <summary>项目简报 v{detail.project.revision} · 默认带入</summary>
          {(Object.keys(BRIEF) as (keyof ParaBrief)[]).map((k) => (
            <p key={k}>
              <strong>{BRIEF[k]}：</strong>
              {detail.project.brief[k] || "未填写"}
            </p>
          ))}
        </details>
        <fieldset>
          <legend>带入的资料（最多 12 份）</legend>
          {detail.resources
            .filter((r) => !r.archived_at)
            .map((r) => (
              <label className="para-picker-row" key={r.id}>
                <input
                  type="checkbox"
                  disabled={!ids.includes(r.id) && ids.length >= 12}
                  checked={ids.includes(r.id)}
                  onChange={(e) =>
                    setIds(
                      e.target.checked
                        ? [...ids, r.id]
                        : ids.filter((id) => id !== r.id),
                    )
                  }
                />
                <span>
                  <strong>{r.title}</strong>
                  <small>
                    {r.kind === "file" ? "文件附件" : "正文与链接"} · v
                    {r.revision}
                  </small>
                </span>
              </label>
            ))}
          {!detail.resources.length && (
            <p className="para-hint">当前没有资料，仅带入简报与资料索引。</p>
          )}
        </fieldset>
        {remote && (
          <p className="para-hint">
            远程工程首版支持简报与文字资料；文件投递另行开放。
            {chosen.some((r) => r.kind === "file")
              ? "请取消文件选择，或改用服务器工程。"
              : ""}
          </p>
        )}
        <label>
          开场内容
          <textarea
            aria-label="开场内容"
            rows={5}
            required
            maxLength={10000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        {chosen.some((r) => r.kind !== "file") && (
          <details className="para-context-preview">
            <summary>查看选定资料正文</summary>
            {chosen
              .filter((r) => r.kind !== "file")
              .map((r) => (
                <div key={r.id}>
                  <h3>{r.title}</h3>
                  <p>{r.url}</p>
                  <pre>{r.body}</pre>
                </div>
              ))}
          </details>
        )}
        <p className="para-hint">
          创建后进入会话草稿，可继续编辑并发送。一次更换工程不会自动修改默认设置。
        </p>
        <ErrorBox error={action.error} />
        <footer>
          <button type="button" disabled={action.busy} onClick={onClose}>
            取消
          </button>
          <button
            className="para-primary"
            disabled={
              action.busy ||
              Boolean(remote && chosen.some((r) => r.kind === "file"))
            }
          >
            创建并打开
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
export function ParaConversationProjectsDialog({
  conversationId, conversationTitle, onOpen, onClose,
}: {
  conversationId: string;
  conversationTitle: string;
  onOpen: (board: string, project: string) => void;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<ParaLink[]>([]);
  const [collect, setCollect] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const generation = useRef(0);
  const action = useAction();
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setLoadError("");
    try {
      const result = await para.conversationProjects(conversationId);
      if (current === generation.current) setLinks(result.projects);
    } catch (error) {
      if (current === generation.current) setLoadError(message(error));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [conversationId]);
  useEffect(() => {
    const update = () => { void refresh(); };
    update();
    window.addEventListener("para-updated", update);
    return () => {
      generation.current++;
      window.removeEventListener("para-updated", update);
    };
  }, [refresh]);
  const blocked = action.busy || loading || Boolean(loadError);
  if (collect) return <CollectDialog conversationId={conversationId} onClose={() => setCollect(false)} />;
  return <Dialog title="关联项目" closeDisabled={action.busy} onClose={onClose}>
    <div className="para-form para-conversation-projects">
      <p className="para-linked-conversation" title={conversationTitle}>{conversationTitle}</p>
      <p className="para-hint">主项目为后续发送提供背景，参考关联用于归属记录。修改关联不会移动会话，当前运行的输入保持不变。</p>
      {loading && <p className="para-hint" role="status">正在读取关联项目…</p>}
      {loadError && <div className="para-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void refresh()}>重试</button></div>}
      {!loading && !loadError && !links.length && <p className="para-linked-empty">尚未关联项目</p>}
      <div className="para-linked-projects" aria-label="已关联项目" aria-busy={loading}>
        {links.map((link) => <section className="para-linked-project" key={link.id} data-linked-project={link.id}>
          <div className="para-linked-project-heading">
            <button type="button" disabled={action.busy} className="para-linked-project-open" title={`打开项目 ${link.title}`} onClick={() => onOpen(link.board_id, link.id)}><LayoutDashboard size={16} /><span>{link.title}</span><ArrowRight size={14} /></button>
            <span className={`para-linked-role ${link.relation === "primary" ? "primary" : ""}`}>{link.relation === "primary" ? "主项目" : "参考关联"}</span>
          </div>
          <div className="para-linked-project-actions">
            {link.relation !== "primary" && <button type="button" disabled={blocked} onClick={() => {
              if (!confirm(`将“${link.title}”设为主项目？后续发送将使用它的背景，原主项目保留为参考关联。当前运行输入不变。`)) return;
              void action.run(async () => {
                await para.linkConversations(link.id, [conversationId], true);
                generation.current++;
                setLinks((rows) => rows.map((row) => ({ ...row, relation: row.id === link.id ? "primary" : "reference" })));
                await refresh();
              });
            }}>设为主项目</button>}
            <button type="button" disabled={blocked} onClick={() => {
              if (!confirm(`取消与“${link.title}”的关联？会话和项目都会保留，当前运行输入不变。`)) return;
              void action.run(async () => {
                await para.unlinkConversation(link.id, conversationId);
                generation.current++;
                setLinks((rows) => rows.filter((row) => row.id !== link.id));
                await refresh();
              });
            }}>取消关联</button>
          </div>
        </section>)}
      </div>
      <ErrorBox error={action.error} />
      <footer>
        <button type="button" disabled={action.busy} onClick={onClose}>关闭</button>
        <button type="button" className="para-primary" disabled={blocked} onClick={() => setCollect(true)}><Plus size={15} />添加关联</button>
      </footer>
    </div>
  </Dialog>;
}
export function ParaCollectButton({
  messageId,
  fileId,
  menuItem = false,
  onOpen,
}: {
  messageId?: string;
  fileId?: string;
  menuItem?: boolean;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { features } = useFeatureSelection();
  useEffect(() => { if (!features.paraBoard) setOpen(false); }, [features.paraBoard]);
  if (!features.paraBoard) return null;
  return (
    <>
      <button
        type="button"
        className={menuItem ? "file-reader-settings-item" : "para-collect"}
        role={menuItem ? "menuitem" : undefined}
        onClick={() => { onOpen?.(); setOpen(true); }}
        title="独立收录到项目"
      >
        <LayoutDashboard size={menuItem ? 15 : 13} />
        <span>加入项目</span>
      </button>
      {open && (
        <CollectDialog
          messageId={messageId}
          fileId={fileId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function CollectDialog({
  conversationId,
  messageId,
  fileId,
  onClose,
}: {
  conversationId?: string;
  messageId?: string;
  fileId?: string;
  onClose: () => void;
}) {
  const [boards, setBoards] = useState<ParaBoard[]>([]),
    [bid, setBid] = useState(""),
    [projects, setProjects] = useState<ParaProject[]>([]),
    [pid, setPid] = useState(""),
    [output, setOutput] = useState(false);
  const action = useAction(),
    key = useRef(newKey());
  useEffect(() => {
    void para
      .boards()
      .then((r) => {
        const bs = r.boards.filter((b) => !b.archived_at);
        setBoards(bs);
        setBid(bs[0]?.id ?? "");
      })
      .catch((e) => action.setError(message(e)));
  }, []);
  useEffect(() => {
    let live = true;
    setPid("");
    setProjects([]);
    if (bid)
      void para
        .board(bid)
        .then((r) => {
          if (live) setProjects(r.projects.filter((p) => !p.archived_at));
        })
        .catch((e) => {
          if (live) action.setError(message(e));
        });
    return () => {
      live = false;
    };
  }, [bid]);
  return (
    <Dialog
      title={conversationId ? "关联工作项目" : "加入项目"}
      onClose={() => {
        if (!action.busy) onClose();
      }}
    >
      <div className="para-form">
        <label>
          看板
          <select value={bid} onChange={(e) => setBid(e.target.value)}>
            <option value="">选择看板</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          项目
          <select value={pid} onChange={(e) => setPid(e.target.value)}>
            <option value="">选择项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        {!boards.length && (
          <p className="para-hint">
            请先从侧栏「新建项目」创建一个项目看板。
          </p>
        )}
        {!conversationId && (
          <label className="para-checkbox">
            <input
              type="checkbox"
              checked={output}
              onChange={(e) => setOutput(e.target.checked)}
            />
            同时保存为成果
          </label>
        )}
        <p className="para-hint">
          {conversationId
            ? "只建立关联，原会话的工程与历史保持不变。已有主项目时默认作为参考。"
            : "文字或文件将独立保存，保留来源信息。之后删除原会话不会删除已收录资料。"}
        </p>
        <ErrorBox error={action.error} />
        <footer>
          <button type="button" onClick={onClose} disabled={action.busy}>
            取消
          </button>
          <button
            className="para-primary"
            disabled={!pid || action.busy}
            onClick={() =>
              void action.run(async () => {
                if (conversationId)
                  await para.linkConversations(pid, [conversationId]);
                else {
                  const f = new FormData();
                  f.set("key", key.current);
                  f.set("projectId", pid);
                  f.set("is_output", String(output));
                  if (messageId) f.set("source_message_id", messageId);
                  if (fileId) f.set("source_file_id", fileId);
                  await para.upload(bid, f);
                }
                onClose();
              })
            }
          >
            确认收录
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
