import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const PERSONAL_MEMORY_EDITABLE_FILES = ["PROFILE.md", "PREFERENCES.md", "KNOWLEDGE.md", "NOW.md"] as const;
export type PersonalMemoryEditableFileName = typeof PERSONAL_MEMORY_EDITABLE_FILES[number];
export const PERSONAL_MEMORY_FILE_MAX_CHARACTERS = 6_000;
// The owner gets an empty, opt-in file set so the feature is discoverable. No
// profile data is shipped; other accounts can enable it through provisioning.
export const PERSONAL_MEMORY_DEFAULT_ENABLED_USERNAMES = new Set(["owner", "codex"]);

const PERSONAL_MEMORY_DEFAULT_FILES: Record<PersonalMemoryEditableFileName, string> = {
  "PROFILE.md": "# Profile\n\n<!-- Store stable personal facts here. -->\n",
  "PREFERENCES.md": "# Preferences\n\n<!-- Store durable response and workflow preferences here. -->\n",
  "KNOWLEDGE.md": "# Knowledge\n\n<!-- Store durable personal knowledge here. -->\n",
  "NOW.md": "# Now\n\n<!-- Store temporary but still useful current context here. -->\n",
};

export type PersonalMemoryManagedFile = {
  name: string;
  content: string;
  editable: boolean;
  updatedAt: string | null;
  maxCharacters: number;
};

export function personalMemoryEnabled(library: string): boolean {
  return isRegularFile(path.join(library, "personal", "ENABLED"));
}

/**
 * Idempotent onboarding for accounts whose personal memory is part of the
 * product contract. This deliberately creates real files and an enable marker
 * rather than relying on a one-off deployment touch command.
 */
export function ensurePersonalMemoryLibrary(library: string, username: string): boolean {
  if (!PERSONAL_MEMORY_DEFAULT_ENABLED_USERNAMES.has(username.trim().toLowerCase())) return false;
  const personalRoot = path.resolve(library, "personal");
  const rootStat = fs.lstatSync(personalRoot, { throwIfNoEntry: false });
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) throw new Error("个人知识目录必须是普通文件夹。");
  fs.mkdirSync(personalRoot, { recursive: true, mode: 0o770 });
  for (const name of PERSONAL_MEMORY_EDITABLE_FILES) {
    const target = path.join(personalRoot, name);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`个人知识文件 ${name} 不是普通文件。`);
    if (!stat) atomicWrite(target, PERSONAL_MEMORY_DEFAULT_FILES[name]);
  }
  const auto = path.join(personalRoot, "AUTO.md");
  const autoStat = fs.lstatSync(auto, { throwIfNoEntry: false });
  if (autoStat && (!autoStat.isFile() || autoStat.isSymbolicLink())) throw new Error("个人知识自动提炼文件不是普通文件。");
  if (!autoStat) atomicWrite(auto, "# Auto extracted memory\n\n");
  const marker = path.join(personalRoot, "ENABLED");
  const markerStat = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (markerStat && (!markerStat.isFile() || markerStat.isSymbolicLink())) throw new Error("个人知识启用标记不是普通文件。");
  if (!markerStat) atomicWrite(marker, "personal-memory-v1\n");
  return true;
}

export function readPersonalMemoryManagedFiles(library: string): PersonalMemoryManagedFile[] {
  const personalRoot = path.resolve(library, "personal");
  return [...PERSONAL_MEMORY_EDITABLE_FILES, "AUTO.md"].map((name) => {
    const target = path.join(personalRoot, name);
    if (!isRegularFile(target)) {
      return { name, content: "", editable: name !== "AUTO.md", updatedAt: null, maxCharacters: PERSONAL_MEMORY_FILE_MAX_CHARACTERS };
    }
    const stat = fs.statSync(target);
    return {
      name,
      content: fs.readFileSync(target, "utf8").replace(/^\uFEFF/, ""),
      editable: name !== "AUTO.md",
      updatedAt: stat.mtime.toISOString(),
      maxCharacters: PERSONAL_MEMORY_FILE_MAX_CHARACTERS,
    };
  });
}

export function isPersonalMemoryEditableFileName(value: string): value is PersonalMemoryEditableFileName {
  return (PERSONAL_MEMORY_EDITABLE_FILES as readonly string[]).includes(value);
}

export function normalizePersonalMemoryFileContent(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (normalized.length > PERSONAL_MEMORY_FILE_MAX_CHARACTERS) {
    throw new Error(`文件不能超过 ${PERSONAL_MEMORY_FILE_MAX_CHARACTERS} 个字符。`);
  }
  return normalized.endsWith("\n") || normalized.length === PERSONAL_MEMORY_FILE_MAX_CHARACTERS
    ? normalized
    : `${normalized}\n`;
}

export function writePersonalMemoryManagedFile(library: string, name: PersonalMemoryEditableFileName, content: string): void {
  const personalRoot = path.resolve(library, "personal");
  const target = path.join(personalRoot, name);
  if (!personalMemoryEnabled(library)) throw new Error("个人知识尚未启用。");
  if (fs.existsSync(target) && !isRegularFile(target)) throw new Error("个人知识文件不是普通文件，无法编辑。");
  atomicWrite(target, normalizePersonalMemoryFileContent(content));
}

function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o660 });
    const descriptor = fs.openSync(temporary, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function isRegularFile(target: string): boolean {
  try { return fs.lstatSync(target).isFile(); }
  catch { return false; }
}
