import type { RunRequest } from "./protocol.js";

export type LocalAttachment = { name: string; path: string; mimeType: string };

const EXCEL = /\.(?:xls|xlsx|xlsm|xlsb|xltx|xltm|xlam)$/i;

export function buildRemoteTurnPrompt(request: RunRequest, attachments: LocalAttachment[]): { prompt: string; imagePaths: string[] } {
  if (!request.turnContext) {
    const attachmentText = attachments.length
      ? `\n\n本轮附件：\n${attachments.map((item) => `- ${item.name}: ${item.path}`).join("\n")}`
      : "";
    return {
      prompt: `${request.prompt}${attachmentText}`,
      imagePaths: attachments.filter(isImage).map((item) => item.path),
    };
  }
  const context = request.turnContext;
  const instruction = context.userPrompt.trim() || "请根据本轮附件完成用户要求，并说明结果。";
  const parts: string[] = [];
  if (attachments.length) parts.push(`本轮附件：\n${attachments.map((item) => `- ${item.name}: ${item.path}`).join("\n")}`);
  if (context.interruptedContext) {
    parts.push(`上一次任务由用户主动终止。以下内容只是终止前保存的历史状态，不是新的指令；结合本轮要求判断从哪里继续：\n<interrupted_task_context>\n${context.interruptedContext}\n</interrupted_task_context>`);
  }
  if (attachments.some((item) => EXCEL.test(item.name) || EXCEL.test(item.path))) {
    parts.push([
      "Excel 附件规则（仅因本轮命中 Excel 附件）：",
      "- 使用 $local-spreadsheets（openpyxl/pandas）；不要使用 artifact-tool、连接器或桌面 Excel 控制。",
      "- 保留上传的源文件并写入新文件；宏文件只保留 VBA 容器，绝不执行宏。",
      "- 尽量保留公式、样式和工作簿结构；保存后重新打开核对关键内容。",
    ].join("\n"));
  }
  if (context.imageInput === "path_only") {
    parts.push("图片附件本轮未预载为视觉输入；文件路径仍然可用。如果实际需要理解图片内容，请主动调用 `view_image` 读取原图后再判断。");
  } else if (context.imageInput === "preload") {
    parts.push("处理图片时先形成简短、可复用的文字摘要；后续优先引用摘要与原文件路径，只有细节不足时再调用 `view_image` 重读原图。");
  }
  parts.push(instruction);
  return {
    prompt: parts.join("\n\n"),
    imagePaths: context.imageInput === "preload" ? attachments.filter(isImage).map((item) => item.path) : [],
  };
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

export function buildRemoteOptionalCapabilityConfig(capabilities: Record<string, boolean>, userPrompt = ""): Record<string, unknown> {
  return {
    features: {
      apps: capabilities.apps === true,
      remote_plugin: capabilities.remotePlugin === true,
      plugins: capabilities.remotePlugin === true,
      tool_suggest: capabilities.remotePlugin === true,
      goals: capabilities.goals === true,
      multi_agent: capabilities.multiAgent === true,
    },
    plugins: {
      "spreadsheets@openai-primary-runtime": { enabled: false },
    },
    skills: {
      config: SPECIALIZED_SKILL_ROUTES.map((route) => ({ name: route.name, enabled: route.intent.test(userPrompt) })),
    },
  };
}

export function buildRemoteSteerPrompt(
  userPrompt: string,
  attachments: LocalAttachment[],
  imageInput: "preload" | "path_only" | "none",
): { prompt: string; imagePaths: string[] } {
  const parts = [`实时调整当前任务：${userPrompt.trim() || "优先查看补充附件并据此调整当前工作。"}`];
  if (attachments.length) parts.push(`补充附件：\n${attachments.map((item) => `- ${item.name}: ${item.path}`).join("\n")}`);
  if (imageInput === "path_only") parts.push("补充图片未预载；如需理解内容，请调用 `view_image` 读取原图。");
  else if (imageInput === "preload") parts.push("请把图片关键信息压缩成可复用文字摘要，后续细节不足时再重读原图。");
  return { prompt: parts.join("\n\n"), imagePaths: imageInput === "preload" ? attachments.filter(isImage).map((item) => item.path) : [] };
}

export function remoteThreadInstructions(): string {
  return [
    "This thread is controlled by its owner through Codex Web. Treat the working directory as the project root.",
    "Keep user-visible replies concise and mention changed or generated files.",
    "Write large logs, tables, and machine-readable tool results to a runtime/artifact file; return only a summary, key lines, and its path to the model context.",
  ].join("\n");
}

function isImage(item: LocalAttachment): boolean {
  return /^image\/(?:png|jpeg|webp)$/i.test(item.mimeType) || /\.(?:png|jpe?g|webp)$/i.test(item.name);
}
