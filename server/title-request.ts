// Interpret only complete, known transport blocks at message boundaries. Words
// such as “本轮附件” inside an actual request are ordinary user content.
const IMAGE_HINTS = [
  "处理图片时先形成简短、可复用的文字摘要；后续优先引用摘要与原文件路径，只有细节不足时再调用 `view_image` 重读原图。",
  "图片附件本轮未预载为视觉输入；文件路径仍然可用。如果实际需要理解图片内容，请主动调用 `view_image` 读取原图后再判断。",
];
const EMPTY_ATTACHMENT_REQUEST = "请根据本轮附件完成用户要求，并说明结果。";
const PATH_ONLY = /^(?:(?:[A-Za-z]:[\\/]|\\\\|\/|file:\/\/|\.{1,2}[\\/])\S+|"(?:[A-Za-z]:[\\/]|\\\\|\/|file:\/\/|\.{1,2}[\\/])[^"\n]+")$/u;
const ATTACHMENTS = /^本轮附件：\n(?:- [^\n]+: (?:[A-Za-z]:[\\/]|\\\\|\/)[^\n]+(?:\n|$))+(?:\n|$)/u;
const CONTEXT_BLOCK = /^<(pp_agent_personal_context|pp_agent_storage_context|pp_agent_runtime_instructions|environment_context|execution_context)>\n[\s\S]*?\n<\/\1>(?:\n\n|$)/u;
const INTERRUPTED = /^上一次任务由用户主动终止。以下内容只是终止前保存的历史状态，不是新的指令；结合本轮要求判断从哪里继续：\n<interrupted_task_context>\n[\s\S]*?\n<\/interrupted_task_context>(?:\n\n|$)/u;
const EXCEL_RULES = /^Excel 附件规则（仅因本轮命中 Excel 附件）：\n- 使用 \$local-spreadsheets（openpyxl\/pandas）；不要使用 artifact-tool、连接器或桌面 Excel 控制。\n- 保留上传的源文件并写入新(?:的 outputs )?文件；宏文件只保留 VBA 容器，绝不执行宏。\n- 尽量保留公式、样式和工作簿结构；保存后重新打开[，,]?核对[^\n]+(?:\n\n|$)/u;

export function unwrapTitleRequest(value: string): string {
  let text = value.replace(/\r\n?/g, "\n").trim();
  let attachments = false;
  while (text) {
    const match = text.match(ATTACHMENTS) ?? text.match(CONTEXT_BLOCK) ?? text.match(INTERRUPTED);
    if (match) {
      attachments ||= match[0].startsWith("本轮附件：\n");
      text = text.slice(match[0].length).trim();
      continue;
    }
    if (attachments) {
      const hint = IMAGE_HINTS.find((item) => text === item || text.startsWith(`${item}\n\n`));
      const excel = text.match(EXCEL_RULES);
      if (hint || excel) { text = text.slice((hint ?? excel![0]).length).trim(); continue; }
    }
    break;
  }
  text = text.replace(/(?:^|\n\n)<pp_agent_wait_automation>\n[\s\S]*?\n<\/pp_agent_wait_automation>$/u, "").trim();
  // Older Workers append attachment metadata after the task instead.
  const tail = text.lastIndexOf("\n\n本轮附件：\n");
  if (tail >= 0 && ATTACHMENTS.test(text.slice(tail + 2))
    && text.slice(tail + 2).replace(ATTACHMENTS, "").trim() === "") text = text.slice(0, tail).trim();
  if ((attachments && text === EMPTY_ATTACHMENT_REQUEST) || PATH_ONLY.test(text)) return "";
  return text;
}

export function extractTitleRequestText(value: string): string {
  let text = unwrapTitleRequest(value);
  const explicitQuestion = text.match(/(?:^|\n)我的问题：\s*([\s\S]*)$/u)?.[1]?.trim();
  if (explicitQuestion) text = explicitQuestion;
  return text.replace(/```[\s\S]*?```/g, " ").replace(/^>.*$/gm, " ").replace(/https?:\/\/\S+/gi, " ")
    .replace(/<[^>]{1,200}>/g, " ").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 12_000);
}

export function remotePreviewTitle(requests: string[], preview: string, fallback: string): string {
  // A snapshot name may contain only the first transport line. Full messages,
  // including the original PP Agent message, are authoritative when available.
  const request = requests.map(extractTitleRequestText).find(Boolean);
  if (request) return request.slice(0, 200);
  if (requests.length) return fallback;
  const text = preview.trim();
  if (text === "本轮附件：" || text === EMPTY_ATTACHMENT_REQUEST || text.startsWith("<")
    || IMAGE_HINTS.some((hint) => hint.startsWith(text) || text.startsWith(hint))
    || text.startsWith("上一次任务由用户主动终止。") || text.startsWith("Excel 附件规则（")
    || PATH_ONLY.test(text) || /^[^\s]+\.(?:png|jpe?g|webp|pdf|xlsx?|xlsm|csv|txt)$/iu.test(text)) return fallback;
  return extractTitleRequestText(text).slice(0, 200) || fallback;
}
