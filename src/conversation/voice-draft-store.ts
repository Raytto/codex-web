export type VoiceDraftRecord = {
  id: string;
  accountId: string;
  scope: string;
  conversationId: string | null;
  projectId: string | null;
  draftText: string;
  quoteExcerpt: string;
  attachmentNames: string[];
  fileName: string;
  mimeType: string;
  durationMs: number;
  blob: Blob;
  sendAfterTranscription: boolean;
  status: "ready" | "retryable";
  retryCount: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

const DATABASE_NAME = "codex-web-voice-drafts";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";
export const VOICE_DRAFT_RETENTION_MS = 24 * 60 * 60_000;

function indexedDb(): IDBFactory | null {
  try { return typeof window !== "undefined" && window.indexedDB ? window.indexedDB : null; }
  catch { return null; }
}

function openDatabase(): Promise<IDBDatabase> {
  const factory = indexedDb();
  if (!factory) return Promise.reject(new Error("当前浏览器不支持本地语音草稿保存。"));
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("account_scope_conversation", ["accountId", "scope", "conversationId"]);
        store.createIndex("updated_at", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地语音草稿存储。"));
    request.onblocked = () => reject(new Error("本地语音草稿存储被其他页面占用。"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地语音草稿保存失败。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地语音草稿保存已取消。"));
  });
}

export function isVoiceDraftExpired(record: Pick<VoiceDraftRecord, "updatedAt">, now = Date.now()): boolean {
  const updatedAt = Date.parse(record.updatedAt);
  return !Number.isFinite(updatedAt) || now - updatedAt > VOICE_DRAFT_RETENTION_MS;
}

export async function saveVoiceDraft(record: VoiceDraftRecord): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
  } finally { database.close(); }
}

export async function getVoiceDraft(accountId: string, scope: string, conversationId: string | null): Promise<VoiceDraftRecord | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    const rows = await new Promise<VoiceDraftRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as VoiceDraftRecord[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error("无法读取本地语音草稿。"));
    });
    await transactionDone(transaction);
    const candidates = rows.filter((row) => row.accountId === accountId && row.scope === scope && row.conversationId === conversationId);
    candidates.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return candidates[0] ?? null;
  } finally { database.close(); }
}

export async function deleteVoiceDraft(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally { database.close(); }
}

export async function purgeExpiredVoiceDrafts(now = Date.now()): Promise<number> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    const rows = await new Promise<VoiceDraftRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as VoiceDraftRecord[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error("无法清理本地语音草稿。"));
    });
    let removed = 0;
    for (const row of rows) {
      if (!isVoiceDraftExpired(row, now)) continue;
      store.delete(row.id);
      removed += 1;
    }
    await transactionDone(transaction);
    return removed;
  } finally { database.close(); }
}

export async function requestPersistentVoiceStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    return await navigator.storage.persist();
  } catch { return false; }
}
