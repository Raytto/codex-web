import fs from "node:fs/promises";
import path from "node:path";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Index filenames only, then stat the requested rollout; never read its contents
 * or reconstruct a turn. Share a bounded, short-lived index across requests. */
export class RolloutSizes {
  private files = new Map<string, string[]>();
  private expiresAt = 0;
  private indexing?: Promise<void>;

  constructor(private readonly codexHome: string) {}

  async read(threadId: string): Promise<number | null> {
    if (!THREAD_ID.test(threadId)) return null;
    if (Date.now() >= this.expiresAt) {
      this.indexing ??= this.index().finally(() => { this.indexing = undefined; });
      await this.indexing;
    }
    let largest: number | null = null;
    for (const file of this.files.get(threadId.toLowerCase()) ?? []) {
      try {
        const stat = await fs.lstat(file);
        if (stat.isFile()) largest = Math.max(largest ?? 0, stat.size);
      } catch { /* File may have moved to the archive during this request. */ }
    }
    if (largest === null) this.expiresAt = 0;
    return largest;
  }

  private async index(): Promise<void> {
    const files = new Map<string, string[]>();
    const directories = [path.join(this.codexHome, "sessions"), path.join(this.codexHome, "archived_sessions")];
    let scanned = 0;
    while (directories.length) {
      const directory = directories.pop()!;
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (++scanned > 20_000) throw new Error("Codex rollout index limit exceeded");
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) directories.push(file);
        else if (entry.isFile()) {
          const id = entry.name.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1]?.toLowerCase();
          if (id) files.set(id, [...(files.get(id) ?? []), file]);
        }
      }
    }
    this.files = files;
    this.expiresAt = Date.now() + 60_000;
  }
}
