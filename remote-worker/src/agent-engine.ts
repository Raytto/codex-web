/** Stable platform model identity; the namespace travels with jobs and schedules. */
export type AgentEngineId = "codex" | "antigravity";
export const ANTIGRAVITY_MODEL_PREFIX = "antigravity:";
export function engineForModel(model: string | null | undefined): AgentEngineId {
  return model?.startsWith(ANTIGRAVITY_MODEL_PREFIX) ? "antigravity" : "codex";
}
export function rawAntigravityModel(model: string): string {
  if (engineForModel(model) !== "antigravity") throw new Error("所选模型不属于 Gemini 执行引擎。");
  const raw = model.slice(ANTIGRAVITY_MODEL_PREFIX.length);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(raw)) throw new Error("Gemini 模型标识无效。");
  return raw;
}
