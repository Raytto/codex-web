import type { AgentModelOption, AgentSelection } from './model-options.js';

export type DotTaskIntent = {
  taskType?: 'youtube' | 'web_research' | 'gemini_specialist' | 'general';
  capabilityReason?: string;
  difficulty?: 'simple' | 'standard' | 'complex';
  model?: string;
  reasoningEffort?: string;
};
export type DotRoutingCatalog = {
  status: string;
  models: AgentModelOption[];
  defaultSelection?: AgentSelection;
  geminiUnavailableReason?: string;
};
export type DotTaskRouting = {
  policy: 'codex-web-task-routing-v1';
  selection: AgentSelection;
  taskType: NonNullable<DotTaskIntent['taskType']>;
  difficulty: NonNullable<DotTaskIntent['difficulty']>;
  mode: 'automatic' | 'explicit';
  fallback: boolean;
  reason: string;
};

export const DOT_ROUTING_INSTRUCTIONS = `后台新任务先按实际目的填写 taskType 和 difficulty。自动选择省略 model/reasoningEffort，由平台按目标节点目录、安装者可选策略及节点当前默认选择；不存在内置个人模型偏好。用户明确指定的模型/深度优先，不可用须说明阻塞，不得改为自动选择绕过。创建前可用 task_preview 核对，已执行任务用 task_steer 保持原位置和线程。gemini_specialist 必须给出已核实的 capabilityReason；模型品牌不构成能力证据。问候、附和和无需后台的简答不要 task_create。`;
export const VIDEO_EVIDENCE_INSTRUCTIONS = '涉及 YouTube 时，最终明确材料类型：视频画面、音轨、字幕或仅网页元数据，并附可核对来源/工具证据。仅字幕不得声称观看视频；无法取得音视频/字幕就如实说明，不能补编内容。';
export type DotRoutingPolicy = Record<string, AgentSelection>;
export function loadDotRoutingPolicy(raw = process.env.CODEX_WEB_DOT_ROUTING_POLICY || '{}'): DotRoutingPolicy {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('CODEX_WEB_DOT_ROUTING_POLICY must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Dot routing policy');
  for (const [key, selection] of Object.entries(value)) {
    if (!/^(general|youtube|web_research|gemini_specialist)(:(simple|standard|complex))?$/.test(key)
      || !selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).some(k => !['model','reasoningEffort'].includes(k))
      || typeof selection.model !== 'string' || !selection.model.trim()
      || typeof selection.reasoningEffort !== 'string' || !selection.reasoningEffort.trim()) throw new Error('Invalid Dot routing policy entry');
  }
  return value as DotRoutingPolicy;
}
export function routeDotTask(intent: DotTaskIntent, catalog: DotRoutingCatalog, policy = loadDotRoutingPolicy()): DotTaskRouting {
  if (catalog.status !== 'online') throw new Error('目标节点不在线或状态不可确认；未更换执行位置、未创建任务。');
  const taskType = intent.taskType ?? 'general', difficulty = intent.difficulty ?? 'standard';
  if (taskType === 'gemini_specialist' && !intent.capabilityReason?.trim()) throw new Error('Gemini 专项任务需要 capabilityReason 说明已核实的能力依据。');
  const configured = policy[taskType + ':' + difficulty] ?? policy[taskType];
  const selected = configured ?? catalog.defaultSelection;
  const modelId = intent.model ?? selected?.model;
  const model = catalog.models.find(m => m.id === modelId);
  if (!model) throw new Error('指定模型或节点默认模型不可用；未创建任务、没有自动改用另一模型。');
  const effort = intent.reasoningEffort ?? (intent.model === undefined || intent.model === selected?.model ? selected?.reasoningEffort : undefined) ?? model.defaultReasoningEffort;
  if (!effort || !model.reasoningEfforts.includes(effort)) throw new Error('指定深度不受目标模型支持；没有自动降级。');
  return {policy:'codex-web-task-routing-v1', taskType, difficulty, mode:intent.model === undefined ? 'automatic':'explicit', fallback:false,
    reason:(intent.model ? '遵守用户明确指定的模型。' : configured ? '采用安装者显式配置的任务策略。' : '采用目标节点当前默认选择。') + (intent.capabilityReason ? '分类依据：'+intent.capabilityReason : '') + '模型选择不代表已验证视频读取能力。',
    selection:{model:model.id, reasoningEffort:effort}};
}
