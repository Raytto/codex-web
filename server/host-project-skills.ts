import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOST_ROOT_USER_ID } from "./host-root-user.js";
import { HOST_EXECUTOR_ID } from "./remote-worker-protocol.js";
import { operateProjectSkill, type ProjectSkillAction } from "./project-skills.js";

// The bridge resolves the root from its own read-only database, never from an
// HTTP-supplied filesystem path. This check is independent of the Web owner check.
export function operateHostProjectSkill(databasePath: string, userId: string, projectId: string, action: ProjectSkillAction, name?: string, content?: string, enabled = true) {
  if (userId !== HOST_ROOT_USER_ID) throw new Error("This account is not allowed to manage host project skills");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let root: string;
  try {
    const project = db.prepare("SELECT root_path FROM projects WHERE id=? AND user_id=? AND executor_id=? AND archived_at IS NULL").get(projectId, userId, HOST_EXECUTOR_ID) as { root_path: string } | undefined;
    if (!project || !path.isAbsolute(project.root_path)) throw new Error("项目不存在或不属于宿主执行器。");
    root = fs.realpathSync(project.root_path);
  } finally { db.close(); }
  return operateProjectSkill(root, action, name, content, enabled);
}
