import fs from "node:fs";
import path from "node:path";

export type ProjectFsResult = { directory: string; parent: string | null; directories: Array<{ name: string; path: string }>; virtualRoot?: boolean };

export function projectFilesystem(action: "list" | "create" | "validate" | "initialize", rawPath: string, name?: string, content?: string): ProjectFsResult {
  if (action === "list" && !rawPath.trim() && process.platform === "win32") return windowsDrives();
  let directory = resolveDirectory(rawPath || path.parse(process.cwd()).root);
  if (action === "create") {
    const safeName = String(name ?? "").trim();
    if (!safeName || safeName.length > 100 || safeName === "." || safeName === ".." || /[\\/\u0000-\u001f<>:"|?*]/.test(safeName)) throw new Error("文件夹名称无效");
    const target = path.join(directory, safeName);
    fs.mkdirSync(target);
    directory = resolveDirectory(target);
  }
  if (action === "initialize") installProjectInstructions(directory, String(content ?? ""));
  if (action === "validate" || action === "initialize") return { directory, parent: parentDirectory(directory), directories: [] };
  const directories = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .slice(0, 1000)
    .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return { directory, parent: parentDirectory(directory), directories };
}

export function resolveDirectory(rawPath: string): string {
  if (!rawPath || rawPath.includes("\0") || rawPath.length > 4096 || !path.isAbsolute(rawPath)) throw new Error("项目路径必须是绝对路径");
  if (process.platform === "win32" && /^(?:\\\\[.?]\\|\\\\\?\\GLOBALROOT)/i.test(rawPath)) throw new Error("不支持 Windows 设备路径");
  let canonical: string;
  try { canonical = fs.realpathSync.native(rawPath); }
  catch { throw new Error("项目文件夹不存在或无法访问"); }
  if (!fs.statSync(canonical).isDirectory()) throw new Error("项目路径不是文件夹");
  return canonical;
}

export function resolveReadableFile(projectRoot: string, requestedPath: string): { path: string; name: string; size: number } {
  const raw = requestedPath.trim().replace(/^<|>$/g, "");
  if (!raw || raw.includes("\0") || raw.length > 4096) throw new Error("文件路径无效");
  if (process.platform === "win32" && /^(?:\\\\[.?]\\|\\\\\?\\GLOBALROOT)/i.test(raw)) throw new Error("不支持 Windows 设备路径");
  const candidate = path.isAbsolute(raw) ? raw : path.resolve(resolveDirectory(projectRoot), raw);
  let canonical: string;
  try { canonical = fs.realpathSync.native(candidate); }
  catch { throw new Error("文件不存在或无法访问"); }
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) throw new Error("所选路径不是普通文件");
  if (stat.size > 100 * 1024 * 1024) throw new Error("文件超过 100 MiB，暂不支持下载");
  return { path: canonical, name: path.basename(canonical), size: stat.size };
}

function windowsDrives(): ProjectFsResult {
  const directories: Array<{ name: string; path: string }> = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try { if (fs.statSync(drive).isDirectory()) directories.push({ name: drive, path: drive }); }
    catch { /* Drive is absent or unavailable to this user. */ }
  }
  return { directory: "", parent: null, directories, virtualRoot: true };
}

function parentDirectory(directory: string): string | null {
  const parsed = path.parse(directory);
  if (directory === parsed.root) return process.platform === "win32" ? "" : null;
  return path.dirname(directory);
}

function installProjectInstructions(directory: string, content: string): void {
  if (!content) throw new Error("缺少项目规则模板");
  const target = path.join(directory, "AGENTS.md");
  if (!fs.existsSync(target)) fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
  const gitignore = path.join(directory, ".gitignore");
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, "/AGENTS.md\n", "utf8");
  else {
    const current = fs.readFileSync(gitignore, "utf8");
    if (!/^\/AGENTS\.md\s*$/m.test(current)) fs.appendFileSync(gitignore, `${current.endsWith("\n") ? "" : "\n"}/AGENTS.md\n`, "utf8");
  }
}
