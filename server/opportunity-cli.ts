#!/usr/bin/env node
import fs from 'node:fs';
import { callOpportunityTool } from './opportunity-tool.js';
async function main(){
 const file=process.argv[2];
 if(!file||file==='--help'){process.stdout.write('Usage: node "$CODEX_WEB_OPPORTUNITY_CLI" request.json\nJSON: {"action":"context","topicId":"UUID","data":{}}. Use topics to list; context returns action schemas. Server-project jobs only.\n');return;}
 const baseUrl=process.env.CODEX_WEB_AUTOMATION_BASE_URL,token=process.env.CODEX_WEB_AUTOMATION_TOKEN,jobId=process.env.CODEX_WEB_AUTOMATION_JOB_ID;
 if(!baseUrl||!token||!jobId)throw new Error('当前任务没有服务器机会接口凭据。');
 const args=JSON.parse(fs.readFileSync(file,'utf8'));
 process.stdout.write(await callOpportunityTool({baseUrl,token,jobId,receiptDirectory:''},args)+'\n');
}
void main().catch(e=>{process.stderr.write((e instanceof Error?e.message:'机会操作失败')+'\n');process.exitCode=1;});
