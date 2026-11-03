import type { AgentModelOption, AgentOptions, ReasoningEffort } from "./api";
import { liveSteeringUnavailableReason } from "./agent-steering-capability";

export function modelEngine(model: AgentModelOption): string {
  return model.engineId ?? (model.id.startsWith("antigravity:") ? "antigravity" : "codex");
}

export function modelReasoningOptions(options: AgentOptions | null | undefined, modelId: string) {
  const model = options?.models.find((candidate) => candidate.id === modelId);
  if (!model) return [];
  return model.reasoningEfforts.map((id) => ({
    id,
    label: model.reasoningEffortOptions?.find((effort) => effort.id === id)?.label
      ?? options?.reasoningEfforts.find((effort) => effort.id === id)?.label
      ?? id,
  }));
}

export function reasoningForModel(options: AgentOptions, modelId: string, previousModelId: string, previousEffort: ReasoningEffort): ReasoningEffort {
  const model = options.models.find((candidate) => candidate.id === modelId);
  const previous = options.models.find((candidate) => candidate.id === previousModelId);
  if (!model) return "";
  if (previous && modelEngine(previous) === modelEngine(model) && model.reasoningEfforts.includes(previousEffort)) return previousEffort;
  if (model.defaultReasoningEffort && model.reasoningEfforts.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort;
  const defaultModel = options.models.find((candidate) => candidate.id === options.defaults.model);
  if ((!defaultModel || modelEngine(defaultModel) === modelEngine(model)) && model.reasoningEfforts.includes(options.defaults.reasoningEffort)) return options.defaults.reasoningEffort;
  return (modelEngine(model) === "codex" ? model.reasoningEfforts.at(-1) : model.reasoningEfforts[0]) ?? "";
}

export function modelMenuOptions(options: AgentOptions | null | undefined) {
  const models = options?.models ?? [];
  const mixed = new Set(models.map(modelEngine)).size > 1;
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    description: [mixed ? model.providerLabel ?? (modelEngine(model) === "antigravity" ? "Antigravity" : "Codex") : "", model.description].filter(Boolean).join(" · "),
    group: mixed ? model.providerLabel ?? (modelEngine(model) === "antigravity" ? "Antigravity" : "Codex") : undefined,
  }));
}

export function pendingPromptActionMode(job: { status: string; agent_model?: string; reasoning_effort?: string } | null | undefined, selectedModel: string, selectedEffort = job?.reasoning_effort): "insert" | "steer" | "queue" {
  if (job?.status !== "running") return "insert";
  if (liveSteeringUnavailableReason(job, { agent_model: selectedModel, reasoning_effort: selectedEffort })) return "queue";
  return "steer";
}

export function canRunPendingPromptImmediately(actionMode: "insert" | "steer" | "queue", promptModel: string, runningModel?: string, promptEffort?: string, runningEffort?: string): boolean {
  return actionMode === "insert" || (actionMode === "steer" && !liveSteeringUnavailableReason(
    { agent_model: runningModel, reasoning_effort: runningEffort }, { agent_model: promptModel, reasoning_effort: promptEffort },
  ));
}

export function hasMultipleEngines(options: AgentOptions | null | undefined): boolean {
  return new Set(options?.models.map(modelEngine)).size > 1;
}
