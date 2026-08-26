import fs from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type OwnedStagingRoot = "remote-worker-staging" | "remote-worker-fetch-staging";
export const OWNED_STAGING_PROTECTION_MS = 24 * 60 * 60 * 1_000;

export function ownedStagingDirectory(dataRoot: string, rootName: OwnedStagingRoot, ownerId: string): string {
  if (!UUID.test(ownerId)) throw new Error("Invalid staging owner identifier");
  const root = path.resolve(dataRoot, rootName);
  const directory = path.resolve(root, ownerId);
  if (path.dirname(directory) !== root) throw new Error("Staging owner directory escapes its root");
  return directory;
}

export function cleanupOwnedStagingDirectory(dataRoot: string, rootName: OwnedStagingRoot, ownerId: string): void {
  const directory = ownedStagingDirectory(dataRoot, rootName, ownerId);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing to clean a non-directory staging owner");
  fs.rmSync(directory, { recursive: true, force: true });
}

export function sweepOwnedStagingDirectories(
  dataRoot: string,
  rootName: OwnedStagingRoot,
  isProtected: (ownerId: string) => boolean,
  now = Date.now(),
  protectionMs = OWNED_STAGING_PROTECTION_MS,
): string[] {
  const root = path.resolve(dataRoot, rootName);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name) || isProtected(entry.name)) continue;
    const directory = ownedStagingDirectory(dataRoot, rootName, entry.name);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < protectionMs) continue;
    cleanupOwnedStagingDirectory(dataRoot, rootName, entry.name);
    removed.push(entry.name);
  }
  return removed;
}
