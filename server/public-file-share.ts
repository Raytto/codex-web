import path from "node:path";
import type { FileRow } from "./db.js";

export type PublicShareDocumentKind = "markdown" | "html";
export type PublicShareAsset = { sourceRef: string; assetFileId: string };

const PUBLIC_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export class PublicShareAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicShareAssetError";
  }
}

export function publicShareDocumentKind(file: Pick<FileRow, "original_name" | "mime_type">): PublicShareDocumentKind | null {
  const mimeType = file.mime_type.split(";", 1)[0].trim().toLowerCase();
  const extension = path.extname(file.original_name).toLowerCase();
  if (mimeType === "text/markdown" || extension === ".md" || extension === ".markdown") return "markdown";
  if (mimeType === "text/html" || extension === ".html" || extension === ".htm") return "html";
  return null;
}

export function isPublicShareImage(file: Pick<FileRow, "mime_type">): boolean {
  return PUBLIC_IMAGE_MIME_TYPES.has(file.mime_type.split(";", 1)[0].trim().toLowerCase());
}

type NormalizedReference = { kind: "embedded" | "fragment" } | { kind: "relative"; value: string; key: string };

function normalizeImageReference(rawValue: string): NormalizedReference {
  let value = rawValue.trim().replace(/^<|>$/g, "");
  if (!value) throw new PublicShareAssetError("报告中存在空图片引用。");
  if (/^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/i.test(value)) return { kind: "embedded" };
  if (/^#/.test(value)) return { kind: "fragment" };
  if (/^(?:data|blob|https?|file|ftp):/i.test(value) || /^\/\//.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value)) {
    throw new PublicShareAssetError(`图片引用“${value.slice(0, 120)}”不是可公开的相对成品图片。`);
  }
  value = value.split("#", 1)[0].split("?", 1)[0].replace(/\\/g, "/");
  try { value = decodeURIComponent(value); }
  catch { throw new PublicShareAssetError(`图片引用“${rawValue.slice(0, 120)}”编码无效。`); }
  if (value.startsWith("/") || value.includes("\0")) throw new PublicShareAssetError("图片引用必须使用安全相对路径。");
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) throw new PublicShareAssetError("图片引用不能包含目录穿越。");
  const normalized = parts.join("/");
  return { kind: "relative", value: normalized, key: normalized.toLocaleLowerCase() };
}

function srcsetUrls(value: string): string[] {
  if (/^\s*data:/i.test(value)) return [value.trim()];
  return value.split(",").map((candidate) => candidate.trim().split(/\s+/, 1)[0]).filter(Boolean);
}

function htmlImageReferences(content: string): string[] {
  const references: string[] = [];
  const tagPattern = /<(?:img|source|image)\b[^>]*>/gi;
  const attributePattern = /\b(srcset|src|xlink:href|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const tag of content.match(tagPattern) ?? []) {
    for (const match of tag.matchAll(attributePattern)) {
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      references.push(...(match[1].toLowerCase() === "srcset" ? srcsetUrls(value) : [value]));
    }
  }
  return references;
}

function markdownImageReferences(content: string): string[] {
  const references: string[] = [];
  const pattern = /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of content.matchAll(pattern)) references.push(match[1] ?? match[2] ?? "");
  return references;
}

export function resolvePublicShareAssets(
  kind: PublicShareDocumentKind,
  content: string,
  siblingFiles: FileRow[],
): PublicShareAsset[] {
  const references = kind === "html" ? htmlImageReferences(content) : markdownImageReferences(content);
  const images = siblingFiles.filter((file) => file.kind === "output" && isPublicShareImage(file));
  const resolved = new Map<string, PublicShareAsset>();
  for (const raw of references) {
    const reference = normalizeImageReference(raw);
    if (reference.kind !== "relative" || resolved.has(reference.key)) continue;
    const basename = path.posix.basename(reference.value).toLocaleLowerCase();
    const matches = images.filter((file) => {
      const name = file.original_name.replace(/\\/g, "/").toLocaleLowerCase();
      if (name === reference.key || path.posix.basename(name) === basename) return true;
      const source = file.source_path?.replace(/\\/g, "/").toLocaleLowerCase();
      return Boolean(source && (source === reference.key || source.endsWith(`/${reference.key}`)));
    });
    if (matches.length !== 1) {
      const reason = matches.length ? "存在多个同名图片" : "没有找到同次交付的已登记图片";
      throw new PublicShareAssetError(`图片“${reference.value}”${reason}；请改为自包含 HTML 或重新交付图片。`);
    }
    resolved.set(reference.key, { sourceRef: reference.value, assetFileId: matches[0].id });
  }
  if (resolved.size > 20) throw new PublicShareAssetError("单个公开报告最多关联 20 张独立图片；请改为自包含 HTML。");
  return [...resolved.values()];
}

function rewriteUrl(raw: string, urls: ReadonlyMap<string, string>): string {
  const reference = normalizeImageReference(raw);
  if (reference.kind !== "relative") return raw;
  return urls.get(reference.key) ?? raw;
}

function rewriteSrcset(value: string, urls: ReadonlyMap<string, string>): string {
  if (/^\s*data:/i.test(value)) return value;
  return value.split(",").map((candidate) => {
    const trimmed = candidate.trim();
    const match = /^(\S+)(\s+.*)?$/.exec(trimmed);
    if (!match) return candidate;
    return `${rewriteUrl(match[1], urls)}${match[2] ?? ""}`;
  }).join(", ");
}

export function rewritePublicShareDocument(
  kind: PublicShareDocumentKind,
  content: string,
  assets: PublicShareAsset[],
  assetUrl: (assetFileId: string) => string,
): string {
  const urls = new Map(assets.map((asset) => [asset.sourceRef.toLocaleLowerCase(), assetUrl(asset.assetFileId)]));
  if (kind === "markdown") {
    return content.replace(/!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g, (full, angled: string | undefined, plain: string | undefined) => {
      const raw = angled ?? plain ?? "";
      const rewritten = rewriteUrl(raw, urls);
      return rewritten === raw ? full : full.replace(raw, rewritten);
    });
  }
  return content.replace(/<(?:img|source|image)\b[^>]*>/gi, (tag) => tag.replace(
    /\b(srcset|src|xlink:href|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (attribute, name: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
      const rewritten = name.toLowerCase() === "srcset" ? rewriteSrcset(value, urls) : rewriteUrl(value, urls);
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '"';
      return `${name}=${quote}${rewritten}${quote}`;
    },
  ));
}
