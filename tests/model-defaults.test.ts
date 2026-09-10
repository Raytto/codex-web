import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../server/config.js";
import { agentOptionsFromAppServer, loadAgentOptions, repairAgentSelection, withPreferredAgentDefaults } from "../server/model-options.js";

test("Astra/high overrides runtime defaults but preserves explicit selections", () => {
  const options = agentOptionsFromAppServer({ data: [
    { model: "gpt-5.6-sol", isDefault: true, defaultReasoningEffort: "xhigh", supportedReasoningEfforts: ["high", "xhigh"] },
    { model: "gpt-6-astra", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  ] })!;
  assert.deepEqual(options.defaults, { model: "gpt-6-astra", reasoningEffort: "high" });
  assert.deepEqual(repairAgentSelection(options, "gpt-5.6-sol", "xhigh"), { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  const persisted = { ...options, defaults: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" as const } };
  assert.deepEqual(withPreferredAgentDefaults(persisted).defaults, options.defaults);
  assert.equal(persisted.defaults.model, "gpt-5.6-sol");
  assert.deepEqual(options.models[1].reasoningEfforts.slice(-2), ["max", "ultra"]);
});

test("cached and missing catalogs default to Astra/high without inventing live capabilities", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-astra-defaults-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({ codexHome: root });
  assert.deepEqual(loadAgentOptions(config).defaults, { model: "gpt-6-astra", reasoningEffort: "high" });
  const models = ["gpt-5.6-sol", "gpt-6-astra"].map((slug, priority) => ({
    slug, priority, visibility: "list", input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }],
  }));
  fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({ models }));
  assert.deepEqual(loadAgentOptions(config).defaults, { model: "gpt-6-astra", reasoningEffort: "high" });
  const limited = agentOptionsFromAppServer({ data: [{ model: "remote-only", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] }] })!;
  assert.deepEqual(limited.defaults, { model: "remote-only", reasoningEffort: "medium" });
  assert.equal(limited.models.length, 1);
});
