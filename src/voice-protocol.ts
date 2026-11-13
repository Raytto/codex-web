// Bump when browser, worklets and gateway can no longer safely interoperate.
export const VOICE_PROTOCOL_VERSION = 2;
export const VOICE_REFRESH_MESSAGE = '通话功能已更新，请刷新页面后重新开始通话。后台任务保持原状态。';
export const PHYSICAL_RECOVERY_REASONS = ['transport_lost', 'context_rotation', 'upstream_disconnected', 'upstream_unresponsive'] as const;
export function isPhysicalRecoveryReason(reason: unknown): reason is typeof PHYSICAL_RECOVERY_REASONS[number] {
  return typeof reason === 'string' && (PHYSICAL_RECOVERY_REASONS as readonly string[]).includes(reason);
}

// Check the loaded render-thread code as well as the page. A cached processor
// must not silently speak an older interruption protocol to a newer page.
export function verifyVoiceWorklet(port: MessagePort, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); port.removeEventListener('message', receive);
      if (error) reject(error); else resolve();
    };
    const receive = ({data}: MessageEvent) => {
      if (data?.type === 'voice_protocol') finish(data.version === VOICE_PROTOCOL_VERSION ? undefined : new Error(VOICE_REFRESH_MESSAGE));
    };
    const timer = setTimeout(() => finish(new Error(VOICE_REFRESH_MESSAGE)), timeoutMs);
    port.addEventListener('message', receive); port.start();
    port.postMessage({type: 'voice_protocol'});
  });
}
