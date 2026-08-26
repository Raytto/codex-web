import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkerMessage } from "./protocol.js";
import { isPersistableWorkerMessage, WORKER_MESSAGE_MAX_BYTES } from "./protocol-validation.js";

const OUTBOX_VERSION = 1;
const OUTBOX_MAX_ITEMS = 500;
const OUTBOX_MAX_BYTES = 8 * 1024 * 1024;

type StoredOutbox = { version: 1; items: WorkerMessage[] };
export type OutboxMutation = { accepted: boolean; dropped: number; reason?: "invalid" | "oversize" };

export class DurableOutbox {
  private items: WorkerMessage[] = [];

  constructor(private readonly filePath: string, private readonly report: (message: string) => void = () => undefined) {
    this.items = this.load();
  }

  get length(): number { return this.items.length; }
  at(index: number): WorkerMessage | undefined { return this.items[index]; }
  findIndex(predicate: (message: WorkerMessage) => boolean): number { return this.items.findIndex(predicate); }

  replace(index: number, message: WorkerMessage): OutboxMutation {
    if (index < 0 || index >= this.items.length) return { accepted: false, dropped: 0, reason: "invalid" };
    if (!this.acceptable(message)) return { accepted: false, dropped: 0, reason: "oversize" };
    this.items[index] = message;
    const dropped = this.enforceBudget(index);
    this.persist();
    return { accepted: this.items.includes(message), dropped };
  }

  enqueue(message: WorkerMessage): OutboxMutation {
    if (!isPersistableWorkerMessage(message)) return { accepted: false, dropped: 0, reason: "invalid" };
    if (!this.acceptable(message)) return { accepted: false, dropped: 0, reason: "oversize" };
    this.coalesceEphemeral(message);
    this.items.push(message);
    const dropped = this.enforceBudget(this.items.length - 1);
    this.persist();
    return { accepted: this.items.includes(message), dropped };
  }

  flush(send: (message: WorkerMessage) => void): number {
    if (this.items.length === 0) return 0;
    const queued = [...this.items];
    for (const message of queued) send(message);
    this.items.splice(0, queued.length);
    this.persist();
    return queued.length;
  }

  persist(): void {
    if (this.items.length === 0) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }
    const body = `${JSON.stringify({ version: OUTBOX_VERSION, items: this.items } satisfies StoredOutbox)}\n`;
    if (Buffer.byteLength(body, "utf8") > OUTBOX_MAX_BYTES + 64 * 1024) throw new Error("durable outbox exceeded its persisted budget");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { fs.renameSync(temporary, this.filePath); }
    catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  }

  private load(): WorkerMessage[] {
    try {
      const stat = fs.statSync(this.filePath);
      if (!stat.isFile() || stat.size > OUTBOX_MAX_BYTES + 64 * 1024) throw new Error("file size is outside the outbox budget");
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredOutbox>;
      if (value.version !== OUTBOX_VERSION || !Array.isArray(value.items) || value.items.length > OUTBOX_MAX_ITEMS
        || !value.items.every(isPersistableWorkerMessage)) throw new Error("outbox schema is invalid");
      const items = [...value.items];
      if (serializedBytes(items) > OUTBOX_MAX_BYTES) throw new Error("outbox payload is outside the byte budget");
      return items;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code === "ENOENT") return [];
      const preserved = `${this.filePath}.invalid-${Date.now()}`;
      try { fs.renameSync(this.filePath, preserved); }
      catch { /* The source may have disappeared between inspection and preservation. */ }
      this.report(`durable outbox was quarantined: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private acceptable(message: WorkerMessage): boolean {
    try { return Buffer.byteLength(JSON.stringify(message), "utf8") <= Math.min(WORKER_MESSAGE_MAX_BYTES, OUTBOX_MAX_BYTES); }
    catch { return false; }
  }

  private coalesceEphemeral(message: WorkerMessage): void {
    if (message.type === "heartbeat" || message.type === "quota_usage") {
      this.items = this.items.filter((item) => item.type !== message.type);
    }
    if (message.type === "runtime_status" && !message.requestId) {
      this.items = this.items.filter((item) => item.type !== "runtime_status" || Boolean(item.requestId));
    }
  }

  private enforceBudget(preferredIndex: number): number {
    let dropped = 0;
    while (this.items.length > OUTBOX_MAX_ITEMS || serializedBytes(this.items) > OUTBOX_MAX_BYTES) {
      let index = this.items.findIndex((item, candidate) => candidate !== preferredIndex && droppable(item));
      if (index < 0) index = this.items.findIndex((_item, candidate) => candidate !== preferredIndex);
      if (index < 0) index = 0;
      this.items.splice(index, 1);
      if (index < preferredIndex) preferredIndex -= 1;
      dropped += 1;
    }
    if (dropped) this.report(`durable outbox dropped ${dropped} oldest bounded update${dropped === 1 ? "" : "s"}`);
    return dropped;
  }
}

function serializedBytes(items: WorkerMessage[]): number {
  return Buffer.byteLength(JSON.stringify(items), "utf8");
}

function droppable(message: WorkerMessage): boolean {
  return message.type === "heartbeat" || message.type === "quota_usage" || message.type === "runtime_status" || message.type === "thread_activity";
}
