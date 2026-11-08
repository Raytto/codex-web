// Local connection feedback only: never connected to capture or model playback.
// A looping buffer keeps the cadence stable when the main thread is busy.
export function startCallRingback(audio: AudioContext): () => void {
  const buffer = audio.createBuffer(1, Math.round(audio.sampleRate * 2), audio.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < Math.round(audio.sampleRate * 0.45); i++) {
    const t = i / audio.sampleRate;
    const envelope = Math.max(0, Math.min(1, t / 0.015, (0.45 - t) / 0.025));
    samples[i] = 0.03 * envelope * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t));
  }
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(audio.destination);
  source.start();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    source.stop();
    source.disconnect();
  };
}
