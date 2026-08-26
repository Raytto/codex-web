import fs from "node:fs";

export const VOICE_SILENCE_TRIM = {
  frameMs: 20,
  minimumSilenceMs: 5_000,
  minimumVoiceMs: 80,
  mergeGapMs: 240,
  paddingMs: 350,
} as const;

export type SilenceTrimStats = {
  trimmed: boolean;
  originalDurationMs: number;
  retainedDurationMs: number;
  removedDurationMs: number;
  thresholdDb: number | null;
  voicedFrameRatio: number;
};

type WavPcm = {
  sampleRate: number;
  samples: Int16Array;
};

type Frame = { start: number; end: number; db: number };
type Run = { start: number; end: number };

/**
 * Trim only silence runs longer than the configured threshold. The threshold
 * is derived from the recording's lower/upper energy percentiles rather than
 * a fixed microphone-specific amplitude, which keeps it usable across gains
 * and rooms. Short pauses remain byte-for-byte in the retained interval.
 */
export function trimWavSilenceBuffer(input: Buffer): { buffer: Buffer; stats: SilenceTrimStats } {
  const wav = readPcmWav(input);
  const originalDurationMs = wav.samples.length * 1_000 / wav.sampleRate;
  const frames = measureFrames(wav.samples, wav.sampleRate);
  if (frames.length === 0) {
    return { buffer: input, stats: emptyStats(originalDurationMs) };
  }

  const dbValues = frames.map((frame) => frame.db);
  const noiseFloorDb = percentile(dbValues, 0.2);
  const upperEnergyDb = percentile(dbValues, 0.8);
  const contrastDb = Math.max(0, upperEnergyDb - noiseFloorDb);
  // Use a relative threshold, bounded conservatively for very quiet/loud
  // microphones. The lower percentile estimates the noise floor; the amount
  // above it scales with the observed speech/noise contrast.
  const thresholdDb = clamp(noiseFloorDb + clamp(contrastDb * 0.45, 6, 12), -48, -26);
  const voiced = frames.map((frame) => frame.db >= thresholdDb);
  const runs = normalizeVoiceRuns(voiced, frames.length);
  const minimumSilenceFrames = Math.ceil(VOICE_SILENCE_TRIM.minimumSilenceMs / VOICE_SILENCE_TRIM.frameMs);
  const minimumVoiceFrames = Math.ceil(VOICE_SILENCE_TRIM.minimumVoiceMs / VOICE_SILENCE_TRIM.frameMs);
  const validRuns = runs.filter((run) => run.end - run.start >= minimumVoiceFrames);
  if (validRuns.length === 0) {
    return {
      buffer: input,
      stats: { ...emptyStats(originalDurationMs), thresholdDb, voicedFrameRatio: 0 },
    };
  }

  const frameSamples = Math.max(1, Math.round(wav.sampleRate * VOICE_SILENCE_TRIM.frameMs / 1_000));
  const paddingSamples = Math.round(wav.sampleRate * VOICE_SILENCE_TRIM.paddingMs / 1_000);
  const intervals: Array<[number, number]> = [];
  let segmentStart = validRuns[0].start * frameSamples;
  let previousEnd = validRuns[0].end * frameSamples;
  // Keep short leading pauses; only discard them if they are themselves long.
  if (segmentStart > minimumSilenceFrames * frameSamples) segmentStart = Math.max(0, segmentStart - paddingSamples);
  else segmentStart = 0;

  for (const run of validRuns.slice(1)) {
    const runStart = run.start * frameSamples;
    const runEnd = run.end * frameSamples;
    const gapFrames = run.start - Math.ceil(previousEnd / frameSamples);
    if (gapFrames > minimumSilenceFrames) {
      intervals.push([segmentStart, Math.min(wav.samples.length, previousEnd + paddingSamples)]);
      segmentStart = Math.max(0, runStart - paddingSamples);
    }
    previousEnd = runEnd;
  }
  const trailingSilenceFrames = frames.length - Math.ceil(previousEnd / frameSamples);
  intervals.push([
    segmentStart,
    trailingSilenceFrames > minimumSilenceFrames
      ? Math.min(wav.samples.length, previousEnd + paddingSamples)
      : wav.samples.length,
  ]);

  const retainedSamples = intervals.reduce((total, [start, end]) => total + Math.max(0, end - start), 0);
  const trimmed = retainedSamples < wav.samples.length;
  if (!trimmed) {
    return {
      buffer: input,
      stats: { trimmed: false, originalDurationMs, retainedDurationMs: originalDurationMs, removedDurationMs: 0, thresholdDb, voicedFrameRatio: voiced.filter(Boolean).length / voiced.length },
    };
  }
  const outputSamples = new Int16Array(retainedSamples);
  let cursor = 0;
  for (const [start, end] of intervals) {
    outputSamples.set(wav.samples.subarray(Math.max(0, start), Math.min(wav.samples.length, end)), cursor);
    cursor += Math.max(0, end - start);
  }
  const retainedDurationMs = retainedSamples * 1_000 / wav.sampleRate;
  return {
    buffer: writePcmWav(wav.sampleRate, outputSamples),
    stats: {
      trimmed: true,
      originalDurationMs,
      retainedDurationMs,
      removedDurationMs: originalDurationMs - retainedDurationMs,
      thresholdDb,
      voicedFrameRatio: voiced.filter(Boolean).length / voiced.length,
    },
  };
}

export function trimWavSilenceFile(inputPath: string, outputPath: string): SilenceTrimStats {
  const { buffer, stats } = trimWavSilenceBuffer(fs.readFileSync(inputPath));
  fs.writeFileSync(outputPath, buffer, { mode: 0o600 });
  return stats;
}

function measureFrames(samples: Int16Array, sampleRate: number): Frame[] {
  const frameSamples = Math.max(1, Math.round(sampleRate * VOICE_SILENCE_TRIM.frameMs / 1_000));
  const frames: Frame[] = [];
  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples);
    let sum = 0;
    for (let index = start; index < end; index += 1) {
      const normalized = samples[index] / 32768;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    frames.push({ start, end, db: 20 * Math.log10(Math.max(rms, 1e-5)) });
  }
  return frames;
}

function normalizeVoiceRuns(voiced: boolean[], frameCount: number): Run[] {
  const raw: Run[] = [];
  let start: number | null = null;
  for (let index = 0; index <= frameCount; index += 1) {
    if (index < frameCount && voiced[index]) {
      if (start === null) start = index;
      continue;
    }
    if (start !== null) raw.push({ start, end: index });
    start = null;
  }
  const mergeFrames = Math.ceil(VOICE_SILENCE_TRIM.mergeGapMs / VOICE_SILENCE_TRIM.frameMs);
  const merged: Run[] = [];
  for (const run of raw) {
    const previous = merged.at(-1);
    if (previous && run.start - previous.end <= mergeFrames) previous.end = run.end;
    else merged.push({ ...run });
  }
  return merged;
}

function readPcmWav(input: Buffer): WavPcm {
  if (input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE") throw new Error("录音 WAV 格式无效。");
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= input.length) {
    const id = input.toString("ascii", offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === "fmt " && size >= 16 && payload + size <= input.length) {
      audioFormat = input.readUInt16LE(payload);
      channels = input.readUInt16LE(payload + 2);
      sampleRate = input.readUInt32LE(payload + 4);
      bitsPerSample = input.readUInt16LE(payload + 14);
    } else if (id === "data" && payload + size <= input.length) {
      dataOffset = payload;
      dataSize = size;
      break;
    }
    offset = payload + size + (size % 2);
  }
  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || !sampleRate || dataOffset < 0 || dataSize < 2) {
    throw new Error("录音必须是单声道 PCM WAV。");
  }
  const sampleCount = Math.floor(dataSize / 2);
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) samples[index] = input.readInt16LE(dataOffset + index * 2);
  return { sampleRate, samples };
}

function writePcmWav(sampleRate: number, samples: Int16Array): Buffer {
  const dataSize = samples.length * 2;
  const output = Buffer.alloc(44 + dataSize);
  output.write("RIFF", 0, 4, "ascii");
  output.writeUInt32LE(36 + dataSize, 4);
  output.write("WAVEfmt ", 8, 8, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, 4, "ascii");
  output.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) output.writeInt16LE(samples[index], 44 + index * 2);
  return output;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))] ?? -100;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function emptyStats(originalDurationMs: number): SilenceTrimStats {
  return { trimmed: false, originalDurationMs, retainedDurationMs: originalDurationMs, removedDurationMs: 0, thresholdDb: null, voicedFrameRatio: 0 };
}
