import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { loadConfig, READER_V1_MAX_CONCURRENT_READS, READER_V1_MAX_FILE_BYTES, READER_V1_MAX_RANGE_BYTES, READER_V1_RETENTION_DAYS } from "../server/config.js";
import { AppDatabase, LEGACY_USER_ID, type FileRow } from "../server/db.js";
import { ensureTenantWorkspace } from "../server/paths.js";
import { archiveReaderVersion, listReaderColdCandidates, restoreReaderVersion } from "../server/reader-cold-storage.js";
import { ingestEpubFile } from "../server/reader-ingest.js";
import { parseReaderRange, ReaderRangeError, ReaderReadLimiter, READER_RANGE_MAX_BYTES } from "../server/reader-range.js";
import { detectReaderFormat, readerCapabilities, ReaderService, ReaderUnavailableError } from "../server/reader-service.js";
import { api } from "../src/api.js";
import { createReaderPdfRangeTransport, READER_PDF_RANGE_BYTES } from "../src/reader/pdf-range-transport.js";

const uuid = () => crypto.randomUUID();

test("reader format adapters keep HTML/Markdown vertical and PDF/EPUB paginated", () => {
  assert.equal(detectReaderFormat({ original_name: "notes.md", mime_type: "application/octet-stream" }), "markdown");
  assert.equal(detectReaderFormat({ original_name: "book.epub", mime_type: "application/octet-stream" }), "epub");
  assert.deepEqual(readerCapabilities("markdown"), ["vertical-flow", "text-selection", "highlight", "note", "agent-ask"]);
  assert.ok(readerCapabilities("pdf").includes("pagination"));
  assert.ok(readerCapabilities("epub").includes("nearby-prefetch"));
});

test("paginated reader uses a full-bleed viewport, a bottom page indicator, and bounded swipe work", () => {
  const readerSource = fs.readFileSync(path.join(process.cwd(), "src", "reader", "ReaderDocument.tsx"), "utf8");
  const readerStyles = fs.readFileSync(path.join(process.cwd(), "src", "reader", "ReaderDocument.css"), "utf8");
  const annotationSource = fs.readFileSync(path.join(process.cwd(), "src", "reader", "annotation-dom.ts"), "utf8");
  const selectionSource = fs.readFileSync(path.join(process.cwd(), "src", "reader-ask.tsx"), "utf8");
  assert.doesNotMatch(readerSource, /className="reader-paginator"/);
  assert.match(readerSource, /<ReaderPageIndicator label=\{`\$\{activePage\} \/ \$\{pageCount\}`\}/);
  assert.match(readerSource, /<ReaderPageIndicator label=\{`\$\{page\} \/ \$\{pageCount\}`\}/);
  assert.match(readerStyles, /\.reader-epub-unit \{[^}]*border: 0;[^}]*border-radius: 0;[^}]*box-shadow: none/);
  assert.match(readerStyles, /\.reader-page-indicator \{[^}]*position: absolute;[^}]*right:/);
  assert.match(readerStyles, /scroll-snap-stop: normal/);
  assert.match(readerStyles, /-webkit-user-select: text/);
  assert.doesNotMatch(readerStyles, /\.reader-(?:pdf-track|epub-page-viewport) \{[^}]*touch-action:/);
  assert.match(readerSource, /Math\.abs\(page - activePage\) <= 2/);
  assert.match(readerSource, /scrollFrameRef/);
  assert.match(readerSource, /contentRef/);
  assert.match(readerSource, /\[0, -1, 1, -2, 2\]/);
  assert.match(annotationSource, /export function markReaderRange/);
  assert.match(annotationSource, /export function selectReaderAnnotation/);
  assert.match(annotationSource, /annotation\.type\);/);
  assert.match(readerSource, /mark\.reader-local-highlight\[data-reader-annotation\]/);
  assert.match(fs.readFileSync(path.join(process.cwd(), "src", "reader", "ReaderAnnotations.tsx"), "utf8"), /reader-annotation-ask/);
  assert.match(fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8"), /type: "highlight", quoteText: selection\.text,[\s\S]*color: "orange"/);
  assert.match(selectionSource, /reader-selection-preview/);
});

test("PDF/EPUB browser code, styles, runtime, and worker stay out of the initial PPA payload", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const readerSource = fs.readFileSync(path.join(process.cwd(), "src", "reader", "ReaderDocument.tsx"), "utf8");
  const readerStylesSource = fs.readFileSync(path.join(process.cwd(), "src", "reader", "ReaderDocument.css"), "utf8");
  assert.doesNotMatch(appSource, /^import\s+\{?\s*ReaderDocument\s*\}?\s+from/m);
  assert.match(appSource, /lazy\(\(\) => import\("\.\/reader\/ReaderDocument"\)/);
  assert.match(appSource, /source\.format === "pdf" \|\| readerManifest\.source\.format === "epub"[\s\S]*<LazyReaderDocument/);
  assert.doesNotMatch(readerSource, /^import .* from ["']pdfjs-dist["'];$/m);
  assert.match(readerSource, /await import\("pdfjs-dist"\)/);
  assert.match(readerSource, /const availableWidth = Number\.isFinite\(maxWidth\)/);
  assert.match(readerSource, /new ResizeObserver\(updatePageWidth\)/);
  assert.match(readerSource, /pageMaxWidth\} active=/);
  assert.match(readerSource, /import "\.\/ReaderDocument\.css"/);
  assert.match(readerStylesSource, /\.reader-pdf-track \{[^}]*display: flex;[^}]*scroll-snap-type: x mandatory/);
  assert.match(readerStylesSource, /\.reader-pdf-page-slot \{ flex: 0 0 auto/);

  const distRoot = path.join(process.cwd(), "dist");
  const assetsRoot = path.join(distRoot, "assets");
  const builtIndex = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
  const entryName = builtIndex.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/)?.[1];
  assert.ok(entryName, "the production build should expose its JavaScript entry");
  const assetNames = fs.readdirSync(assetsRoot);
  const sources = new Map(assetNames.filter((name) => /\.(?:js|mjs|css)$/.test(name)).map((name) => [name, fs.readFileSync(path.join(assetsRoot, name), "utf8")]));
  const readerScripts = assetNames.filter((name) => name.endsWith(".js") && sources.get(name)?.includes("正在按需加载 PDF") && sources.get(name)?.includes("正在后台解析 EPUB"));
  const readerStyles = assetNames.filter((name) => name.endsWith(".css") && sources.get(name)?.includes(".reader-pdf-track") && sources.get(name)?.includes(".reader-epub-track"));
  const pdfRuntimes = assetNames.filter((name) => name.endsWith(".js") && sources.get(name)?.includes("pdfjsLib") && sources.get(name)?.includes("PDFDataRangeTransport"));
  const pdfWorkers = assetNames.filter((name) => /^pdf\.worker-.*\.mjs$/.test(name));
  assert.equal(readerScripts.length, 1, "the paginated reader should be one isolated lazy chunk");
  assert.equal(readerStyles.length, 1, "PDF/EPUB-only CSS should be one isolated lazy stylesheet");
  assert.equal(pdfRuntimes.length, 1, "PDF.js should remain one isolated lazy runtime");
  assert.equal(pdfWorkers.length, 1, "the PDF worker should remain a separate on-demand asset");

  const entrySource = sources.get(entryName) ?? "";
  const readerSourceBuilt = sources.get(readerScripts[0]) ?? "";
  assert.ok(entrySource.includes(readerScripts[0]), "the entry should reference the lazy reader chunk");
  assert.ok(entrySource.includes(readerStyles[0]), "the dynamic import should associate its lazy stylesheet");
  assert.doesNotMatch(entrySource, /正在按需加载 PDF|正在后台解析 EPUB|reader-pdf-reader|PDFDataRangeTransport/);
  assert.ok(!entrySource.includes(pdfRuntimes[0]), "the initial entry must not reference PDF.js directly");
  assert.ok(!entrySource.includes(pdfWorkers[0]), "the initial entry must not reference the PDF worker");
  assert.ok(readerSourceBuilt.includes(pdfRuntimes[0]), "the reader chunk should own the PDF.js dynamic edge");
  assert.ok(readerSourceBuilt.includes(pdfWorkers[0]), "the reader chunk should own the worker URL");
  assert.ok(!builtIndex.includes(readerScripts[0]));
  assert.ok(!builtIndex.includes(readerStyles[0]));
  assert.ok(!builtIndex.includes(pdfRuntimes[0]));
  assert.ok(!builtIndex.includes(pdfWorkers[0]));
  for (const stylesheet of Array.from(builtIndex.matchAll(/href="\/assets\/([^"]+\.css)"/g), (match) => match[1])) {
    assert.doesNotMatch(sources.get(stylesheet) ?? "", /\.reader-(?:pdf|epub|paginator|document-shell)/);
  }
  assert.ok(fs.statSync(path.join(assetsRoot, readerScripts[0])).size < 32 * 1024, "the lightweight reader shell should stay below 32 KiB minified");
  assert.ok(fs.statSync(path.join(assetsRoot, readerStyles[0])).size < 8 * 1024, "the reader-only stylesheet should stay below 8 KiB minified");
});

test("reader v1 policy ceilings cannot be widened by environment-style overrides", () => {
  const config = loadConfig({
    readerMaxFileBytes: Number.MAX_SAFE_INTEGER,
    readerMaxConcurrentReads: 99,
    readerRangeMaxBytes: 64 * 1024 * 1024,
    readerRetentionDays: 3650,
  });
  assert.equal(READER_V1_MAX_FILE_BYTES, 100 * 1024 * 1024);
  assert.equal(READER_V1_MAX_CONCURRENT_READS, 5);
  assert.equal(READER_V1_MAX_RANGE_BYTES, 1 * 1024 * 1024);
  assert.equal(READER_V1_RETENTION_DAYS, 15);
  assert.equal(config.readerMaxFileBytes, READER_V1_MAX_FILE_BYTES);
  assert.equal(config.readerMaxConcurrentReads, READER_V1_MAX_CONCURRENT_READS);
  assert.equal(config.readerRangeMaxBytes, READER_V1_MAX_RANGE_BYTES);
  assert.equal(config.readerRetentionDays, READER_V1_RETENTION_DAYS);
});

test("host reader cold-storage entry stays independent of web-only config dependencies", () => {
  const coldStorageSource = fs.readFileSync(path.join(process.cwd(), "server", "reader-cold-storage.ts"), "utf8");
  const policySource = fs.readFileSync(path.join(process.cwd(), "server", "reader-policy.ts"), "utf8");
  assert.match(coldStorageSource, /from "\.\/reader-policy\.js"/);
  assert.doesNotMatch(coldStorageSource, /from "\.\/config\.js"/);
  assert.doesNotMatch(policySource, /(?:from|require\()\s*["'](?!node:)/);
});

test("reader Range parsing accepts bounded suffixes and rejects multi-range/oversized reads", () => {
  assert.equal(READER_RANGE_MAX_BYTES, 1 * 1024 * 1024);
  assert.deepEqual(parseReaderRange("bytes=0-99", 10_000), { start: 0, end: 99, length: 100 });
  assert.deepEqual(parseReaderRange("bytes=-50", 10_000), { start: 9_950, end: 9_999, length: 50 });
  assert.deepEqual(parseReaderRange("bytes=9990-", 10_000), { start: 9_990, end: 9_999, length: 10 });
  assert.throws(() => parseReaderRange("bytes=0-1,4-5", 10_000), (error: unknown) => error instanceof ReaderRangeError && error.code === "invalid");
  assert.throws(() => parseReaderRange(`bytes=0-${READER_RANGE_MAX_BYTES}`, READER_RANGE_MAX_BYTES + 10), (error: unknown) => error instanceof ReaderRangeError && error.code === "too_large");
  assert.throws(() => parseReaderRange("bytes=100-101", 100), (error: unknown) => error instanceof ReaderRangeError && error.code === "unsatisfiable" && error.resourceSize === 100);
});

test("reader concurrency is isolated per account and releases idempotently", () => {
  const limiter = new ReaderReadLimiter(2);
  const first = limiter.tryAcquire("user-a");
  const second = limiter.tryAcquire("user-a");
  assert.ok(first && second);
  assert.equal(limiter.tryAcquire("user-a"), null);
  assert.ok(limiter.tryAcquire("user-b"));
  first(); first();
  assert.equal(limiter.activeFor("user-a"), 1);
  second();
  assert.equal(limiter.activeFor("user-a"), 0);
});

test("PDF browser transport splits coalesced ranges at the 1 MiB server boundary", async () => {
  type Callback = (args: { type: string; begin?: number; chunk?: Uint8Array | null }) => void;
  class FakeTransport {
    readonly length: number;
    readonly initialData: Uint8Array | null;
    readonly progressiveDone: boolean;
    readonly contentDispositionFilename: string | undefined;
    listener: Callback | null = null;
    received: Array<{ begin: number; chunk: Uint8Array | null }> = [];
    constructor(length: number, initialData: Uint8Array | null, progressiveDone = false, filename?: string) {
      this.length = length; this.initialData = initialData; this.progressiveDone = progressiveDone; this.contentDispositionFilename = filename;
    }
    transportReady(listener: Callback): void { this.listener = listener; }
    onDataRange(begin: number, chunk: Uint8Array | null): void { this.received.push({ begin, chunk }); }
    abort(): void { /* test transport */ }
  }
  const bytes = new Uint8Array(READER_PDF_RANGE_BYTES * 2 + 321);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const requests: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const range = String(new Headers(init?.headers).get("Range"));
    requests.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]); const end = Number(match[2]);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } });
  }) as typeof fetch;
  const transport = createReaderPdfRangeTransport(FakeTransport as never, {
    url: "/reader.pdf", length: bytes.length, fetchImpl, maxConcurrent: 2,
  }) as unknown as FakeTransport & { requestDataRange(begin: number, end: number): void };
  transport.requestDataRange(17, bytes.length - 5);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(transport.received.length, 1);
  assert.equal(transport.received[0].begin, 17);
  assert.deepEqual(transport.received[0].chunk, bytes.slice(17, bytes.length - 5));
  assert.ok(requests.length >= 3);
  for (const request of requests) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request);
    assert.ok(match);
    assert.ok(Number(match[2]) - Number(match[1]) + 1 <= READER_PDF_RANGE_BYTES);
  }
});

test("browser reader API treats 202 processing responses as retryable", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  let calls = 0;
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    setTimeout: (callback: () => void) => { callback(); return 0; },
    clearTimeout: () => undefined,
  };
  globalThis.fetch = (async () => {
    calls += 1;
    const body = calls === 1 ? { code: "READER_RESTORE_IN_PROGRESS", restoring: true } : { unit: { id: "unit", ordinal: 0, href: "chapter.xhtml", title: null, mediaType: "application/xhtml+xml" }, content: "<p>ok</p>" };
    return new Response(JSON.stringify(body), { status: calls === 1 ? 202 : 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await api.readerUnit("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002");
    assert.equal(result.content, "<p>ok</p>");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as typeof globalThis & { window?: unknown }).window;
    else (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }
});

async function writeFixtureEpub(filePath: string): Promise<void> {
  const writer = new ZipWriter(new BlobWriter("application/epub+zip"));
  await writer.add("mimetype", new TextReader("application/epub+zip"), { level: 0 });
  await writer.add("META-INF/container.xml", new TextReader(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
  await writer.add("OEBPS/package.opf", new TextReader(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">测试书</dc:title><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">测试作者</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="images/cover.png" media-type="image/png"/></manifest><spine><itemref idref="chapter"/></spine></package>`));
  await writer.add("OEBPS/chapter.xhtml", new TextReader(`<!doctype html><html><body><h1>第一章</h1><p>可选择的正文。</p><script>window.evil=1</script><img src="images/cover.png"><img src="missing.png"><img src="https://example.invalid/remote.png"></body></html>`));
  await writer.add("OEBPS/images/cover.png", new TextReader("not-a-real-image"));
  const blob = await writer.close();
  await fsp.writeFile(filePath, Buffer.from(await blob.arrayBuffer()));
}

function executable(root: string, name: string, source: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

function fakeAge(root: string): string {
  return executable(root, "age", `
const fs = require("node:fs"); const args = process.argv.slice(2); const source = args.at(-1); const outputIndex = args.indexOf("-o");
if (!source) process.exit(2);
if (outputIndex >= 0) { const output = args[outputIndex + 1]; if (!output) process.exit(2); fs.copyFileSync(source, output); }
else { process.stdout.write(fs.readFileSync(source)); }
`);
}

function fakeAliyun(root: string, cloud: string): string {
  return executable(root, "aliyunpan", `
const fs = require("node:fs"); const path = require("node:path"); const args = process.argv.slice(2); const cloud = ${JSON.stringify(cloud)}; const cmd = args[0];
const remote = (value) => path.join(cloud, String(value).replace(/^\\/+/, ""));
if (cmd === "tree") { const dir = args.at(-1); const target = remote(dir); if (!fs.existsSync(target)) process.exit(1); console.log(dir); for (const name of fs.readdirSync(target)) console.log(path.posix.join(dir, name) + " -> " + path.posix.join(dir, name)); process.exit(0); }
if (cmd === "mkdir") { const dir = args.at(-1); fs.mkdirSync(remote(dir), { recursive: true }); console.log(dir); process.exit(0); }
if (cmd === "upload") { const source = args.filter((value) => fs.existsSync(value) && fs.statSync(value).isFile()).at(-1); const dir = args.at(-1); if (!source || !dir) process.exit(2); fs.mkdirSync(remote(dir), { recursive: true }); fs.copyFileSync(source, path.join(remote(dir), path.basename(source))); process.exit(0); }
if (cmd === "download") { const dirArg = args.find((value) => value.startsWith("--saveto=")); const source = args.at(-1); if (!dirArg || !source) process.exit(2); fs.mkdirSync(dirArg.slice(9), { recursive: true }); fs.copyFileSync(remote(source), path.join(dirArg.slice(9), path.basename(source))); process.exit(0); }
process.exit(2);
`);
}

test("EPUB normalization is asynchronous-friendly, sanitizes scripts, and rewrites safe assets", async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "reader-epub-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const epub = path.join(root, "book.epub");
  await writeFixtureEpub(epub);
  const config = loadConfig({ projectRoot: root, dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), basePath: "/agent", readerMaxFileBytes: 100 * 1024 * 1024 });
  const versionId = uuid();
  const result = await ingestEpubFile({ userId: LEGACY_USER_ID, versionId, absolutePath: epub, config });
  assert.equal(result.title, "测试书");
  assert.equal(result.author, "测试作者");
  assert.equal(result.units.length, 1);
  assert.match(result.units[0].text_content ?? "", /可选择的正文/);
  assert.doesNotMatch(result.units[0].text_content ?? "", /window\.evil/);
  const normalized = await fsp.readFile(path.join(root, "data", "reader-resources", LEGACY_USER_ID, versionId, "units", "0.html"), "utf8");
  assert.match(normalized, /\/api\/reader\/versions\/.+\/asset\?path=/);
  assert.match(normalized, /\/agent\/api\/reader\/versions\/.+\/asset\?path=/);
  assert.doesNotMatch(normalized, /missing\.png|example\.invalid/);
  assert.equal(fs.existsSync(path.join(root, "data", "reader-resources", LEGACY_USER_ID, versionId, "assets", "OEBPS", "images", "cover.png")), true);
});

function addReaderFixture(db: AppDatabase, root: string, format: "pdf" | "epub" = "epub") {
  const conversationId = uuid();
  const fileId = uuid();
  const sourceId = uuid();
  const versionId = uuid();
  db.createConversation(conversationId, "reader test");
  const file: FileRow = {
    id: fileId, conversation_id: conversationId, message_id: null, original_name: `book.${format}`,
    relative_path: `uploads/${fileId}.${format}`, source_path: null,
    mime_type: format === "pdf" ? "application/pdf" : "application/epub+zip", size: 4, sha256: "abcd", kind: "upload", created_at: new Date().toISOString(),
  };
  db.addFile(file);
  const workspace = ensureTenantWorkspace(path.join(root, "tenants"), LEGACY_USER_ID, conversationId);
  fs.writeFileSync(path.join(workspace, file.relative_path), "test");
  const source = db.createReadingSource({ id: sourceId, user_id: LEGACY_USER_ID, file_id: fileId, format, title: file.original_name, author: null });
  const version = db.createReadingVersion({
    id: versionId, source_id: source.id, user_id: LEGACY_USER_ID, file_id: fileId, version_no: 1,
    derived_kind: format === "epub" ? "normalized" : "original", source_sha256: file.sha256 ?? null, source_bytes: file.size,
    parser_version: format === "epub" ? "epub-normalizer-v1" : "native-reader-v1", status: "ready",
    normalized_root: format === "epub" ? `reader-resources/${LEGACY_USER_ID}/${versionId}` : null,
    manifest_json: JSON.stringify({ format }), last_accessed_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1_000).toISOString(), storage_state: "local",
    storage_generation: 0, storage_revision: 0, storage_manifest_json: null, storage_manifest_sha256: null, storage_archive_sha256: null,
    storage_archive_bytes: null, storage_plaintext_bytes: null, storage_uploaded_at: null, storage_verified_at: null, storage_restored_at: null,
    remote_drive_id: null, remote_path: null, local_isolated_path: null, last_error: null,
  });
  if (format === "epub") {
    const resourceRoot = path.join(root, "data", "reader-resources", LEGACY_USER_ID, version.id);
    fs.mkdirSync(path.join(resourceRoot, "units"), { recursive: true });
    fs.writeFileSync(path.join(resourceRoot, "units", "0.html"), "<p>unit</p>");
    db.replaceReadingUnits(version.id, LEGACY_USER_ID, [{ id: uuid(), version_id: version.id, ordinal: 0, kind: "spine", href: "chapter.xhtml", title: "chapter", media_type: "application/xhtml+xml", content_path: "units/0.html", byte_size: 11, text_content: "unit", metadata_json: null }]);
  }
  return { file, source, version };
}

test("reader cold candidates honor the 15-day inactivity window and only archive ready normalized EPUBs", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-cold-candidate-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const db = new AppDatabase(dataRoot, { username: "pp", passwordHash: "", displayName: "PP" });
  try {
    const ready = addReaderFixture(db, root);
    const failed = addReaderFixture(db, root);
    const pdf = addReaderFixture(db, root, "pdf");
    db.updateReadingVersion(failed.version.id, LEGACY_USER_ID, { status: "failed" });
    const candidates = listReaderColdCandidates({ dataRoot, tenantRoot, databasePath: path.join(dataRoot, "codex-web.sqlite"), isolationRoot: path.join(root, "cold-storage", "isolated") }, 15);
    const readyCandidate = candidates.find((candidate) => candidate.versionId === ready.version.id);
    const failedCandidate = candidates.find((candidate) => candidate.versionId === failed.version.id);
    const pdfCandidate = candidates.find((candidate) => candidate.versionId === pdf.version.id);
    assert.equal(readyCandidate?.eligible, true);
    assert.equal(failedCandidate?.eligible, false);
    assert.ok(failedCandidate?.reasons.includes("status_failed"));
    assert.equal(pdfCandidate?.eligible, false);
    assert.ok(pdfCandidate?.reasons.includes("format_pdf"));
    assert.ok(pdfCandidate?.reasons.includes("derived_original"));
  } finally { db.close(); }
});

test("reader normalized resources round-trip through the encrypted cold-storage boundary", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-cold-roundtrip-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const tools = path.join(root, "tools");
  const cloud = path.join(root, "cloud");
  fs.mkdirSync(tools, { recursive: true }); fs.mkdirSync(cloud, { recursive: true });
  const originalPath = process.env.PATH;
  executable(tools, "id", `console.log("0");`);
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  context.after(() => { process.env.PATH = originalPath; });
  const ageRecipient = path.join(root, "recipient"); const ageIdentity = path.join(root, "identity");
  fs.writeFileSync(ageRecipient, "recipient"); fs.writeFileSync(ageIdentity, "identity");
  const db = new AppDatabase(dataRoot, { username: "pp", passwordHash: "", displayName: "PP" });
  try {
    const fixture = addReaderFixture(db, root);
    const resource = path.join(dataRoot, "reader-resources", LEGACY_USER_ID, fixture.version.id, "units", "0.html");
    fs.writeFileSync(resource, "<p>round-trip</p>");
    const roots = {
      dataRoot, tenantRoot, databasePath: path.join(dataRoot, "codex-web.sqlite"),
      age: fakeAge(tools), aliyunpan: fakeAliyun(tools, cloud), ageRecipient, ageIdentity,
      relayDir: path.join(root, "relay"), downloadDir: path.join(root, "downloads"),
      isolationRoot: path.join(root, "isolated"), readerIsolationRoot: path.join(root, "reader-isolated"), driveId: "test-drive",
    };
    const archived = archiveReaderVersion(roots, fixture.version.id, 15);
    assert.equal(fs.existsSync(resource), false);
    assert.equal(fs.existsSync(archived.isolatedPath), true);
    const cold = db.getReadingVersion(fixture.version.id, LEGACY_USER_ID);
    assert.equal(cold?.storage_state, "cold");
    restoreReaderVersion(roots, fixture.version.id, LEGACY_USER_ID);
    assert.equal(fs.readFileSync(resource, "utf8"), "<p>round-trip</p>");
    const restored = db.getReadingVersion(fixture.version.id, LEGACY_USER_ID);
    assert.equal(restored?.storage_state, "local");
    assert.equal(restored?.status, "ready");
  } finally { db.close(); }
});

test("ReaderService reuses a ready native PDF version and exposes a bounded manifest", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-service-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const db = new AppDatabase(dataRoot, { username: "pp", passwordHash: "", displayName: "PP" });
  try {
    const fixture = addReaderFixture(db, root, "pdf");
    const config = loadConfig({ projectRoot: root, dataRoot, tenantRoot, readerMaxConcurrentReads: 5 });
    const service = new ReaderService({ db, config, resolveFilePath: (file, userId) => path.join(tenantRoot, userId, "conversations", file.conversation_id, file.relative_path) });
    const manifest = await service.openFile(fixture.file, LEGACY_USER_ID);
    assert.equal(manifest.source.format, "pdf");
    assert.equal(manifest.version.status, "ready");
    assert.deepEqual(manifest.units, []);
    assert.ok(manifest.capabilities.includes("pagination"));
  } finally { db.close(); }
});

test("direct PDF version manifests respect conversation cold-storage activation", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-manifest-restore-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const db = new AppDatabase(dataRoot, { username: "pp", passwordHash: "", displayName: "PP" });
  try {
    const fixture = addReaderFixture(db, root, "pdf");
    fs.rmSync(path.dirname(path.join(tenantRoot, LEGACY_USER_ID, "conversations", fixture.file.conversation_id, fixture.file.relative_path)), { recursive: true, force: true });
    const config = loadConfig({ projectRoot: root, dataRoot, tenantRoot });
    const service = new ReaderService({
      db,
      config,
      resolveFilePath: (file, userId) => path.join(tenantRoot, userId, "conversations", file.conversation_id, file.relative_path),
      resolveExistingFilePath: (file, userId) => path.join(tenantRoot, userId, "conversations", file.conversation_id, file.relative_path),
      ensureFileAvailable: () => "restoring",
    });
    await assert.rejects(service.getManifest(fixture.version.id, LEGACY_USER_ID), (error: unknown) => error instanceof ReaderUnavailableError);
  } finally { db.close(); }
});
