import assert from 'node:assert/strict';
import test from 'node:test';
import {startCallRingback} from '../src/call-ringback.js';

test('connection feedback has quiet gaps and bounded PCM at both browser sample rates', () => {
  for (const sampleRate of [44100, 48000]) {
    let pcm!: Float32Array;
    const source = {buffer: null, loop: false, connect() {}, start() {}, stop() {}, disconnect() {}};
    const audio = {sampleRate, destination: {}, createBuffer(_channels: number, size: number) {pcm = new Float32Array(size);return {getChannelData: () => pcm};}, createBufferSource: () => source};
    startCallRingback(audio as unknown as AudioContext)();
    assert.equal(pcm.length, sampleRate * 2);
    assert.ok(pcm.slice(0, sampleRate * .45).some(v => Math.abs(v) > .04));
    assert.ok(pcm.every(v => Math.abs(v) <= .061));
    assert.ok(pcm.slice(Math.ceil(sampleRate * .45)).every(v => v === 0));
    assert.equal(pcm[0], 0);
    assert.ok(Math.abs(pcm[Math.ceil(sampleRate * .45) - 1]) < .001);
  }
});

test('cancel and repeated cleanup stop and disconnect the looping source exactly once', () => {
  const events: string[] = [], destination = {};
  const source = {buffer: null, loop: false, connect(target: unknown) {assert.equal(target,destination);events.push('connect');}, start() {events.push('start');}, stop() {events.push('stop');}, disconnect() {events.push('disconnect');}};
  const audio = {sampleRate: 48000, destination, createBuffer: () => ({getChannelData: () => new Float32Array(96000)}), createBufferSource: () => source};
  const stop = startCallRingback(audio as unknown as AudioContext);
  assert.equal(source.loop, true);
  stop();stop();
  assert.deepEqual(events, ['connect','start','stop','disconnect']);
});
