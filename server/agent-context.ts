export type AgentAttachmentContext = {
  name: string;
  path: string;
};

type TurnPromptOptions = {
  userPrompt: string;
  attachments: AgentAttachmentContext[];
  isolationReason?: string;
  runtimeWarning?: string;
};

export function buildAgentTurnPrompt(options: TurnPromptOptions): string {
  const parts = [options.userPrompt.trim() || "请根据本轮附件完成用户要求，并说明结果。"];
  if (options.attachments.length > 0) {
    parts.push(`本轮附件：\n${options.attachments.map((file) => `- ${file.name}: ${file.path}`).join("\n")}`);
  }
  if (options.runtimeWarning) parts.push(options.runtimeWarning);
  if (options.isolationReason) {
    parts.push(`安全要求：本轮已启用离线隔离（${options.isolationReason}）。只做静态检查，不执行不受信任的附件、宏或脚本；若必须动态执行，请说明尚未执行。`);
  }
  return parts.join("\n\n");
}

export function buildAgentSteerPrompt(userPrompt: string, attachments: AgentAttachmentContext[]): string {
  const instruction = userPrompt.trim() || "优先查看补充附件并据此调整当前工作。";
  const parts = [`实时调整当前任务：${instruction}`];
  if (attachments.length > 0) {
    parts.push(`补充附件：\n${attachments.map((file) => `- ${file.name}: ${file.path}`).join("\n")}`);
  }
  return parts.join("\n\n");
}
