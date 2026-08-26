import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(async () => {
    setError("");
    try { setSkills((await api.projectSkills(project.id)).skills); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "项目技能读取失败"); }
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  async function selectSkill(skill: ProjectSkill) {
    setBusy(true); setError("");
    try { setSelected((await api.projectSkill(project.id, skill.name)).skill); setCreating(false); }
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
      setSelected(result.skill); setCreating(false); setName(""); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "项目技能保存失败"); }
    finally { setBusy(false); }
  }

  async function toggle(skill: ProjectSkillDetail) {
    setBusy(true); setError("");
    try { const next = (await api.setProjectSkillEnabled(project.id, skill.name, !skill.enabled)).skill; setSelected(next); await load(); }
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

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="project-dialog project-skills-dialog" role="dialog" aria-modal="true" aria-labelledby="project-skills-title">
      <header><div><h2 id="project-skills-title">项目技能 · {project.name}</h2><p>仅当前账号的个人受限项目可管理；技能保存在项目目录 .agents/skills，不会写入账号 Codex Home。</p></div><button type="button" onClick={onClose} aria-label="关闭项目技能"><X size={18} /></button></header>
      <div className="project-dialog-body project-skills-body">
        <aside className="project-skills-list"><button type="button" className="project-skill-new" onClick={() => { setCreating(true); setSelected(null); setName(""); setContent(TEMPLATE); }}><Plus size={15} />新建技能</button>{skills.map((skill) => <button type="button" key={skill.name} className={selected?.name === skill.name ? "selected" : undefined} onClick={() => void selectSkill(skill)}><span>{skill.name}</span><small>{skill.enabled ? "已启用" : "已停用"}</small></button>)}{!skills.length && <small className="project-skills-empty">还没有项目技能</small>}</aside>
        <div className="project-skills-editor">{(creating || selected) ? <>
          <label>技能名称<input value={creating ? name : selected?.name ?? ""} disabled={!creating || busy} onChange={(event) => setName(event.target.value)} placeholder="例如：release-check" /></label>
          <label>SKILL.md<textarea value={content} disabled={busy} onChange={(event) => setContent(event.target.value)} spellCheck={false} rows={18} /></label>
          {selected && <div className="project-skill-actions"><button type="button" disabled={busy} onClick={() => void toggle(selected)}><Power size={15} />{selected.enabled ? "停用" : "启用"}</button><button type="button" className="danger" disabled={busy} onClick={() => void remove(selected)}><Trash2 size={15} />删除</button></div>}
          <button type="button" className="primary-button" disabled={busy || (creating ? !name.trim() : !selected)} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存技能</button>
        </> : <div className="project-skills-placeholder"><Pencil size={22} /><span>选择技能查看或编辑，或新建一个项目技能。</span></div>}{error && <div className="project-dialog-error">{error}</div>}</div>
      </div>
      <footer><span>宿主项目/远端项目暂不支持网页 CRUD，界面不会静默假装成功。</span><button type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}
