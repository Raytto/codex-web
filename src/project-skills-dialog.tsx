import { useCallback, useEffect, useState, useRef } from "react";
import { Check, LoaderCircle, Pencil, Plus, Power, Trash2, X } from "lucide-react";
import { api, type Project, type ProjectSkill, type ProjectSkillDetail } from "./api";

const TEMPLATE = `---\nname: my-skill\ndescription: Describe when this project skill should be used.\n---\n\n# Instructions\n\nWrite the project-specific instructions here.\n`;

export function ProjectSkillsDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [selected, setSelected] = useState<ProjectSkillDetail | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState(TEMPLATE);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const dialogRef = useRef<HTMLElement>(null);
  const dirty = creating ? content !== TEMPLATE || Boolean(name) : Boolean(selected && content !== selected.content);
  function canLeave() { return !busy && (!dirty || window.confirm("放弃尚未保存的技能内容？")); }
  function close() { if (canLeave()) onClose(); }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { previous?.focus(); };
  }, []);

  const load = useCallback(async () => {
    setError(""); setLoading(true);
    try { setSkills((await api.projectSkills(project.id)).skills); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "项目技能读取失败"); }
    finally { setLoading(false); }
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  async function selectSkill(skill: ProjectSkill) {
    if (!canLeave()) return;
    setBusy(true); setError("");
    try { const next = (await api.projectSkill(project.id, skill.name)).skill; setSelected(next); setContent(next.content); setCreating(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "项目技能读取失败"); }
    finally { setBusy(false); }
  }

  async function save() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = creating
        ? await api.createProjectSkill(project.id, name, content)
        : selected ? await api.updateProjectSkill(project.id, selected.name, content) : null;
      if (!result) return;
      setSelected(result.skill); setContent(result.skill.content); setCreating(false); setName(""); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "项目技能保存失败"); }
    finally { setBusy(false); }
  }

  async function toggle(skill: ProjectSkillDetail) {
    if (!canLeave()) return;
    setBusy(true); setError("");
    try { const next = (await api.setProjectSkillEnabled(project.id, skill.name, !skill.enabled)).skill; setSelected(next); setContent(next.content); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "项目技能状态更新失败"); }
    finally { setBusy(false); }
  }

  async function remove(skill: ProjectSkillDetail) {
    if (!window.confirm(`确定删除项目技能“${skill.name}”吗？`)) return;
    setBusy(true); setError("");
    try { await api.deleteProjectSkill(project.id, skill.name); setSelected(null); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "项目技能删除失败"); }
    finally { setBusy(false); }
  }

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialogRef} tabIndex={-1} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]'));
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} className="project-dialog project-skills-dialog ui-dialog" role="dialog" aria-modal="true" aria-labelledby="project-skills-title">
      <header><div><h2 id="project-skills-title" className="dialog-title">项目技能 · {project.name}</h2><p>管理这个项目专属的技能，查看内容、编辑或切换启用状态。</p></div><button type="button" onClick={close} disabled={busy} aria-label="关闭项目技能"><X size={18} /></button></header>
      <div className="project-dialog-body project-skills-body">
        <aside className="project-skills-list"><button type="button" className="project-skill-new" disabled={busy} onClick={() => { if (!canLeave()) return; setCreating(true); setSelected(null); setName(""); setContent(TEMPLATE); }}><Plus size={15} />新建技能</button>{skills.map((skill) => <button type="button" key={skill.name} disabled={busy} className={selected?.name === skill.name ? "selected" : undefined} onClick={() => void selectSkill(skill)}><span>{skill.name}</span><small>{skill.enabled ? "已启用" : "已停用"}</small></button>)}{loading && <p role="status">正在加载技能…</p>}{!loading && !skills.length && <small className="project-skills-empty">还没有项目技能</small>}</aside>
        <div className="project-skills-editor">{(creating || selected) ? <>
          <label>技能名称<input aria-label="技能名称" value={creating ? name : selected?.name ?? ""} disabled={!creating || busy} onChange={(event) => setName(event.target.value)} placeholder="例如：release-check" /></label>
          <label>技能内容（SKILL.md）<textarea aria-label="技能内容（SKILL.md）" value={content} disabled={busy} onChange={(event) => setContent(event.target.value)} spellCheck={false} rows={18} /></label>
          {selected && <div className="project-skill-actions"><button type="button" disabled={busy} onClick={() => void toggle(selected)}><Power size={15} />{selected.enabled ? "停用" : "启用"}</button><button type="button" className="danger" disabled={busy} onClick={() => void remove(selected)}><Trash2 size={15} />删除</button></div>}
          <button type="button" className="primary-button" disabled={busy || (creating ? !name.trim() : !selected)} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存技能</button>
        </> : <div className="project-skills-placeholder"><Pencil size={22} /><span>选择技能查看或编辑，或新建一个项目技能。</span></div>}{error && <div className="project-dialog-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => void load()}>重试</button></div>}</div>
      </div>
      <footer><span>启用状态会影响之后启动的任务。删除会移除该技能及其附属文件。</span><button type="button" onClick={close} disabled={busy}>关闭</button></footer>
    </section>
  </div>;
}
