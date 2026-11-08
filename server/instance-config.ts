import path from 'node:path';

/** Pure resolver. config.ts is the sole application env loader; this module never reads a file. */
export type InstanceEnvironment = Record<string, string | undefined>;
export type PublicInstanceConfig = {
  productName: string; tagline: string; icon: 'bolt' | 'wrench'; theme: 'indigo' | 'jade';
  loginHint: string; privacyNote: string; basePath: string;
};
function text(env: InstanceEnvironment, key: string, fallback: string, max = 160): string {
  const value = env[key] ?? fallback;
  if (!value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid ${key}`);
  return value;
}
function choice<T extends string>(env: InstanceEnvironment, key: string, values: readonly T[], fallback: T): T {
  const value = env[key] ?? fallback;
  if (!values.includes(value as T)) throw new Error(`Invalid ${key}`);
  return value as T;
}
export function instanceBasePath(value = ''): string {
  if (value === '' || value === '/') return '';
  if (!/^\/[a-zA-Z0-9_/-]+$/.test(value) || value.includes('//') || value.includes('..')) throw new Error('Invalid BASE_PATH');
  return value.replace(/\/$/, '');
}
export function instancePort(value: unknown = 37821): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid PORT');
  return n;
}
export function instanceBoolean(value: string | undefined, fallback: boolean, key: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`Invalid ${key}`);
}
export function loadPublicInstanceConfig(env: InstanceEnvironment = {}, basePath = instanceBasePath(env.BASE_PATH)): PublicInstanceConfig {
  return Object.freeze({
    productName: text(env, 'APP_PRODUCT_NAME', 'Codex Web', 80),
    tagline: text(env, 'APP_TAGLINE', 'PERSONAL AI WORKSTATION'),
    icon: choice(env, 'APP_ICON', ['bolt', 'wrench'], 'bolt'),
    theme: choice(env, 'APP_THEME', ['indigo', 'jade'], 'indigo'),
    loginHint: text(env, 'APP_LOGIN_HINT', '登录你的私人 Agent 工作站'),
    privacyNote: text(env, 'APP_PRIVACY_NOTE', '任务与文件由你的工作站处理'),
    basePath: instanceBasePath(basePath),
  });
}
/** Explicit selection, never spread AppConfig/process.env into a browser response. */
export function publicInstanceConfig(value: PublicInstanceConfig): PublicInstanceConfig {
  return { productName: value.productName, tagline: value.tagline, icon: value.icon, theme: value.theme,
    loginHint: value.loginHint, privacyNote: value.privacyNote, basePath: value.basePath };
}
export function loadInstancePaths(env: InstanceEnvironment, projectRoot: string) {
  if (env.APP_STATE_ROOT && (!path.isAbsolute(env.APP_STATE_ROOT) || env.APP_STATE_ROOT.includes("\0"))) throw new Error("Invalid APP_STATE_ROOT: absolute path required");
  const stateRoot = path.resolve(env.APP_STATE_ROOT || projectRoot);
  const absolute = (key: string, fallback: string) => {
    const value = env[key] || fallback;
    if (!value) return '';
    if (!path.isAbsolute(value) || value.includes('\0')) throw new Error(`Invalid ${key}: absolute path required`);
    return path.normalize(value);
  };
  const dataRoot = absolute('DATA_ROOT', path.join(stateRoot, 'data'));
  return {
    stateRoot, dataRoot, tenantRoot: absolute('TENANT_ROOT', path.join(stateRoot, 'tenants')),
    pythonRuntimeRoot: absolute('PYTHON_RUNTIME_ROOT', path.join(dataRoot, 'python')),
    hostHome: absolute('PPHK_HOST_HOME', path.join(stateRoot, 'host-home')),
    hostRootSocketPath: absolute('PPHK_HOST_SOCKET_PATH', ''),
    ecsCredentialsSocketPath: absolute('PPHK_ECS_CREDENTIALS_SOCKET_PATH', ''),
    hostTenantRoot: absolute('PPHK_HOST_TENANT_ROOT', path.join(stateRoot, 'tenants')),
    hostKnowledgeRoot: absolute('PPHK_KNOWLEDGE_ROOT', path.join(stateRoot, 'workspaces')),
    hostRootCodexHome: absolute('PPHK_CODEX_HOME', path.join(stateRoot, 'host-codex-home')),
    hostDatabasePath: absolute('CWW_DATABASE_PATH', path.join(dataRoot, 'chatgpt-work.sqlite')),
    spreadsheetPython: absolute('PPHK_SPREADSHEET_PYTHON', path.join(stateRoot, 'spreadsheet-runtime', 'bin', 'python')),
  };
}
export function renderInstanceHtml(template: string, instance: PublicInstanceConfig): string {
  const safe = publicInstanceConfig(instance);
  const escape = (v: string) => v.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const json = JSON.stringify(safe).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (safe.icon === 'wrench') template = template
    .replace(/(<link rel="icon") type="image\/png"/, '$1 type="image/svg+xml"')
    .replace(/(<link rel="apple-touch-icon" href=")(?:\.\/|\/)favicon.png/, '$1/wrench-touch.png');
  return template.replace(/<html\b/, `<html data-brand-theme="${safe.theme}"`)
    .replace(/(<h1 id="startup-title">)[^<]*/, (_, prefix) => `${prefix}${escape(safe.productName)}`)
    .replace(/(<meta name="theme-color" content=")[^"]*/, (_, prefix) => `${prefix}${safe.theme === 'jade' ? '#f3faf7' : '#fafbff'}`)
    .replace('<!--instance-config-->' , `<script id="instance-config" type="application/json">${json}</script>`)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escape(safe.productName)}</title>`)
    .replace(/(<meta name="application-name" content=")[^"]*("\s*\/?>)/, (_, before, after) => `${before}${escape(safe.productName)}${after}`)
    .replace(/\b(src|href)="(?:\.\/|\/)(assets\/[^"\s]+|favicon\.png|wrench-touch\.png)"/g, (_, attr, file) => `${attr}="${safe.basePath}/${file === 'favicon.png' && safe.icon === 'wrench' ? 'wrench.svg' : file}"`);
}
