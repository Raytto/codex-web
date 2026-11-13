type Parameters = Record<string, unknown>;
export type AntigravityToolProgress = { kind: "tool" | "search" | "command" | "file"; label: string; detail?: string; files?: string[] };

export const ANTIGRAVITY_PROGRESS_INSTRUCTIONS = [
  "运行进度：需要调用工具时，先用用户的语言（默认中文）给出一句简短的公开工作说明，说明接下来做什么及目的，再调用工具。",
  "多步骤任务在取得关键结果或改变方向时继续简短反馈，说明已确认的事实与下一步；不要逐个工具重复报幕。",
  "工作说明写在工具调用前的普通回复中，不要只放在思考中，也不要等到最终答案才汇总。仅说明工作进度，不输出内部逐步推理，不编造结果。",
].join("\n");

/** Only display selected call metadata, never the tool output or arbitrary arguments. */
export function antigravityToolProgress(name: string, parameters: Parameters, done: boolean, failed: boolean): AntigravityToolProgress {
  const value = (...keys: string[]) => {
    for (const key of keys) if (typeof parameters[key] === "string" && parameters[key].trim()) return parameters[key] as string;
    return "";
  };
  const label = (active: string, completed: string, failure: string) => failed ? failure : done ? completed : active;
  const file = () => safeProgressText(value("Path", "AbsolutePath", "TargetFile", "FilePath", "file_path", "path", "filename").split(/[\\/]/).at(-1) ?? "");
  if (name === "search_web") return {
    kind: "search", label: label("正在搜索网页", "网页搜索完成", "网页搜索失败"),
    detail: safeProgressText(value("query", "Query", "SearchQuery", "search_query")),
  };
  if (["read_file", "view_file", "view_file_outline", "view_code_item"].includes(name)) return {
    kind: "tool", label: label("正在读取文件", "文件读取完成", "文件读取失败"), detail: file(),
  };
  if (["read_url_content", "read_url", "fetch_url", "view_web_document"].includes(name)) return {
    kind: "tool", label: label("正在阅读网页", "网页阅读完成", "网页阅读失败"),
    detail: safeProgressText(value("Url", "URL", "url", "DocumentId")),
  };
  if (["grep_search", "find_by_name", "list_dir", "search_in_file"].includes(name)) return {
    kind: "search", label: label(name === "list_dir" ? "正在查看目录" : "正在查找项目文件", "项目文件查找完成", "项目文件查找失败"),
    detail: safeProgressText(value("Query", "query", "Pattern", "pattern")) || file(),
  };
  if (name === "run_command") return {
    kind: "command", label: label("正在执行本机处理步骤", "本机处理步骤完成", "本机处理步骤失败"),
    detail: safeProgressText(value("CommandLine", "command"), 1000),
  };
  if (["write_to_file", "replace_file_content", "multi_replace_file_content"].includes(name)) return {
    kind: "file", label: label("正在更新文件", "已更新文件", "文件更新失败"), files: file() ? [file()] : [],
  };
  if (name === "call_mcp_tool") {
    const tool = value("ToolName", "tool_name", "name");
    return { kind: "tool", label: label("正在调用扩展工具", "扩展工具调用完成", "扩展工具调用失败"), detail: safeProgressText(tool) };
  }
  return { kind: "tool", label: label("正在调用工具", "工具调用完成", "工具调用失败"), detail: safeProgressText(name) };
}

function safeProgressText(value: string, limit = 240): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return "[网页链接]"; }
  }).replace(/((?:password|passwd|token|cookie|secret|api[ _-]?key|authorization|bearer|密码|口令|私钥|验证码)["']?\s*(?:[=:：]\s*|\s+))["']?[^\s,;"']+/gi, "$1[已隐藏]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{16,}|[A-Za-z0-9_-]{48,})\b/g, "[已隐藏]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}
