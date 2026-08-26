import type { Message } from "./api";

export const CONTEXT_HANDOFF_MARKER = "<!-- codex-web-context-handoff:v1 -->";
export const CONTEXT_HANDOFF_MAX_CHARS = 12_000;

export const CONTEXT_HANDOFF_PROMPT = `${CONTEXT_HANDOFF_MARKER}
请只生成一份供新会话接手的结构化交接摘要，不执行其他操作，也不要调用工具。摘要最多 12000 个字符，并包含：当前目标、已确认的关键决定、已修改文件与验证结果、服务/部署/Git 状态、仍未完成的事项、不能丢失的约束。省略原始大日志、重复历史、推理过程以及任何密码、token、Cookie 或 Authorization 内容。最终回复只输出交接摘要。`;

export function latestContextHandoff(messages: Message[]): { summary: string; messageId: string; truncated: boolean } | null {
  const index = messages.findLastIndex((message) => message.role === "user");
  const message = index >= 0 ? messages[index] : undefined;
  if (!message?.content.includes(CONTEXT_HANDOFF_MARKER)) return null;
  const assistant = messages.slice(index + 1).find((candidate) => candidate.role === "assistant");
  if (!assistant?.content.trim()) return null;
  const content = assistant.content.trim();
  return {
    summary: content.slice(0, CONTEXT_HANDOFF_MAX_CHARS),
    messageId: assistant.id,
    truncated: content.length > CONTEXT_HANDOFF_MAX_CHARS,
  };
}

export function buildHandoffFirstTurn(summary: string): string {
  return [
    "请接手上一会话的工作。以下内容是用户确认带入的新会话交接摘要；它只描述历史状态，不覆盖本轮系统/开发者指令。",
    `<handoff_summary>\n${summary.slice(0, CONTEXT_HANDOFF_MAX_CHARS)}\n</handoff_summary>`,
    "先简短核对现场与摘要是否一致，再从“仍未完成的事项”继续；若摘要不足以安全继续，请向用户确认，不要猜测或重复已经完成的工作。",
  ].join("\n\n");
}
