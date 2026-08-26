import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { archiveVoiceRecording, defaultColdStorageRoots, listVoiceRecordingCandidates, purgeVoiceRecordingIsolation, restoreVoiceRecording } from "../server/conversation-cold-storage.js";
import { persistVoiceRecording, sha256File } from "../server/voice-recording.js";

function executable(root: string, name: string, source: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

function fakeAge(root: string): string {
  return executable(root, "age", `
const fs = require("node:fs"); const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1]; const source = args.at(-1);
if (!out || !source) process.exit(2); fs.copyFileSync(source, out);
`);
}

function fakeAliyun(root: string, cloud: string): string {
  return executable(root, "aliyunpan", `
const fs = require("node:fs"); const path = require("node:path"); const args = process.argv.slice(2); const cloud = ${JSON.stringify(cloud)}; const cmd = args[0];
const remote = (value) => path.join(cloud, String(value).replace(/^\\/+/, ""));
if (cmd === "tree") { const dir = args.at(-1); const target = remote(dir); if (!fs.existsSync(target)) process.exit(1); console.log(dir); for (const name of fs.readdirSync(target)) console.log(path.posix.join(dir, name) + " -> " + path.posix.join(dir, name)); process.exit(0); }
if (cmd === "mkdir") { const dir = args.at(-1); fs.mkdirSync(remote(dir), { recursive: true }); console.log(dir); process.exit(0); }
if (cmd === "upload") { const files = args.filter((value) => fs.existsSync(value) && fs.statSync(value).isFile()); const source = files.at(-1); const dir = args.at(-1); if (!source || !dir) process.exit(2); fs.mkdirSync(remote(dir), { recursive: true }); fs.copyFileSync(source, path.join(remote(dir), path.basename(source))); process.exit(0); }
if (cmd === "download") { const dirArg = args.find((value) => value.startsWith("--saveto=")); const source = args.at(-1); if (!dirArg || !source) process.exit(2); fs.mkdirSync(dirArg.slice(9), { recursive: true }); fs.copyFileSync(remote(source), path.join(dirArg.slice(9), path.basename(source))); process.exit(0); }
process.exit(2);
`);
}

test("voice audio persists with ownership metadata and round-trips through encrypted cold storage", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-voice-recording-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const tools = path.join(root, "tools");
  const cloud = path.join(root, "cloud");
  fs.mkdirSync(tools, { recursive: true }); fs.mkdirSync(cloud, { recursive: true });
  const originalPath = process.env.PATH;
  executable(tools, "id", `const args = process.argv.slice(2); if (args[1] !== "aliyunpan") process.exit(1); console.log(args[0] === "-u" ? "0" : "0");`);
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => { process.env.PATH = originalPath; });
  const ageRecipient = path.join(root, "recipient"); const ageIdentity = path.join(root, "identity");
  fs.writeFileSync(ageRecipient, "recipient"); fs.writeFileSync(ageIdentity, "identity");
  const db = new AppDatabase(dataRoot, undefined, false);
  t.after(() => db.close());
  const transcriptionId = crypto.randomUUID();
  const source = path.join(root, "input.wav"); const content = Buffer.from("voice-review-fixture"); fs.writeFileSync(source, content);
  const createdAt = new Date(Date.now() - 20 * 24 * 60 * 60_000);
  const persisted = persistVoiceRecording({ dataRoot, sourcePath: source, userId: LEGACY_USER_ID, transcriptionId, mimeType: "audio/wav", createdAt });
  assert.equal(persisted.bytes, content.length); assert.equal(persisted.sha256, sha256File(path.join(dataRoot, persisted.relativePath)));
  const row = db.createVoiceTranscription({ id: transcriptionId, userId: LEGACY_USER_ID, rawText: "会话", model: "test", promptVersion: "test", createdAt: createdAt.toISOString(), audio: persisted });
  assert.equal(row.audio_storage_state, "local"); assert.equal(row.audio_relative_path, persisted.relativePath);

  const roots = defaultColdStorageRoots({ dataRoot, databasePath: path.join(dataRoot, "codex-web.sqlite"), age: fakeAge(tools), aliyunpan: fakeAliyun(tools, cloud), ageRecipient, ageIdentity, relayDir: path.join(root, "relay"), downloadDir: path.join(root, "downloads"), voiceIsolationRoot: path.join(root, "isolated"), driveId: "test-drive" });
  assert.equal(listVoiceRecordingCandidates(roots)[0]?.eligible, true);
  assert.throws(() => restoreVoiceRecording(roots, transcriptionId, crypto.randomUUID()), /账号不匹配/);
  const archived = archiveVoiceRecording(roots, transcriptionId);
  assert.equal(archived.transcriptionId, transcriptionId); assert.equal(fs.existsSync(path.join(dataRoot, persisted.relativePath)), false);
  const cold = db.sqlite.prepare("SELECT audio_storage_state,audio_remote_path,audio_local_isolated_path FROM voice_transcriptions WHERE id=?").get(transcriptionId) as { audio_storage_state: string; audio_remote_path: string; audio_local_isolated_path: string };
  assert.equal(cold.audio_storage_state, "cold"); assert.ok(cold.audio_remote_path); assert.ok(fs.existsSync(cold.audio_local_isolated_path));
  db.sqlite.prepare("UPDATE voice_transcriptions SET audio_updated_at=? WHERE id=?").run(new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(), transcriptionId);
  assert.equal(purgeVoiceRecordingIsolation(roots, 7)[0]?.deleted, true);
  assert.equal(fs.existsSync(cold.audio_local_isolated_path), false);
  restoreVoiceRecording(roots, transcriptionId, LEGACY_USER_ID);
  const restored = db.sqlite.prepare("SELECT audio_storage_state,audio_relative_path FROM voice_transcriptions WHERE id=?").get(transcriptionId) as { audio_storage_state: string; audio_relative_path: string };
  assert.equal(restored.audio_storage_state, "local"); assert.equal(sha256File(path.join(dataRoot, restored.audio_relative_path)), persisted.sha256);
});
