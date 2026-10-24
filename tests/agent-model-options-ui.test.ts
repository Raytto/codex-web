import assert from "node:assert/strict";
import test from "node:test";
import { canRunPendingPromptImmediately, modelMenuOptions, modelReasoningOptions, pendingPromptActionMode, reasoningForModel } from "../src/agent-model-options.js";
import type { AgentOptions } from "../src/api.js";

const options: AgentOptions = {
  models: [
    { id: "codex-model", label: "Codex model", description: "", reasoningEfforts: ["low", "high", "ultra"] },
    { id: "codex-other", label: "Codex other", description: "", reasoningEfforts: ["low", "high"] },
    { id: "antigravity:gemini", label: "Gemini", engineId: "antigravity", description: "", reasoningEfforts: ["automatic", "low", "high"], defaultReasoningEffort: "automatic", reasoningEffortOptions: [{ id: "automatic", label: "自动" }, { id: "low", label: "Gemini 快速思考" }, { id: "high", label: "Gemini 深度思考" }] },
  ],
  reasoningEfforts: [{ id: "low", label: "低" }, { id: "high", label: "高" }, { id: "ultra", label: "极高" }],
  defaults: { model: "codex-model", reasoningEffort: "high" },
  selection: { model: "codex-model", reasoningEffort: "high" },
};

test("reasoning options preserve model-specific ids, order and labels without a shared intensity scale", () => {
  assert.deepEqual(modelReasoningOptions(options, "antigravity:gemini"), [
    { id: "automatic", label: "自动" }, { id: "low", label: "Gemini 快速思考" }, { id: "high", label: "Gemini 深度思考" },
  ]);
  assert.deepEqual(modelReasoningOptions(options, "codex-model"), options.reasoningEfforts);
  assert.deepEqual(modelReasoningOptions(options, "removed-model"), []);
  assert.deepEqual(modelReasoningOptions(undefined, "codex-model"), []);
});

test("changing engines applies that model's default without transferring a same-named Codex intensity", () => {
  assert.equal(reasoningForModel(options, "antigravity:gemini", "codex-model", "high"), "automatic");
  assert.equal(reasoningForModel(options, "codex-model", "antigravity:gemini", "low"), "high");
  assert.equal(reasoningForModel(options, "codex-other", "codex-model", "low"), "low");
  assert.equal(reasoningForModel(options, "codex-other", "codex-model", "ultra"), "high");
  assert.equal(reasoningForModel(options, "missing", "codex-model", "low"), "");
});

test("catalog visibility controls model choices and Codex-only menus keep their previous labels", () => {
  const codexOnly = { ...options, models: options.models.filter((model) => !model.id.startsWith("antigravity:")) };
  assert.ok(modelMenuOptions(codexOnly).every((model) => model.group === undefined && model.description === ""));
  assert.deepEqual(modelMenuOptions(options).map((model) => model.group), ["Codex", "Codex", "Antigravity"]);
  assert.deepEqual(modelMenuOptions(null), []);
});

test("running requests never accept a queued prompt for a different model or engine", () => {
  const codexJob = { status: "running", agent_model: "codex-model" };
  assert.equal(pendingPromptActionMode(codexJob, "codex-model"), "steer");
  assert.equal(pendingPromptActionMode(codexJob, "codex-other"), "queue");
  assert.equal(pendingPromptActionMode(codexJob, "antigravity:gemini"), "queue");
  assert.equal(pendingPromptActionMode({ status: "running", agent_model: "antigravity:gemini" }, "antigravity:gemini"), "queue");
  assert.equal(canRunPendingPromptImmediately("steer", "codex-model", "codex-model"), true);
  assert.equal(canRunPendingPromptImmediately("steer", "codex-other", "codex-model"), false);
  assert.equal(canRunPendingPromptImmediately("steer", "antigravity:gemini", "codex-model"), false);
  assert.equal(canRunPendingPromptImmediately("queue", "codex-model", "codex-model"), false);
  assert.equal(canRunPendingPromptImmediately("insert", "antigravity:gemini"), true);
  assert.equal(pendingPromptActionMode(null, "antigravity:gemini"), "insert");
  assert.equal(pendingPromptActionMode({ status: "running" }, "codex-model"), "steer");
});
