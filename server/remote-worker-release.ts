import remoteWorkerPackage from "../remote-worker/package.json" with { type: "json" };
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REMOTE_WORKER_TARGET_VERSION = remoteWorkerPackage.version;
export const REMOTE_WORKER_TARGET_REF = `remote-worker-v${REMOTE_WORKER_TARGET_VERSION}`;

export type RemoteWorkerReleaseManifest = {
  format: "codex-web-remote-worker-release-manifest-v1";
  version: string;
  ref: string;
  commit: string;
  platform: "win32-x64";
  archive: { fileName: string; sha256: string; size: number };
  platforms?: {
    "win32-x64": RemoteWorkerReleaseArchive & { format: "zip" };
    "darwin-universal": RemoteWorkerReleaseArchive & { format: "tar.gz" };
  };
};

export type RemoteWorkerReleaseArchive = { fileName: string; sha256: string; size: number };

export function loadRemoteWorkerReleaseManifest(releaseRoot: string): RemoteWorkerReleaseManifest | null {
  const manifestPath = path.join(releaseRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { throw new Error("Remote Worker release manifest is not valid JSON"); }
  if (!value || typeof value !== "object") throw new Error("Remote Worker release manifest is invalid");
  const manifest = value as Partial<RemoteWorkerReleaseManifest>;
  if (manifest.format !== "codex-web-remote-worker-release-manifest-v1"
    || manifest.version !== REMOTE_WORKER_TARGET_VERSION
    || manifest.ref !== REMOTE_WORKER_TARGET_REF
    || manifest.platform !== "win32-x64"
    || typeof manifest.commit !== "string" || !/^[0-9a-f]{40}$/.test(manifest.commit)
    || /^0{40}$/.test(manifest.commit)
    || !manifest.archive || typeof manifest.archive !== "object"
    || typeof manifest.archive.fileName !== "string"
    || !/^codex-web-remote-worker-[0-9A-Za-z.+-]+-win-x64\.zip$/.test(manifest.archive.fileName)
    || typeof manifest.archive.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.archive.sha256)
    || !Number.isSafeInteger(manifest.archive.size) || manifest.archive.size <= 0 || manifest.archive.size > 100 * 1024 * 1024) {
    throw new Error("Remote Worker release manifest does not match the target package");
  }
  const archivePath = path.join(releaseRoot, manifest.archive.fileName);
  const resolvedRoot = path.resolve(releaseRoot);
  const resolvedArchive = path.resolve(archivePath);
  if (path.dirname(resolvedArchive) !== resolvedRoot || !fs.statSync(resolvedArchive, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Remote Worker release archive is unavailable");
  }
  const size = fs.statSync(resolvedArchive).size;
  if (size !== manifest.archive.size) throw new Error("Remote Worker release archive size does not match its manifest");
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(resolvedArchive)).digest("hex");
  if (sha256 !== manifest.archive.sha256) throw new Error("Remote Worker release archive checksum does not match its manifest");
  if (manifest.platforms !== undefined) {
    const win = manifest.platforms?.["win32-x64"];
    const mac = manifest.platforms?.["darwin-universal"];
    if (!validArchive(win, "zip") || !validArchive(mac, "tar.gz")
      || win.fileName !== manifest.archive.fileName || win.sha256 !== manifest.archive.sha256 || win.size !== manifest.archive.size) {
      throw new Error("Remote Worker multi-platform release manifest is invalid");
    }
    verifyArchive(releaseRoot, mac);
  }
  return manifest as RemoteWorkerReleaseManifest;
}

function validArchive(value: unknown, format: "zip" | "tar.gz"): value is RemoteWorkerReleaseArchive & { format: typeof format } {
  if (!value || typeof value !== "object") return false;
  const archive = value as Partial<RemoteWorkerReleaseArchive & { format: string }>;
  return archive.format === format
    && typeof archive.fileName === "string" && /^codex-web-remote-worker-[0-9A-Za-z.+-]+-(?:win-x64\.zip|macos-universal\.tar\.gz)$/.test(archive.fileName)
    && typeof archive.sha256 === "string" && /^[0-9a-f]{64}$/.test(archive.sha256)
    && Number.isSafeInteger(archive.size) && Number(archive.size) > 0 && Number(archive.size) <= 100 * 1024 * 1024;
}

function verifyArchive(releaseRoot: string, archive: RemoteWorkerReleaseArchive): void {
  const resolvedRoot = path.resolve(releaseRoot);
  const resolvedArchive = path.resolve(releaseRoot, archive.fileName);
  if (path.dirname(resolvedArchive) !== resolvedRoot || !fs.statSync(resolvedArchive, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Remote Worker release archive is unavailable");
  }
  if (fs.statSync(resolvedArchive).size !== archive.size) throw new Error("Remote Worker release archive size does not match its manifest");
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(resolvedArchive)).digest("hex");
  if (sha256 !== archive.sha256) throw new Error("Remote Worker release archive checksum does not match its manifest");
}
