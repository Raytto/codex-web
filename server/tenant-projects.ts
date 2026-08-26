import fs from "node:fs";
import path from "node:path";
import type { TenantPaths } from "./paths.js";
import { LEGACY_LIBRARY_AGENTS } from "./paths.js";
import { DEFAULT_PROJECT_AGENTS_TEMPLATE, installProjectInstructions } from "./project-instructions.js";
import type { RemoteProjectFsResult } from "./remote-worker-protocol.js";

export const TENANT_LOCAL_EXECUTOR_ID = "tenant-local";
export const TENANT_DEFAULT_PROJECT_DIRECTORY = "default";
const TENANT_PROJECT_LAYOUT_MARKER = ".codex-web-project-layout-v1";

const DEFAULT_PROJECT_AGENTS = `${DEFAULT_PROJECT_AGENTS_TEMPLATE.trim()}\n
## Default knowledge project

- PROFILE.md stores stable preferences and INDEX.md is the concise durable catalog for this default project.
- Put source material and project facts under projects/, new unclassified material under inbox/, and retired material under archive/.
- Preserve originals when reorganizing important user files.
`;

export function tenantDefaultProjectRoot(tenant: TenantPaths): string {
  return path.join(tenant.library, TENANT_DEFAULT_PROJECT_DIRECTORY);
}

export function ensureTenantProjectLayout(tenant: TenantPaths): string {
  fs.mkdirSync(tenant.library, { recursive: true });
  const defaultRoot = tenantDefaultProjectRoot(tenant);
  assertDirectoryOrAbsent(defaultRoot, "默认项目路径");
  fs.mkdirSync(defaultRoot, { recursive: true, mode: 0o770 });

  const marker = path.join(defaultRoot, TENANT_PROJECT_LAYOUT_MARKER);
  if (!fs.existsSync(marker)) {
    for (const entry of fs.readdirSync(tenant.library, { withFileTypes: true })) {
      // Personal memory is account-scoped, not project-scoped. Keep it beside
      // the project container so every project/thread can resolve the same
      // account library and future starts do not create duplicate copies.
      if (entry.name === TENANT_DEFAULT_PROJECT_DIRECTORY || entry.name === "personal") continue;
      const source = path.join(tenant.library, entry.name);
      const destination = path.join(defaultRoot, entry.name);
      if (fs.existsSync(destination)) throw new Error(`默认项目迁移发现冲突文件：${entry.name}`);
      fs.renameSync(source, destination);
    }
  }

  for (const directory of ["inbox", "projects", "archive"]) {
    fs.mkdirSync(path.join(defaultRoot, directory), { recursive: true });
  }
  const agentsPath = path.join(defaultRoot, "AGENTS.md");
  if (fs.existsSync(agentsPath) && fs.readFileSync(agentsPath, "utf8") === LEGACY_LIBRARY_AGENTS) {
    fs.writeFileSync(agentsPath, DEFAULT_PROJECT_AGENTS, "utf8");
  }
  installProjectInstructions(defaultRoot, DEFAULT_PROJECT_AGENTS);
  const profile = path.join(defaultRoot, "PROFILE.md");
  if (!fs.existsSync(profile)) fs.writeFileSync(profile, "# User profile\n\n<!-- Store stable preferences here. -->\n", "utf8");
  const index = path.join(defaultRoot, "INDEX.md");
  if (!fs.existsSync(index)) fs.writeFileSync(index, "# Knowledge index\n\n<!-- Keep a concise catalog of durable topics and projects here. -->\n", "utf8");
  if (!fs.existsSync(marker)) {
    const temporary = `${marker}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, "tenant-project-layout-v1\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, marker);
  }
  return defaultRoot;
}

export function listTenantProjectDirectories(tenant: TenantPaths, directory = ""): RemoteProjectFsResult {
  const container = realTenantProjectContainer(tenant);
  const selected = directory.trim() ? validateTenantProjectLocation(tenant, directory, true) : container;
  if (selected !== container) return { directory: selected, parent: container, directories: [] };
  const directories = fs.readdirSync(container, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: path.join(container, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return { directory: container, parent: null, directories };
}

export function createTenantProjectDirectory(tenant: TenantPaths, parent: string, rawName: string): RemoteProjectFsResult {
  const container = realTenantProjectContainer(tenant);
  const selectedParent = parent.trim() ? path.resolve(parent) : container;
  if (selectedParent !== container || fs.realpathSync(selectedParent) !== container) throw new Error("新项目只能创建在个人知识库根目录下");
  const name = rawName.trim();
  if (!name || name === "." || name === ".." || name.length > 120 || /[\\/\0]/.test(name)) throw new Error("项目文件夹名称无效");
  const target = path.join(container, name);
  if (fs.existsSync(target)) throw new Error("同名文件夹已经存在");
  fs.mkdirSync(target, { mode: 0o770 });
  return listTenantProjectDirectories(tenant, target);
}

export function validateTenantProjectDirectory(tenant: TenantPaths, directory: string): RemoteProjectFsResult {
  const selected = validateTenantProjectLocation(tenant, directory, false);
  return { directory: selected, parent: realTenantProjectContainer(tenant), directories: [] };
}

export function initializeTenantProjectDirectory(tenant: TenantPaths, directory: string, content: string): RemoteProjectFsResult {
  const selected = validateTenantProjectLocation(tenant, directory, false);
  installProjectInstructions(selected, content);
  return { directory: selected, parent: realTenantProjectContainer(tenant), directories: [] };
}

export function assertTenantProjectRoot(tenant: TenantPaths, directory: string): string {
  return validateTenantProjectLocation(tenant, directory, false);
}

function realTenantProjectContainer(tenant: TenantPaths): string {
  assertDirectoryOrAbsent(tenant.library, "个人知识库根目录");
  fs.mkdirSync(tenant.library, { recursive: true });
  return fs.realpathSync(tenant.library);
}

function validateTenantProjectLocation(tenant: TenantPaths, directory: string, allowContainer: boolean): string {
  if (!directory.trim()) throw new Error("项目文件夹不能为空");
  const container = realTenantProjectContainer(tenant);
  const requested = path.resolve(directory);
  const stat = fs.lstatSync(requested, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("项目路径必须是普通文件夹，不能使用符号链接");
  const resolved = fs.realpathSync(requested);
  if (resolved === container) {
    if (allowContainer) return resolved;
    throw new Error("知识库根目录只是项目容器，请选择其中一个项目文件夹");
  }
  if (path.dirname(resolved) !== container) throw new Error("项目只能选择个人知识库根目录下的一级文件夹");
  return resolved;
}

function assertDirectoryOrAbsent(target: string, label: string): void {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`${label}必须是普通文件夹`);
}
