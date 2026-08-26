import assert from "node:assert/strict";
import test from "node:test";
import { trimWavSilenceBuffer, VOICE_SILENCE_TRIM } from "../server/voice-silence.js";

const SAMPLE_RATE = 8_000;

test("adaptive silence trim removes only leading, middle and trailing gaps longer than five seconds", () => {
  const input = wav([
    noise(6_000, 70),
    tone(1_000, 5_500),
    noise(2_000, 70),
    tone(1_000, 2_800),
    noise(6_000, 70),
    tone(1_000, 4_000),
    noise(6_000, 70),
  ]);
  const result = trimWavSilenceBuffer(input);
  assert.equal(result.stats.trimmed, true);
  assert.equal(Math.round(result.stats.originalDurationMs), 23_000);
  // Kept audio: 350ms pre/post padding around two retained speech islands,
  // while the two-second conversational pause remains intact.
  assert.ok(Math.abs(result.stats.retainedDurationMs - 6_400) <= VOICE_SILENCE_TRIM.frameMs * 2);
  assert.ok(result.stats.removedDurationMs > 16_500);
  assert.ok((result.stats.thresholdDb ?? -100) >= -48);
  assert.ok((result.stats.thresholdDb ?? 0) < -26);
  assert.equal(wavDurationMs(result.buffer), Math.round(result.stats.retainedDurationMs));
});

test("exactly five seconds and ordinary conversational pauses are preserved", () => {
  const input = wav([
    tone(1_000, 4_000),
    noise(5_000, 60),
    tone(1_000, 3_000),
  ]);
  const result = trimWavSilenceBuffer(input);
  assert.equal(result.stats.trimmed, false);
  assert.equal(result.stats.removedDurationMs, 0);
  assert.equal(result.buffer, input);
});

test("a short click does not turn a long silent gap into speech", () => {
  const input = wav([
    tone(1_000, 4_000),
    noise(3_000, 80),
    tone(20, 9_000),
    noise(3_000, 80),
    tone(1_000, 3_000),
  ]);
  const result = trimWavSilenceBuffer(input);
  assert.equal(result.stats.trimmed, true);
  assert.ok(result.stats.removedDurationMs > 5_200);
});

test("uncertain uniform low-level audio is left untouched", () => {
  const input = wav([noise(8_000, 90)]);
  const result = trimWavSilenceBuffer(input);
  assert.equal(result.stats.trimmed, false);
  assert.equal(result.stats.voicedFrameRatio, 0);
  assert.equal(result.buffer, input);
});

test("threshold adapts to both quiet and loud recording gains", () => {
  for (const [background, speech] of [[35, 800], [900, 8_000]] as const) {
    const result = trimWavSilenceBuffer(wav([
      tone(1_000, speech),
      noise(6_000, background),
      tone(1_000, speech),
    ]));
    assert.equal(result.stats.trimmed, true, `background=${background}, speech=${speech}`);
    assert.ok(result.stats.removedDurationMs > 5_200);
  }
});

function noise(durationMs: number, amplitude: number): Int16Array {
  const samples = new Int16Array(Math.round(SAMPLE_RATE * durationMs / 1_000));
  let state = 0x12345678;
  for (let index = 0; index < samples.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    samples[index] = Math.round((((state >>> 0) / 0xffffffff) * 2 - 1) * amplitude);
  }
  return samples;
}

function tone(durationMs: number, amplitude: number): Int16Array {
  const samples = new Int16Array(Math.round(SAMPLE_RATE * durationMs / 1_000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin(index * Math.PI * 2 * 220 / SAMPLE_RATE) * amplitude);
  }
  return samples;
}

function wav(parts: Int16Array[]): Buffer {
  const sampleCount = parts.reduce((total, part) => total + part.length, 0);
  const output = Buffer.alloc(44 + sampleCount * 2);
  output.write("RIFF", 0, 4, "ascii");
  output.writeUInt32LE(36 + sampleCount * 2, 4);
  output.write("WAVEfmt ", 8, 8, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, 4, "ascii");
  output.writeUInt32LE(sampleCount * 2, 40);
  let cursor = 44;
  for (const part of parts) {
    for (const sample of part) {
      output.writeInt16LE(sample, cursor);
      cursor += 2;
    }
  }
  return output;
}

function wavDurationMs(buffer: Buffer): number {
  return Math.round(buffer.readUInt32LE(40) / 2 * 1_000 / buffer.readUInt32LE(24));
}
