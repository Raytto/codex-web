import { fileUrl, type WorkFile } from "./api";

export type ResolvedMessageLink =
  | { kind: "download"; href: string }
  | { kind: "unavailable" }
  | { kind: "regular"; href: string };

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

function normalizePath(value: string): string | null {
  let normalized = decodePath(value).replace(/^file:\/+/i, "").replace(/\\/g, "/");
  if (/^\/[a-z]:\//i.test(normalized)) normalized = normalized.slice(1);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..") || normalized.includes("\0")) return null;
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
  return file.mime_type.startsWith("image/")
    || file.mime_type === "application/pdf"
    || /^text\/(?:plain|markdown|csv)/.test(file.mime_type);
}

export function resolveMessageFileLink(href: string | undefined, files: WorkFile[]): ResolvedMessageLink {
  if (!href) return { kind: "unavailable" };
  const normalized = normalizePath(href);
  if (!normalized) return { kind: "unavailable" };
  const folded = normalized.toLocaleLowerCase();
  const candidates = files.map((file) => ({
    file,
    relative: normalizePath(file.relative_path)?.toLocaleLowerCase() ?? "",
    name: normalizePath(file.original_name)?.toLocaleLowerCase() ?? "",
  }));
  const exact = candidates.find((candidate) => candidate.relative && (folded === candidate.relative || folded.endsWith(`/${candidate.relative}`)));
  const basename = folded.split("/").pop() ?? "";
  const named = candidates.find((candidate) => candidate.name && basename === candidate.name);
  const matched = exact ?? named;
  if (matched) return { kind: "download", href: fileUrl(matched.file, true) };
  if (/^sandbox:/i.test(href) || isLocalMachinePath(href, normalized) || /^(?:outputs|uploads)\//i.test(normalized)) return { kind: "unavailable" };
  return { kind: "regular", href };
}
