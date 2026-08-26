import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";

test("voice transcription receipts make retries durable and reject mismatched audio", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-voice-receipt-"));
  const db = new AppDatabase(dataRoot, { username: "owner", passwordHash: "", displayName: "Owner" }, false);
  try {
    const id = "6a1b6d11-6af0-4de8-83b5-1f8ddf8e5d68";
    const claimed = db.claimVoiceTranscriptionReceipt({ userId: LEGACY_USER_ID, clientRecordingId: id, audioSha256: "a".repeat(64), audioBytes: 12 });
    assert.equal(claimed.state, "processing");
    db.updateVoiceTranscriptionReceipt({ userId: LEGACY_USER_ID, clientRecordingId: id, state: "succeeded", transcriptionId: "transcription-1", transcriptionText: "你好" });
    const completed = db.getVoiceTranscriptionReceipt(LEGACY_USER_ID, id);
    assert.equal(completed?.state, "succeeded");
    assert.equal(completed?.transcription_id, "transcription-1");
    assert.equal(completed?.transcription_text, "你好");
    assert.throws(() => db.claimVoiceTranscriptionReceipt({ userId: LEGACY_USER_ID, clientRecordingId: id, audioSha256: "b".repeat(64), audioBytes: 12 }), /不同音频内容/);
  } finally {
    db.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
