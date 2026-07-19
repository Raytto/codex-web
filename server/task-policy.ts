import path from "node:path";
import type { FileRow } from "./db.js";

const RISKY_EXTENSIONS = new Set([
  ".apk", ".bat", ".cmd", ".com", ".dll", ".docm", ".exe", ".hta", ".iso", ".jar",
  ".js", ".jse", ".lnk", ".msi", ".pptm", ".ps1", ".reg", ".scr", ".vbe", ".vbs", ".xlsm",
]);

const RISK_PATTERNS = [
  /(?:malware|ransomware|trojan|payload|untrusted\s+(?:code|script|binary)|suspicious\s+(?:file|binary))/i,
  /(?:恶意软件|勒索软件|木马|病毒样本|可疑文件|未知程序|不受信任的(?:代码|脚本|程序))/,
  /(?:运行|执行|打开).{0,12}(?:未知|可疑|不受信任).{0,8}(?:程序|文件|脚本|代码)/,
];

export type TaskPolicy = {
  isolated: boolean;
  networkAccessEnabled: boolean;
  reason?: string;
};

export function assessTaskPolicy(prompt: string, uploads: Pick<FileRow, "original_name">[]): TaskPolicy {
  const riskyUpload = uploads.find((file) => RISKY_EXTENSIONS.has(path.extname(file.original_name).toLowerCase()));
  if (riskyUpload) return { isolated: true, networkAccessEnabled: false, reason: `可执行或含宏附件：${riskyUpload.original_name}` };
  if (RISK_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return { isolated: true, networkAccessEnabled: false, reason: "任务描述包含高风险执行意图" };
  }
  return { isolated: false, networkAccessEnabled: true };
}
