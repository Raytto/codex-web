import fs from "node:fs";
import path from "node:path";

export type OmittedArtifact = {
  path: string;
  reason: "count_limit" | "outside_project" | "missing" | "not_file" | "too_large" | "manifest_limit";
};

type Options = { maximumFiles?: number; maximumFileBytes?: number; maximumManifestItems?: number };
const IMAGE_SUFFIXES = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export async function collectChangedFiles(
  projectRoot: string,
  reportedFiles: Iterable<string>,
  upload: (absolutePath: string, name: string) => Promise<void>,
  options: Options = {},
): Promise<{ uploaded: number; hasUploadedImage: boolean; omitted: OmittedArtifact[] }> {
  const maximumFiles = options.maximumFiles ?? 20;
  const maximumFileBytes = options.maximumFileBytes ?? 100 * 1024 * 1024;
  const maximumManifestItems = options.maximumManifestItems ?? 100;
  const realProjectRoot = await fs.promises.realpath(projectRoot);
  const omitted: OmittedArtifact[] = [];
  let unlisted = 0;
  const omit = (entry: OmittedArtifact) => {
    if (omitted.length < maximumManifestItems - 1) omitted.push(entry);
    else unlisted += 1;
  };
  let uploaded = 0;
  let hasUploadedImage = false;
  for (const reported of reportedFiles) {
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
    await upload(realPath, path.basename(realPath));
    uploaded += 1;
    if (IMAGE_SUFFIXES.has(path.extname(realPath).toLowerCase())) hasUploadedImage = true;
  }
  if (unlisted > 0) omitted.push({ path: `另有 ${unlisted} 个省略项`, reason: "manifest_limit" });
  return { uploaded, hasUploadedImage, omitted };
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
