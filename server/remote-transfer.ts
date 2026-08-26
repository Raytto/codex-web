import crypto from "node:crypto";
import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const REMOTE_TRANSFER_MAX_FILE_BYTES = 100 * 1024 * 1024;

export class RemoteTransferError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "RemoteTransferError";
  }
}

export function parseRemoteContentLength(value: string | string[] | undefined): number {
  if (Array.isArray(value) || typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value.trim())) {
    throw new RemoteTransferError("必须提供有效的 Content-Length。", 411, "REMOTE_CONTENT_LENGTH_REQUIRED");
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RemoteTransferError("Content-Length 无效。", 400, "REMOTE_CONTENT_LENGTH_INVALID");
  }
  if (size > REMOTE_TRANSFER_MAX_FILE_BYTES) {
    throw new RemoteTransferError("远程文件超过 100 MiB 上限。", 413, "REMOTE_FILE_TOO_LARGE");
  }
  return size;
}

export async function streamRemoteUpload(source: Readable, temporaryPath: string, expectedSize: number): Promise<{ size: number; sha256: string }> {
  let size = 0;
  const hash = crypto.createHash("sha256");
  const counter = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      size += bytes.length;
      if (size > expectedSize || size > REMOTE_TRANSFER_MAX_FILE_BYTES) {
        callback(new RemoteTransferError("请求体字节数超过声明值或文件上限。", 400, "REMOTE_BODY_SIZE_MISMATCH"));
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    },
  });
  try {
    await pipeline(source, counter, fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
    if (size !== expectedSize) {
      throw new RemoteTransferError("请求体字节数与 Content-Length 不一致。", 400, "REMOTE_BODY_SIZE_MISMATCH");
    }
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
