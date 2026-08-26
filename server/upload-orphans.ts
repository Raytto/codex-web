import fs from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[A-Za-z0-9._-]{1,16})?$/i;

export function uploadOwnershipKey(userId: string, conversationId: string, fileName: string): string {
  if (!UUID.test(userId) || !UUID.test(conversationId) || !UPLOAD_NAME.test(fileName) || path.basename(fileName) !== fileName) {
    throw new Error("Upload ownership key is not strictly UUID-scoped");
  }
  return `${userId}/${conversationId}/${fileName}`;
}

export async function sweepUploadOrphans(
  tenantRoot: string,
  registered: ReadonlySet<string>,
  options: { minimumAgeMs?: number; now?: number } = {},
): Promise<{ removed: string[]; failed: Array<{ key: string; message: string }> }> {
  const minimumAgeMs = options.minimumAgeMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  const failed: Array<{ key: string; message: string }> = [];
  let users: fs.Dirent[];
  try { users = await fs.promises.readdir(tenantRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed, failed };
    throw error;
  }
  for (const user of users) {
    if (!user.isDirectory() || user.isSymbolicLink() || !UUID.test(user.name)) continue;
    const conversationsRoot = path.join(tenantRoot, user.name, "conversations");
    let conversations: fs.Dirent[];
    try { conversations = await fs.promises.readdir(conversationsRoot, { withFileTypes: true }); }
    catch { continue; }
    for (const conversation of conversations) {
      if (!conversation.isDirectory() || conversation.isSymbolicLink() || !UUID.test(conversation.name)) continue;
      const uploads = path.join(conversationsRoot, conversation.name, "uploads");
      let files: fs.Dirent[];
      try { files = await fs.promises.readdir(uploads, { withFileTypes: true }); }
      catch { continue; }
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink() || !UPLOAD_NAME.test(file.name)) continue;
        const key = uploadOwnershipKey(user.name, conversation.name, file.name);
        if (registered.has(key)) continue;
        const absolute = path.join(uploads, file.name);
        try {
          const stat = await fs.promises.lstat(absolute);
          if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs < minimumAgeMs) continue;
          await fs.promises.rm(absolute, { force: true });
          removed.push(key);
        } catch (error) {
          failed.push({ key, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  return { removed, failed };
}
