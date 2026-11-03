import { engineForModel } from "../remote-worker/src/agent-engine.js";

/** A live steer keeps the running turn's model and effort; it cannot switch either. */
export function liveSteeringUnavailableReason(running: { agent_model?: string | null; reasoning_effort?: string | null }, pending?: { agent_model: string; reasoning_effort?: string | null }): string | null {
  if (!running.agent_model) return "正在确认当前任务的模型，补充消息会保留在队列中。";
  if (engineForModel(running.agent_model) === "antigravity") return "Antigravity 不支持运行中引导；补充消息已保留在队列中，当前任务完成后发送。";
  if (pending && (pending.agent_model !== running.agent_model || pending.reasoning_effort !== running.reasoning_effort)) return "模型或思考深度与当前任务不同；补充消息会保留在队列中，按所选配置执行。";
  return null;
}
