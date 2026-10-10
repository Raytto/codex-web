import crypto from "node:crypto";
import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import {
  TRANSFER_MAX_FILE_BYTES,
  type TransferRole,
  type TransferSpec,
} from "../remote-worker/src/node-transfer-types.js";
export type TransferLocation = { executorId: string; path: string };
export type TransferInput = {
  source: TransferLocation;
  target: TransferLocation;
  overwrite: boolean;
  route: "auto" | "relay";
  idempotencyKey: string;
};
export type TransferRow = TransferInput & {
  id: string;
  userId: string;
  conversationId: string | null;
  state: string;
  outcome: "success" | "failed" | "cancelled" | null;
  epoch: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  retryUntil: number;
  nextAttempt: number;
  bytes: number;
  size: number | null;
  sha256: string | null;
  actualRoute: "direct" | "relay" | null;
  relayBytes: number;
  committed: boolean;
  forceRelay?: boolean;
  cleaned: { source: boolean; target: boolean };
  error: string | null;
};
type End = {
  token: string;
  socket?: WebSocket;
  key?: string;
  cryptoReady: boolean;
  directReady: boolean;
  lastSeen: number;
};
type Attempt = {
  row: TransferRow;
  source: End;
  target: End;
  timer?: ReturnType<typeof setTimeout>;
  paired: boolean;
  routeSelected: boolean;
  fallbackDue?: boolean;
  closed: boolean;
};
export type TransferDispatch = (
  executorId: string,
  spec: TransferSpec,
) => Promise<void>;
const terminal = new Set(["completed", "failed", "cancelled"]);
export function parseTransferInput(raw: unknown): TransferInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("INVALID_TRANSFER");
  const v = raw as Record<string, any>;
  if (
    Object.keys(v).some(
      (k) =>
        !["source", "target", "overwrite", "route", "idempotencyKey"].includes(
          k,
        ),
    )
  )
    throw new Error("UNKNOWN_TRANSFER_FIELD");
  for (const role of ["source", "target"]) {
    const loc = v[role];
    if (
      !loc ||
      Object.keys(loc).some((k) => !["executorId", "path"].includes(k)) ||
      typeof loc.executorId !== "string" ||
      loc.executorId.length > 100 ||
      typeof loc.path !== "string" ||
      loc.path.length < 1 ||
      loc.path.length > 4096 ||
      /[\0\r\n]/.test(loc.path)
    )
      throw new Error("INVALID_TRANSFER_LOCATION");
  }
  if (v.source.executorId === v.target.executorId)
    throw new Error("DIFFERENT_NODES_REQUIRED");
  if (v.overwrite !== undefined && typeof v.overwrite !== "boolean")
    throw new Error("INVALID_OVERWRITE");
  if (v.route !== undefined && !["auto", "relay"].includes(v.route))
    throw new Error("INVALID_ROUTE");
  if (
    typeof v.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(v.idempotencyKey)
  )
    throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  return {
    source: { ...v.source },
    target: { ...v.target },
    overwrite: v.overwrite === true,
    route: v.route ?? "auto",
    idempotencyKey: v.idempotencyKey,
  };
}
export class NodeTransferCoordinator {
  private readonly ws = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  private readonly active = new Map<string, Attempt>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private closed = false;
  private attachedServer?: http.Server;
  private upgradeListener?: Parameters<http.Server["on"]>[1];
  constructor(
    private db: DatabaseSync,
    private dispatch: TransferDispatch,
    private url: string,
    private capable: (id: string) => boolean,
    private iceServers: TransferSpec["iceServers"] = [
      { urls: "stun:stun.cloudflare.com:3478" },
    ],
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS node_transfers(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(user_id,idempotency_key)); CREATE INDEX IF NOT EXISTS node_transfers_active ON node_transfers(state,updated_at)`,
    );
    // Leases and encryption keys are deliberately not persisted. Recovery creates a fenced epoch.
    for (const row of this.pending()) {
      row.nextAttempt = 0;
      this.save(row);
    }
  }
  create(
    userId: string,
    conversationId: string | null,
    raw: unknown,
  ): TransferRow {
    const input = parseTransferInput(raw);
    const existing = this.db
      .prepare(
        "SELECT payload FROM node_transfers WHERE user_id=? AND idempotency_key=?",
      )
      .get(userId, input.idempotencyKey) as { payload: string } | undefined;
    if (existing) {
      const row = JSON.parse(existing.payload) as TransferRow;
      if (JSON.stringify(pickInput(row)) !== JSON.stringify(input))
        throw new Error("IDEMPOTENCY_CONFLICT");
      return row;
    }
    if (this.pending().filter((r) => r.userId === userId).length >= 32)
      throw new Error("TRANSFER_QUEUE_FULL");
    if (
      !this.capable(input.source.executorId) ||
      !this.capable(input.target.executorId)
    )
      throw new Error("NODE_REQUIRES_TRANSFER_UPGRADE");
    const now = Date.now();
    const row: TransferRow = {
      ...input,
      id: crypto.randomUUID(),
      userId,
      conversationId,
      state: "queued",
      outcome: null,
      epoch: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 24 * 3600_000,
      retryUntil: now + 24 * 3600_000,
      nextAttempt: 0,
      bytes: 0,
      size: null,
      sha256: null,
      actualRoute: null,
      relayBytes: 0,
      committed: false,
      cleaned: { source: false, target: false },
      error: null,
    };
    this.save(row);
    void this.tick();
    return row;
  }
  get(id: string, userId: string): TransferRow | undefined {
    const r = this.db
      .prepare("SELECT payload FROM node_transfers WHERE id=? AND user_id=?")
      .get(id, userId) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) : undefined;
  }
  list(userId: string): TransferRow[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM node_transfers WHERE user_id=? ORDER BY updated_at DESC LIMIT 100",
        )
        .all(userId) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  cancel(id: string, userId: string): TransferRow {
    const row = this.get(id, userId);
    if (!row) throw new Error("TRANSFER_NOT_FOUND");
    if (terminal.has(row.state)) return row;
    row.outcome = row.committed ? "success" : "cancelled";
    row.state = "cleanup_pending";
    row.nextAttempt = 0;
    this.save(row);
    const a = this.active.get(id);
    if (a) {
      a.row = row;
      for (const role of roles) this.send(a[role], { type: "cancel" });
    } else void this.tick();
    return row;
  }
  attach(server: http.Server): void {
    this.attachedServer = server;
    const listener: Parameters<http.Server["on"]>[1] = (
      request: any,
      socket: any,
      head: any,
    ) => {
      let pathname: string;
      try { pathname = new URL(request.url ?? "/", "http://localhost").pathname; }
      catch { socket.destroy(); return; }
      if (pathname !== new URL(this.url).pathname) return;
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      let match: { a: Attempt; role: TransferRole } | undefined;
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token))
        for (const a of this.active.values())
          for (const role of roles)
            if (safeEqual(a[role].token, token) && !a[role].socket)
              match = { a, role };
      if (!match) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const { a, role } = match;
      this.ws.handleUpgrade(request, socket, head, (ws) =>
        this.connect(a, role, ws),
      );
    };
    this.upgradeListener = listener;
    server.on("upgrade", listener);
    this.timer = setInterval(() => void this.tick(), 2_000);
    this.timer.unref();
    void this.tick();
  }
  private connect(a: Attempt, role: TransferRole, socket: WebSocket): void {
    if (a.closed || a[role].socket) {
      socket.close();
      return;
    }
    a[role].socket = socket;
    a[role].lastSeen = Date.now();
    socket.on("message", (raw, binary) => {
      if (a.closed) return;
      a[role].lastSeen = Date.now();
      try {
        if (binary) {
          if (
            a.row.actualRoute !== "relay" ||
            !a.routeSelected ||
            Buffer.byteLength(raw as Buffer) > 16512
          )
            throw new Error("UNEXPECTED_RELAY_DATA");
          const peer = a[other(role)].socket;
          if (!peer || peer.readyState !== WebSocket.OPEN)
            throw new Error("PEER_OFFLINE");
          if (peer.bufferedAmount > 2 * 1024 * 1024)
            throw new Error("RELAY_BUFFER_LIMIT");
          a.row.relayBytes += Buffer.byteLength(raw as Buffer);
          peer.send(raw, { binary: true });
          return;
        }
        if (Buffer.byteLength(raw as Buffer) > 64 * 1024)
          throw new Error("CONTROL_TOO_LARGE");
        this.message(a, role, JSON.parse(raw.toString()));
      } catch (e) {
        this.fail(a, errorText(e), false);
      }
    });
    socket.on("error", () => this.disconnected(a));
    socket.on("close", () => this.disconnected(a));
  }
  private message(
    a: Attempt,
    role: TransferRole,
    m: Record<string, any>,
  ): void {
    const row = a.row,
      peer = a[other(role)];
    if (
      row.state === "cleanup_pending" &&
      ![
        "ready",
        "committed",
        "cleaned",
        "cleanup_error",
        "error",
        "heartbeat",
        "stopped",
      ].includes(m.type)
    )
      return;
    switch (m.type) {
      case "ready":
        if (typeof m.key !== "string" || m.key.length !== 44 || a[role].key)
          throw new Error("INVALID_PEER_KEY");
        a[role].key = m.key;
        if (row.state === "cleanup_pending") {
          this.send(a[role], { type: "cancel" });
          return;
        }
        if (a.source.key && a.target.key && !a.paired) {
          a.paired = true;
          for (const r of roles)
            this.send(a[r], { type: "peer", key: a[other(r)].key });
          a.timer = setTimeout(() => {
            a.fallbackDue = true;
            this.selectRoute(a, "relay");
          }, 8_000);
          a.timer.unref();
        }
        break;
      case "crypto_header":
        if (typeof m.header !== "string" || m.header.length > 64)
          throw new Error("INVALID_CRYPTO_HEADER");
        this.send(peer, m);
        break;
      case "crypto_ready":
        a[role].cryptoReady = true;
        if (row.route === "relay" || row.forceRelay || a.fallbackDue)
          this.selectRoute(a, "relay");
        else if (a.source.directReady && a.target.directReady)
          this.selectRoute(a, "direct");
        break;
      case "sdp":
      case "candidate":
        if (!a.routeSelected) this.send(peer, m);
        break;
      case "direct_unavailable":
        a.fallbackDue = true;
        this.selectRoute(a, "relay");
        break;
      case "direct_ready":
        a[role].directReady = true;
        if (a.source.directReady && a.target.directReady)
          this.selectRoute(a, "direct");
        break;
      case "preparing":
        row.state = "preparing";
        this.save(row);
        break;
      case "manifest":
        if (
          role !== "target" ||
          !Number.isSafeInteger(m.size) ||
          m.size < 0 ||
          m.size > TRANSFER_MAX_FILE_BYTES ||
          typeof m.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(m.sha256)
        )
          throw new Error("INVALID_MANIFEST");
        if (row.sha256 && row.sha256 !== m.sha256)
          throw new Error("SOURCE_CHANGED");
        row.size = m.size;
        row.sha256 = m.sha256;
        row.state = "transferring";
        row.retryUntil = Date.now() + 600_000;
        this.save(row);
        break;
      case "progress":
        if (
          !Number.isSafeInteger(m.offset) ||
          m.offset < 0 ||
          m.offset > TRANSFER_MAX_FILE_BYTES ||
          !Number.isSafeInteger(m.size) ||
          m.offset > m.size
        )
          throw new Error("INVALID_PROGRESS");
        row.bytes = Math.max(row.bytes, m.offset);
        row.retryUntil = Math.min(row.expiresAt, Date.now() + 600_000);
        this.save(row);
        break;
      case "verifying":
        if (role !== "target") throw new Error("WRONG_ROLE");
        row.state = "verifying";
        this.save(row);
        break;
      case "committed":
        if (role !== "target" || m.sha256 !== row.sha256 || m.size !== row.size)
          throw new Error("INVALID_COMMIT");
        row.committed = true;
        row.outcome = "success";
        row.state = "cleanup_pending";
        this.save(row);
        break;
      case "cleaned":
        row.cleaned[role] = true;
        this.save(row);
        this.finishIfClean(a);
        break;
      case "cleanup_error":
        row.state = "cleanup_pending";
        row.error = errorText(m.message);
        this.save(row);
        break;
      case "error":
        this.fail(
          a,
          errorText(m.message),
          !/^DIRECT_DISCONNECTED|^TRANSFER_STALLED|^PEER_ACK_TIMEOUT/.test(
            String(m.message),
          ),
        );
        break;
      case "heartbeat":
        break;
      case "stopped":
        break;
      default:
        throw new Error("INVALID_TRANSFER_EVENT");
    }
  }
  private selectRoute(a: Attempt, route: "direct" | "relay"): void {
    if (
      a.closed ||
      a.routeSelected ||
      !a.source.cryptoReady ||
      !a.target.cryptoReady
    )
      return;
    if (route === "direct" && (!a.source.directReady || !a.target.directReady))
      return;
    a.routeSelected = true;
    if (a.timer) clearTimeout(a.timer);
    a.row.actualRoute = route;
    a.row.state = "transferring";
    this.save(a.row);
    for (const role of roles) this.send(a[role], { type: "route", route });
  }
  private finishIfClean(a: Attempt): void {
    if (!a.row.cleaned.source || !a.row.cleaned.target) return;
    if (!a.row.outcome) {
      a.row.outcome = "failed";
      a.row.error = "MISSING_COMMIT_RECEIPT";
    }
    a.row.state = a.row.outcome === "success" ? "completed" : a.row.outcome;
    this.save(a.row);
    for (const role of roles) this.send(a[role], { type: "release" });
    this.drop(a);
  }
  private disconnected(a: Attempt): void {
    if (a.closed) return;
    this.fail(a, "NODE_DISCONNECTED", false);
  }
  private fail(a: Attempt, message: string, fatal: boolean): void {
    if (a.closed) return;
    const r = a.row;
    r.error = message;
    r.nextAttempt = Date.now() + 5_000;
    if (r.committed || r.outcome || fatal) {
      r.state = "cleanup_pending";
      r.outcome = r.committed ? "success" : (r.outcome ?? "failed");
    } else {
      r.state = "paused";
      if (r.actualRoute === "direct") r.forceRelay = true;
    }
    this.save(r);
    this.drop(a);
    void this.tick();
  }
  private drop(a: Attempt): void {
    a.closed = true;
    if (a.timer) clearTimeout(a.timer);
    this.active.delete(a.row.id);
    for (const role of roles) {
      a[role].token = "";
      a[role].socket?.close(1000, "attempt finished");
    }
  }
  private send(e: End, m: Record<string, unknown>): void {
    if (e.socket?.readyState === WebSocket.OPEN)
      e.socket.send(JSON.stringify(m));
  }
  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const a of this.active.values()) {
        if (now > a.row.expiresAt && a.row.state !== "cleanup_pending") {
          this.fail(a, "TRANSFER_EXPIRED", true);
          continue;
        }
        if (roles.some((r) => now - a[r].lastSeen > 60_000)) {
          this.fail(a, "NODE_TIMEOUT", false);
        }
      }
      for (const row of this.pending()) {
        if (this.active.has(row.id) || row.nextAttempt > now) continue;
        if (now > row.expiresAt || now > row.retryUntil) {
          row.state = "cleanup_pending";
          row.outcome = row.committed ? "success" : (row.outcome ?? "failed");
          row.error ??= "TRANSFER_EXPIRED";
        }
        if (this.active.size >= 4) break;
        if (
          [...this.active.values()].some((a) =>
            [a.row.source.executorId, a.row.target.executorId].some(
              (id) =>
                id === row.source.executorId || id === row.target.executorId,
            ),
          )
        )
          continue;
        await this.launch(row);
      }
    } finally {
      this.ticking = false;
    }
  }
  private async launch(row: TransferRow): Promise<void> {
    const cleanup = row.state === "cleanup_pending";
    row.epoch++;
    row.state = cleanup ? "cleanup_pending" : "connecting";
    row.nextAttempt = Date.now() + 15_000;
    this.save(row);
    const make = (): End => ({
      token: crypto.randomBytes(32).toString("base64url"),
      cryptoReady: false,
      directReady: false,
      lastSeen: Date.now(),
    });
    const a: Attempt = {
      row,
      source: make(),
      target: make(),
      paired: false,
      routeSelected: false,
      closed: false,
    };
    this.active.set(row.id, a);
    try {
      for (const role of roles) {
        if (a.closed || this.closed) return;
        if (cleanup && row.cleaned[role]) continue;
        await this.dispatch(row[role].executorId, {
          id: row.id,
          epoch: row.epoch,
          role,
          operation: cleanup ? "cleanup" : "run",
          path: row[role].path,
          token: a[role].token,
          url: this.url,
          expiresAt: cleanup ? Date.now() + 600_000 : row.expiresAt,
          overwrite: row.overwrite,
          direct: row.route === "auto" && !row.forceRelay,
          iceServers: this.iceServers,
        });
      }
      this.finishIfCleanIfCleanup(a, cleanup);
    } catch (e) {
      this.fail(a, errorText(e), false);
    }
  }
  private finishIfCleanIfCleanup(a: Attempt, cleanup: boolean): void {
    if (cleanup) this.finishIfClean(a);
  }
  isBusy(executorId: string): boolean {
    return [...this.active.values()].some(
      (a) =>
        a.row.source.executorId === executorId ||
        a.row.target.executorId === executorId,
    );
  }
  private pending(): TransferRow[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM node_transfers WHERE state NOT IN ('completed','failed','cancelled') ORDER BY updated_at LIMIT 100",
        )
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  private save(r: TransferRow): void {
    r.updatedAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO node_transfers(id,user_id,idempotency_key,state,updated_at,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,payload=excluded.payload",
      )
      .run(
        r.id,
        r.userId,
        r.idempotencyKey,
        r.state,
        r.updatedAt,
        JSON.stringify(r),
      );
  }
  close(): void {
    this.closed = true;
    if (this.upgradeListener)
      this.attachedServer?.off("upgrade", this.upgradeListener);
    if (this.timer) clearInterval(this.timer);
    for (const a of [...this.active.values()]) this.drop(a);
    this.ws.close();
  }
}
const roles: TransferRole[] = ["source", "target"];
function other(role: TransferRole): TransferRole {
  return role === "source" ? "target" : "source";
}
function pickInput(r: TransferInput): TransferInput {
  return {
    source: r.source,
    target: r.target,
    overwrite: r.overwrite,
    route: r.route,
    idempotencyKey: r.idempotencyKey,
  };
}
function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}
function safeEqual(a: string, b: string): boolean {
  return (
    a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
