import { REMOTE_TRANSFER_MAX_FILES_PER_JOB, REMOTE_TRANSFER_MAX_FILE_BYTES, REMOTE_TRANSFER_MAX_TOTAL_BYTES_PER_JOB } from "./transfer-policy.js";
import fs from "node:fs";
import path from "node:path";

export type OmittedArtifact = {
  path: string;
  reason: "count_limit" | "outside_project" | "missing" | "not_file" | "too_large" | "total_size_limit" | "manifest_limit";
};

type Options = { maximumFiles?: number; maximumTotalBytes?: number; maximumFileBytes?: number; maximumManifestItems?: number; managedOutputRoot?: string };
const IMAGE_SUFFIXES = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const PRESENTATION_SUFFIX = ".pp-agent.json";

export async function collectChangedFiles(
  projectRoot: string,
  reportedFiles: Iterable<string>,
  upload: (absolutePath: string, name: string) => Promise<void>,
  options: Options = {},
): Promise<{ uploaded: number; uploadedBytes: number; hasUploadedImage: boolean; omitted: OmittedArtifact[] }> {
  const maximumFiles = options.maximumFiles ?? REMOTE_TRANSFER_MAX_FILES_PER_JOB;
  const maximumFileBytes = options.maximumFileBytes ?? REMOTE_TRANSFER_MAX_FILE_BYTES;
  const maximumTotalBytes = options.maximumTotalBytes ?? REMOTE_TRANSFER_MAX_TOTAL_BYTES_PER_JOB;
  const maximumManifestItems = options.maximumManifestItems ?? 100;
  const realProjectRoot = await fs.promises.realpath(projectRoot);
  if (options.managedOutputRoot) {
    const outputStat = await fs.promises.lstat(options.managedOutputRoot);
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("受管成品目录不是普通文件夹");
  }
  const realOutputRoot = options.managedOutputRoot ? await fs.promises.realpath(options.managedOutputRoot) : undefined;
  const allowedRoots = [realProjectRoot, ...(realOutputRoot ? [realOutputRoot] : [])];
  const omitted: OmittedArtifact[] = [];
  let unlisted = 0;
  const omit = (entry: OmittedArtifact) => {
    if (omitted.length < maximumManifestItems - 1) omitted.push(entry);
    else unlisted += 1;
  };
  let uploaded = 0;
  let uploadedBytes = 0;
  let hasUploadedImage = false;
  const seen = new Set<string>();
  const candidates = async function* () {
    // Only this Job's explicit output directory is scanned. Shell-generated
    // deliverables need not produce a Codex fileChange event.
    if (realOutputRoot) yield* outputFiles(realOutputRoot);
    yield* reportedFiles;
  };
  for await (const reported of candidates()) {
    if (reported.split(/[\\/]/).some(segment => segment.startsWith(".ppa-transfer-"))) continue;
    let absolute = path.isAbsolute(reported) ? reported : path.resolve(projectRoot, reported);
    // A declaration is protocol material. Collect it only with its HTML, even
    // when Codex reports the declaration first or the HTML was shell-written.
    if (absolute.endsWith(PRESENTATION_SUFFIX)) {
      absolute = absolute.slice(0, -PRESENTATION_SUFFIX.length);
      if (!/\.html?$/i.test(absolute)) continue;
    }
    const displayPath = manifestPath(projectRoot, absolute, reported);
    let realPath: string;
    try { realPath = await fs.promises.realpath(absolute); }
    catch { omit({ path: displayPath, reason: "missing" }); continue; }
    if (seen.has(realPath)) continue;
    seen.add(realPath);
    if (!allowedRoots.some((root) => insideDirectory(root, realPath))) { omit({ path: displayPath, reason: "outside_project" }); continue; }
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(realPath); }
    catch { omit({ path: displayPath, reason: "missing" }); continue; }
    if (!stat.isFile()) { omit({ path: displayPath, reason: "not_file" }); continue; }
    const members = [{ path: realPath, name: path.basename(absolute), size: stat.size }];
    if (/\.html?$/i.test(absolute)) {
      const declaration = `${absolute}${PRESENTATION_SUFFIX}`;
      let exists = true;
      try { await fs.promises.lstat(declaration); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        exists = false;
      }
      if (exists) {
        let declarationPath: string;
        try { declarationPath = await fs.promises.realpath(declaration); }
        catch { omit({ path: displayPath, reason: "missing" }); continue; }
        if (!allowedRoots.some((root) => insideDirectory(root, declarationPath))) { omit({ path: displayPath, reason: "outside_project" }); continue; }
        const declarationStat = await fs.promises.stat(declarationPath);
        if (!declarationStat.isFile()) { omit({ path: displayPath, reason: "not_file" }); continue; }
        members.push({ path: declarationPath, name: `${path.basename(absolute)}${PRESENTATION_SUFFIX}`, size: declarationStat.size });
      }
    }
    // Reserve a complete HTML/declaration pair before sending either member;
    // a budget boundary must not silently turn an interactive page into reader.
    const bytes = members.reduce((total, member) => total + member.size, 0);
    if (uploaded + members.length > maximumFiles) { omit({ path: displayPath, reason: "count_limit" }); continue; }
    if (members.some((member) => member.size > maximumFileBytes)) { omit({ path: displayPath, reason: "too_large" }); continue; }
    if (uploadedBytes + bytes > maximumTotalBytes) { omit({ path: displayPath, reason: "total_size_limit" }); continue; }
    for (const member of members) {
      await upload(member.path, member.name);
      uploaded += 1;
      uploadedBytes += member.size;
    }
    if (IMAGE_SUFFIXES.has(path.extname(absolute).toLowerCase())) hasUploadedImage = true;
  }
  if (unlisted > 0) omitted.push({ path: `另有 ${unlisted} 个省略项`, reason: "manifest_limit" });
  return { uploaded, uploadedBytes, hasUploadedImage, omitted };
}

async function* outputFiles(directory: string): AsyncGenerator<string> {
  const entries = await fs.promises.opendir(directory);
  for await (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* outputFiles(candidate);
    else yield candidate;
  }
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
