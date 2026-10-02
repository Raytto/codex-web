import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";

const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 16;
const IMAGE_DATA_URI = /data:(image\/(?:png|jpeg|webp|gif|avif|bmp|x-icon|svg\+xml));base64,([a-z0-9+/\r\n]+={0,2})/gi;

type EmbeddedImage = { offset: number; length: number; mime: string };
type TextDocument = { revision: string; parts: string[]; images: EmbeddedImage[]; bytes: number };

function revision(stat: Stats): string {
  return crypto.createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest("hex").slice(0, 24);
}

/** Cache only text and byte ranges, never all of a report's decoded images. */
export class ReaderTextResources {
  private cache = new Map<string, TextDocument>();
  private cacheBytes = 0;
  private pending = new Map<string, Promise<TextDocument>>();

  private async document(absolute: string): Promise<TextDocument> {
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new Error("文件不存在或超过在线阅读上限。");
    const current = revision(stat);
    const cached = this.cache.get(absolute);
    if (cached?.revision === current) {
      this.cache.delete(absolute);
      this.cache.set(absolute, cached);
      return cached;
    }
    const key = `${absolute}:${current}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    // Bound concurrent full-file parsing independently of the small text cache.
    if (this.pending.size >= 4) throw new Error("阅读文件正在处理中，请稍后重试。");
    const task = this.parse(absolute, current);
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }

  private async parse(absolute: string, expected: string): Promise<TextDocument> {
    const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    let source: string;
    try {
      if (revision(await handle.stat()) !== expected) throw new Error("文件已变化，请重新打开。");
      source = (await handle.readFile()).toString("utf8");
      if (revision(await handle.stat()) !== expected) throw new Error("文件已变化，请重新打开。");
    } finally { await handle.close(); }
    const parts: string[] = [];
    const images: EmbeddedImage[] = [];
    let cursor = 0;
    let byteCursor = 0;
    for (const match of source.matchAll(IMAGE_DATA_URI)) {
      const prefix = source.slice(cursor, match.index);
      const headerBytes = match[0].indexOf(",") + 1;
      byteCursor += Buffer.byteLength(prefix);
      // V8 substring views can otherwise retain the entire Base64-heavy source
      // behind a tiny cached paragraph. Own the UTF-8 text we keep in the cache.
      parts.push(Buffer.from(prefix).toString("utf8"));
      images.push({ offset: byteCursor + headerBytes, length: match[2].length, mime: match[1].toLowerCase() });
      byteCursor += match[0].length;
      cursor = match.index + match[0].length;
    }
    parts.push(Buffer.from(source.slice(cursor)).toString("utf8"));
    const bytes = parts.reduce((total, part) => total + Buffer.byteLength(part), images.length * 128);
    const document = { revision: expected, parts, images, bytes };
    const old = this.cache.get(absolute);
    if (old) { this.cacheBytes -= old.bytes; this.cache.delete(absolute); }
    if (bytes <= MAX_CACHE_BYTES) {
      while (this.cache.size && (this.cacheBytes + bytes > MAX_CACHE_BYTES || this.cache.size >= MAX_CACHE_ENTRIES)) {
        const oldest = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(oldest)!.bytes;
        this.cache.delete(oldest);
      }
      this.cache.set(absolute, document);
      this.cacheBytes += bytes;
    }
    return document;
  }

  async content(absolute: string, imageUrl: (revision: string, index: number) => string): Promise<string> {
    const document = await this.document(absolute);
    return document.parts.map((part, index) => part + (index < document.images.length ? imageUrl(document.revision, index) : "")).join("").replace(/^\uFEFF/, "");
  }

  async image(absolute: string, expectedRevision: string, index: number): Promise<{ body: Buffer; mime: string } | null> {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    const document = await this.document(absolute);
    const image = document.images[index];
    if (document.revision !== expectedRevision || !image) return null;
    const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (revision(await handle.stat()) !== expectedRevision) return null;
      const encoded = Buffer.alloc(image.length);
      let read = 0;
      while (read < encoded.length) {
        const result = await handle.read(encoded, read, encoded.length - read, image.offset + read);
        if (!result.bytesRead) return null;
        read += result.bytesRead;
      }
      if (revision(await handle.stat()) !== expectedRevision) return null;
      return { body: Buffer.from(encoded.toString("ascii"), "base64"), mime: image.mime };
    } finally { await handle.close(); }
  }
}
