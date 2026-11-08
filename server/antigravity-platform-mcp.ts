import {STORAGE_TOOL_SPEC,callStorageTool} from './storage-tool.js';
import { platformAutomationConfig, runPlatformMcpServer, workerPlatformTools } from "../remote-worker/src/platform-mcp.js";
import { JUDGMENT_TOOL_SPEC, callJudgmentTool } from "./judgment-tool.js";
import { OPPORTUNITY_TOOL_SPEC, callOpportunityTool } from "./opportunity-tool.js";

const config = platformAutomationConfig();
const tools = workerPlatformTools(config);
if (config) {
  tools.push({...STORAGE_TOOL_SPEC,call:args=>callStorageTool(config,args)});
  tools.push({ ...JUDGMENT_TOOL_SPEC, call: (args) => callJudgmentTool(config, args) });
  tools.push({ ...OPPORTUNITY_TOOL_SPEC, call: (args) => callOpportunityTool(config, args) });
}
runPlatformMcpServer(tools);
