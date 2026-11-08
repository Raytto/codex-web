import type {WaitDynamicToolConfig} from './wait-dynamic-tool.js';
export const STORAGE_TOOL_NAME='pp_agent_storage';
export const STORAGE_TOOL_SPEC={type:'function' as const,name:STORAGE_TOOL_NAME,
 description:'Find and restore this account’s cold files. Read context, then list or lookup. Directory entries are metadata, not original contents. Restore the exact item before shell/native path reading; if restoring, retry after the returned delay. Never recreate a missing original or treat a storage index as its contents.',
 inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['context','list','lookup','restore','events','native']},id:{type:'string'},query:{type:'string'},root:{type:'string'},path:{type:'string'},after:{type:'string'},
  jobId:{type:'string'},afterSeq:{type:'integer'},limit:{type:'integer'},batchId:{type:'string'},offsetBytes:{type:'integer'}}}};
export async function callStorageTool(config:WaitDynamicToolConfig,args:unknown):Promise<string>{
 const response=await fetch(`${config.baseUrl.replace(/\/$/,'')}/api/automation/jobs/${encodeURIComponent(config.jobId)}/storage`,{
  method:'POST',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(30_000)});
 const result=await response.json() as Record<string,unknown>;
 if(!response.ok && response.status!==410)throw new Error(typeof result.error==='string'?result.error:`Storage request failed (${response.status})`);return JSON.stringify(result);
}
