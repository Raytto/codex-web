import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const PROJECT_AGENTS_TEMPLATE_SETTING = "project_agents_template_v1";

export const DEFAULT_PROJECT_AGENTS_TEMPLATE = `# Codex Web project rules

- Treat this directory as the project root. Read its existing documentation and configuration before changing files.
- Keep work scoped to this project unless the user explicitly asks for a server-wide action.
- Preserve existing user changes and unrelated files. Never run destructive commands against broad or unresolved paths.
- Never reveal passwords, tokens, private keys, cookies, browser profiles, or unrelated server data.
- Prefer fast, targeted searches with rg. Verify relevant builds, tests, and user-visible behavior before reporting completion.
- Conversation attachments and deliverable paths are provided separately by the platform; do not copy temporary runtime files into the project.
- Project-specific Codex skills, when present, live under .agents/skills/<skill-name>/SKILL.md; treat them as scoped instructions for this project only, not as account-wide skills.
- Reply in Chinese unless the user requests another language. Summarize concrete results and any remaining risks clearly.
`;

export type ProjectInstructionsResult = { created: boolean; ignored: boolean; path: string };

export function installProjectInstructions(projectRoot: string, template: string): ProjectInstructionsResult {
  if (!template.trim() || Buffer.byteLength(template, "utf8") > 64_000) throw new Error("项目规则模板无效");
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  let created = false;
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, template.endsWith("\n") ? template : `${template}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
    created = true;
  }

  const tracked = spawnSync("git", ["-C", projectRoot, "ls-files", "--error-unmatch", "--", "AGENTS.md"], { stdio: "ignore" }).status === 0;
  if (tracked) return { created, ignored: false, path: agentsPath };

  const gitPath = spawnSync("git", ["-C", projectRoot, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
  if (gitPath.status === 0 && gitPath.stdout.trim()) {
    const excludePath = path.resolve(projectRoot, gitPath.stdout.trim());
    appendIgnoreRule(excludePath, "/AGENTS.md");
    return { created, ignored: true, path: agentsPath };
  }
  appendIgnoreRule(path.join(projectRoot, ".gitignore"), "/AGENTS.md");
  return { created, ignored: true, path: agentsPath };
}

function appendIgnoreRule(filePath: string, rule: string): void {
  let existing = "";
  try { existing = fs.readFileSync(filePath, "utf8"); } catch {}
  if (existing.split(/\r?\n/).some((line) => line.trim() === rule)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(filePath, `${prefix}${rule}\n`, "utf8");
}
