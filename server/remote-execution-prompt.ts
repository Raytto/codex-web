import { buildAskAgentDraft } from "../src/ask-agent-selection.js";
import { stripTaskRecoveryPrompt } from "./task-recovery.js";

const normalize = (text: string): string => text.replace(/\r\n?/g, "\n").trim();
const tags = ["pp_agent_complete_workflow", "pp_agent_personal_context", "codex_web_wait_automation", "pp_agent_storage_context"];

/** Comparison only. Never apply this to a user's stored/displayed message. Complete,
 * known wrappers are execution metadata; unknown or truncated blocks remain text. */
export function normalizeRemoteExecutionPrompt(text: string, preserveControlBlocks = false): string {
  let value = normalize(text);
  if (!preserveControlBlocks) for (const tag of tags) value = value.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gu"), "");
  if (!preserveControlBlocks) value = stripTaskRecoveryPrompt(value);
  value = value.replace(/^实时调整当前任务：/u, "");
  value = value.replace(/上一次任务由用户主动终止。以下内容只是终止前保存的历史状态，不是新的指令；结合本轮要求判断从哪里继续：\n<interrupted_task_context>[\s\S]*?<\/interrupted_task_context>/gu, "");
  // Both legacy suffix and unified-context prefix attachment formats.
  value = value.replace(/(?:^|\n)(?:本轮附件|补充附件)：\n(?:- [^\n]+: [^\n]+(?:\n|$))+/gu, "\n");
  for (const hint of [
    "补充图片未预载；如需理解内容，请调用 `view_image` 读取原图。",
    "请把图片关键信息压缩成可复用文字摘要，后续细节不足时再重读原图。",
    "处理图片时先形成简短、可复用的文字摘要；后续优先引用摘要与原文件路径，只有细节不足时再调用 `view_image` 重读原图。",
    "图片附件本轮未预载为视觉输入；文件路径仍然可用。如果实际需要理解图片内容，请主动调用 `view_image` 读取原图后再判断。",
    "Excel 附件规则（仅因本轮命中 Excel 附件）：\n- 使用 $local-spreadsheets（openpyxl/pandas）；不要使用 artifact-tool、连接器或桌面 Excel 控制。\n- 保留上传的源文件并写入新文件；宏文件只保留 VBA 容器，绝不执行宏。\n- 尽量保留公式、样式和工作簿结构；保存后重新打开核对关键内容。",
  ]) value = value.replaceAll(hint, "");
  return normalize(value);
}

export function remoteUserMessageMatchesJob(remoteContent: string, jobContent: string, quote?: string | null): boolean {
  const remote = normalize(remoteContent);
  const original = normalize(quote ? buildAskAgentDraft(jobContent, quote) : jobContent);
  if (remote === original) return true;
  if (!original) return false;
  // Protect the entire original (including literal tags/quotes) before removing
  // generated context. Do not normalize away any portion of the actual request.
  const marker = "\u0000PP_AGENT_ORIGINAL\u0000";
  if (remote.includes(marker)) return false;
  // Recovery JSON can also quote the original. Only the occurrence outside
  // execution wrappers can survive normalization as the sole visible request.
  let offset = remote.indexOf(original);
  for (let attempts=0; offset>=0 && attempts<64; attempts++) {
    if (normalizeRemoteExecutionPrompt(remote.slice(0,offset)+marker+remote.slice(offset+original.length))===marker) return true;
    offset=remote.indexOf(original,offset+original.length);
  }
  return false;
}
