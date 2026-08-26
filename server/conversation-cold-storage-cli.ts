import {
  archiveConversation, archiveVoiceRecording, defaultColdStorageRoots, formatCandidateJson,
  listColdCandidates, listVoiceRecordingCandidates, coldStorageSummary, purgeColdIsolated,
  purgeVoiceRecordingIsolation, restoreVoiceRecording,
} from "./conversation-cold-storage.js";

const args = process.argv.slice(2);
const command = args[0] ?? "dry-run";
const valueOf = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const limit = Math.max(1, Math.min(100, Number(valueOf("--limit") ?? process.env.CWW_COLD_STORAGE_MAX_CONVERSATIONS ?? 1)));
const roots = defaultColdStorageRoots();

if (command === "dry-run" || command === "candidates") {
  const candidates = listColdCandidates(roots, Number(valueOf("--days") ?? 15));
  const eligible = candidates.filter((candidate) => candidate.eligible);
  if (args.includes("--json")) process.stdout.write(`${formatCandidateJson(candidates)}\n`);
  else {
    const totals = eligible.reduce((sum, candidate) => ({ conversations: sum.conversations + 1, bytes: sum.bytes + candidate.rolloutBytes + candidate.deliverableBytes }), { conversations: 0, bytes: 0 });
    process.stdout.write(`cold_storage_dry_run candidates=${totals.conversations} bytes=${totals.bytes}\n`);
    for (const candidate of candidates.slice(0, 200)) process.stdout.write(`${candidate.eligible ? "eligible" : "skip"} ${candidate.conversationId} age_hours=${Math.floor(candidate.ageHours)} entries=${candidate.entries} rollout_bytes=${candidate.rolloutBytes} deliverable_bytes=${candidate.deliverableBytes} reasons=${candidate.reasons.join(",") || "-"} title=${JSON.stringify(candidate.title)}\n`);
  }
  process.exit(0);
}

if (command === "summary") {
  process.stdout.write(`${JSON.stringify(coldStorageSummary(roots), null, 2)}\n`);
  process.exit(0);
}

if (command === "voice-dry-run" || command === "voice-candidates") {
  const candidates = listVoiceRecordingCandidates(roots, Number(valueOf("--days") ?? 15));
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
  else for (const candidate of candidates.slice(0, 200)) process.stdout.write(`${candidate.eligible ? "eligible" : "skip"} ${candidate.transcriptionId} age_hours=${Math.floor(candidate.ageHours)} bytes=${candidate.bytes} reasons=${candidate.reasons.join(",") || "-"}\n`);
  process.exit(0);
}

if (command === "voice-purge") {
  const graceDays = Number(valueOf("--grace-days") ?? process.env.CWW_COLD_STORAGE_ISOLATION_GRACE_DAYS ?? 7);
  const results = purgeVoiceRecordingIsolation(roots, graceDays);
  process.stdout.write(`${JSON.stringify({ graceDays, results }, null, 2)}\n`);
  process.exit(results.some((result) => !result.deleted) ? 1 : 0);
}

if (command === "voice-restore") {
  const transcriptionId = valueOf("--transcription");
  const userId = valueOf("--user");
  if (!transcriptionId || !userId) { process.stderr.write("voice-restore requires --transcription UUID --user UUID\n"); process.exit(2); }
  restoreVoiceRecording(roots, transcriptionId, userId);
  process.stdout.write(`voice_restored transcription=${transcriptionId} user=${userId}\n`);
  process.exit(0);
}

if (command === "purge") {
  const graceDays = Number(valueOf("--grace-days") ?? process.env.CWW_COLD_STORAGE_ISOLATION_GRACE_DAYS ?? 7);
  const results = purgeColdIsolated(roots, graceDays);
  process.stdout.write(`${JSON.stringify({ graceDays, results }, null, 2)}\n`);
  process.exit(results.some((result) => !result.deleted) ? 1 : 0);
}

if (command !== "archive" && command !== "voice-archive") {
  process.stderr.write("usage: conversation-cold-storage-cli {dry-run|summary|archive|purge|voice-dry-run|voice-archive|voice-restore|voice-purge} [--limit N] [--conversation UUID] [--transcription UUID] [--user UUID] [--grace-days N]\n");
  process.exit(2);
}

if (command === "voice-archive") {
  const candidates = listVoiceRecordingCandidates(roots, Number(valueOf("--days") ?? 15)).filter((candidate) => candidate.eligible);
  const requested = valueOf("--transcription");
  const selected = requested ? candidates.filter((candidate) => candidate.transcriptionId === requested) : candidates.slice(0, limit);
  if (requested && selected.length === 0) { process.stderr.write("requested transcription is not an eligible voice-storage candidate\n"); process.exit(3); }
  let failed = 0;
  for (const candidate of selected) {
    try {
      const result = archiveVoiceRecording(roots, candidate.transcriptionId);
      process.stdout.write(`archived voice=${candidate.transcriptionId} generation=${result.generation} archive_bytes=${result.archiveBytes} remote=${result.remotePath}\n`);
    } catch (error) {
      failed += 1; process.stderr.write(`voice_archive_failed transcription=${candidate.transcriptionId} error=${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  process.stdout.write(`voice_storage_archive complete=${selected.length - failed} failed=${failed} selected=${selected.length}\n`);
  process.exit(failed ? 1 : 0);
}

const candidates = listColdCandidates(roots, Number(valueOf("--days") ?? 15)).filter((candidate) => candidate.eligible);
const requested = valueOf("--conversation");
const selected = requested ? candidates.filter((candidate) => candidate.conversationId === requested) : candidates.slice(0, limit);
if (requested && selected.length === 0) {
  process.stderr.write("requested conversation is not an eligible cold-storage candidate\n");
  process.exit(3);
}
const results: unknown[] = [];
let failed = 0;
for (const candidate of selected) {
  try {
    const result = archiveConversation(roots, candidate.conversationId);
    results.push({ ok: true, ...result });
    process.stdout.write(`archived conversation=${candidate.conversationId} generation=${result.generation} archive_bytes=${result.archiveBytes} plaintext_bytes=${result.plaintextBytes} remote=${result.remotePath}\n`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    results.push({ ok: false, conversationId: candidate.conversationId, error: message });
    process.stderr.write(`archive_failed conversation=${candidate.conversationId} error=${message}\n`);
  }
}
process.stdout.write(`cold_storage_archive complete=${selected.length - failed} failed=${failed} selected=${selected.length}\n`);
process.exit(failed ? 1 : 0);
