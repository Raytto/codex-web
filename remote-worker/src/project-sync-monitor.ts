import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ThreadSnapshot } from "./protocol.js";
import type { ThreadHeader } from "./codex-client.js";

type ProjectWatch = { id: string; rootPath: string };
type Observer = {
  codexHome(): Promise<string>;
  listProjectThreadHeaders(projectRoot: string, cursor: string | null, limit?: number): Promise<{ threads: ThreadHeader[]; nextCursor: string | null }>;
  readThread(threadId: string): Promise<ThreadSnapshot | null>;
  close(): void;
};
type ThreadState = {
  metadata: string;
  messages: Map<string, string>;
  activities: Map<string, string>;
};
const SNAPSHOT_PAYLOAD_BUDGET = 8 * 1024 * 1024;

export class ProjectSyncMonitor {
  private readonly projects = new Map<string, ProjectWatch>();
  private readonly threadProjects = new Map<string, string>();
  private readonly headerVersions = new Map<string, number>();
  private readonly threadStates = new Map<string, ThreadState>();
  private readonly runningThreads = new Set<string>();
  private readonly runningPolls = new Map<string, { intervalMs: number; nextAt: number }>();
  private readonly queuedThreads = new Set<string>();
  private watcher?: fs.FSWatcher;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private reconcileTicks = 0;
  private reconciling = false;
  private reconcileAgain = false;
  private closed = false;
  private bootstrapGeneration = 0;

  constructor(
    private readonly observer: Observer,
    private readonly onSnapshot: (projectId: string, snapshot: ThreadSnapshot) => void,
    private readonly log: (message: string) => void,
    private readonly watchFilesystem = true,
  ) {}

  async replaceProjects(projects: ProjectWatch[]): Promise<void> {
    if (this.closed) return;
    const next = new Map(projects.map((project) => [project.id, project]));
    for (const [threadId, projectId] of this.threadProjects) {
      if (next.has(projectId)) continue;
      this.threadProjects.delete(threadId);
      this.headerVersions.delete(threadId);
      this.threadStates.delete(threadId);
      this.runningThreads.delete(threadId);
      this.runningPolls.delete(threadId);
    }
    this.projects.clear();
    for (const project of next.values()) this.projects.set(project.id, project);
    await this.ensureStarted();
    this.bootstrapGeneration += 1;
    await this.reconcileAll(true);
  }

  async reconcileAll(fullHistory = false): Promise<void> {
    if (this.closed || this.reconciling) {
      if (!this.closed) this.reconcileAgain = true;
      return;
    }
    this.reconciling = true;
    try {
      for (const project of this.projects.values()) await this.reconcileProject(project, fullHistory);
    } catch (error) {
      this.log(`automatic Codex sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.reconciling = false;
      if (this.reconcileAgain) {
        this.reconcileAgain = false;
        void this.reconcileAll(false);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bootstrapGeneration += 1;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.watcher?.close();
    this.observer.close();
  }

  hasRunningThreads(): boolean {
    return this.runningThreads.size > 0;
  }

  private async ensureStarted(): Promise<void> {
    if (this.reconcileTimer || this.closed) return;
    if (this.watchFilesystem) {
      try {
        const codexHome = await this.observer.codexHome();
        const sessions = path.join(codexHome, "sessions");
        if (fs.existsSync(sessions)) {
          this.watcher = fs.watch(sessions, { recursive: true }, (_event, fileName) => this.filesChanged(fileName?.toString() ?? ""));
          this.watcher.on("error", (error) => this.log(`Codex session watcher failed; periodic sync remains active: ${error.message}`));
          this.log(`watching Codex session changes in ${sessions}`);
        }
      } catch (error) {
        this.log(`Codex session watcher unavailable; periodic sync remains active: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.reconcileTimer = setInterval(() => {
      if (this.closed) return;
      this.reconcileTicks += 1;
      const now = Date.now();
      for (const threadId of this.runningThreads) {
        const poll = this.runningPolls.get(threadId) ?? { intervalMs: 5_000, nextAt: 0 };
        if (poll.nextAt > now) continue;
        poll.nextAt = now + poll.intervalMs;
        this.runningPolls.set(threadId, poll);
        this.queuedThreads.add(threadId);
      }
      if (this.queuedThreads.size > 0) this.scheduleFlush();
      if (this.reconcileTicks % 6 === 0) void this.reconcileAll(false);
    }, 5_000);
    this.reconcileTimer.unref();
  }

  private filesChanged(fileName: string): void {
    if (this.closed) return;
    const threadId = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    if (threadId && this.threadProjects.has(threadId)) {
      this.queuedThreads.add(threadId);
      this.runningPolls.set(threadId, { intervalMs: 5_000, nextAt: 0 });
    }
    else this.reconcileAgain = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushChangedThreads();
    }, 1_200);
  }

  private async flushChangedThreads(): Promise<void> {
    const threadIds = [...this.queuedThreads];
    this.queuedThreads.clear();
    for (const threadId of threadIds) {
      const projectId = this.threadProjects.get(threadId);
      if (!projectId || !this.projects.has(projectId)) continue;
      try {
        const started = Date.now();
        const snapshot = await this.observer.readThread(threadId);
        if (snapshot) {
          const changed = this.publishDelta(projectId, snapshot);
          this.updateRunningPoll(snapshot, changed);
          this.logLargeRead(threadId, snapshot, Date.now() - started);
        }
      } catch (error) {
        this.log(`automatic Codex thread read failed (${threadId}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.reconcileAgain) {
      this.reconcileAgain = false;
      await this.reconcileAll(false);
    }
  }

  private async reconcileProject(project: ProjectWatch, fullHistory: boolean): Promise<void> {
    const discovered: ThreadHeader[] = [];
    const page = await this.observer.listProjectThreadHeaders(project.rootPath, null, 50);
    for (const header of page.threads) {
      this.threadProjects.set(header.id, project.id);
      const previousVersion = this.headerVersions.get(header.id);
      this.headerVersions.set(header.id, header.updatedAt);
      if (fullHistory || previousVersion !== header.updatedAt) discovered.push(header);
    }
    // thread/list is newest-first. Import the startup checkpoint oldest-first so
    // normal "latest activity wins" sidebar ordering still leaves the newest
    // desktop thread at the top after a Worker restart.
    if (fullHistory) discovered.reverse();
    for (const header of discovered) {
      const started = Date.now();
      const snapshot = await this.observer.readThread(header.id);
      if (snapshot) {
        this.publishDelta(project.id, snapshot);
        this.updateRunningPoll(snapshot, true);
        this.logLargeRead(header.id, snapshot, Date.now() - started);
      }
    }
    if (fullHistory && page.nextCursor) void this.backfillProject(project, page.nextCursor, 1, this.bootstrapGeneration);
  }

  private publishDelta(projectId: string, snapshot: ThreadSnapshot): boolean {
    const next = snapshotState(snapshot);
    const previous = this.threadStates.get(snapshot.id);
    const changedMetadata = !previous || previous.metadata !== next.metadata;
    const messages = previous
      ? snapshot.messages.filter((item) => previous.messages.get(itemKey(item)) !== next.messages.get(itemKey(item)))
      : snapshot.messages;
    const activities = previous
      ? snapshot.activities.filter((item) => previous.activities.get(itemKey(item)) !== next.activities.get(itemKey(item)))
      : snapshot.activities;
    this.threadStates.set(snapshot.id, next);
    this.headerVersions.set(snapshot.id, snapshot.updatedAt);
    if (snapshot.status === "running") this.runningThreads.add(snapshot.id);
    else this.runningThreads.delete(snapshot.id);
    if (!changedMetadata && messages.length === 0 && activities.length === 0) return false;
    for (const packet of snapshotPackets(snapshot, messages, activities)) this.onSnapshot(projectId, packet);
    return true;
  }

  private async backfillProject(project: ProjectWatch, initialCursor: string, pages: number, generation: number): Promise<void> {
    let cursor: string | null = initialCursor;
    let pageNumber = pages;
    while (!this.closed && generation === this.bootstrapGeneration && cursor && pageNumber < 10) {
      await delay(2_000);
      if (this.closed || generation !== this.bootstrapGeneration) return;
      try {
        const page = await this.observer.listProjectThreadHeaders(project.rootPath, cursor, 50);
        const discovered = [...page.threads].reverse();
        for (const header of discovered) {
          this.threadProjects.set(header.id, project.id);
          const previousVersion = this.headerVersions.get(header.id);
          this.headerVersions.set(header.id, header.updatedAt);
          if (previousVersion === header.updatedAt) continue;
          const started = Date.now();
          const snapshot = await this.observer.readThread(header.id);
          if (snapshot) {
            this.publishDelta(project.id, snapshot);
            this.updateRunningPoll(snapshot, true);
            this.logLargeRead(header.id, snapshot, Date.now() - started);
          }
        }
        cursor = page.nextCursor;
        pageNumber += 1;
      } catch (error) {
        this.log(`lazy Codex startup import failed (${project.id}): ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }

  private updateRunningPoll(snapshot: ThreadSnapshot, changed: boolean): void {
    if (snapshot.status !== "running") {
      this.runningPolls.delete(snapshot.id);
      return;
    }
    const current = this.runningPolls.get(snapshot.id) ?? { intervalMs: 5_000, nextAt: 0 };
    const intervalMs = changed ? 5_000 : Math.min(60_000, current.intervalMs * 2);
    this.runningPolls.set(snapshot.id, { intervalMs, nextAt: Date.now() + intervalMs });
  }

  private logLargeRead(threadId: string, snapshot: ThreadSnapshot, elapsedMs: number): void {
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (bytes >= 1024 * 1024 || elapsedMs >= 1_000) {
      this.log(`Codex thread read ${threadId}: ${bytes} bytes in ${elapsedMs} ms`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function snapshotState(snapshot: ThreadSnapshot): ThreadState {
  return {
    metadata: crypto.createHash("sha256").update(JSON.stringify({
      name: snapshot.name,
      nameSource: snapshot.nameSource,
      status: snapshot.status,
    })).digest("hex"),
    messages: new Map(snapshot.messages.map((item) => [itemKey(item), itemFingerprint(item)])),
    activities: new Map(snapshot.activities.map((item) => [itemKey(item), itemFingerprint(item)])),
  };
}

function itemFingerprint(item: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex");
}
function itemKey(item: { turnId: string; itemId: string }): string { return `${item.turnId}\u0000${item.itemId}`; }

function snapshotPackets(
  snapshot: ThreadSnapshot,
  messages: ThreadSnapshot["messages"],
  activities: ThreadSnapshot["activities"],
): ThreadSnapshot[] {
  if (messages.length === 0 && activities.length === 0) return [{ ...snapshot, messages: [], activities: [] }];
  const packets: ThreadSnapshot[] = [];
  let packet: ThreadSnapshot = { ...snapshot, messages: [], activities: [] };
  let bytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
  const flush = () => {
    if (packet.messages.length === 0 && packet.activities.length === 0) return;
    packets.push(packet);
    packet = { ...snapshot, messages: [], activities: [] };
    bytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
  };
  for (const message of messages) {
    const size = Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    if (bytes + size > SNAPSHOT_PAYLOAD_BUDGET) flush();
    packet.messages.push(message);
    bytes += size;
  }
  for (const activity of activities) {
    const size = Buffer.byteLength(JSON.stringify(activity), "utf8") + 1;
    if (bytes + size > SNAPSHOT_PAYLOAD_BUDGET) flush();
    packet.activities.push(activity);
    bytes += size;
  }
  flush();
  return packets;
}
