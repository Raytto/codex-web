import type { Conversation } from "./api";

type WaitingConversation = Pick<Conversation, "status" | "external_status" | "workflow_state" | "has_pending_work" | "active_wake_count">;

export function conversationWaitingLabel(conversation: WaitingConversation, maintenancePhase = "idle"): string | null {
  if (conversation.status === "running" || conversation.external_status === "running") return null;
  switch (conversation.workflow_state) {
    case "queued": return "正在排队";
    case "blocked": return "等待处理";
    case "closing": return "正在收尾";
    case "active": return "等待续跑或验收";
  }
  if (conversation.has_pending_work && !conversation.active_wake_count) {
    return maintenancePhase === "idle" ? "等待发送" : "等待维护结束后发送";
  }
  return null;
}
