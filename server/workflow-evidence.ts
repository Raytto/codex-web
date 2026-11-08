import fs from "node:fs";
import path from "node:path";
import { validateCompletionEvidence } from "./workflow-store.js";
/** Host-only, configured allowlist. Never accepts arbitrary paths from the model. */
export function verifyWorkflowEvidence(raw: unknown, roots: Record<string,string> = JSON.parse(process.env.WORKFLOW_RELEASE_ROOTS_FILE ? fs.readFileSync(process.env.WORKFLOW_RELEASE_ROOTS_FILE,"utf8") : process.env.WORKFLOW_RELEASE_ROOTS || "{}")): void {
  const e=validateCompletionEvidence(raw);
  if(e.kind!=='deployment')return;
  for(const value of e.releases as unknown[]){
    const r=value as {instance?:string;requestId?:number;sha?:string};
    const root=roots[r.instance??''];
    if(!root || !Number.isSafeInteger(r.requestId) || Number(r.requestId)<1 || !/^[a-f0-9]{40}$/.test(r.sha??''))throw new Error('发布身份无效或实例未配置验收回执目录');
    const file=path.join(root,`${r.requestId}.json`);
    if(fs.lstatSync(file).isSymbolicLink())throw new Error('发布回执不能是符号链接');
    const receipt=JSON.parse(fs.readFileSync(file,'utf8')) as Record<string,unknown>;
    if(receipt.request!==r.requestId || receipt.target_sha!==r.sha || receipt.phase!=='cleaned' || !['accepted','repaired'].includes(String(receipt.outcome)))throw new Error('对应发布尚未完成验收及 cleaned 收尾');
    let accepted=receipt;
    const visited=new Set<unknown>();
    while(accepted.outcome==='repaired') {
      if(!Number.isSafeInteger(accepted.repaired_by) || visited.has(accepted.repaired_by) || visited.size>=20)throw new Error('补修回执缺少精确后继或形成循环');
      visited.add(accepted.repaired_by);
      accepted=JSON.parse(fs.readFileSync(path.join(root,`${accepted.repaired_by}.json`),'utf8')) as Record<string,unknown>;
      if(accepted.phase!=='cleaned')throw new Error('补修链尚未完成验收收尾');
    }
    if(accepted.outcome!=='accepted')throw new Error('补修终点未通过验收');
    const checks=accepted.evidence as Record<string,unknown>|undefined;
    if(!checks || checks.baseline_ok!==true || checks.functional_ok!==true || checks.session_revoked!==true || checks.cookie_rejected!==true)throw new Error('发布回执缺少真实验收及短期会话撤销证据');
  }
}
