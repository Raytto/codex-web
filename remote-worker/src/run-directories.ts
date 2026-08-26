import fs from "node:fs";
import path from "node:path";

export const RUN_DIRECTORY_SWEEP_PROTECTION_MS = 24 * 60 * 60 * 1000;

export function isRunDirectoryId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function cleanupCurrentRunDirectory(stateRoot: string, jobId: string): Promise<void> {
  const target = resolveRunDirectory(stateRoot, jobId);
  await fs.promises.rm(target, { recursive: true, force: true });
}

export async function sweepRunDirectories(
  stateRoot: string,
  activeJobIds: ReadonlySet<string>,
  now = Date.now(),
  protectionMs = RUN_DIRECTORY_SWEEP_PROTECTION_MS,
): Promise<{ removed: string[]; failed: Array<{ jobId: string; message: string }> }> {
  const runsRoot = path.resolve(stateRoot, "runs");
  const removed: string[] = [];
  const failed: Array<{ jobId: string; message: string }> = [];
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(runsRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed, failed };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isRunDirectoryId(entry.name) || activeJobIds.has(entry.name)) continue;
    const target = resolveRunDirectory(stateRoot, entry.name);
    try {
      const stat = await fs.promises.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < protectionMs) continue;
      await fs.promises.rm(target, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (error) {
      failed.push({ jobId: entry.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, failed };
}

function resolveRunDirectory(stateRoot: string, jobId: string): string {
  if (!isRunDirectoryId(jobId)) throw new Error("Refusing to remove a non-UUID run directory");
  const runsRoot = path.resolve(stateRoot, "runs");
  const target = path.resolve(runsRoot, jobId);
  if (path.dirname(target) !== runsRoot || path.basename(target) !== jobId) throw new Error("Run directory escaped the protected root");
  return target;
}
