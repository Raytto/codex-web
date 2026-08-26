import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_RELATIVE = /^voice-recordings\/[0-9a-f-]{36}\/[0-9]{4}-[0-9]{2}\/[0-9a-f-]{36}\.(?:webm|ogg|mp4|mp3|wav|aac|flac)$/i;

export type PersistedVoiceRecording = {
  relativePath: string;
  mimeType: string;
  bytes: number;
  sha256: string;
};

export function persistVoiceRecording(input: {
  dataRoot: string;
  sourcePath: string;
  userId: string;
  transcriptionId: string;
  mimeType: string;
  createdAt?: Date;
}): PersistedVoiceRecording {
  if (!UUID.test(input.userId) || !UUID.test(input.transcriptionId)) throw new Error("Invalid voice recording identity");
  const extension = path.extname(input.sourcePath).toLowerCase();
  if (!/^\.(?:webm|ogg|mp4|mp3|wav|aac|flac)$/.test(extension)) throw new Error("Invalid voice recording extension");
  const createdAt = input.createdAt ?? new Date();
  const month = `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, "0")}`;
  const relativePath = path.posix.join("voice-recordings", input.userId, month, `${input.transcriptionId}${extension}`);
  const target = resolveVoiceRecordingPath(input.dataRoot, relativePath);
  const temporary = `${target}.pending-${process.pid}-${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) throw new Error("Voice recording already exists");
  try {
    fs.copyFileSync(input.sourcePath, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, 0o600);
    const bytes = fs.statSync(temporary).size;
    const sha256 = sha256File(temporary);
    fs.renameSync(temporary, target);
    return { relativePath, mimeType: input.mimeType.slice(0, 120), bytes, sha256 };
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

export function resolveVoiceRecordingPath(dataRoot: string, relativePath: string): string {
  if (!SAFE_RELATIVE.test(relativePath)) throw new Error("Invalid persisted voice recording path");
  const root = path.resolve(dataRoot);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Voice recording path escapes data root");
  return resolved;
}

export function removePersistedVoiceRecording(dataRoot: string, relativePath: string | null | undefined): boolean {
  if (!relativePath) return false;
  const target = resolveVoiceRecordingPath(dataRoot, relativePath);
  const existed = fs.existsSync(target);
  fs.rmSync(target, { force: true });
  removeEmptyParents(path.dirname(target), path.resolve(dataRoot, "voice-recordings"));
  return existed;
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

function removeEmptyParents(start: string, stop: string): void {
  let current = path.resolve(start);
  const boundary = path.resolve(stop);
  while (current.startsWith(`${boundary}${path.sep}`)) {
    try { fs.rmdirSync(current); } catch { break; }
    current = path.dirname(current);
  }
}
