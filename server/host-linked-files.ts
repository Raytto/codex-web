import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKDOWN_LINK = /(?<!!)\[([^\]\n]+)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TRANSIENT_SUFFIXES = new Set([".bak", ".lock", ".part", ".swp", ".temp", ".tmp"]);

export const DEFAULT_HOST_LINKED_FILE_LIMIT = 24;
export const DEFAULT_HOST_LINKED_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_HOST_LINKED_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

export type HostLinkedFileOmissionReason = "count_limit" | "missing" | "not_file" | "too_large" | "total_limit" | "copy_failed";

export type HostLinkedFileResult = {
  finalResponse: string;
  delivered: Array<{ sourcePath: string; outputPath: string }>;
  omissions: Array<{ label: string; target: string; reason: HostLinkedFileOmissionReason }>;
};

type HostLinkedFileOptions = {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

type LinkMatch = {
  start: number;
  end: number;
  full: string;
  label: string;
  target: string;
  angleWrapped: boolean;
};

export async function materializeHostLinkedFiles(
  finalResponse: string,
  workspace: string,
  projectRoot: string,
  options: HostLinkedFileOptions = {},
): Promise<HostLinkedFileResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_HOST_LINKED_FILE_LIMIT;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_HOST_LINKED_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_HOST_LINKED_TOTAL_BYTES;
  const outputRoot = path.resolve(workspace, "outputs");
  await assertRealDirectory(outputRoot);

  const matches = markdownLinks(finalResponse);
  const delivered: HostLinkedFileResult["delivered"] = [];
  const omissions: HostLinkedFileResult["omissions"] = [];
  const sourceOutputs = new Map<string, string>();
  const claimedNames = new Set<string>();
  let totalBytes = 0;
  let cursor = 0;
  let rewritten = "";

  for (const match of matches) {
    rewritten += finalResponse.slice(cursor, match.start);
    cursor = match.end;
    const source = await resolveLinkedSource(match.target, workspace, projectRoot);
    if (!source) {
      rewritten += match.full;
      continue;
    }
    if (source.reason) {
      omissions.push({ label: match.label, target: match.target, reason: source.reason });
      rewritten += match.full;
      continue;
    }
    const existing = sourceOutputs.get(source.realPath);
    if (existing) {
      rewritten += rewriteLink(match, existing);
      continue;
    }
    if (delivered.length >= maxFiles) {
      omissions.push({ label: match.label, target: match.target, reason: "count_limit" });
      rewritten += match.full;
      continue;
    }
    if (source.size > maxFileBytes) {
      omissions.push({ label: match.label, target: match.target, reason: "too_large" });
      rewritten += match.full;
      continue;
    }
    if (totalBytes + source.size > maxTotalBytes) {
      omissions.push({ label: match.label, target: match.target, reason: "total_limit" });
      rewritten += match.full;
      continue;
    }

    const deliveryName = uniqueDeliveryName(safeDeliveryName(path.basename(source.realPath)), claimedNames);
    const outputPath = path.posix.join("outputs", deliveryName);
    const destination = path.join(outputRoot, deliveryName);
    let deliveredSize = source.size;
    try {
      if (path.resolve(source.realPath) === path.resolve(destination)) {
        const now = new Date();
        await fs.promises.utimes(destination, now, now);
      } else {
        const temporary = path.join(outputRoot, `.codex-web-linked-${crypto.randomUUID()}.tmp`);
        try {
          await fs.promises.copyFile(source.realPath, temporary);
          deliveredSize = (await fs.promises.stat(temporary)).size;
          if (deliveredSize > maxFileBytes) {
            omissions.push({ label: match.label, target: match.target, reason: "too_large" });
            rewritten += match.full;
            continue;
          }
          if (totalBytes + deliveredSize > maxTotalBytes) {
            omissions.push({ label: match.label, target: match.target, reason: "total_limit" });
            rewritten += match.full;
            continue;
          }
          await fs.promises.chmod(temporary, 0o644);
          await fs.promises.rename(temporary, destination);
        } finally {
          await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      omissions.push({ label: match.label, target: match.target, reason: "copy_failed" });
      rewritten += match.full;
      continue;
    }
    sourceOutputs.set(source.realPath, outputPath);
    claimedNames.add(deliveryName.toLocaleLowerCase());
    totalBytes += deliveredSize;
    delivered.push({ sourcePath: source.realPath, outputPath });
    rewritten += rewriteLink(match, outputPath);
  }
  rewritten += finalResponse.slice(cursor);
  return { finalResponse: rewritten, delivered, omissions };
}

function markdownLinks(markdown: string): LinkMatch[] {
  return [...markdown.matchAll(MARKDOWN_LINK)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    full: match[0],
    label: match[1],
    target: match[2] ?? match[3],
    angleWrapped: match[2] !== undefined,
  }));
}

async function resolveLinkedSource(
  target: string,
  workspace: string,
  projectRoot: string,
): Promise<{ realPath: string; size: number; reason?: undefined } | { reason: HostLinkedFileOmissionReason } | null> {
  let decoded = target.trim();
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return { reason: "missing" };
    }
  }
  if (decoded.includes("\0") || decoded.startsWith("#")) return null;
  if (/^file:\/\//i.test(decoded)) {
    try { decoded = fileURLToPath(decoded); }
    catch { return { reason: "missing" }; }
  } else if (URI_SCHEME.test(decoded)) {
    return null;
  }

  const base = /^(?:outputs|uploads)[/\\]/i.test(decoded) ? workspace : projectRoot;
  const initial = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(base, decoded);
  const candidates = [initial];
  const withoutPosition = initial.replace(/:\d+(?::\d+)?$/, "");
  if (withoutPosition !== initial) candidates.push(withoutPosition);

  let sawNotFile = false;
  for (const candidate of candidates) {
    try {
      const realPath = await fs.promises.realpath(candidate);
      const stat = await fs.promises.stat(realPath);
      if (!stat.isFile()) {
        sawNotFile = true;
        continue;
      }
      return { realPath, size: stat.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
        return { reason: "missing" };
      }
    }
  }
  return { reason: sawNotFile ? "not_file" : "missing" };
}

function safeDeliveryName(input: string): string {
  let name = input.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
  if (!name || name === "." || name === "..") name = "download";
  if (name.startsWith(".")) name = `download-${name.slice(1) || "file"}`;
  if (name.startsWith("~$")) name = `download-${name.slice(2) || "file"}`;
  if (name.endsWith("~")) name = `${name.slice(0, -1) || "download"}-file`;
  if (TRANSIENT_SUFFIXES.has(path.extname(name).toLowerCase())) name = `${name}.download`;
  return name.slice(0, 240) || "download";
}

function uniqueDeliveryName(input: string, claimed: Set<string>): string {
  if (!claimed.has(input.toLocaleLowerCase())) return input;
  const extension = path.extname(input);
  const stem = input.slice(0, input.length - extension.length) || "download";
  for (let index = 2; index <= 10_000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!claimed.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${stem}-${crypto.randomUUID()}${extension}`;
}

function rewriteLink(match: LinkMatch, outputPath: string): string {
  const replacement = match.angleWrapped || !/\s/.test(outputPath) ? outputPath : `<${outputPath}>`;
  const targetIndex = match.full.lastIndexOf(match.target);
  if (targetIndex < 0) return match.full;
  return `${match.full.slice(0, targetIndex)}${replacement}${match.full.slice(targetIndex + match.target.length)}`;
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Host output directory is invalid");
}
