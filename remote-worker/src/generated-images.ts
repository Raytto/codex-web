import { REMOTE_TRANSFER_MAX_FILES_PER_JOB, REMOTE_TRANSFER_MAX_FILE_BYTES, REMOTE_TRANSFER_MAX_TOTAL_BYTES_PER_JOB } from "./transfer-policy.js";
import fs from "node:fs";
import path from "node:path";
import type { OmittedArtifact } from "./changed-files.js";

const THREAD_ID = /^[0-9a-f-]{36}$/i;
const IMAGE_SUFFIXES = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

type Options = { maximumFiles?: number; maximumTotalBytes?: number; maximumFileBytes?: number };

export async function snapshotGeneratedImages(codexHome: string, threadId: string): Promise<Map<string, string>> {
  const threadRoot = generatedImageThreadRoot(codexHome, threadId);
  const snapshot = new Map<string, string>();
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(threadRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !IMAGE_SUFFIXES.has(path.extname(entry.name).toLowerCase())) continue;
    const absolute = resolveGeneratedImage(codexHome, threadId, entry.name);
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    snapshot.set(entry.name, `${stat.size}:${stat.mtimeMs}`);
  }
  return snapshot;
}

export async function collectGeneratedImages(
  codexHome: string,
  threadId: string,
  baseline: ReadonlyMap<string, string>,
  upload: (absolutePath: string, name: string) => Promise<void>,
  options: Options = {},
): Promise<{ uploaded: number; omitted: OmittedArtifact[] }> {
  const maximumFiles = Math.max(0, options.maximumFiles ?? REMOTE_TRANSFER_MAX_FILES_PER_JOB);
  const maximumFileBytes = options.maximumFileBytes ?? REMOTE_TRANSFER_MAX_FILE_BYTES;
  const maximumTotalBytes = options.maximumTotalBytes ?? REMOTE_TRANSFER_MAX_TOTAL_BYTES_PER_JOB;
  const after = await snapshotGeneratedImages(codexHome, threadId);
  const omitted: OmittedArtifact[] = [];
  let uploaded = 0;
  let uploadedBytes = 0;
  for (const [fileName, fingerprint] of after) {
    if (baseline.get(fileName) === fingerprint) continue;
    if (uploaded >= maximumFiles) { omitted.push({ path: fileName, reason: "count_limit" }); continue; }
    const absolute = resolveGeneratedImage(codexHome, threadId, fileName);
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) { omitted.push({ path: fileName, reason: "not_file" }); continue; }
    if (stat.size > maximumFileBytes) { omitted.push({ path: fileName, reason: "too_large" }); continue; }
    if (uploadedBytes + stat.size > maximumTotalBytes) { omitted.push({ path: fileName, reason: "total_size_limit" }); continue; }
    await upload(absolute, fileName);
    uploaded += 1;
    uploadedBytes += stat.size;
  }
  return { uploaded, omitted };
}

function generatedImageThreadRoot(codexHome: string, threadId: string): string {
  if (!THREAD_ID.test(threadId)) throw new Error("Invalid Codex thread id");
  const generatedRoot = path.resolve(codexHome, "generated_images");
  const threadRoot = path.resolve(generatedRoot, threadId);
  if (path.dirname(threadRoot) !== generatedRoot) throw new Error("Generated image path escapes its root");
  return threadRoot;
}

function resolveGeneratedImage(codexHome: string, threadId: string, fileName: string): string {
  if (path.basename(fileName) !== fileName || !IMAGE_SUFFIXES.has(path.extname(fileName).toLowerCase())) {
    throw new Error("Invalid generated image name");
  }
  const threadRoot = generatedImageThreadRoot(codexHome, threadId);
  const absolute = path.resolve(threadRoot, fileName);
  if (path.dirname(absolute) !== threadRoot) throw new Error("Generated image path escapes its root");
  return absolute;
}
