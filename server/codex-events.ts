import type { ThreadEvent } from "@openai/codex-sdk";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { isRetryableUpstreamError } from "./retry-policy.js";

export function redactBrandForDisplay(value: string): string {
  return value.replace(/chatgpt|codex/gi, "Codex Web");
}
export function summarizeEvent(event: ThreadEvent): unknown | null {
  if (event.type === "turn.started") return { kind: "status", label: "已开始分析" };
  if (event.type === "error") return isRetryableUpstreamError(event.message)
    ? { kind: "status", status: "retrying", label: "上游连接短暂中断，正在自动重试" }
    : { kind: "error", label: redactBrandForDisplay(event.message) };
  if (event.type === "turn.completed") return { kind: "status", label: "工作已完成，正在整理结果" };
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return null;
  const item = event.item;
  if (item.type === "reasoning") {
    const summary = redactBrandForDisplay(sanitizeAgentMarkdown(item.text)).trim();
    return summary ? { kind: "reasoning", label: "模型思路摘要", detail: summary } : null;
  }
  if (item.type === "command_execution") {
    const detail = redactBrandForDisplay(item.command);
    return { kind: "command", label: commandProgressLabel(item.command, item.status), detail };
  }
  if (item.type === "file_change") return { kind: "file", label: "已更新文件", files: item.changes.map((change) => change.path) };
  if (item.type === "web_search") return { kind: "search", label: "正在搜索资料", detail: item.query };
  if (item.type === "mcp_tool_call") return { kind: "tool", label: `正在使用 ${redactBrandForDisplay(item.server)}`, detail: redactBrandForDisplay(item.tool) };
  if (item.type === "todo_list") return { kind: "todo", label: "任务计划已更新", items: item.items };
  if (item.type === "error") return isRetryableUpstreamError(item.message)
    ? { kind: "status", status: "retrying", label: "上游连接短暂中断，正在自动重试" }
    : { kind: "error", label: redactBrandForDisplay(item.message) };
  if (item.type === "agent_message" && event.type === "item.completed") {
    const detail = redactBrandForDisplay(sanitizeAgentMarkdown(item.text)).trim();
    return detail ? { kind: "update", label: "阶段反馈", detail } : null;
  }
  return null;
}

function commandProgressLabel(command: string, status: "in_progress" | "completed" | "failed"): string {
  const running = status === "in_progress";
  if (status === "failed") return "本机步骤执行失败，正在调整";
  const presentationQa = /&\s+[^;\r\n]*(?:slides_test|create_montage|render_slides)\.(?:py|mjs)/i.test(command)
    || /run-python-task\.(?:ps1|sh)[^;\r\n]*(?:-Script|--script)\s+[^;\r\n]*(?:slides_test|create_montage|render_slides)\.(?:py|mjs)/i.test(command);
  if (presentationQa) return running ? "正在检查演示文稿质量" : "演示文稿质量检查完成";
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint)|\bpytest\b|\bnode\s+--test\b|\bslides_test\b/i.test(command)) return running ? "正在运行质量验证" : "质量验证完成";
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|\btsc\b|build[_-]?(?:ppt|doc|report)|render/i.test(command)) return running ? "正在生成或渲染结果" : "结果生成或渲染完成";
  if (/\b(?:rg|Select-String|Get-Content|type)\b/i.test(command)) return running ? "正在读取并核对资料" : "资料读取与核对完成";
  if (/\b(?:npm|pnpm|yarn|pip|uv)\s+(?:install|add|sync)\b/i.test(command)) return running ? "正在准备所需工具" : "所需工具准备完成";
  if (/\b(?:python|node)(?:\.exe)?\b|\.py\b|\.mjs\b/i.test(command)) return running ? "正在处理数据或生成内容" : "数据与内容处理完成";
  if (/\b(?:Get-ChildItem|Test-Path|git\s+(?:status|diff))\b/i.test(command)) return running ? "正在检查文件与工作区" : "文件与工作区检查完成";
  return running ? "正在执行本机处理步骤" : "本机处理步骤完成";
}
