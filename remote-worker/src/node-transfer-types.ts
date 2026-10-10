export const NODE_TRANSFER_VERSION = 1;
export const TRANSFER_BLOCK_BYTES = 1024 * 1024;
export const TRANSFER_FRAME_BYTES = 16 * 1024;
export const TRANSFER_MAX_FILE_BYTES = 2 * 1024 ** 3;
export type TransferRole = "source" | "target";
export type TransferSpec = {
  id: string;
  epoch: number;
  role: TransferRole;
  operation: "run" | "cleanup";
  path: string;
  token: string;
  url: string;
  expiresAt: number;
  overwrite: boolean;
  direct: boolean;
  iceServers: Array<{ urls: string; username?: string; credential?: string }>;
};
export function isTransferSpec(raw: unknown): raw is TransferSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const s = raw as TransferSpec;
  return (
    Object.keys(s).every((k) =>
      [
        "id",
        "epoch",
        "role",
        "operation",
        "path",
        "token",
        "url",
        "expiresAt",
        "overwrite",
        "direct",
        "iceServers",
      ].includes(k),
    ) &&
    /^[a-f0-9-]{36}$/.test(s.id) &&
    Number.isSafeInteger(s.epoch) &&
    s.epoch > 0 &&
    ["source", "target"].includes(s.role) &&
    ["run", "cleanup"].includes(s.operation) &&
    typeof s.path === "string" &&
    s.path.length > 0 &&
    s.path.length <= 4096 &&
    !s.path.includes("\0") &&
    typeof s.token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(s.token) &&
    typeof s.url === "string" &&
    s.url.length < 2048 &&
    /^wss?:\/\//.test(s.url) &&
    Number.isSafeInteger(s.expiresAt) &&
    s.expiresAt > 0 &&
    typeof s.overwrite === "boolean" &&
    typeof s.direct === "boolean" &&
    Array.isArray(s.iceServers) &&
    s.iceServers.length <= 4 &&
    s.iceServers.every(
      (i) =>
        typeof i.urls === "string" &&
        /^(stun|turn|turns):[^\s]{1,250}$/.test(i.urls) &&
        (i.username === undefined ||
          (typeof i.username === "string" && i.username.length < 256)) &&
        (i.credential === undefined ||
          (typeof i.credential === "string" && i.credential.length < 256)),
    )
  );
}
