import { engineForModel } from "./agent-engine.js";

/** Google profiles are independent of Codex credentials and Codex processes. */
export function assertGeminiAccountChangeAllowed(input: {
  maintenance?: boolean;
  activeModels?: Iterable<string | null | undefined>;
  runningGeminiJobs?: number;
}): void {
  if (input.maintenance) throw new Error("节点正在停止或升级，暂不能管理 Gemini 账号。");
  if ((input.runningGeminiJobs ?? 0) > 0
    || [...(input.activeModels ?? [])].some(model => engineForModel(model) === "antigravity")) {
    throw new Error("目标机器仍有 Gemini 任务执行，请任务结束后启用或删除 Gemini 账号。");
  }
}
