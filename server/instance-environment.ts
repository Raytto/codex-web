import path from 'node:path';
import type { InstanceEnvironment } from './instance-config.js';

/** Compatibility adapter only; config.ts remains the sole .env loader.
 * The shared resolver's legacy key names never opt a public install into private capabilities.
 */
export function publicInstanceEnvironment(env: InstanceEnvironment, projectRoot: string): InstanceEnvironment {
  const root = env.APP_STATE_ROOT || projectRoot;
  return { ...env,
    PPHK_HOST_SOCKET_PATH: env.CODEX_WEB_HOST_SOCKET_PATH || '',
    PPHK_ECS_CREDENTIALS_SOCKET_PATH: '',
    PPHK_HOST_TENANT_ROOT: env.CODEX_WEB_HOST_TENANT_ROOT || path.join(root, 'host', 'tenants'),
    PPHK_KNOWLEDGE_ROOT: env.CODEX_WEB_KNOWLEDGE_ROOT || path.join(root, 'host', 'knowledge'),
    PPHK_CODEX_HOME: env.CODEX_WEB_CODEX_HOME || path.join(root, 'host', 'codex-home'),
    PPHK_HOST_HOME: env.CODEX_WEB_HOST_HOME || path.join(root, 'host', 'home'),
    PPHK_SPREADSHEET_PYTHON: env.CODEX_WEB_SPREADSHEET_PYTHON || '',
    CWW_DATABASE_PATH: env.CWW_DATABASE_PATH || path.join(root, '.state', 'data', 'codex-web.sqlite'),
  };
}
