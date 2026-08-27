import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { BlobReader, ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";
import { XMLParser } from "fast-xml-parser";
import sanitizeHtml from "sanitize-html";
import type { AppConfig } from "./config.js";
import { newId, resolveInside } from "./paths.js";
import type { ReadingUnitRow, ReaderFormat } from "./reader-types.js";

export const READER_PARSER_VERSION = "epub-normalizer-v1";
const MAX_ZIP_ENTRIES = 4_000;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_STORED_TEXT_BYTES = 256 * 1024;
const XHTML_MEDIA_TYPES = new Set(["application/xhtml+xml", "text/html", "application/xml"]);
const SAFE_ASSET_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "text/css", "audio/mpeg", "audio/ogg", "audio/mp4", "video/mp4",
]);
const READER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ReaderIngestError extends Error {
  constructor(message: string) { super(message); this.name = "ReaderIngestError"; }
}

function assertReaderId(value: string, label: string): void {
  if (!READER_ID_PATTERN.test(value)) throw new ReaderIngestError(`阅读${label}格式无效。`);
}

/** Check the already-existing part of a reader-owned path.  A lexical
 * resolveInside check is not enough when an attacker can replace an ancestor
 * directory with a symlink between requests. */
export function assertNoSymlinkAncestors(base: string, target: string): void {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  const relativeTarget = path.relative(resolvedBase, resolvedTarget);
  if (path.isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`)) {
    throw new ReaderIngestError("阅读资源路径越界。");
  }
  try {
    const baseStat = fs.lstatSync(resolvedBase);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw new ReaderIngestError("阅读资源根目录类型不安全。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let current = resolvedBase;
  for (const part of relativeTarget ? relativeTarget.split(path.sep) : []) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ReaderIngestError("阅读资源目录类型不安全。");
  }
}

/** Validate every existing component of an absolute file path.  Reader input
 * paths are resolved from database metadata, but a symlink swap between the
 * lexical check and lstat would otherwise let a replacement upload point at a
 * different tenant's file. */
export function assertNoSymlinkPath(target: string): void {
  const resolved = path.resolve(target);
  // The final component may be a regular file; only its ancestors must be
  // directories.  Callers perform the final lstat/type check themselves, so
  // a missing file remains a normal "not found" result rather than a path
  // validation failure.
  assertNoSymlinkAncestors(path.parse(resolved).root, path.dirname(resolved));
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new ReaderIngestError("阅读资源文件类型不安全。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

type ParsedManifestItem = { id: string; href: string; mediaType: string; properties: string };

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attribute(value: unknown, name: string): string {
  if (!value || typeof value !== "object") return "";
  const raw = (value as Record<string, unknown>)[`@_${name}`];
  return typeof raw === "string" ? raw : raw == null ? "" : String(raw);
}

function safeZipName(value: string): string {
  let decoded = value.replace(/\\/g, "/");
  try { decoded = decodeURIComponent(decoded); } catch { /* keep the raw name; validation below rejects ambiguity */ }
  if (!decoded || decoded.includes("\0") || decoded.startsWith("/") || /^[a-z]:/i.test(decoded)) throw new ReaderIngestError("EPUB 包含不安全的资源路径。");
  const normalized = path.posix.normalize(decoded);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new ReaderIngestError("EPUB 包含越界资源路径。");
  return normalized;
}

function resolveEpubHref(base: string, reference: string): string | null {
  const clean = reference.trim().split(/[?#]/, 1)[0];
  if (!clean || clean.startsWith("/") || /^(?:data|https?|mailto|javascript):/i.test(clean)) return null;
  try { return safeZipName(path.posix.join(path.posix.dirname(base), decodeURIComponent(clean))); }
  catch { return null; }
}

function mediaTypeForName(name: string): string {
  const ext = path.posix.extname(name).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".png" ? "image/png"
      : ext === ".gif" ? "image/gif"
        : ext === ".webp" ? "image/webp"
          : ext === ".avif" ? "image/avif"
            : ext === ".css" ? "text/css"
              : ext === ".mp3" ? "audio/mpeg"
                : ext === ".ogg" ? "audio/ogg"
                  : ext === ".mp4" ? "video/mp4"
                    : "application/octet-stream";
}

function stripBody(markup: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(markup);
  return body?.[1] ?? markup.replace(/<!doctype[^>]*>/gi, "").replace(/<\/?(?:html|head|title|meta|link)\b[^>]*>/gi, "");
}

function textFromHtml(markup: string): string {
  return sanitizeHtml(markup, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ").trim().slice(0, MAX_STORED_TEXT_BYTES);
}

function normalizeXhtml(markup: string): string {
  const clean = sanitizeHtml(stripBody(markup), {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "article", "section", "header", "footer", "figure", "figcaption", "small", "center", "del", "ins", "ruby", "rt", "rp", "img",
    ].filter((tag, index, all) => all.indexOf(tag) === index),
    allowedAttributes: {
      // Inline style is deliberately excluded.  EPUB CSS is not executed by
      // the reader shell, and allowing style attributes would reintroduce
      // browser-specific URL/exfiltration tricks.
      "*": ["id", "class", "title", "lang", "dir"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height", "loading"],
      td: ["colspan", "rowspan"], th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (_tag, attrs) => {
        const href = attrs.href ?? "";
        if (/^https?:/i.test(href)) {
          attrs.target = "_blank";
          attrs.rel = "noreferrer noopener";
        } else if (href && !href.startsWith("#")) {
          // Cross-spine navigation is not part of v1.  Do not let a relative
          // publisher link escape the normalized reader shell; a later
          // navigation adapter can reintroduce it with an explicit unit map.
          delete attrs.href;
        }
        return { tagName: "a", attribs: attrs };
      },
      img: (_tag, attrs) => {
        // Images are served only through the normalized asset endpoint.  A
        // remote image must not trigger a network request from a private
        // reader page; it is left as an empty, accessible image element.
        if (attrs.src && (attrs.src.startsWith("/") || /^(?:[a-z][a-z0-9+.-]*:|\\\\)/i.test(attrs.src))) delete attrs.src;
        return { tagName: "img", attribs: attrs };
      },
    },
    // CSS can contain external requests and browser-specific escape tricks;
    // visual styling is supplied by the reader shell instead.
    exclusiveFilter: (frame) => frame.tag === "style" || frame.tag === "link" || frame.tag === "script" || frame.tag === "iframe" || frame.tag === "object" || frame.tag === "embed" || frame.tag === "form",
  });
  return clean.trim();
}

type DecompressionBudget = { used: number };

function reserveDecompressedBytes(budget: DecompressionBudget | undefined, bytes: number): void {
  if (!budget) return;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || budget.used + bytes > MAX_UNCOMPRESSED_BYTES) {
    throw new ReaderIngestError("EPUB 解压后总大小超过安全上限。");
  }
  budget.used += bytes;
}

async function entryText(entry: FileEntry, budget?: DecompressionBudget): Promise<string> {
  const declaredSize = Number(entry.uncompressedSize ?? 0);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_ENTRY_BYTES) throw new ReaderIngestError("EPUB 单个资源超过安全大小上限。");
  const writer = new LimitedBufferWriter(MAX_ENTRY_BYTES, (bytes) => reserveDecompressedBytes(budget, bytes));
  await entry.getData(writer, { checkOverlappingEntry: true });
  return new TextDecoder("utf-8", { fatal: false }).decode(writer.bytes());
}

function asFileEntry(entry: Entry | undefined, missingMessage: string): FileEntry {
  if (!entry || entry.directory) throw new ReaderIngestError(missingMessage);
  return entry;
}

async function entryBytes(entry: FileEntry, budget?: DecompressionBudget): Promise<Uint8Array> {
  const declaredSize = Number(entry.uncompressedSize ?? 0);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_ENTRY_BYTES) throw new ReaderIngestError("EPUB 单个资源超过安全大小上限。");
  const writer = new LimitedBufferWriter(MAX_ENTRY_BYTES, (bytes) => reserveDecompressedBytes(budget, bytes));
  await entry.getData(writer, { checkOverlappingEntry: true });
  return writer.bytes();
}

/** A bounded sink for decompressed ZIP output.  zip.js validates the declared
 * uncompressed size, but a hostile archive can omit or falsify that metadata;
 * counting actual output makes the cap effective while the stream is still
 * being decoded instead of buffering an unbounded entry in TextWriter. */
class LimitedBufferWriter {
  readonly writable: WritableStream<Uint8Array>;
  /** zip.js increments this after the worker completes; keep our own counter
   * so it is not double-counted by GenericWriter. */
  size = 0;
  private written = 0;
  private readonly chunks: Uint8Array[] = [];
  constructor(private readonly limit: number, private readonly onWrite?: (bytes: number) => void) {
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
        if (this.written + value.byteLength > this.limit) throw new ReaderIngestError("EPUB 单个资源超过安全大小上限。");
        this.onWrite?.(value.byteLength);
        this.chunks.push(new Uint8Array(value));
        this.written += value.byteLength;
      },
    });
  }
  bytes(): Uint8Array {
    const result = new Uint8Array(this.written);
    let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
}

function metadataValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return metadataValue(value[0]);
  if (value && typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    return typeof text === "string" ? text.trim() || null : null;
  }
  return null;
}

export type EpubIngestResult = {
  title: string | null;
  author: string | null;
  units: Array<Omit<ReadingUnitRow, "created_at">>;
  manifest: { spineCount: number; opfPath: string; navPath: string | null };
};

/** Normalize an EPUB into immutable, local XHTML units and explicitly selected
 * safe assets.  The original ZIP remains the source of truth and is never
 * replaced by this derived representation. */
export async function ingestEpubFile(options: {
  userId: string;
  versionId: string;
  absolutePath: string;
  config: AppConfig;
}): Promise<EpubIngestResult> {
  assertReaderId(options.userId, "账号 ID");
  assertReaderId(options.versionId, "版本 ID");
  assertNoSymlinkPath(options.absolutePath);
  const stat = await fsp.lstat(options.absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ReaderIngestError("EPUB 原文件不存在或不是普通文件。");
  if (stat.size > options.config.readerMaxFileBytes) throw new ReaderIngestError("文件超过在线阅读大小上限。");
  const openAsBlob = (fs as typeof fs & { openAsBlob?: (file: string) => Promise<Blob> }).openAsBlob;
  if (!openAsBlob) throw new ReaderIngestError("当前运行时不支持流式读取 EPUB。");
  const blob = await openAsBlob(options.absolutePath);
  const zip = new ZipReader(new BlobReader(blob));
  let entries: Entry[] = [];
  try {
    entries = await zip.getEntries();
    if (entries.length === 0 || entries.length > MAX_ZIP_ENTRIES) throw new ReaderIngestError("EPUB 资源数量超过安全上限。");
    const byName = new Map<string, Entry>();
    let total = 0;
    for (const entry of entries) {
      const name = safeZipName(entry.filename);
      // A ZIP symlink's payload is a path, not the target bytes.  Treating it
      // as an ordinary EPUB resource would make the normalized manifest
      // ambiguous and could reintroduce publisher-controlled filesystem
      // semantics if a future adapter copies it differently.
      if (entry.symlink) throw new ReaderIngestError("EPUB 不支持符号链接资源。");
      if (entry.directory) continue;
      const size = Number(entry.uncompressedSize ?? 0);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) throw new ReaderIngestError("EPUB 资源大小无效或超过安全上限。");
      total += size;
      if (total > MAX_UNCOMPRESSED_BYTES) throw new ReaderIngestError("EPUB 解压后总大小超过安全上限。");
      if (byName.has(name)) throw new ReaderIngestError("EPUB 包含重复资源路径。");
      byName.set(name, entry);
    }
    const decompressionBudget: DecompressionBudget = { used: 0 };
    const containerEntry = asFileEntry(byName.get("META-INF/container.xml"), "EPUB 缺少 META-INF/container.xml。");
    const container = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true }).parse(await entryText(containerEntry, decompressionBudget)) as Record<string, any>;
    const rootfiles = arrayOf(container.container?.rootfiles?.rootfile);
    const opfRelative = attribute(rootfiles[0], "full-path");
    if (!opfRelative) throw new ReaderIngestError("EPUB 未声明 OPF 包文件。");
    const opfPath = safeZipName(opfRelative);
    const opfEntry = asFileEntry(byName.get(opfPath), "EPUB OPF 文件不存在。");
    const opf = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true }).parse(await entryText(opfEntry, decompressionBudget)) as Record<string, any>;
    const pkg = opf.package ?? opf;
    const metadata = pkg.metadata ?? {};
    const title = metadataValue(metadata.title) ?? null;
    const author = metadataValue(metadata.creator) ?? metadataValue(metadata.author);
    const itemValues = arrayOf(pkg.manifest?.item);
    const itemById = new Map<string, ParsedManifestItem>();
    for (const raw of itemValues) {
      const id = attribute(raw, "id");
      const hrefRaw = attribute(raw, "href");
      const mediaType = attribute(raw, "media-type").toLowerCase() || mediaTypeForName(hrefRaw);
      if (!id || !hrefRaw) continue;
      const href = safeZipName(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(hrefRaw.split(/[?#]/, 1)[0])));
      const item = { id, href, mediaType, properties: attribute(raw, "properties") };
      itemById.set(id, item);
    }
    const spineValues = arrayOf(pkg.spine?.itemref);
    const spineItems = spineValues.map((raw) => itemById.get(attribute(raw, "idref"))).filter((item): item is ParsedManifestItem => Boolean(item));
    if (spineItems.length === 0) throw new ReaderIngestError("EPUB 没有可阅读的 spine 文档。");
    const resourcesRoot = path.join(options.config.dataRoot, "reader-resources");
    const userRoot = path.join(resourcesRoot, options.userId);
    const root = path.join(userRoot, options.versionId);
    await fsp.mkdir(resourcesRoot, { recursive: true });
    assertNoSymlinkAncestors(options.config.dataRoot, resourcesRoot);
    await fsp.mkdir(userRoot, { recursive: true });
    assertNoSymlinkAncestors(resourcesRoot, userRoot);
    assertNoSymlinkAncestors(resourcesRoot, root);
    await fsp.mkdir(path.dirname(root), { recursive: true });
    const tempRoot = await fsp.mkdtemp(path.join(path.dirname(root), `.staging-${options.versionId}-`));
    const units: Array<Omit<ReadingUnitRow, "created_at">> = [];
    let normalizedBytes = 0;
    try {
      await fsp.mkdir(path.join(tempRoot, "units"), { recursive: true });
      await fsp.mkdir(path.join(tempRoot, "assets"), { recursive: true });
      const assetNames = new Set<string>();
      for (const item of itemById.values()) {
        if (XHTML_MEDIA_TYPES.has(item.mediaType)) continue;
        if (!SAFE_ASSET_TYPES.has(item.mediaType)) continue;
        const entry = byName.get(item.href);
        if (!entry || entry.directory) continue;
        const bytes = await entryBytes(entry, decompressionBudget);
        normalizedBytes += bytes.byteLength;
        if (normalizedBytes > MAX_UNCOMPRESSED_BYTES) throw new ReaderIngestError("EPUB 规范化产物超过安全大小上限。");
        const assetPath = path.join(tempRoot, "assets", item.href);
        await fsp.mkdir(path.dirname(assetPath), { recursive: true });
        await fsp.writeFile(assetPath, bytes, { mode: 0o600 });
        assetNames.add(item.href);
      }
      for (let ordinal = 0; ordinal < spineItems.length; ordinal += 1) {
        const item = spineItems[ordinal];
        const entry = asFileEntry(byName.get(item.href), `EPUB spine 文档不存在：${item.href}`);
        const raw = await entryText(entry, decompressionBudget);
        const normalized = normalizeXhtml(raw);
        const unitId = newId();
        const rewritten = normalized.replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi, (all, attributeName: string, quote: string, reference: string) => {
          const target = resolveEpubHref(item.href, reference);
          // A relative image that was not explicitly copied to the safe asset
          // set must not fall back to a browser request against the reader
          // origin.  Drop it; fragment links and publisher anchors remain
          // untouched because they are not asset fetches.
          if (attributeName.toLowerCase() === "src" && (!target || !assetNames.has(target))) return "";
          if (!target || !assetNames.has(target)) return all;
          const basePath = options.config.basePath.replace(/\/$/, "");
          const url = `${basePath}/api/reader/versions/${encodeURIComponent(options.versionId)}/asset?path=${encodeURIComponent(target)}`;
          return `${attributeName}=${quote}${url}${quote}`;
        });
        const relativeContentPath = `units/${ordinal}.html`;
        normalizedBytes += Buffer.byteLength(rewritten, "utf8");
        if (normalizedBytes > MAX_UNCOMPRESSED_BYTES) throw new ReaderIngestError("EPUB 规范化产物超过安全大小上限。");
        await fsp.writeFile(path.join(tempRoot, relativeContentPath), rewritten, "utf8");
        const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(rewritten);
        const unit: Omit<ReadingUnitRow, "created_at"> = {
          id: unitId, version_id: options.versionId, ordinal, kind: "spine", href: item.href,
          title: heading ? textFromHtml(heading[1]).slice(0, 200) || null : null,
          media_type: item.mediaType, content_path: relativeContentPath,
          byte_size: Buffer.byteLength(rewritten, "utf8"), text_content: textFromHtml(rewritten), metadata_json: JSON.stringify({ properties: item.properties }),
        };
        units.push(unit);
      }
      if (fs.existsSync(root)) {
        const existing = await fsp.lstat(root);
        if (existing.isSymbolicLink() || !existing.isDirectory()) throw new ReaderIngestError("EPUB 规范化目标目录不安全。");
        await fsp.rm(root, { recursive: true, force: true });
      }
      await fsp.rename(tempRoot, root);
    } catch (error) {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const nav = Array.from(itemById.values()).find((item) => /\bnav\b/i.test(item.properties));
    return { title, author, units, manifest: { spineCount: units.length, opfPath, navPath: nav?.href ?? null } };
  } finally {
    await zip.close().catch(() => undefined);
  }
}

export function hashReaderFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

/** Hash an original upload without synchronously blocking the request event
 * loop.  The synchronous helper above remains useful to the cold-storage
 * worker, which already runs as an isolated maintenance process. */
export async function hashReaderFileAsync(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

export function readerResourcePath(config: AppConfig, version: { normalized_root: string | null }): string | null {
  if (!version.normalized_root) return null;
  try {
    const resolved = resolveInside(config.dataRoot, version.normalized_root);
    assertNoSymlinkAncestors(config.dataRoot, resolved);
    return resolved;
  } catch { return null; }
}
