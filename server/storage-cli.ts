#!/usr/bin/env node
import fs from 'node:fs';
import {callStorageTool} from './storage-tool.js';
async function main(){
 const request=process.argv[2];if(!request || request==='--help'){process.stdout.write('Usage: node "$CODEX_WEB_STORAGE_CLI" request.json\nStart with {"action":"context"}. Credentials come from this task environment.\n');return;}
 const baseUrl=process.env.CODEX_WEB_AUTOMATION_BASE_URL,token=process.env.CODEX_WEB_AUTOMATION_TOKEN,jobId=process.env.CODEX_WEB_AUTOMATION_JOB_ID;
 if(!baseUrl || !token || !jobId)throw new Error('当前任务没有文件恢复接口。');
 process.stdout.write(await callStorageTool({baseUrl,token,jobId,receiptDirectory:''},JSON.parse(fs.readFileSync(request,'utf8')))+'\n');
}
void main().catch(error=>{process.stderr.write((error instanceof Error?error.message:'文件恢复失败')+'\n');process.exitCode=1;});
