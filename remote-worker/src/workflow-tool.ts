import type { WaitToolConfig } from "./wait-dynamic-tool.js";
export const WORKFLOW_TOOL_NAME = "pp_agent_workflow";
export const WORKFLOW_TOOL_SPEC = {
  type: "function" as const, name: WORKFLOW_TOOL_NAME,
  description: "Manage the durable complete task across turns, waits and deployments. Call status for its revision and completion schema. phase/block retain ownership. complete requires verified evidence, no pending work, and releases only after this execution exits. Never mark incomplete work complete or use another task identity.",
  inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
    action: {type:"string",enum:["status","phase","block","complete"]},
    phase: {type:"string",maxLength:300}, revision: {type:"integer",minimum:1},
    evidence: {type:"object",additionalProperties:true},
  } },
};
export async function callWorkflowTool(config: WaitToolConfig, args: unknown): Promise<string> {
  const response=await fetch(`${config.baseUrl.replace(/\/$/,"")}/api/automation/jobs/${encodeURIComponent(config.jobId)}/workflow`,{
    method:"POST",headers:{authorization:`Bearer ${config.token}`,"content-type":"application/json"},body:JSON.stringify(args),signal:AbortSignal.timeout(30000),
  });
  const data=await response.json() as {error?:string};if(!response.ok)throw new Error(data.error||`Workflow request failed (${response.status})`);
  return JSON.stringify(data);
}
