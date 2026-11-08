import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { HostRootWorkerClient } from '../server/host-root-worker-client.js';
import { ExecutionUncertainError } from '../server/execution-ownership.js';
import type { HostRootRunRequest } from '../server/host-root-protocol.js';

test('a real host socket loss reports unverified execution, distinct from acknowledged exit',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-socket-'));
 const socketPath=path.join(root,'s');const peers:net.Socket[]=[];
 const server=net.createServer(socket=>{peers.push(socket);socket.once('data',()=>socket.destroy());});
 server.listen(socketPath);await once(server,'listening');
 t.after(async()=>{for(const p of peers)p.destroy();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});});
 const client=new HostRootWorkerClient(socketPath);
 await assert.rejects(client.run({jobId:'test-job'} as HostRootRunRequest,{onThreadStarted(){},onProgress(){},onContextUsage(){},onQuotaUsage(){}}),ExecutionUncertainError);
});
