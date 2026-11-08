import fs from 'node:fs';
import { platformAutomationConfig } from './platform-mcp.js';
import { callWorkflowTool } from './workflow-tool.js';
const args=process.argv.slice(2);
if(args[0]==='--help')console.log('Usage: node "$PPAGENT_WORKFLOW_CLI" status | --json <UTF-8 arguments file>. JSON: {action:"complete",revision:<from status>,evidence:{...}}. Never print credentials.');
else {
 const config=platformAutomationConfig();if(!config)throw new Error('This command must run inside the authorized active Job');
 const body=args[0]==='status'?{action:'status'}:args[0]==='--json'&&args[1]?JSON.parse(fs.readFileSync(args[1],'utf8')):null;
 if(!body)throw new Error('Use status or --json <file>');
 console.log(await callWorkflowTool(config,body));
}
