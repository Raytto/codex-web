import type { Project } from "./api";

export const HOST_EXECUTOR_ID = "local-host";
export const TENANT_LOCAL_EXECUTOR_ID = "tenant-local";

export type ConversationProjectDrag = {
  id: string;
  projectId: string;
  title: string;
  projectMoveBlocked: boolean;
};

export function conversationProjectMoveBlockReason(
  source: ConversationProjectDrag,
  target: Project,
  projects: Project[],
): string | null {
  if (source.projectId === target.id) return "任务已经在这个项目中。";
  const sourceProject = projects.find((project) => project.id === source.projectId);
  const supportedExecutor = sourceProject?.executor_id === HOST_EXECUTOR_ID
    || sourceProject?.executor_id === TENANT_LOCAL_EXECUTOR_ID;
  if (!sourceProject || !supportedExecutor || target.executor_id !== sourceProject.executor_id) {
    return "任务只能在同一个本地工作区的项目之间移动。";
  }
  if (source.projectMoveBlocked) return "会话仍在运行或有排队、待发送内容，暂时不能移动。";
  return null;
}
