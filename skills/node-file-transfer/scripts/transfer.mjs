#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--request-file'){console.error('Usage: node transfer.mjs --request-file request.json');process.exit(2);}
try{
 const v=JSON.parse(fs.readFileSync(args[1],'utf8').replace(/^\uFEFF/,''));
 const action=v.action;if(!['nodes','create','list','get','cancel'].includes(action))throw new Error('Invalid action');
 const env=name=>{const value=process.env[name];if(!value)throw new Error(`当前回合没有 ${name}，请使用 Codex Web 发起的任务`);return value;};
 const base=env('PPAGENT_AUTOMATION_BASE_URL').replace(/\/$/,''),job=env('PPAGENT_AUTOMATION_JOB_ID'),token=env('PPAGENT_AUTOMATION_TOKEN');
 let suffix=action==='nodes'?'/nodes':'',method='GET',body;
 if(['get','cancel'].includes(action)){if(!/^[a-f0-9-]{36}$/.test(v.id))throw new Error('Invalid id');suffix=`/${v.id}`;}
 if(action==='cancel'){method='POST';suffix+='/cancel';body={};}
 if(action==='create'){method='POST';const {action:_,...request}=v;body=request;}
 const res=await fetch(`${base}/api/automation/jobs/${encodeURIComponent(job)}/transfers${suffix}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30_000)});
 const result=await res.json();if(!res.ok)throw new Error(result.error||`Request failed (${res.status})`);console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
