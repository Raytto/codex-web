import { garbageCollectConversationRecords, restoreColdConversation } from "./conversation-cold-storage.js";
import { readerRoots, removeReaderResourcesForConversation, restoreReaderVersion, type ReaderColdRoots } from "./reader-cold-storage.js";
import {StorageHost} from './storage-host.js';

export type HostStorageOperation = "restore_conversation" | "restore_reader" | "remove_reader" | "collect_records" | "restore_file" | "restore_item" | "restore_native";
export type HostStorageRequest = { operation: HostStorageOperation; roots: Partial<ReaderColdRoots>; id: string; userId: string; threadId?:string };
export type HostStorageResult = { ok: true; removed?: number } | { ok: false; error: string };

// One request per process. The existing synchronous implementations retain
// their identity checks, kernel locks, checksums and durable state transitions.
process.once("message", async (request: HostStorageRequest) => {
  let result: HostStorageResult;
  try {
    const roots = readerRoots(request.roots);
    switch (request.operation) {
      case "restore_file":
      case "restore_item":
      case "restore_native": {
        const host=new StorageHost(roots);
        try{if(request.operation==='restore_file')await host.restoreFile(request.userId,request.id);
          else if(request.operation==='restore_native')await host.restoreNativeUnit(request.userId,request.id);
          else await host.restoreItem(request.userId,request.id,'tool-read');}
        finally{host.close();}
        break;
      }
      case "restore_conversation": {
        if(process.env.STORAGE_LIFECYCLE_ENABLED==='1'){
          const host=new StorageHost(roots);try{await host.preheatConversation(request.userId,request.id,request.threadId);}finally{host.close();}
        }else restoreColdConversation(roots, request.id, request.userId);
        break;
      }
      case "restore_reader": restoreReaderVersion(roots, request.id, request.userId); break;
      case "remove_reader": removeReaderResourcesForConversation(roots, request.id, request.userId); break;
      case "collect_records": {
        const removed = garbageCollectConversationRecords(roots, request.id, request.userId);
        result = { ok: true, removed };
        break;
      }
      default: throw new Error("Unknown host storage operation");
    }
    result ??= { ok: true };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message.slice(0, 2_000) : "Storage operation failed" };
  }
  if (process.connected) process.send!(result, () => { if (process.connected) process.disconnect(); });
});
