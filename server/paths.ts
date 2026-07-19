import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const LEGACY_WORKSPACE_AGENTS = `# Conversation workspace\n\n- Work only inside this conversation directory unless the user explicitly asks otherwise.\n- User uploads are in uploads/. Save only finished deliverables in outputs/.\n- Put intermediate files, extracted assets, caches, and temporary environments in .runtime/; the service deletes it after every turn.\n- Prefer replying in Chinese unless the user requests another language.\n- Never reveal credentials, authentication files, browser profiles, or unrelated local data.\n- When a task creates useful files, mention only the final filenames the user needs. Do not list process files.\n`;

const MANAGED_INSTRUCTIONS_START = "<!-- codex-web-managed-start -->";
const MANAGED_INSTRUCTIONS_END = "<!-- codex-web-managed-end -->";
const WORKSPACE_AGENTS = `# Conversation workspace

${MANAGED_INSTRUCTIONS_START}
- Work only inside this conversation directory unless the user explicitly asks otherwise.
- Tenant boundary: access only this conversation and ../../library. Never read codex-home, application data, sibling conversations, or another user under /app/tenants.
- User uploads are in uploads/. Save only finished deliverables in outputs/.
- Put intermediate files, extracted assets, caches, and temporary environments in .runtime/; the service deletes it after every turn.
- Never reveal credentials, authentication files, browser profiles, or unrelated local data.
- In replies, mention only final filenames the user needs. Never expose absolute paths or list process files.
- This web runtime does not provide \`load_workspace_dependencies\` or \`@oai/artifact-tool\`. Do not invoke the artifact-backed Spreadsheets skill here.
- Use the interpreter in \`CWW_SHARED_PYTHON\`; keep temporary scripts and caches in \`CWW_JOB_RUNTIME\`. Never install into the shared environment. If a required package is missing, invoke \`CWW_PYTHON_RUNNER\` in temporary mode instead.
- For local Excel work, use the pinned \`openpyxl\`/\`pandas\` packages. Never execute macros or automate a desktop Excel application.
- Preserve the source workbook by writing a new file under outputs/. For \`.xlsm\`, load with \`keep_vba=True\`; for all workbooks, retain formulas and formatting where possible, reopen the saved file, and verify requested row counts, keys, formulas, and sheet structure before delivery.
${MANAGED_INSTRUCTIONS_END}
`;

const GLOBAL_AGENTS = `# Codex Web Agent

- Prefer replying in Chinese unless the user requests another language.
- The persistent user knowledge library is in ../library relative to this file.
- Read the library when it is relevant. Update it only with useful, durable, user-approved knowledge; never save credentials, cookies, tokens, or authentication files.
- Keep user preferences in ../library/PROFILE.md, maintain ../library/INDEX.md as a concise catalog, and put project knowledge under ../library/projects/.
- Conversation uploads and generated deliverables stay in that conversation unless the user asks to organize or retain them in the library.
`;

const LIBRARY_AGENTS = `# Long-term knowledge library

- This directory belongs to one web user and persists across conversations.
- PROFILE.md stores stable preferences; INDEX.md catalogs durable topics and projects.
- Put source material and project facts under projects/, new unclassified material under inbox/, and retired material under archive/.
- Preserve originals when reorganizing important user files, and do not store credentials or authentication data.
`;

const TRANSIENT_OUTPUT_SUFFIXES = new Set([".bak", ".lock", ".part", ".swp", ".temp", ".tmp"]);

export function newId(): string {
  return crypto.randomUUID();
}

function assertUserId(userId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid user id");
}

export type TenantPaths = {
  root: string;
  codexHome: string;
  library: string;
  conversations: string;
};

export function tenantPaths(tenantRoot: string, userId: string): TenantPaths {
  assertUserId(userId);
  const root = path.resolve(tenantRoot, userId);
  return {
    root,
    codexHome: path.join(root, "codex-home"),
    library: path.join(root, "library"),
    conversations: path.join(root, "conversations"),
  };
}

export function ensureTenant(tenantRoot: string, userId: string): TenantPaths {
  const paths = tenantPaths(tenantRoot, userId);
  for (const directory of [paths.codexHome, paths.library, paths.conversations, path.join(paths.library, "inbox"), path.join(paths.library, "projects"), path.join(paths.library, "archive")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const globalAgents = path.join(paths.codexHome, "AGENTS.md");
  if (!fs.existsSync(globalAgents)) fs.writeFileSync(globalAgents, GLOBAL_AGENTS, "utf8");
  const libraryAgents = path.join(paths.library, "AGENTS.md");
  if (!fs.existsSync(libraryAgents)) fs.writeFileSync(libraryAgents, LIBRARY_AGENTS, "utf8");
  const profile = path.join(paths.library, "PROFILE.md");
  if (!fs.existsSync(profile)) fs.writeFileSync(profile, "# User profile\n\n<!-- Store stable preferences here. -->\n", "utf8");
  const index = path.join(paths.library, "INDEX.md");
  if (!fs.existsSync(index)) fs.writeFileSync(index, "# Knowledge index\n\n<!-- Keep a concise catalog of durable topics and projects here. -->\n", "utf8");
  return paths;
}

export function ensureTenantWorkspace(tenantRoot: string, userId: string, conversationId: string): string {
  return ensureWorkspace(ensureTenant(tenantRoot, userId).conversations, conversationId);
}

export function ensureWorkspace(workspaceRoot: string, conversationId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new Error("Invalid conversation id");
  const root = path.resolve(workspaceRoot, conversationId);
  fs.mkdirSync(path.join(root, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
  const agentsPath = path.join(root, "AGENTS.md");
  syncWorkspaceInstructions(agentsPath);
  const gitignorePath = path.join(root, ".gitignore");
  if (!fs.existsSync(gitignorePath)) fs.writeFileSync(gitignorePath, ".codex/\n.runtime/\n", "utf8");
  if (!fs.existsSync(path.join(root, ".git"))) {
    const result = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Unable to initialize workspace: ${result.stderr}`);
  }
  return root;
}

function syncWorkspaceInstructions(agentsPath: string): void {
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, WORKSPACE_AGENTS, "utf8");
    return;
  }
  const existing = fs.readFileSync(agentsPath, "utf8");
  if (existing === LEGACY_WORKSPACE_AGENTS) {
    fs.writeFileSync(agentsPath, WORKSPACE_AGENTS, "utf8");
    return;
  }
  const start = existing.indexOf(MANAGED_INSTRUCTIONS_START);
  const end = existing.indexOf(MANAGED_INSTRUCTIONS_END);
  if (start >= 0 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MANAGED_INSTRUCTIONS_END.length);
    const managed = WORKSPACE_AGENTS.slice(WORKSPACE_AGENTS.indexOf(MANAGED_INSTRUCTIONS_START), WORKSPACE_AGENTS.indexOf(MANAGED_INSTRUCTIONS_END) + MANAGED_INSTRUCTIONS_END.length);
    const updated = `${before}${managed}${after}`;
    if (updated !== existing) fs.writeFileSync(agentsPath, updated, "utf8");
    return;
  }
  const managed = WORKSPACE_AGENTS.slice(WORKSPACE_AGENTS.indexOf(MANAGED_INSTRUCTIONS_START));
  fs.writeFileSync(agentsPath, `${existing.trimEnd()}\n\n${managed}`, "utf8");
}

export function safeUploadName(originalName: string): { diskName: string; displayName: string } {
  let displayName = path.basename(normalizeUploadFileName(originalName)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  if (!displayName) displayName = "file";
  const extension = path.extname(displayName).slice(0, 16);
  return { diskName: `${newId()}${extension}`, displayName: displayName.slice(0, 180) };
}

/**
 * Browsers send multipart filenames as UTF-8 bytes, while Busboy/Multer may
 * decode the legacy filename parameter as Latin-1. Repair only strings that
 * form a complete, valid UTF-8 byte sequence so genuine Latin-1 names such as
 * "café.xlsx" are left untouched.
 */
export function normalizeUploadFileName(originalName: string): string {
  const normalized = originalName.normalize("NFC");
  const characters = Array.from(normalized);
  if (!characters.some((character) => character.codePointAt(0)! >= 0x80)) return normalized;
  if (characters.some((character) => character.codePointAt(0)! > 0xff)) return normalized;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(normalized, "latin1"));
    return decoded.normalize("NFC");
  } catch {
    return normalized;
  }
}

export function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const normalized = normalizeStoredRelativePath(relativePath);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path escapes workspace");
  }
  return resolved;
}

/** Store paths in a platform-neutral form while accepting legacy Windows rows. */
export function normalizeStoredRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

export function removeWorkspace(workspaceRoot: string, conversationId: string): void {
  const root = ensureWorkspace(workspaceRoot, conversationId);
  const expectedParent = path.resolve(workspaceRoot);
  if (path.dirname(root) !== expectedParent) throw new Error("Refusing to remove unexpected path");
  fs.rmSync(root, { recursive: true, force: true });
}

export function removeCodexThreadFiles(codexHome: string, threadId: string): number {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error("Invalid Codex thread id");
  let removed = 0;
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const root = path.resolve(codexHome, directoryName);
    if (!fs.existsSync(root)) continue;
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.resolve(directory, entry.name);
        if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to inspect unexpected Codex session path");
        if (entry.isDirectory()) visit(absolute);
        if (entry.isFile() && entry.name.includes(threadId)) {
          fs.rmSync(absolute, { force: true });
          removed += 1;
        }
      }
    };
    visit(root);
  }
  return removed;
}

export async function snapshotWorkspace(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".codex") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      if (entry.isFile()) {
        const stat = await fs.promises.stat(absolute);
        snapshot.set(normalizeStoredRelativePath(path.relative(root, absolute)), `${stat.size}:${stat.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return snapshot;
}

export function isDeliverablePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.length < 2 || !["outputs", "deliverables"].includes(parts[0].toLowerCase())) return false;
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  const name = parts.at(-1)!;
  if (name.startsWith("~$") || name.endsWith("~")) return false;
  return !TRANSIENT_OUTPUT_SUFFIXES.has(path.extname(name).toLowerCase());
}

export function isPersistedDeliverablePath(relativePath: string): boolean {
  const parts = normalizeStoredRelativePath(relativePath).split("/");
  return parts.length === 3 && parts[0] === "deliverables" && /^[0-9a-f-]{36}$/i.test(parts[1])
    && parts.every((part) => part !== "." && part !== ".." && !part.startsWith("."));
}

function persistedDeliverablePath(fileId: string, originalPath: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new Error("Invalid file id");
  return path.posix.join("deliverables", fileId, path.basename(normalizeStoredRelativePath(originalPath)));
}

export async function persistDeliverable(dataRoot: string, workspace: string, relativePath: string, fileId: string): Promise<string> {
  const source = resolveInside(workspace, relativePath);
  const storedPath = persistedDeliverablePath(fileId, relativePath);
  const destination = resolveInside(dataRoot, storedPath);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination);
  return storedPath;
}

export function persistDeliverableSync(dataRoot: string, workspace: string, relativePath: string, fileId: string): string {
  const source = resolveInside(workspace, relativePath);
  const storedPath = persistedDeliverablePath(fileId, relativePath);
  const destination = resolveInside(dataRoot, storedPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return storedPath;
}

export function removePersistedDeliverable(dataRoot: string, relativePath: string): void {
  if (!isPersistedDeliverablePath(relativePath)) return;
  const absolute = resolveInside(dataRoot, relativePath);
  const fileDirectory = path.dirname(absolute);
  const expectedParent = path.resolve(dataRoot, "deliverables");
  if (path.dirname(fileDirectory) !== expectedParent) throw new Error("Refusing to remove unexpected deliverable path");
  fs.rmSync(fileDirectory, { recursive: true, force: true });
}

export async function snapshotDeliverables(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const outputRoot = path.join(root, "outputs");
  async function walk(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      if (entry.isFile()) {
        const relativePath = normalizeStoredRelativePath(path.relative(root, absolute));
        if (!isDeliverablePath(relativePath)) continue;
        const stat = await fs.promises.stat(absolute);
        snapshot.set(relativePath, `${stat.size}:${stat.mtimeMs}`);
      }
    }
  }
  await walk(outputRoot);
  return snapshot;
}
