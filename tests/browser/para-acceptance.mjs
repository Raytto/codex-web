// Compatibility entry for older maintenance invocations. The personal board
// supersedes the original four-stage PARA scenario.
import { run as lifecycle } from "./personal-kanban.mjs";
import { run as agent } from "./personal-kanban-agent.mjs";
export async function run(args) {
  await lifecycle(args);
  if (process.env.CODEX_WEB_BROWSER_MODEL_PROBE === "true") await agent(args);
}
