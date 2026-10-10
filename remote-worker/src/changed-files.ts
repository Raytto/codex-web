import { REMOTE_TRANSFER_MAX_FILE_BYTES, REMOTE_TRANSFER_MAX_TOTAL_BYTES_PER_JOB } from "./transfer-policy.js";
import fs from "node:fs";
import path from "node:path";

export type OmittedArtifact = {
  path: string;
  reason: "count_limit" | "outside_project" | "missing" | "not_file" | "too_large" | "total_size_limit" | "manifest_limit";
};

type Options = { maximumFiles?: number; maximumTotalBytes?: number; maximumFileBytes?: number; maximumManifestItems?: number };
const IMAGE_SUFFIXES = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export async function collectChangedFiles(
  projectRoot: string,
  reportedFiles: Iterable<string>,
  upload: (absolutePath: string, name: string) => Promise<void>,
  options: Options = {},
): Promise<{ uploaded: number; uploadedBytes: number; hasUploadedImage: boolean; omitted: OmittedArtifact[] }> {
  const maximumFiles = options.maximumFiles ?? 20;
  const maximumFileBytes = options.maximumFileBytes ?? REMOTE_TRANSFER_MAX_FILE_BYTES;
  const maximumTotalBytes = options.maximumTotalBytes ?? REMOTE_TRANSFER_MAX_TOTAL_BYTES_PER_JOB;
  const maximumManifestItems = options.maximumManifestItems ?? 100;
  const realProjectRoot = await fs.promises.realpath(projectRoot);
  const omitted: OmittedArtifact[] = [];
  let unlisted = 0;
  const omit = (entry: OmittedArtifact) => {
    if (omitted.length < maximumManifestItems - 1) omitted.push(entry);
    else unlisted += 1;
  };
  let uploaded = 0;
  let uploadedBytes = 0;
  let hasUploadedImage = false;
  for (const reported of reportedFiles) {
    if (reported.split(/[\\/]/).some(segment => segment.startsWith(".ppa-transfer-"))) continue;
    const absolute = path.isAbsolute(reported) ? reported : path.resolve(projectRoot, reported);
    const displayPath = manifestPath(projectRoot, absolute, reported);
    if (uploaded >= maximumFiles) { omit({ path: displayPath, reason: "count_limit" }); continue; }
    let realPath: string;
    try { realPath = await fs.promises.realpath(absolute); }
    catch { omit({ path: displayPath, reason: "missing" }); continue; }
    if (!insideDirectory(realProjectRoot, realPath)) { omit({ path: displayPath, reason: "outside_project" }); continue; }
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(realPath); }
    catch { omit({ path: displayPath, reason: "missing" }); continue; }
    if (!stat.isFile()) { omit({ path: displayPath, reason: "not_file" }); continue; }
    if (stat.size > maximumFileBytes) { omit({ path: displayPath, reason: "too_large" }); continue; }
    if (uploadedBytes + stat.size > maximumTotalBytes) { omit({ path: displayPath, reason: "total_size_limit" }); continue; }
    await upload(realPath, path.basename(realPath));
    uploaded += 1;
    uploadedBytes += stat.size;
    if (IMAGE_SUFFIXES.has(path.extname(realPath).toLowerCase())) hasUploadedImage = true;
  }
  if (unlisted > 0) omitted.push({ path: `另有 ${unlisted} 个省略项`, reason: "manifest_limit" });
  return { uploaded, uploadedBytes, hasUploadedImage, omitted };
}

function insideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function manifestPath(projectRoot: string, absolute: string, reported: string): string {
  const relative = path.relative(projectRoot, absolute);
  const label = relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    ? relative
    : path.basename(reported);
  return label.replace(/\\/g, "/").replace(/[\u0000-\u001f]/g, "_").slice(0, 500) || "未命名文件";
}
