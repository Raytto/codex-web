import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  TRANSFER_MAX_FILE_BYTES,
  type TransferSpec,
} from "./node-transfer-types.js";
export type Manifest = { size: number; sha256: string };
type Ledger = Manifest & {
  id: string;
  target: string;
  staging: string;
  dev: number;
  ino: number;
  directoryDev?: number;
  directoryIno?: number;
  offset: number;
  prefix: string;
  expiresAt: number;
  committed: boolean;
  prepared: boolean;
  overwrite: boolean;
};
const idPattern = /^[a-f0-9-]{36}$/;
const emptyHash = crypto.createHash("sha256").digest("hex");
export async function hashHandle(
  file: FileHandle,
  length: number,
): Promise<crypto.Hash> {
  const hash = crypto.createHash("sha256"),
    bytes = Buffer.alloc(1024 * 1024);
  for (let offset = 0; offset < length; ) {
    const n = (
      await file.read(bytes, 0, Math.min(bytes.length, length - offset), offset)
    ).bytesRead;
    if (!n) throw new Error("FILE_TRUNCATED");
    hash.update(bytes.subarray(0, n));
    offset += n;
  }
  return hash;
}
export async function openSource(
  raw: string,
): Promise<{ file: FileHandle; manifest: Manifest; identity: string }> {
  const target = await canonicalFile(raw);
  const before = await fs.promises.lstat(target);
  const file = await fs.promises.open(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > TRANSFER_MAX_FILE_BYTES
    )
      throw new Error("SOURCE_INVALID_OR_TOO_LARGE");
    const manifest = {
      size: stat.size,
      sha256: (await hashHandle(file, stat.size)).digest("hex"),
    };
    if (sourceIdentity(await file.stat()) !== sourceIdentity(stat))
      throw new Error("SOURCE_CHANGED");
    return { file, manifest, identity: sourceIdentity(stat) };
  } catch (e) {
    await file.close();
    throw e;
  }
}
export function sourceIdentity(s: fs.Stats): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}
async function canonicalFile(raw: string): Promise<string> {
  if (!path.isAbsolute(raw) || /\0/.test(raw) || /^(?:\\\\[.?]\\)/.test(raw))
    throw new Error("ABSOLUTE_FILE_PATH_REQUIRED");
  const parent = await fs.promises.realpath(path.dirname(raw));
  const target = path.join(parent, path.basename(raw));
  const stat = await fs.promises.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("REGULAR_FILE_REQUIRED");
  return target;
}
export class TransferFiles {
  readonly root: string;
  constructor(stateRoot: string) {
    this.root = path.join(stateRoot, "node-transfers");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  ledgerPath(id: string): string {
    if (!idPattern.test(id)) throw new Error("INVALID_TRANSFER_ID");
    return path.join(this.root, `${id}.json`);
  }
  read(id: string): Ledger | null {
    try {
      const p = this.ledgerPath(id);
      if (fs.lstatSync(p).isSymbolicLink()) throw new Error("UNSAFE_LEDGER");
      const l = JSON.parse(fs.readFileSync(p, "utf8")) as Ledger;
      if (
        l.id !== id ||
        !path.isAbsolute(l.target) ||
        l.staging !==
          path.join(path.dirname(l.target), `.ppa-transfer-${id}`, "payload") ||
        !Number.isSafeInteger(l.offset) ||
        l.offset < 0 ||
        l.offset > l.size
      )
        throw new Error("INVALID_LEDGER");
      return l;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async save(l: Ledger): Promise<void> {
    const dest = this.ledgerPath(l.id),
      temp = `${dest}.tmp`;
    // This directory belongs only to this endpoint; serialize calls per transfer.
    const f = await fs.promises.open(temp, "w", 0o600);
    try {
      await f.writeFile(JSON.stringify(l));
      await f.sync();
    } finally {
      await f.close();
    }
    await fs.promises.rename(temp, dest);
    await syncDirectory(this.root);
  }
  async receive(
    spec: TransferSpec,
    manifest: Manifest,
  ): Promise<{
    file: FileHandle | null;
    ledger: Ledger;
    hash: crypto.Hash | null;
  }> {
    if (
      !Number.isSafeInteger(manifest.size) ||
      manifest.size < 0 ||
      manifest.size > TRANSFER_MAX_FILE_BYTES ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256)
    )
      throw new Error("INVALID_MANIFEST");
    if (
      !path.isAbsolute(spec.path) ||
      /\0/.test(spec.path) ||
      /^(?:\\\\[.?]\\)/.test(spec.path)
    )
      throw new Error("ABSOLUTE_TARGET_REQUIRED");
    const parent = await fs.promises.realpath(path.dirname(spec.path));
    const target = path.join(parent, path.basename(spec.path));
    if (path.basename(target).startsWith(".ppa-transfer-"))
      throw new Error("RESERVED_TARGET");
    let l = this.read(spec.id);
    if (l && !l.dev && !l.ino) {
      await this.cleanup(spec.id, true);
      l = null;
    }
    if (
      l &&
      (l.target !== target ||
        l.sha256 !== manifest.sha256 ||
        l.size !== manifest.size ||
        l.overwrite !== spec.overwrite)
    )
      throw new Error("SOURCE_CHANGED");
    if (l?.prepared || l?.committed) {
      try {
        const f = await fs.promises.open(await canonicalFile(target), "r");
        try {
          const st = await f.stat();
          if (
            st.dev === l.dev &&
            st.ino === l.ino &&
            st.size === l.size &&
            (await hashHandle(f, st.size)).digest("hex") === l.sha256
          ) {
            l.committed = true;
            await this.save(l);
            return { file: null, ledger: l, hash: null };
          }
        } finally {
          await f.close();
        }
      } catch (e) {
        if (l.committed) throw e;
      }
      if (l.committed) throw new Error("COMMITTED_TARGET_CHANGED");
    }
    if (!l) {
      try {
        const st = await fs.promises.lstat(target);
        if (!spec.overwrite) throw new Error("TARGET_EXISTS");
        if (!st.isFile() || st.isSymbolicLink())
          throw new Error("UNSAFE_TARGET");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const free = await fs.promises.statfs(parent);
      if (free.bavail * free.bsize < manifest.size + 1024 * 1024)
        throw new Error("INSUFFICIENT_DISK");
      const directory = path.join(parent, `.ppa-transfer-${spec.id}`);
      const staging = path.join(directory, "payload");
      // Persist the owned name before creating any payload, including the empty-file crash window.
      l = {
        id: spec.id,
        target,
        staging,
        dev: 0,
        ino: 0,
        offset: 0,
        prefix: emptyHash,
        expiresAt: Math.min(spec.expiresAt, Date.now() + 600_000),
        committed: false,
        prepared: false,
        overwrite: spec.overwrite,
        ...manifest,
      };
      await this.save(l);
      await fs.promises.mkdir(directory, { mode: 0o700 });
      const directoryStat = await fs.promises.lstat(directory);
      l.directoryDev = directoryStat.dev;
      l.directoryIno = directoryStat.ino;
      await this.save(l);
      const f = await fs.promises.open(staging, "wx+", 0o600);
      try {
        const st = await f.stat();
        l.dev = st.dev;
        l.ino = st.ino;
        await this.save(l);
      } catch (e) {
        await f.close();
        throw e;
      }
      return { file: f, ledger: l, hash: crypto.createHash("sha256") };
    }
    const directoryStat = await fs.promises.lstat(path.dirname(l.staging));
    if (
      directoryStat.isSymbolicLink() ||
      (l.directoryIno !== undefined &&
        (directoryStat.ino !== l.directoryIno ||
          directoryStat.dev !== l.directoryDev))
    )
      throw new Error("STAGING_DIRECTORY_CHANGED");
    const st = await fs.promises.lstat(l.staging);
    if (
      st.isSymbolicLink() ||
      !st.isFile() ||
      st.dev !== l.dev ||
      st.ino !== l.ino
    )
      throw new Error("STAGING_IDENTITY_CHANGED");
    const f = await fs.promises.open(
      l.staging,
      fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
    );
    try {
      const actual = await f.stat();
      if (actual.dev !== l.dev || actual.ino !== l.ino)
        throw new Error("STAGING_IDENTITY_CHANGED");
      const hash = await hashHandle(f, l.offset);
      if (hash.copy().digest("hex") !== l.prefix)
        throw new Error("PARTIAL_FILE_CORRUPT");
      await f.truncate(l.offset);
      l.expiresAt = Math.min(spec.expiresAt, Date.now() + 600_000);
      await this.save(l);
      return { file: f, ledger: l, hash };
    } catch (e) {
      await f.close();
      throw e;
    }
  }
  async commit(file: FileHandle, l: Ledger): Promise<void> {
    if (
      l.offset !== l.size ||
      (await hashHandle(file, l.size)).digest("hex") !== l.sha256
    )
      throw new Error("HASH_MISMATCH");
    await file.sync();
    l.prepared = true;
    await this.save(l);
    await file.close();
    if (l.overwrite) {
      try {
        const st = await fs.promises.lstat(l.target);
        if (!st.isFile() || st.isSymbolicLink())
          throw new Error("UNSAFE_TARGET");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await fs.promises.rename(l.staging, l.target);
    } else {
      // Atomic no-clobber publication. The second name is removed immediately; no data copy.
      await fs.promises.link(l.staging, l.target);
      await fs.promises.unlink(l.staging);
    }
    await syncDirectory(path.dirname(l.target));
    l.committed = true;
    await this.save(l);
  }
  async committedReceipt(id: string): Promise<Manifest | null> {
    const l = this.read(id);
    if (!l || (!l.prepared && !l.committed)) return null;
    try {
      const f = await fs.promises.open(await canonicalFile(l.target), "r");
      try {
        const st = await f.stat();
        if (
          st.dev !== l.dev ||
          st.ino !== l.ino ||
          st.size !== l.size ||
          (await hashHandle(f, st.size)).digest("hex") !== l.sha256
        )
          return null;
      } finally {
        await f.close();
      }
      l.committed = true;
      await this.save(l);
      return { size: l.size, sha256: l.sha256 };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async cleanup(id: string, releaseReceipt = false): Promise<void> {
    const l = this.read(id);
    if (!l) return;
    const dir = path.dirname(l.staging);
    const parent = await fs.promises.realpath(path.dirname(l.target));
    if (parent !== path.dirname(l.target))
      throw new Error("STAGING_PARENT_CHANGED");
    try {
      const d = await fs.promises.lstat(dir);
      if (
        d.isSymbolicLink() ||
        !d.isDirectory() ||
        (l.directoryIno !== undefined &&
          (d.ino !== l.directoryIno || d.dev !== l.directoryDev))
      )
        throw new Error("UNSAFE_STAGING_DIRECTORY");
      try {
        const s = await fs.promises.lstat(l.staging);
        if (
          s.isSymbolicLink() ||
          !s.isFile() ||
          ((l.dev || l.ino) && (s.dev !== l.dev || s.ino !== l.ino)) ||
          (!(l.dev || l.ino) && l.directoryIno === undefined)
        )
          throw new Error("STAGING_IDENTITY_CHANGED");
        await fs.promises.unlink(l.staging);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      // Never recursively remove an unknown file placed in this directory.
      await fs.promises.rmdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (releaseReceipt || !l.committed)
      await fs.promises.rm(this.ledgerPath(id), { force: true });
  }
  async sweep(active: ReadonlySet<string>, now = Date.now()): Promise<void> {
    for (const name of await fs.promises.readdir(this.root)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const id = name.slice(0, -5);
      if (active.has(id)) continue;
      const l = this.read(id);
      if (l && l.expiresAt < now) await this.cleanup(id, true);
    }
  }
}
async function syncDirectory(p: string): Promise<void> {
  if (process.platform === "win32") return;
  const d = await fs.promises.open(p, "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
