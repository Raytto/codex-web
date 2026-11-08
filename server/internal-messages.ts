import { stripTaskRecoveryPrompt } from "./task-recovery.js";

export const MODEL_CAPACITY_CONTINUATION_PROMPT = [
  "继续刚才因模型容量不足而中断、尚未完成的任务。",
  "先检查原会话中的最新进展、已经执行的命令、已有文件和现场状态，不要重复已经完成的步骤或外部操作；只完成剩余工作，并在完成后给出最终结果。",
].join("\n\n");

export const UPSTREAM_ROUTING_CONTINUATION_PROMPT = [
  "继续刚才因上游路由连接暂时不可用而中断、尚未完成的任务。",
  "先检查原会话中的最新进展、已经执行的命令、已有文件和现场状态，不要重复已经完成的步骤或外部操作；只完成剩余工作，并在完成后给出最终结果。",
].join("\n\n");

export function isModelCapacityContinuationPrompt(value: string): boolean {
  // Keep the historical entry point for observer imports and old transcripts.
  const prompt = stripTaskRecoveryPrompt(value.replace(/<pp_agent_complete_workflow>[\s\S]*?<\/pp_agent_complete_workflow>/g, "")).trim();
  return prompt === MODEL_CAPACITY_CONTINUATION_PROMPT || prompt === UPSTREAM_ROUTING_CONTINUATION_PROMPT;
}
