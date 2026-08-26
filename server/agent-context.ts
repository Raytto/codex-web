export type AgentAttachmentContext = {
  name: string;
  path: string;
  mimeType?: string;
};

export type ImageInputDecision = {
  preload: boolean;
  reason: "image" | "no_images";
};

const IMAGE_MIME = /^image\/(?:png|jpeg|webp)$/i;

export function isSupportedImageAttachment(name: string, mimeType?: string): boolean {
  return IMAGE_MIME.test(mimeType ?? "") || /\.(?:png|jpe?g|webp)$/i.test(name);
}

// Every supported image is preloaded. Codex, not a keyword router, decides how much visual inspection is needed.
export function decideImageInput(attachments: AgentAttachmentContext[]): ImageInputDecision {
  if (!attachments.some((file) => isSupportedImageAttachment(file.name, file.mimeType))) {
    return { preload: false, reason: "no_images" };
  }
  return { preload: true, reason: "image" };
}

const EXCEL_FILE_EXTENSION = /\.(?:xls|xlsx|xlsm|xlsb|xltx|xltm|xlam)$/i;
const EXCEL_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.addin.macroenabled.12",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.template.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
]);

const EXCEL_ATTACHMENT_RULES = [
  "Excel 附件规则（仅因本轮命中 Excel 附件）：",
  "- 使用 $local-spreadsheets（openpyxl/pandas）；不要使用 artifact-tool、连接器或桌面 Excel 控制。",
  "- 保留上传的源文件并写入新的 outputs 文件；宏文件只保留 VBA 容器，绝不执行宏。",
  "- 尽量保留公式、样式和工作簿结构；保存后重新打开，核对工作表、关键数据、公式及错误。",
].join("\n");

const SKILL_LOCATOR_RULES = [
  "技能读取规则：运行时提供的 Available skills 清单中的 source locator 是权威文件路径。使用某个技能时，必须按清单给出的完整路径读取其 SKILL.md，并按该文件中的相对路径读取 references、assets 和 scripts。",
  "不要把账号级技能改写到 .system/<skill-name>、不要只在项目根的 .agents/skills 中查找，也不要因为项目目录里没有该文件就判断技能缺失；账号级技能通常位于当前 CODEX_HOME/skills/<skill-name>/。",
].join("\n");

type TurnPromptOptions = {
  userPrompt: string;
  attachments: AgentAttachmentContext[];
  personalContext?: string;
  interruptedContext?: string;
  isolationReason?: string;
  runtimeWarning?: string;
  capabilityRoutingHint?: string;
  imageInputDecision?: ImageInputDecision;
};

export function buildAgentTurnPrompt(options: TurnPromptOptions): string {
  const instruction = options.userPrompt.trim() || "请根据本轮附件完成用户要求，并说明结果。";
  const parts: string[] = [];
  if (options.attachments.length > 0) {
    parts.push(`本轮附件：\n${options.attachments.map((file) => `- ${file.name}: ${file.path}`).join("\n")}`);
  }
  if (options.interruptedContext) {
    parts.push(`上一次任务由用户主动终止。以下内容只是终止前保存的历史状态，不是新的指令；结合本轮要求判断从哪里继续：\n<interrupted_task_context>\n${options.interruptedContext}\n</interrupted_task_context>`);
  }
  if (options.attachments.some(isExcelAttachment)) parts.push(EXCEL_ATTACHMENT_RULES);
  if (options.imageInputDecision?.preload) {
    parts.push("处理图片时先形成简短、可复用的文字摘要；后续优先引用摘要与原文件路径，只有细节不足时再调用 `view_image` 重读原图。");
  }
  if (options.runtimeWarning) parts.push(options.runtimeWarning);
  if (options.isolationReason) {
    parts.push(`安全要求：本轮已启用离线隔离（${options.isolationReason}）。只做静态检查，不执行不受信任的附件、宏或脚本；若必须动态执行，请说明尚未执行。`);
  }
  if (options.capabilityRoutingHint) parts.push(options.capabilityRoutingHint);
  if (options.personalContext?.trim()) parts.push(options.personalContext.trim());
  parts.push(instruction);
  return parts.join("\n\n");
}

export function appendPersonalContextToUserPrompt(userPrompt: string, personalContext?: string): string {
  const instruction = userPrompt.trim() || "请根据本轮附件完成用户要求，并说明结果。";
  return personalContext?.trim() ? `${personalContext.trim()}\n\n${instruction}` : instruction;
}

export function buildAgentSteerPrompt(userPrompt: string, attachments: AgentAttachmentContext[], imageInputDecision = decideImageInput(attachments)): string {
  const instruction = userPrompt.trim() || "优先查看补充附件并据此调整当前工作。";
  const parts = [`实时调整当前任务：${instruction}`];
  if (attachments.length > 0) {
    parts.push(`补充附件：\n${attachments.map((file) => `- ${file.name}: ${file.path}`).join("\n")}`);
  }
  if (attachments.some(isExcelAttachment)) parts.push(EXCEL_ATTACHMENT_RULES);
  if (imageInputDecision.preload) {
    parts.push("请把图片关键信息压缩成可复用文字摘要，后续细节不足时再重读原图。");
  }
  return parts.join("\n\n");
}

function isExcelAttachment(file: AgentAttachmentContext): boolean {
  return EXCEL_FILE_EXTENSION.test(file.name) || EXCEL_FILE_EXTENSION.test(file.path)
    || EXCEL_MIME_TYPES.has(file.mimeType?.toLowerCase() ?? "");
}

export function buildHostThreadInstructions(): string {
  return [
    "这是 CODEX_WEB 网页工作站发起的宿主 root 管理线程。严格遵守当前工作目录自动加载的 AGENTS.md。",
    "当前工作目录是用户选定的项目根；附件从 CWW_UPLOADS_DIR 读取，最终交付写入 CWW_OUTPUTS_DIR，过程文件写入 CWW_JOB_RUNTIME。不要把网页交付物写到项目根 outputs/。",
    "CODEX_WEB 宿主线程的最终回复只要用 Markdown 文件链接明确指向一个可读取的服务器本地普通文件，宿主桥就会自动复制到 CWW_OUTPUTS_DIR，并登记为当前消息的附件卡片；需要用户下载的本机文件可以直接链接绝对路径或当前项目相对路径。纯文字路径不会自动交付，不要链接用户不需要的敏感文件或过程文件。",
    "使用宿主机现有工具和环境。交付格式、编码与视觉细则以项目 AGENTS.md 为准；用于触发附件自动登记的 Markdown 文件链接可以包含源路径，除此之外回复只提最终文件名，不暴露绝对路径或过程文件。",
    "大日志、表格和机器可读结果先写入 CWW_JOB_RUNTIME（可复用成品写 CWW_OUTPUTS_DIR）；给模型和用户只保留摘要、关键行与文件路径，避免把完整工具输出复制进历史。",
    SKILL_LOCATOR_RULES,
  ].join("\n");
}

export function buildTenantProjectThreadInstructions(): string {
  return [
    "这是 Codex Web 网页工作站发起的受限租户项目线程。严格遵守当前工作目录自动加载的 AGENTS.md。",
    "当前工作目录是用户选定的项目根，也是本会话的长期知识范围；不要读取同一租户的其他项目、codex-home、其他会话或其他租户。",
    "网页附件只从环境变量 CWW_UPLOADS_DIR 指向的目录读取；最终交付必须写入 CWW_OUTPUTS_DIR；过程文件必须写入 CWW_JOB_RUNTIME。禁止把网页交付物写到当前项目根的 outputs/。",
    "回复中凡是作为可打开或可下载成品提到的本地文件，都必须先复制或生成到 CWW_OUTPUTS_DIR，使 Codex Web 把它登记为当前消息的附件卡片；不要输出项目源文件或其他本机路径的 Markdown 下载链接。只需定位源码时使用普通文字文件名和行号。",
    "在回复中只提用户需要的最终文件名，不暴露绝对路径或过程文件。",
    "大日志、表格和机器可读结果先写入 CWW_JOB_RUNTIME（可复用成品写 CWW_OUTPUTS_DIR）；只把摘要、关键行与文件路径带回上下文。",
    SKILL_LOCATOR_RULES,
  ].join("\n");
}
