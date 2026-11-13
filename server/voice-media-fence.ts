import crypto from 'node:crypto';

// A primary Live WebSocket has no output item IDs. An application-owned PCM
// fixture interrupts model output. Its actual bytes in that ordered media stream
// are the boundary; fixture.played and instructions.appended alone are not.
export class VoiceMediaFence {
  readonly id = crypto.randomUUID();
  readonly marker = crypto.randomBytes(960); // 20ms, never forwarded to a speaker.
  readonly createdAt = Date.now();
  instructionId = 'voice_correct_' + this.id;
  fixtureId = 'voice_fence_' + this.id;
  after: Buffer[] = [];
  injected = false;
  drained = false;
  matched = false;
  private tail = Buffer.alloc(0);
  constructor(readonly epoch: number) {}
  consume(audio: Buffer) {
    if (this.matched) return audio;
    const combined = Buffer.concat([this.tail, audio]);
    const index = combined.indexOf(this.marker);
    if (index >= 0) {
      this.matched = true; this.tail = Buffer.alloc(0);
      return combined.subarray(index + this.marker.length);
    }
    // Keep only the overlap needed for split packets, never an old utterance.
    this.tail = combined.subarray(Math.max(0, combined.length - this.marker.length + 1));
    return Buffer.alloc(0);
  }
  get ready() { return this.injected && this.drained && this.matched; }
}
