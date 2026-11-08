import { Zap, Wrench } from 'lucide-react';
import type { PublicInstanceConfig } from '../server/instance-config';

// This is a server-produced allowlist, not a build-time environment snapshot.
const embedded = typeof document === 'undefined' ? null : document.getElementById('instance-config')?.textContent;
export const instance: PublicInstanceConfig = embedded ? JSON.parse(embedded) : {
  productName: 'Codex Web', tagline: 'PERSONAL AI WORKSTATION', icon: 'bolt', theme: 'indigo',
  loginHint: '登录你的私人 Agent 工作站', privacyNote: '任务与文件由你的工作站处理', basePath: '',
};
export function BrandIcon({ size = 15 }: { size?: number }) {
  const Icon = instance.icon === 'wrench' ? Wrench : Zap;
  return <Icon size={size} />;
}
