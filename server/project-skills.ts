import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PROJECT_SKILLS_DIRECTORY = ".agents/skills";
export const PROJECT_SKILL_MAX_NAME = 64;
export const PROJECT_SKILL_MAX_CONTENT = 256 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type ProjectSkill = {
  name: string;
  description: string;
  enabled: boolean;
  updatedAt: string;
  size: number;
};

export type ProjectSkillDetail = ProjectSkill & { content: string };

export function isValidProjectSkillName(name: string): boolean {
  return name.length > 0 && name.length <= PROJECT_SKILL_MAX_NAME && SKILL_NAME_PATTERN.test(name);
}

export function validateProjectSkillContent(name: string, raw: string): { content: string; description: string } {
  if (!isValidProjectSkillName(name)) throw new Error("技能名称只能使用小写字母、数字和连字符。");
  if (typeof raw !== "string") throw new Error("SKILL.md 内容无效。");
  const content = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!content.trim() || content.length > PROJECT_SKILL_MAX_CONTENT) throw new Error("SKILL.md 不能为空或超过 256 KiB。");
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error("SKILL.md 必须包含 YAML front matter。");
  const frontMatter = match[1];
  const declaredName = frontMatter.match(/^name:\s*([^\n#]+)\s*$/m)?.[1]?.trim();
  const description = frontMatter.match(/^description:\s*([^\n#]+)\s*$/m)?.[1]?.trim();
  if (declaredName !== name) throw new Error("SKILL.md 的 name 必须与技能名称一致。");
  if (!description) throw new Error("SKILL.md 必须包含非空 description。");
  return { content: content.endsWith("\n") ? content : `${content}\n`, description: description.slice(0, 500) };
}

export function listProjectSkills(projectRoot: string): ProjectSkill[] {
  const roots = ensureRoots(projectRoot, false);
  return [...readSkillDirectory(roots.active, true), ...readSkillDirectory(roots.disabled, false)]
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function readProjectSkill(projectRoot: string, name: string): ProjectSkillDetail {
  const roots = ensureRoots(projectRoot, false);
  const normalized = assertSkillName(name);
  const active = path.join(roots.active, normalized);
  const disabled = path.join(roots.disabled, normalized);
  const enabled = fs.existsSync(active);
  const directory = enabled ? active : disabled;
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("项目技能不存在。");
  const file = path.join(directory, "SKILL.md");
  const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) throw new Error("项目技能文件无效。");
  const content = fs.readFileSync(file, "utf8");
  const validated = validateProjectSkillContent(normalized, content);
  return { name: normalized, description: validated.description, enabled, updatedAt: fileStat.mtime.toISOString(), size: Buffer.byteLength(validated.content), content: validated.content };
}

export function createProjectSkill(projectRoot: string, name: string, rawContent: string, enabled = true): ProjectSkillDetail {
  const roots = ensureRoots(projectRoot, true);
  const normalized = assertSkillName(name);
  const validated = validateProjectSkillContent(normalized, rawContent);
  const directory = path.join(enabled ? roots.active : roots.disabled, normalized);
  if (fs.existsSync(directory)) throw new Error("同名项目技能已经存在。");
  fs.mkdirSync(directory, { recursive: false, mode: 0o770 });
  try {
    atomicWrite(path.join(directory, "SKILL.md"), validated.content);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return readProjectSkill(projectRoot, normalized);
}

export function updateProjectSkill(projectRoot: string, name: string, rawContent: string): ProjectSkillDetail {
  const current = readProjectSkill(projectRoot, name);
  const validated = validateProjectSkillContent(current.name, rawContent);
  const roots = ensureRoots(projectRoot, true);
  atomicWrite(path.join(current.enabled ? roots.active : roots.disabled, current.name, "SKILL.md"), validated.content);
  return readProjectSkill(projectRoot, current.name);
}

export function setProjectSkillEnabled(projectRoot: string, name: string, enabled: boolean): ProjectSkillDetail {
  const current = readProjectSkill(projectRoot, name);
  if (current.enabled === enabled) return current;
  const roots = ensureRoots(projectRoot, true);
  const source = path.join(enabled ? roots.disabled : roots.active, current.name);
  const target = path.join(enabled ? roots.active : roots.disabled, current.name);
  if (fs.existsSync(target)) throw new Error("项目技能状态发生冲突，请刷新后重试。");
  fs.renameSync(source, target);
  return readProjectSkill(projectRoot, current.name);
}

export function deleteProjectSkill(projectRoot: string, name: string): void {
  const current = readProjectSkill(projectRoot, name);
  const roots = ensureRoots(projectRoot, true);
  const directory = path.join(current.enabled ? roots.active : roots.disabled, current.name);
  fs.rmSync(directory, { recursive: true, force: false });
}

function assertSkillName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!isValidProjectSkillName(normalized)) throw new Error("技能名称只能使用小写字母、数字和连字符。");
  return normalized;
}

function ensureRoots(projectRoot: string, create: boolean): { active: string; disabled: string } {
  const root = path.resolve(projectRoot);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error("项目路径必须是普通文件夹。");
  const agents = path.join(root, ".agents");
  const skills = path.join(agents, "skills");
  const disabled = path.join(skills, ".disabled");
  for (const [target, label] of [[agents, ".agents"], [skills, "skills"], [disabled, ".disabled"]] as const) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`${label} 必须是普通文件夹，禁止使用符号链接。`);
  }
  if (create) {
    fs.mkdirSync(skills, { recursive: true, mode: 0o770 });
    fs.mkdirSync(disabled, { recursive: true, mode: 0o770 });
  }
  return { active: skills, disabled };
}

function readSkillDirectory(root: string, enabled: boolean): ProjectSkill[] {
  if (!fs.existsSync(root)) return [];
  const result: ProjectSkill[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isValidProjectSkillName(entry.name)) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    try {
      const validated = validateProjectSkillContent(entry.name, fs.readFileSync(file, "utf8"));
      result.push({ name: entry.name, description: validated.description, enabled, updatedAt: stat.mtime.toISOString(), size: Buffer.byteLength(validated.content) });
    } catch {
      // Invalid/unmanaged directories are not exposed as executable skills.
    }
  }
  return result;
}

function atomicWrite(target: string, content: string): void {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o660, flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}
