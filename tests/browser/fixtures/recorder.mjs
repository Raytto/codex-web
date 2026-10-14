export async function installRecorder(context, audioBase64) {
  await context.addInitScript(({ audioBase64 }) => {
    const bytes = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
    class Recorder {
      static isTypeSupported() { return true; }
      state = 'inactive'; mimeType = 'audio/wav';
      start() { this.state = 'recording'; }
      requestData() {}
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([bytes], { type: 'audio/wav' }) }); this.onstop?.(); }
    }
    Object.defineProperty(window, 'MediaRecorder', { value: Recorder, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true });
  }, { audioBase64 });
}
