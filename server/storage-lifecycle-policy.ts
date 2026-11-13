export const STORAGE_DAY = 86_400_000;
export const STORAGE_GIB = 1024 ** 3;
export type StorageKind = 'file' | 'image' | 'voice' | 'reader' | 'library' | 'native-history' | 'recovery' | 'events' | 'unmapped';
export type UsageEvidence = 'user-read' | 'tool-read' | 'write' | 'resume';
export const isRealUsage = (value: string): value is UsageEvidence => ['user-read','tool-read','write','resume'].includes(value);
export function storageRetentionDays(kind: StorageKind, recoveryDependency = false): 15 | 30 | 60 {
  return recoveryDependency || kind === 'recovery' || kind === 'unmapped' ? 60 : kind === 'library' || kind === 'events' ? 30 : 15;
}
export type StoragePolicy = {
  enabled: boolean; instanceId: string; remoteRoot: string; driveId: string; recipient: string; identity: string;
  graceMs: number; chunkBytes: number; scratchBytes: number; hotBytes: number; softBytes: number; highBytes: number;
};
/** No instance A path, drive or key is an implicit default for another install. */
export function storagePolicy(env: NodeJS.ProcessEnv = process.env): StoragePolicy {
  const enabled = ['1','true'].includes(env.STORAGE_LIFECYCLE_ENABLED ?? '');
  const required = (name: string) => {
    const value = env[name]?.trim() ?? '';
    if (enabled && !value) throw new Error(`storage_config_missing:${name}`);
    return value;
  };
  const policy = {
    enabled, instanceId: required('STORAGE_INSTANCE_ID'), remoteRoot: required('STORAGE_REMOTE_ROOT'),
    driveId: required('STORAGE_DRIVE_ID'), recipient: required('STORAGE_AGE_RECIPIENT'), identity: required('STORAGE_AGE_IDENTITY'),
    graceMs: 3 * STORAGE_DAY, chunkBytes: STORAGE_GIB, scratchBytes: 6 * STORAGE_GIB,
    hotBytes: 8 * STORAGE_GIB, softBytes: 24 * STORAGE_GIB, highBytes: 32 * STORAGE_GIB,
  };
  if (enabled && (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(policy.instanceId)
    || !policy.remoteRoot.startsWith('/') || policy.remoteRoot === '/' || policy.remoteRoot.split('/').slice(1).some(p => !p || p === '.' || p === '..')
    || !policy.recipient.startsWith('/') || !policy.identity.startsWith('/'))) throw new Error('storage_config_invalid');
  return policy;
}
