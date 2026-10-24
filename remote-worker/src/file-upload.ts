import fs from "node:fs";
import path from "node:path";
import { REMOTE_TRANSFER_MAX_FILE_BYTES } from "./transfer-policy.js";

export async function uploadFile(url: string, transferToken: string, filePath: string, name: string): Promise<Response> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size < 0 || stat.size > REMOTE_TRANSFER_MAX_FILE_BYTES) throw new Error("文件大小不符合远程传输限制");
  const body = fs.createReadStream(filePath);
  try {
    return await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${transferToken}`,
        "content-type": mimeType(name),
        "content-length": String(stat.size),
        "x-file-name": encodeURIComponent(name),
      },
      body: body as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } finally {
    if (!body.destroyed) body.destroy();
  }
}


function mimeType(name: string): string { const ext = path.extname(name).toLowerCase(); return ({ ".html": "text/html", ".htm": "text/html", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".zip": "application/zip" } as Record<string, string>)[ext] || "application/octet-stream"; }
