/** Local operator interface. No network or second ownership database. */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore } from './workflow-store.js';
import { verifyWorkflowEvidence } from './workflow-evidence.js';
const [command,...rest]=process.argv.slice(2);
const args:Record<string,string>={};for(let i=0;i<rest.length;i+=2){if(!rest[i]?.startsWith('--') || rest[i+1]===undefined)throw new Error('Use --key value');args[rest[i].slice(2)]=rest[i+1];}
if(!args.database)throw new Error('--database is required');
const db=new DatabaseSync(args.database,{readOnly:command==='status'});
if(command==='bootstrap') {db.exec('BEGIN IMMEDIATE');try{
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflows'").get())throw new Error('Bootstrap cannot replace an installed ledger');
 WorkflowStore.migrate(db);db.exec('COMMIT');
}catch(e){db.exec('ROLLBACK');throw e;}}
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
const store=new WorkflowStore(db);
try{
 let result:unknown;
 if(command==='bootstrap'){
   if(!args.capacity)throw new Error('Bootstrap needs explicit capacity');store.configure(Number(args.capacity));
   if(!args.user)throw new Error("Bootstrap requires explicit --user ID");
   const user=db.prepare("SELECT id FROM users WHERE id=?").get(args.user) as {id:string}|undefined;if(!user)throw new Error("User missing");
   result=store.external(args.key,user.id,args.title||'外部维护');
 } else if(command==='status') result=args.id?{...store.get(args.id),recovery:store.recoveryStatus(args.id)}:{capacity:store.capacity(),workflows:store.list().map(w=>({...w,recovery:store.recoveryStatus(w.id)}))};
 else if(command==='enqueue') {
   if(!args.key || !args.title || !args.user)throw new Error('--key --title --user required');
   result=store.external(args.key,args.user,args.title);
 } else if(command==='assert') {
   const w=store.get(args.id);if(!w || w.state!=='active')throw new Error('维护名额尚未获准或已经结束');result={ok:true,id:w.id,revision:w.revision,epoch:w.epoch};
 } else if(command==='bind') {
   const w=store.get(args.id);const c=db.prepare('SELECT user_id FROM conversations WHERE id=?').get(args.conversation) as {user_id:string}|undefined;
   if(!w || w.state!=='active' || !w.source_key || !c || c.user_id!==w.user_id)throw new Error('Only active external owner can attach an empty acceptance conversation');
   if(db.prepare('SELECT 1 FROM jobs WHERE conversation_id=?').get(args.conversation)||db.prepare('SELECT 1 FROM pending_prompts WHERE conversation_id=?').get(args.conversation))throw new Error('Conversation already contains work');
   db.prepare('INSERT INTO workflow_conversations VALUES(?,?)').run(args.conversation,w.id);result={bound:true};
 } else if(command==='prioritize') {
   result=store.prioritize(args.id,Number(args.priority),args.reason||'');
 } else if(command==='recover') {
   if(args['executors-stopped']!=='true')throw new Error('First verify actual processes, workers and background operations have exited');
   if(!args.revision || args['run-ids']===undefined)throw new Error('Use status, verify actual exits, then supply --revision and --run-ids (comma separated, empty for none)');
   store.recover(args.id,args.reason||'',{revision:Number(args.revision),runIds:args['run-ids'].split(',').filter(Boolean)});result=store.get(args.id);
 } else if(command==='complete'||command==='abort') {
   if(args['executors-stopped']!=='true')throw new Error('Explicit --executors-stopped true after verification is required');
   const evidence=JSON.parse(fs.readFileSync(args.evidence,'utf8'));verifyWorkflowEvidence(evidence);
   if(command==='abort' && evidence.kind!=='safe_abort')throw new Error('Abort requires safe_abort evidence and the user cancellation');
   result=store.closeExternal(args.id,Number(args.revision),evidence,command==='abort');
 } else throw new Error('Commands: status, enqueue, assert, bind, prioritize, recover, complete, abort, bootstrap');
 console.log(JSON.stringify(result));
}finally{db.close();}
