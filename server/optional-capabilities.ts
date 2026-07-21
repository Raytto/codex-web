export type OptionalAgentCapabilities = {
  apps: boolean;
  remotePlugin: boolean;
  goals: boolean;
  multiAgent: boolean;
};

export const DEFAULT_OPTIONAL_AGENT_CAPABILITIES: OptionalAgentCapabilities = {
  apps: false,
  remotePlugin: false,
  goals: false,
  multiAgent: false,
};

export function isOptionalAgentCapabilities(value: unknown): value is OptionalAgentCapabilities {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(DEFAULT_OPTIONAL_AGENT_CAPABILITIES).every((key) => typeof record[key] === "boolean");
}

const CONNECTOR_SUBJECT = /(?:\b(?:apps?|connectors?|plugins?|gmail|sharepoint|slack|notion|figma|box|teams|atlassian|rovo)\b|\bgoogle\s+(?:drive|calendar)\b|\boutlook(?:\s+(?:email|calendar))?\b|应用连接器|连接器|插件|谷歌(?:云端硬盘|日历)|邮箱|邮件|网盘|日历)/i;
const APP_ACTION = /(?:使用|启用|打开|调用|接入|连接|授权|读取|查找|搜索|同步|发送|安装|\b(?:use|enable|open|call|connect|authorize|read|search|sync|send|install)\b)/i;
const GOAL_SUBJECT = /(?:\bgoals?\b|长期目标|持续目标|目标追踪|目标跟踪)/i;
const GOAL_ACTION = /(?:创建|建立|设置|启用|使用|追踪|跟踪|\b(?:create|set|enable|use|track)\b)/i;
const MULTI_AGENT_SUBJECT = /(?:子代理|子agent|多代理|并行代理|\b(?:sub-?agents?|multi-?agents?)\b)/i;
const MULTI_AGENT_ACTION = /(?:使用|启用|调用|委派|分派|并行|\b(?:use|enable|call|delegate|parallel)\b)/i;
const DISABLE_ACTION = /(?:不要|无需|不用|关闭|禁用|停用|默认.{0,4}关闭|\bdisable\b|\bturn\s+off\b|\bdo\s+not\s+use\b)/i;

function detectIntent(text: string, subject: RegExp, action: RegExp): boolean | undefined {
  let decision: boolean | undefined;
  for (const chunk of text.split(/[。！？!?\n;；]/)) {
    if (!subject.test(chunk)) continue;
    decision = DISABLE_ACTION.test(chunk) ? false : action.test(chunk) ? true : decision;
  }
  return decision;
}

export function detectOptionalAgentCapabilities(userPrompts: string[]): OptionalAgentCapabilities {
  const capabilities = { ...DEFAULT_OPTIONAL_AGENT_CAPABILITIES };
  for (const prompt of userPrompts) {
    const text = prompt.trim();
    if (!text) continue;
    const appIntent = /app:\/\//i.test(text) ? true : detectIntent(text, CONNECTOR_SUBJECT, APP_ACTION);
    if (appIntent !== undefined) {
      capabilities.apps = appIntent;
      capabilities.remotePlugin = appIntent;
    }
    const goalIntent = /\/goal(?:\s|$)/i.test(text) ? !DISABLE_ACTION.test(text) : detectIntent(text, GOAL_SUBJECT, GOAL_ACTION);
    if (goalIntent !== undefined) capabilities.goals = goalIntent;
    const multiAgentIntent = detectIntent(text, MULTI_AGENT_SUBJECT, MULTI_AGENT_ACTION);
    if (multiAgentIntent !== undefined) capabilities.multiAgent = multiAgentIntent;
  }
  return capabilities;
}

export function buildOptionalCapabilityConfig(capabilities: OptionalAgentCapabilities): Record<string, unknown> {
  return {
    features: {
      apps: capabilities.apps,
      remote_plugin: capabilities.remotePlugin,
      goals: capabilities.goals,
      multi_agent: capabilities.multiAgent,
    },
    plugins: {
      "spreadsheets@openai-primary-runtime": { enabled: false },
    },
  };
}
