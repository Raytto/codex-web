import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TAIL_BYTES = 256 * 1024;
const BOOT_CLOCK_MARGIN_MS = 60_000;

/** Disk turn reconstruction can leave completed or interrupted work looking live.
 * Read only a bounded tail of the authoritative rollout. Unknown or partially
 * written data leaves the existing observer decision unchanged. */
export function rolloutLifecycle(filePath: string, bootTimeMs = Date.now() - os.uptime() * 1000): "running" | "idle" | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size === 0) return null;
    const offset = Math.max(0, before.size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(before.size, TAIL_BYTES));
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    const after = fs.fstatSync(descriptor);
    if (read !== buffer.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
    let text = buffer.toString("utf8");
    if (!text.endsWith("\n")) return null;
    if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
    let state: "running" | "idle" | null = null;
    let lastTimestamp = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      // Malformed tail data must never clear a running lock.
      let row: { timestamp?: string; type?: string; payload?: { type?: string } };
      try { row = JSON.parse(line) as typeof row; } catch { return null; }
      const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
      if (Number.isFinite(timestamp)) lastTimestamp = Math.max(lastTimestamp, timestamp);
      if (row.type !== "event_msg") continue;
      if (row.payload?.type === "task_started") state = "running";
      if (row.payload?.type === "task_complete" || row.payload?.type === "turn_aborted") state = "idle";
    }
    // A native execution cannot survive this machine's OS boot. Use both the
    // recorded timestamp and file mtime; a merely quiet, post-boot task is live.
    if (lastTimestamp > 0 && lastTimestamp < bootTimeMs - BOOT_CLOCK_MARGIN_MS
      && before.mtimeMs < bootTimeMs - BOOT_CLOCK_MARGIN_MS) return "idle";
    return state;
  } catch { return null; }
  finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Best-effort read-only cleanup. */ }
    }
  }
}

/** Reconcile only requested UUIDs from the local session store, without starting
 * an app-server or reconstructing every historical turn. Unknown stays locked. */
export function localThreadLifecycles(codexHome: string, threadIds: string[]): Array<{ threadId: string; status: "idle" | "running" }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (threadIds.length > 200 || threadIds.some(id => !uuid.test(id))) return [];
  const wanted = new Set(threadIds);
  if (wanted.size === 0) return [];
  const found = new Map<string, string | null>();
  const directories = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  let scanned = 0;
  while (directories.length) {
    const directory = directories.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return [];
    }
    for (const entry of entries) {
      if (++scanned > 20_000) return [];
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(fullPath);
      else if (entry.isFile()) {
        const id = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
        if (id && wanted.has(id)) found.set(id, found.has(id) ? null : fullPath);
      }
    }
  }
  return [...found].flatMap(([threadId, file]) => {
    const status = file ? rolloutLifecycle(file) : null;
    return status ? [{ threadId, status }] : [];
  });
}
