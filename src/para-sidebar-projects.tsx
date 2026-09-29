import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Archive, GripVertical, LoaderCircle, MoreHorizontal } from "lucide-react";
import { para, type SidebarProjectPage } from "./para-api";
import type { ParaSidebarProject } from "../server/para-types";

type Placement = "before" | "after";
export function ParaSidebarProjects({ boardId, query, archives, selected, disabled, menuProjectId, onOpen, onMenu }: {
  boardId: string; query: string; archives: boolean; selected: string | null; disabled: boolean; menuProjectId: string | null;
  onOpen: (id: string) => void;
  onMenu: (project: ParaSidebarProject, target: HTMLButtonElement) => void;
}) {
  const [page, setPage] = useState<SidebarProjectPage | null>(null);
  const [loading, setLoading] = useState(true), [moving, setMoving] = useState(false), [error, setError] = useState("");
  const [dragging, setDragging] = useState<string | null>(null), [drop, setDrop] = useState<{ id: string; placement: Placement } | null>(null);
  const generation = useRef(0), shown = useRef(5), busy = useRef(false);
  const drag = useRef<{ source: string; target?: string; placement?: Placement } | null>(null);
  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      let result: SidebarProjectPage = { projects: [], total: 0, nextOffset: 0, hasMore: true };
      do {
        const next = await para.sidebarProjects(boardId, query, archives, Math.min(100, shown.current - result.projects.length), result.nextOffset);
        if (generation.current !== gen) return;
        const advanced = next.nextOffset > result.nextOffset;
        result = { ...next, projects: [...result.projects, ...next.projects] };
        if (!advanced) break;
      } while (result.hasMore && result.projects.length < shown.current);
      setPage(result); setError("");
    } catch (e) { if (gen === generation.current) setError(e instanceof Error ? e.message : "项目加载失败，请重试。"); }
    finally { if (gen === generation.current) setLoading(false); }
  }, [boardId, query, archives]);
  useEffect(() => {
    shown.current = 5; setPage(null); void refresh();
    const reload = (event: Event) => {
      const project = (event as CustomEvent<{ project?: ParaSidebarProject }>).detail?.project;
      if (project) {
        // A write receipt is authoritative before the background list returns.
        // In particular, closing an archive dialog must not expose an old menu.
        setPage((current) => current ? {
          ...current,
          projects: current.projects.flatMap((p) => p.id !== project.id ? [p]
            : project.board_id !== boardId || (!archives && project.archived_at) ? [] : [project]),
        } : current);
      }
      void refresh(); // Invalidates list reads that started before this receipt.
    };
    const timer = window.setInterval(() => { if (!document.hidden && !busy.current) void refresh(); }, 15000);
    window.addEventListener("para-updated", reload);
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener("para-updated", reload); };
  }, [refresh]);
  const projects = page?.projects ?? [];
  const sortable = !query && !disabled && !moving;
  const cancel = () => { drag.current = null; setDragging(null); setDrop(null); };
  async function move(source: string, target: string, placement: Placement) {
    if (!sortable || busy.current || source === target) return;
    busy.current = true; setMoving(true); setError("");
    try { await para.reorderSidebarProjects(source, target, placement); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "调整顺序失败，请重试。"); }
    finally { busy.current = false; setMoving(false); }
  }
  function end() {
    const value = drag.current; cancel();
    if (value?.target && value.placement) void move(value.source, value.target, value.placement);
  }
  function moveTouch(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag.current || event.pointerType === "mouse") return;
    event.preventDefault(); event.stopPropagation();
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".para-sidebar-project-row");
    if (row?.dataset.paraBoard === boardId && row.dataset.paraProject !== drag.current.source && row.dataset.sortable === "true") {
      const rect = row.getBoundingClientRect(), placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      drag.current.target = row.dataset.paraProject; drag.current.placement = placement;
      setDrop({ id: row.dataset.paraProject!, placement });
    } else { delete drag.current.target; setDrop(null); }
    const scroll = event.currentTarget.closest<HTMLElement>(".sidebar-content");
    if (scroll) {
      const rect = scroll.getBoundingClientRect();
      if (event.clientY < rect.top + 35) scroll.scrollTop -= 14;
      if (event.clientY > rect.bottom - 35) scroll.scrollTop += 14;
    }
  }
  return <div className="para-sidebar-projects" aria-label="看板内项目">
    {projects.map((p) => <div key={p.id} data-para-project={p.id} data-para-board={boardId} data-sortable={sortable && !p.archived_at}
      className={`para-sidebar-row para-sidebar-project-row ${selected === p.id ? "selected" : ""} ${dragging === p.id ? "dragging" : ""} ${drop?.id === p.id ? `drop-${drop.placement}` : ""}`}
      draggable={sortable && !p.archived_at}
      onDragStart={(event) => {
        event.stopPropagation();
        if (!sortable || p.archived_at || (event.target as HTMLElement).closest(".para-sidebar-more")) { event.preventDefault(); return; }
        drag.current = { source: p.id }; setDragging(p.id);
        event.dataTransfer.setData("application/x-para-project", p.id); event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (!drag.current || drag.current.source === p.id || p.archived_at) return;
        event.preventDefault(); event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect(), placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
        drag.current.target = p.id; drag.current.placement = placement; setDrop({ id: p.id, placement });
      }}
      onDrop={(event) => { if (drag.current) { event.preventDefault(); event.stopPropagation(); end(); } }}
      onDragEnd={cancel}>
      <button type="button" className="para-board-grip" disabled={!sortable || Boolean(p.archived_at)} aria-label={`拖动项目 ${p.title}`}
        title={query ? "清空搜索后可拖动排序" : "拖动排序，也可用上下方向键调整；新活动会移到最前"}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" || !sortable) return;
          event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { source: p.id }; setDragging(p.id);
        }} onPointerMove={moveTouch} onPointerUp={(event) => { if (event.pointerType !== "mouse") end(); }} onPointerCancel={cancel}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault(); const active = projects.filter((p) => !p.archived_at), index = active.findIndex((item) => item.id === p.id);
          const target = active[index + (event.key === "ArrowUp" ? -1 : 1)];
          if (target) void move(p.id, target.id, event.key === "ArrowUp" ? "before" : "after");
        }}><GripVertical size={12} /></button>
      <button type="button" className="para-sidebar-item para-sidebar-project-select" title={p.title} aria-current={selected === p.id ? "page" : undefined} onClick={() => onOpen(p.id)}>
        <span>{p.title}</span>{p.archived_at && <Archive size={13} aria-label="已归档" />}
      </button>
      <button type="button" className="para-sidebar-more" disabled={moving} aria-label={`看板内项目 ${p.title} 操作`} title="项目操作" aria-haspopup="menu" aria-expanded={menuProjectId === p.id}
        onClick={(event) => onMenu(p, event.currentTarget)}><MoreHorizontal size={15} /></button>
    </div>)}
    {loading && <div className="list-loading" role="status"><LoaderCircle className="spin" size={14} /><span>{query ? "正在搜索…" : "正在加载…"}</span></div>}
    {error && <div className="para-sidebar-load-error" role="alert">{error}<button onClick={() => void refresh()}>重试</button></div>}
    {!loading && !error && !projects.length && <div className="project-empty">{query ? "没有匹配项目" : "还没有项目"}</div>}
    {page?.hasMore && <button type="button" className="project-show-more" disabled={loading} onClick={() => { shown.current = page.nextOffset + 5; void refresh(); }}>展开显示</button>}
  </div>;
}
