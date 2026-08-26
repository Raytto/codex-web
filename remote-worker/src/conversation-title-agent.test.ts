import assert from "node:assert/strict";
import test from "node:test";
import { conversationTitleAgentArguments, TITLE_AGENT_MODEL, TITLE_AGENT_REASONING_EFFORT } from "./conversation-title-agent.js";

test("remote conversation title agent is ephemeral Luna low with no tools or history", () => {
  const args = conversationTitleAgentArguments("schema.json", "output.json");
  assert.equal(TITLE_AGENT_MODEL, "gpt-5.6-luna");
  assert.equal(TITLE_AGENT_REASONING_EFFORT, "low");
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(args.includes('history.persistence="none"'));
  assert.ok(args.includes("tools.web_search=false"));
  assert.ok(args.includes("features.shell_tool=false"));
  assert.ok(args.includes("agents.enabled=false"));
  assert.ok(args.includes("--output-schema"));
});
