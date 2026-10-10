import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import sodium from "libsodium-wrappers-sumo";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import {
  TransferFiles,
  openSource,
  sourceIdentity,
  type Manifest,
} from "./node-transfer-files.js";
import {
  isTransferSpec,
  TRANSFER_BLOCK_BYTES,
  TRANSFER_FRAME_BYTES,
  type TransferSpec,
} from "./node-transfer-types.js";
type Json = Record<string, any>;
const wait = (n: number) => new Promise<void>((r) => setTimeout(r, n));
export class NodeTransferEndpoint {
  private readonly files: TransferFiles;
  private readonly active = new Map<string, TransferSession>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  constructor(
    stateRoot: string,
    private readonly allowedOrigin: string,
  ) {
    this.files = new TransferFiles(stateRoot);
    this.sweeper = setInterval(
      () =>
        void this.files
          .sweep(new Set(this.active.keys()))
          .catch(() => undefined),
      60_000,
    );
    this.sweeper.unref();
    void this.files.sweep(new Set()).catch(() => undefined);
  }
  get activeCount(): number {
    return this.active.size;
  }
  async start(spec: TransferSpec): Promise<void> {
    if (
      !isTransferSpec(spec) ||
      spec.expiresAt <= Date.now() ||
      spec.expiresAt > Date.now() + 25 * 3600_000
    )
      throw new Error("INVALID_TRANSFER_SPEC");
    const url = new URL(spec.url),
      allowed = new URL(this.allowedOrigin.replace(/^http/, "ws"));
    if (
      url.origin !== allowed.origin ||
      url.pathname !== `${allowed.pathname.replace(/\/$/, "")}/api/node-transfers/connect` ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("UNTRUSTED_TRANSFER_SERVER");
    if (!path.isAbsolute(spec.path)) throw new Error("ABSOLUTE_PATH_REQUIRED");
    const previous = this.active.get(spec.id);
    if (previous && previous.spec.epoch >= spec.epoch) return;
    if (previous) await previous.stop(false);
    if (this.active.size >= 2) throw new Error("TRANSFER_NODE_BUSY");
    const session = new TransferSession(spec, this.files, () => {
      if (this.active.get(spec.id) === session) this.active.delete(spec.id);
    });
    this.active.set(spec.id, session);
    await session.start();
  }
  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.active.values()].map((s) => s.stop(false)));
  }
}
class TransferSession {
  private ws!: WebSocket;
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private route: "direct" | "relay" | null = null;
  private peerKey?: Uint8Array;
  private pair?: { publicKey: Uint8Array; privateKey: Uint8Array };
  private tx: any;
  private rx: any;
  private receive?: Awaited<ReturnType<TransferFiles["receive"]>>;
  private source?: Awaited<ReturnType<typeof openSource>>;
  private messages: Json[] = [];
  private deadline?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastProgress = Date.now();
  private finishing = false;
  constructor(
    readonly spec: TransferSpec,
    private files: TransferFiles,
    private onClose: () => void,
  ) {}
  async start(): Promise<void> {
    await sodium.ready;
    if (this.closed) return;
    this.pair = sodium.crypto_kx_keypair();
    this.ws = new WebSocket(this.spec.url, {
      headers: { authorization: `Bearer ${this.spec.token}` },
      maxPayload: 128 * 1024,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    this.ws.on("open", () => {
      this.control({
        type: "ready",
        key: sodium.to_base64(
          this.pair!.publicKey,
          sodium.base64_variants.ORIGINAL,
        ),
      });
      if (this.spec.operation === "cleanup") void this.stop(true);
    });
    this.ws.on("message", (raw, binary) => {
      if (this.closed) return;
      if (binary) this.packet(Buffer.from(raw as Buffer));
      else {
        let m: Json;
        try {
          m = JSON.parse(raw.toString());
        } catch {
          void this.fail("INVALID_CONTROL");
          return;
        }
        // Cancel must not wait behind a long hash pass, but cleanup waits for writes.
        if (m.type === "cancel") {
          void this.stop(true);
          return;
        }
        if (m.type === "release") {
          void this.release();
          return;
        }
        void this.controlMessage(m).catch((e) => {
          if (["sdp", "candidate"].includes(m.type)) {
            if (!this.route) this.control({ type: "direct_unavailable" });
            return;
          }
          return this.fail(errorText(e));
        });
      }
    });
    this.ws.on("error", () => void this.stop(false));
    this.ws.on("close", () => void this.stop(false));
    this.deadline = setTimeout(
      () => void this.stop(true),
      Math.max(1, this.spec.expiresAt - Date.now()),
    );
    this.deadline.unref();
    this.heartbeat = setInterval(() => {
      this.control({ type: "heartbeat" });
      if (
        this.route &&
        !this.finishing &&
        Date.now() - this.lastProgress > 90_000
      )
        void this.fail("TRANSFER_STALLED");
    }, 15_000);
    this.heartbeat.unref();
  }
  private control(m: Json): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
  private async controlMessage(m: Json): Promise<void> {
    if (m.type === "peer") {
      if (this.peerKey) throw new Error("DUPLICATE_PEER");
      const peer = sodium.from_base64(m.key, sodium.base64_variants.ORIGINAL);
      if (peer.length !== 32) throw new Error("INVALID_PEER_KEY");
      this.peerKey = peer;
      const k =
        this.spec.role === "source"
          ? sodium.crypto_kx_client_session_keys(
              this.pair!.publicKey,
              this.pair!.privateKey,
              peer,
            )
          : sodium.crypto_kx_server_session_keys(
              this.pair!.publicKey,
              this.pair!.privateKey,
              peer,
            );
      const tx = sodium.crypto_secretstream_xchacha20poly1305_init_push(
        k.sharedTx,
      );
      this.tx = tx.state;
      this.control({
        type: "crypto_header",
        header: sodium.to_base64(tx.header, sodium.base64_variants.ORIGINAL),
      });
      // Keep only the receive key until the authenticated peer header arrives.
      this.messages.push({ type: "rx_key", key: k.sharedRx });
      sodium.memzero(k.sharedTx);
      sodium.memzero(this.pair!.privateKey);
      if (this.spec.direct)
        await this.makePeer().catch(() =>
          this.control({ type: "direct_unavailable" }),
        );
    } else if (m.type === "crypto_header") {
      const key = this.messages.find((x) => x.type === "rx_key");
      if (!key || this.rx) throw new Error("INVALID_CRYPTO_SEQUENCE");
      this.rx = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        sodium.from_base64(m.header, sodium.base64_variants.ORIGINAL),
        key.key,
      );
      sodium.memzero(key.key);
      this.messages = this.messages.filter((x) => x !== key);
      this.control({ type: "crypto_ready" });
    } else if (m.type === "sdp") {
      if (this.route === "relay") return;
      if (!this.pc) await this.makePeer();
      const pc = this.pc;
      if (!pc) return;
      if (
        !m.description ||
        !["offer", "answer"].includes(m.description.type) ||
        typeof m.description.sdp !== "string" ||
        m.description.sdp.length > 60_000
      )
        throw new Error("INVALID_SDP");
      await pc.setRemoteDescription(m.description);
      if (m.description.type === "offer" && this.pc === pc) {
        const a = await pc.createAnswer();
        await pc.setLocalDescription(a);
        if (this.pc === pc)
          this.control({ type: "sdp", description: pc.localDescription });
      }
    } else if (m.type === "candidate") {
      if (this.pc && m.candidate) await this.pc.addIceCandidate(m.candidate);
    } else if (m.type === "route") {
      if (this.route || !this.rx || !["direct", "relay"].includes(m.route))
        throw new Error("INVALID_ROUTE");
      this.route = m.route;
      if (this.route === "relay") {
        await this.pc?.close();
        this.pc = undefined;
      }
      if (this.spec.role === "source")
        void this.sendFile().catch((e) => this.fail(errorText(e)));
    }
  }
  private async makePeer(): Promise<void> {
    if (this.pc || this.closed) return;
    this.pc = new RTCPeerConnection({
      iceServers: this.spec.iceServers,
      iceUseIpv6: true,
    });
    this.pc.onIceCandidate.subscribe((candidate) => {
      if (candidate)
        this.control({ type: "candidate", candidate: candidate.toJSON() });
    });
    this.pc.onDataChannel.subscribe((c) => this.bindChannel(c));
    if (this.spec.role === "source") {
      this.bindChannel(
        this.pc.createDataChannel("ppa-transfer-v1", { ordered: true }),
      );
      const pc = this.pc;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.route !== "relay")
        this.control({ type: "sdp", description: pc.localDescription });
    }
  }
  private bindChannel(c: RTCDataChannel): void {
    this.channel = c;
    c.onMessage.subscribe((data) => {
      if (typeof data !== "string") this.packet(data);
      else void this.fail("BINARY_DATA_REQUIRED");
    });
    c.stateChange.subscribe((state) => {
      if (state === "open") this.control({ type: "direct_ready" });
      if (state === "closed" && this.route === "direct" && !this.closed)
        void this.fail("DIRECT_DISCONNECTED");
    });
    if (c.readyState === "open") this.control({ type: "direct_ready" });
  }
  private packet(data: Buffer): void {
    if (this.closed) return;
    if (
      data.length > TRANSFER_FRAME_BYTES + 128 ||
      !this.rx ||
      (this.queuedBytes += data.length) > 2 * TRANSFER_BLOCK_BYTES
    ) {
      void this.fail("TRANSFER_BUFFER_LIMIT");
      return;
    }
    this.queue = this.queue
      .then(async () => {
        try {
          if (this.closed) return;
          const ad = Buffer.from(`${this.spec.id}:${this.spec.epoch}`);
          const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
            this.rx,
            data,
            ad,
          );
          if (!result) throw new Error("AUTHENTICATION_FAILED");
          const plain = Buffer.from(result.message);
          this.lastProgress = Date.now();
          if (plain[0] === 1) await this.receiveData(plain);
          else if (plain[0] === 2)
            await this.peerMessage(JSON.parse(plain.subarray(1).toString()));
          else throw new Error("INVALID_FRAME");
        } finally {
          this.queuedBytes -= data.length;
        }
      })
      .catch((e) => {
        void this.fail(errorText(e));
      });
  }
  private async transmit(plain: Buffer): Promise<void> {
    if (this.closed) throw new Error("TRANSFER_CLOSED");
    const cipher = Buffer.from(
      sodium.crypto_secretstream_xchacha20poly1305_push(
        this.tx,
        plain,
        Buffer.from(`${this.spec.id}:${this.spec.epoch}`),
        sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      ),
    );
    if (this.route === "direct") {
      while (
        !this.closed &&
        this.channel &&
        this.channel.bufferedAmount > 512 * 1024
      )
        await wait(5);
      if (this.closed || this.channel?.readyState !== "open")
        throw new Error("DIRECT_DISCONNECTED");
      this.channel.send(cipher);
    } else if (this.route === "relay") {
      while (!this.closed && this.ws.bufferedAmount > 512 * 1024) await wait(5);
      if (this.closed || this.ws.readyState !== WebSocket.OPEN)
        throw new Error("RELAY_DISCONNECTED");
      await new Promise<void>((resolve, reject) =>
        this.ws.send(cipher, { binary: true }, (e) =>
          e ? reject(e) : resolve(),
        ),
      );
    } else throw new Error("ROUTE_NOT_SELECTED");
  }
  private peer(m: Json): Promise<void> {
    return this.transmit(
      Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify(m))]),
    );
  }
  private async next(type: string): Promise<Json> {
    const until = Date.now() + 90_000;
    while (!this.closed && Date.now() < until) {
      const i = this.messages.findIndex((x) => x.type === type);
      if (i >= 0) return this.messages.splice(i, 1)[0];
      await wait(10);
    }
    throw new Error("PEER_ACK_TIMEOUT");
  }
  private async sendFile(): Promise<void> {
    this.finishing = true;
    this.control({ type: "preparing" });
    const src = await openSource(this.spec.path);
    this.source = src;
    if (this.closed) {
      await src.file.close();
      return;
    }
    this.finishing = false;
    this.lastProgress = Date.now();
    await this.peer({ type: "manifest", ...src.manifest });
    const ready = await this.next("receive_ready");
    let offset = ready.offset;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > src.manifest.size
    )
      throw new Error("INVALID_OFFSET");
    const buffer = Buffer.alloc(TRANSFER_FRAME_BYTES - 9);
    while (offset < src.manifest.size) {
      const end = Math.min(
        src.manifest.size,
        (Math.floor(offset / TRANSFER_BLOCK_BYTES) + 1) * TRANSFER_BLOCK_BYTES,
      );
      while (offset < end) {
        if (this.closed) throw new Error("TRANSFER_CLOSED");
        const n = (
          await src.file.read(
            buffer,
            0,
            Math.min(buffer.length, end - offset),
            offset,
          )
        ).bytesRead;
        if (!n) throw new Error("SOURCE_CHANGED");
        const h = Buffer.alloc(9);
        h[0] = 1;
        h.writeBigUInt64BE(BigInt(offset), 1);
        await this.transmit(Buffer.concat([h, buffer.subarray(0, n)]));
        offset += n;
      }
      const ack = await this.next("block_ack");
      if (ack.offset !== offset) throw new Error("INVALID_ACK");
      this.lastProgress = Date.now();
      this.control({ type: "progress", offset, size: src.manifest.size });
    }
    if (sourceIdentity(await src.file.stat()) !== src.identity)
      throw new Error("SOURCE_CHANGED");
    await this.peer({ type: "finish" });
    const committed = await this.next("committed");
    if (committed.sha256 !== src.manifest.sha256)
      throw new Error("HASH_MISMATCH");
    await src.file.close();
    this.source = undefined;
    this.control({ type: "cleaned", role: "source" });
    this.finishing = true;
  }
  private async peerMessage(m: Json): Promise<void> {
    if (m.type === "manifest" && this.spec.role === "target") {
      if (this.receive) throw new Error("DUPLICATE_MANIFEST");
      this.receive = await this.files.receive(this.spec, m as Manifest);
      this.control({
        type: "manifest",
        size: this.receive.ledger.size,
        sha256: this.receive.ledger.sha256,
      });
      await this.peer({
        type: "receive_ready",
        offset: this.receive.ledger.offset,
      });
    } else if (
      m.type === "finish" &&
      this.spec.role === "target" &&
      this.receive
    ) {
      this.finishing = true;
      this.control({ type: "verifying" });
      const r = this.receive;
      if (!r.ledger.committed) {
        if (!r.file) throw new Error("MISSING_RECEIVER");
        await this.files.commit(r.file, r.ledger);
        r.file = null;
      }
      this.control({
        type: "committed",
        size: r.ledger.size,
        sha256: r.ledger.sha256,
      });
      await this.files.cleanup(this.spec.id);
      await this.peer({ type: "committed", sha256: r.ledger.sha256 });
      this.control({ type: "cleaned", role: "target" });
    } else if (
      ["receive_ready", "block_ack", "committed"].includes(m.type) &&
      this.spec.role === "source"
    ) {
      if (this.messages.length > 16) throw new Error("CONTROL_BUFFER_LIMIT");
      this.messages.push(m);
    } else throw new Error("INVALID_PEER_MESSAGE");
  }
  private async receiveData(p: Buffer): Promise<void> {
    const r = this.receive;
    if (this.spec.role !== "target" || !r?.file || !r.hash || p.length < 10)
      throw new Error("UNEXPECTED_DATA");
    const offset = Number(p.readBigUInt64BE(1)),
      bytes = p.subarray(9);
    if (offset !== r.ledger.offset || offset + bytes.length > r.ledger.size)
      throw new Error("INVALID_OFFSET");
    for (let done = 0; done < bytes.length; ) {
      const n = (
        await r.file.write(bytes, done, bytes.length - done, offset + done)
      ).bytesWritten;
      if (!n) throw new Error("WRITE_FAILED");
      done += n;
    }
    r.hash.update(bytes);
    r.ledger.offset += bytes.length;
    if (
      r.ledger.offset % TRANSFER_BLOCK_BYTES === 0 ||
      r.ledger.offset === r.ledger.size
    ) {
      await r.file.sync();
      r.ledger.expiresAt = Math.min(this.spec.expiresAt, Date.now() + 600_000);
      r.ledger.prefix = r.hash.copy().digest("hex");
      await this.files.save(r.ledger);
      await this.peer({ type: "block_ack", offset: r.ledger.offset });
      this.control({
        type: "progress",
        offset: r.ledger.offset,
        size: r.ledger.size,
      });
    }
  }
  private async fail(message: string): Promise<void> {
    if (this.closed) return;
    this.control({ type: "error", message });
    await this.stop(false);
  }
  async stop(cleanup: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.deadline) clearTimeout(this.deadline);
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.queue;
    await this.source?.file.close().catch(() => undefined);
    this.source = undefined;
    await this.receive?.file?.close().catch(() => undefined);
    if (this.receive) this.receive.file = null;
    try {
      if (cleanup) {
        if (this.spec.role === "target") {
          const receipt = await this.files.committedReceipt(this.spec.id);
          if (receipt) this.control({ type: "committed", ...receipt });
        }
        await this.files.cleanup(this.spec.id);
        this.control({ type: "cleaned", role: this.spec.role });
      }
    } catch (e) {
      this.control({ type: "cleanup_error", message: errorText(e) });
    }
    this.channel?.close();
    await this.pc?.close().catch(() => undefined);
    if (this.ws?.readyState === WebSocket.OPEN)
      await new Promise<void>((r) =>
        this.ws.send(JSON.stringify({ type: "stopped" }), () => r()),
      );
    this.ws?.close();
    this.onClose();
  }
  private async release(): Promise<void> {
    try {
      await this.files.cleanup(this.spec.id, true);
    } finally {
      await this.stop(false);
    }
  }
}
function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}
