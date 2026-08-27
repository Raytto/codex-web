import { BASE_PATH, fileUrl, type WorkFile } from "./api";

export type ResolvedMessageLink =
  | { kind: "preview"; href: string }
  | { kind: "raw"; href: string }
  | { kind: "download"; href: string }
  | { kind: "unavailable"; path?: string }
  | { kind: "regular"; href: string };

export type FileReaderKind = "markdown" | "html" | "pdf" | "epub";

export type RemoteMessageFileReference = {
  sourcePath: string;
  label: string;
};

function decodePath(value: string): string {
  let decoded = value.trim().replace(/^<|>$/g, "");
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function normalizePath(value: string, allowParentSegments = false): string | null {
  let normalized = decodePath(value)
    .replace(/^file:\/\/\/(?=[a-z]:)/i, "")
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/");
  if (/^\/[a-z]:\//i.test(normalized)) normalized = normalized.slice(1);
  const parts = normalized.split("/");
  if ((!allowParentSegments && parts.some((part) => part === "..")) || normalized.includes("\0")) return null;
  return normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function isLocalMachinePath(raw: string, normalized: string): boolean {
  const decoded = decodePath(raw);
  return /^[a-z]:[\\/]/i.test(decoded)
    || /^file:\/\//i.test(decoded)
    || /^\\\\/.test(decoded)
    || /^\/(?:home|users|var|tmp|srv|opt)\//i.test(normalized)
    || /\/workspaces\//i.test(normalized);
}

export function isLocalMarkdownUrl(url: string): boolean {
  return /^sandbox:/i.test(url) || /^[a-z]:[\\/]/i.test(url) || /^file:\/\//i.test(url) || /^\\\\/.test(url);
}

export function isBrowserPreviewable(file: WorkFile): boolean {
  const mimeType = file.mime_type.split(";", 1)[0].trim().toLowerCase();
  return mimeType.startsWith("image/")
    || mimeType === "application/pdf"
    || mimeType === "application/epub+zip"
    || /^text\/(?:plain|csv)$/.test(mimeType);
}

export function fileReaderKind(file: Pick<WorkFile, "original_name" | "mime_type">): FileReaderKind | null {
  const mimeType = file.mime_type.split(";", 1)[0].trim().toLowerCase();
  const extension = file.original_name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  if (mimeType === "text/markdown" || [".md", ".markdown"].includes(extension)) return "markdown";
  if (mimeType === "text/html" || [".html", ".htm"].includes(extension)) return "html";
  if (mimeType === "application/pdf" || extension === ".pdf") return "pdf";
  if (mimeType === "application/epub+zip" || extension === ".epub") return "epub";
  return null;
}

export function filePreviewUrl(file: Pick<WorkFile, "id">): string {
  return `${BASE_PATH}/files/${encodeURIComponent(file.id)}/preview`;
}

export function publicFilePreviewUrl(file: Pick<WorkFile, "id">): string {
  return `${filePreviewUrl(file)}/public`;
}

export function filePreviewIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/files\/([^/]+)\/preview\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function publicFilePreviewIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/files\/([^/]+)\/preview\/public\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function resolveMessageFileLink(href: string | undefined, files: WorkFile[], allowRemoteRelative = false): ResolvedMessageLink {
  if (!href) return { kind: "unavailable" };
  const normalized = normalizePath(href, allowRemoteRelative);
  if (!normalized) return { kind: "unavailable" };
  const folded = normalized.toLocaleLowerCase();
  const candidates = files.map((file) => ({
    file,
    relative: normalizePath(file.relative_path)?.toLocaleLowerCase() ?? "",
    source: normalizePath(file.source_path ?? "")?.toLocaleLowerCase() ?? "",
    name: normalizePath(file.original_name)?.toLocaleLowerCase() ?? "",
  }));
  const exact = candidates.find((candidate) => (candidate.source && folded === candidate.source)
    || (candidate.relative && (folded === candidate.relative || folded.endsWith(`/${candidate.relative}`))));
  const basename = folded.split("/").pop() ?? "";
  const named = candidates.find((candidate) => candidate.name && basename === candidate.name);
  const matched = exact ?? named;
  if (matched) {
    const readerKind = fileReaderKind(matched.file);
    if (readerKind === "html" || readerKind === "pdf" || readerKind === "epub") return { kind: "preview", href: filePreviewUrl(matched.file) };
    if (readerKind === "markdown") return { kind: "raw", href: fileUrl(matched.file) };
    return { kind: "download", href: fileUrl(matched.file, true) };
  }
  const relativeRemotePath = allowRemoteRelative && !/^(?:#|\/api\/|[a-z][a-z0-9+.-]*:)/i.test(normalized);
  if (/^sandbox:/i.test(href) || isLocalMachinePath(href, normalized) || /^(?:outputs|uploads)\//i.test(normalized) || relativeRemotePath) {
    return { kind: "unavailable", path: normalized };
  }
  return { kind: "regular", href };
}

export function remoteMessageFileReferences(markdown: string, files: WorkFile[], allowRemoteRelative = false): RemoteMessageFileReference[] {
  const references = new Map<string, RemoteMessageFileReference>();
  const markdownLink = /(?<!!)\[([^\]\n]+)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of markdown.matchAll(markdownLink)) {
    const resolved = resolveMessageFileLink(match[2] ?? match[3], files, allowRemoteRelative);
    if (resolved.kind !== "unavailable" || !resolved.path) continue;
    const key = resolved.path.toLocaleLowerCase();
    if (!references.has(key)) references.set(key, { sourcePath: resolved.path, label: match[1] });
  }
  return [...references.values()];
}
