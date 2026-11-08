import type { WaitDynamicToolConfig } from './wait-dynamic-tool.js';
export const DOT_TOOL_NAME = 'pp_dot';
export const DOT_TOOL_SPEC = { type: 'function' as const, name: DOT_TOOL_NAME, description: 'PP Dot coordinator only: context first for schemas and exact project/executor IDs. Create/check/correct/cancel delegated jobs; maintain source-linked memory with revision and requestKey. Executors cannot overwrite coordinator memory. Actual job state is authoritative. Never send secrets or raw logs.', inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['context', 'search', 'task_list', 'task_detail', 'task_create', 'task_steer', 'task_review', 'task_cancel', 'memory_put', 'memory_forget', 'checkpoint'] }, id: { type: 'string' }, data: { type: 'object', additionalProperties: true } } } };
export async function callDotTool(config: WaitDynamicToolConfig, args: unknown) { const r = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api/automation/jobs/${encodeURIComponent(config.jobId)}/dot`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(30000) }); const body = await r.json() as {
    error?: string;
}; if (!r.ok)
    throw Error(body.error ?? 'PP Dot 操作失败'); return JSON.stringify(body); }
