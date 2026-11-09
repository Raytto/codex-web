import crypto from 'node:crypto';

export type VoiceSegment = {
  role: 'user' | 'assistant'; text: string; source: string; callId: string;
  startMs: number; endMs: number; createdAt: string; timed: boolean; withheld: boolean;
};
type Fragment = Omit<VoiceSegment, 'source' | 'createdAt'> & { id: string; order: number; birth: number };

// Captions describe a session timeline, not speaker playback. Late fragments retain
// their event time even when a previous batch has already been persisted.
export class VoiceTranscripts {
  private fragments: Fragment[] = [];
  private order = 0;
  constructor(private readonly record: (segment: VoiceSegment) => void) {}
  add(role: VoiceSegment['role'], e: Record<string, any>, callId: string, birth: number, withheld = false) {
    const text = String(e.delta ?? '');
    if (!text) return;
    const timed = Number.isFinite(e.start_ms) && Number.isFinite(e.end_ms) && e.start_ms >= 0 && e.end_ms >= e.start_ms && e.end_ms < 24*60*60000;
    const startMs = timed ? e.start_ms : Math.max(0, Date.now() - birth);
    this.fragments.push({role, text, callId, birth, startMs, endMs: timed ? e.end_ms : startMs,
      timed, withheld, id: String(e.event_id ?? `${role}:${startMs}:${text}`), order: this.order++});
    if (this.fragments.length >= 200) this.flush();
  }
  flush() {
    const sorted = this.fragments.sort((a,b) => a.birth - b.birth || a.startMs - b.startMs || a.order - b.order);
    this.fragments = [];
    let segment: Fragment | undefined, ids: string[] = [];
    const save = () => {
      if (!segment?.text.trim()) return;
      this.record({role:segment.role, text:segment.text, callId:segment.callId, startMs:segment.startMs,
        endMs:segment.endMs, timed:segment.timed, withheld:segment.withheld,
        createdAt:new Date(segment.birth + segment.startMs).toISOString(),
        source:crypto.createHash('sha256').update(segment.callId + ':' + ids.join(':')).digest('hex')});
    };
    for (const f of sorted) {
      if (segment && segment.callId === f.callId && segment.role === f.role && segment.withheld === f.withheld
          && segment.timed === f.timed && f.startMs <= segment.endMs + 800 && segment.text.length + f.text.length < 1600) {
        segment.text += f.text; segment.endMs = Math.max(segment.endMs, f.endMs); ids.push(f.id);
      } else { save(); segment = {...f}; ids = [f.id]; }
    }
    save();
  }
}
