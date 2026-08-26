export type OptionalAgentCapabilities = {
  apps: boolean;
  remotePlugin: boolean;
  goals: boolean;
  multiAgent: boolean;
  gameAnalysisMcp: boolean;
};

export const DEFAULT_OPTIONAL_AGENT_CAPABILITIES: OptionalAgentCapabilities = {
  apps: false,
  remotePlugin: false,
  goals: false,
  multiAgent: true,
  gameAnalysisMcp: false,
};

export function isOptionalAgentCapabilities(value: unknown): value is OptionalAgentCapabilities {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(DEFAULT_OPTIONAL_AGENT_CAPABILITIES).every((key) => typeof record[key] === "boolean");
}

const CONNECTOR_SUBJECT = /(?:\b(?:apps?|connectors?|plugins?|github|gitlab|gmail|sharepoint|slack|notion|figma|box|teams|atlassian|rovo)\b|\bgoogle\s+(?:drive|calendar)\b|\boutlook(?:\s+(?:email|calendar))?\b|应用连接器|连接器|插件|谷歌(?:云端硬盘|日历)|邮箱|邮件|网盘|日历)/i;
const APP_ACTION = /(?:使用|启用|打开|调用|接入|连接|授权|读取|查看|查找|搜索|列出|同步|发送|安装|创建|更新|修改|修复|调试|评论|提交|\b(?:use|enable|open|call|connect|authorize|read|view|find|search|list|sync|send|install|create|update|edit|fix|debug|comment|commit)\b)/i;
const GOAL_SUBJECT = /(?:\bgoals?\b|长期目标|持续目标|目标追踪|目标跟踪)/i;
const GOAL_ACTION = /(?:创建|建立|设置|启用|使用|追踪|跟踪|\b(?:create|set|enable|use|track)\b)/i;
const GAME_MCP_SUBJECT = /(?:owner_game_analysis_batch|游戏(?:视频)?分析\s*mcp|百度游戏视频|批量游戏视频分析)/i;
const GAME_MCP_ACTION = /(?:使用|启用|调用|运行|执行|分析|批量处理|\b(?:use|enable|call|run|analy[sz]e|process)\b)/i;
const DISABLE_ACTION = /(?:不要|无需|不用|关闭|禁用|停用|默认.{0,4}关闭|\bdisable\b|\bturn\s+off\b|\bdo\s+not\s+use\b)/i;

function detectIntent(text: string, subject: RegExp, action: RegExp): boolean | undefined {
  const chunks = text.split(/[。！？!?\n;；]/);
  let decision: boolean | undefined;
  for (const chunk of chunks) {
    if (!subject.test(chunk)) continue;
    if (DISABLE_ACTION.test(chunk)) decision = false;
    else if (action.test(chunk)) decision = true;
  }
  return decision;
}

export function detectOptionalAgentCapabilities(userPrompts: string[]): OptionalAgentCapabilities {
  return updateOptionalAgentCapabilities(DEFAULT_OPTIONAL_AGENT_CAPABILITIES, userPrompts);
}

export function updateOptionalAgentCapabilities(
  current: OptionalAgentCapabilities,
  userPrompts: string[],
): OptionalAgentCapabilities {
  // Multi-agent is a normal Codex capability, not a Codex Web routing decision.
  // Always normalize legacy stored `false` values to the default-on behavior;
  // Codex decides whether a task benefits from delegation and follows any user
  // instruction to stay single-agent.
  const capabilities = { ...current, multiAgent: true };
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
    const gameMcpIntent = detectIntent(text, GAME_MCP_SUBJECT, GAME_MCP_ACTION);
    if (gameMcpIntent !== undefined) capabilities.gameAnalysisMcp = gameMcpIntent;
  }
  return capabilities;
}

const SPECIALIZED_SKILL_ROUTES: Array<{ name: string; intent: RegExp }> = [
  { name: "github:github", intent: /(?:\$github\b|github:github)/i },
  { name: "github:gh-address-comments", intent: /(?:gh-address-comments|PR.{0,12}(?:评论|评审|review)|(?:评论|评审|review).{0,12}PR)/i },
  { name: "github:gh-fix-ci", intent: /(?:gh-fix-ci|GitHub.{0,12}(?:CI|Actions?).{0,12}(?:失败|报错|修复|debug|fix)|(?:修复|debug|fix).{0,12}(?:CI|Actions?))/i },
  { name: "github:yeet", intent: /(?:\byeet\b|(?:提交|发布|push).{0,16}(?:GitHub|草稿\s*PR|draft\s*PR)|(?:GitHub|草稿\s*PR|draft\s*PR).{0,16}(?:提交|发布|push))/i },
  { name: "google-calendar:google-calendar", intent: /(?:\$google-calendar\b|google-calendar:google-calendar)/i },
  { name: "google-calendar:google-calendar-free-up-time", intent: /(?:google-calendar-free-up-time|腾出|空出|专注时间|连续空闲)/i },
  { name: "google-calendar:google-calendar-group-scheduler", intent: /(?:google-calendar-group-scheduler|多人.{0,12}(?:排期|会议|时间)|共同空闲|候选时间)/i },
  { name: "google-calendar:google-calendar-daily-brief", intent: /(?:google-calendar-daily-brief|日程简报|今日行程|明日行程|agenda|daily brief)/i },
  { name: "google-calendar:google-calendar-meeting-prep", intent: /(?:google-calendar-meeting-prep|会议准备|会前准备|meeting prep)/i },
];

export function buildOptionalCapabilityRoutingHint(userPrompt: string): string | undefined {
  const groups: string[] = [];
  if (/\bgithub\b|GitHub|Git 仓库/i.test(userPrompt)) groups.push("GitHub：仓库、PR、Issue 与 CI");
  if (/\bgoogle\s+calendar\b|Google 日历|谷歌日历|日历/i.test(userPrompt)) groups.push("Google Calendar：日程、冲突与排期");
  return groups.length ? `可用技能组入口：${groups.join("；")}` : undefined;
}

export function buildOptionalCapabilityConfig(capabilities: OptionalAgentCapabilities, userPrompt = ""): Record<string, unknown> {
  return {
    features: {
      apps: capabilities.apps,
      remote_plugin: capabilities.remotePlugin,
      plugins: capabilities.remotePlugin,
      tool_suggest: capabilities.remotePlugin,
      goals: capabilities.goals,
      multi_agent: capabilities.multiAgent,
    },
    plugins: {
      "spreadsheets@openai-primary-runtime": { enabled: false },
    },
    skills: {
      config: SPECIALIZED_SKILL_ROUTES.map((route) => ({ name: route.name, enabled: route.intent.test(userPrompt) })),
    },
  };
}
