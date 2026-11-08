import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { loadPublicInstanceConfig } from '../server/instance-config.js';

test('instance metadata is public, narrowly filtered, and HTML routes share runtime identity', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'instance-http-'));
  fs.mkdirSync(path.join(root,'dist'));
  fs.writeFileSync(path.join(root,'dist/index.html'),'<html><head><!--instance-config--><title>build default</title><script src="/assets/app.js"></script></head></html>');
  const instance=loadPublicInstanceConfig({APP_PRODUCT_NAME:'Configured workstation',BASE_PATH:'/codex-web'});
  const runtime=createApp({projectRoot:root,dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),basePath:instance.basePath,instance,sessionSecret:'s'.repeat(40),queueAutoStart:false,hostKnowledgeRoot:path.join(root,'workspaces'),hostRootSocketPath:path.join(root,'no-bridge.sock')});
  try {
    const response=await request(runtime.app).get('/codex-web/api/instance').expect(200);
    assert.deepEqual(response.body,instance); assert.equal(response.headers['cache-control'],'no-store');
    for(const url of ['/codex-web/','/codex-web/index.html','/codex-web/files/id/preview']) {
      const html=await request(runtime.app).get(url).set('Accept','text/html').expect(200);
      assert.ok(html.text.includes('<title>Configured workstation</title>'));
      assert.ok(html.text.includes('/codex-web/assets/app.js'));
      assert.ok(!html.text.includes('s'.repeat(40)));
      assert.equal(html.headers['cache-control'],'no-store');
    }
    await request(runtime.app).get('/codex-web/api/projects').expect(401);
  } finally { runtime.beginShutdown(); await runtime.waitForBackgroundTasks(); runtime.db.close(); fs.rmSync(root,{recursive:true,force:true}); }
});
test('server overrides beat environment without a second parser; resource guards remain independent', () => {
  const prev=process.env.MAX_ACTIVE_WORKFLOWS;
  const previousRoot=process.env.DATA_ROOT;
  process.env.MAX_ACTIVE_WORKFLOWS='1';
  try {
    assert.equal(loadConfig().maxActiveWorkflows,1);
    const unlimited=loadConfig({maxActiveWorkflows:-1,port:12345,basePath:'/isolated'});
    process.env.DATA_ROOT="invalid-relative-root";
    assert.equal(loadConfig({dataRoot:"/isolated/override"}).dataRoot,"/isolated/override");
    assert.equal(unlimited.maxActiveWorkflows,-1);assert.equal(unlimited.port,12345);
    assert.equal(unlimited.instance.basePath,'/isolated');
    assert.ok(unlimited.maxGlobalRunningJobs>0 && unlimited.minimumFreeDiskBytes>0);
  } finally { if(previousRoot===undefined)delete process.env.DATA_ROOT;else process.env.DATA_ROOT=previousRoot; if(prev===undefined)delete process.env.MAX_ACTIVE_WORKFLOWS;else process.env.MAX_ACTIVE_WORKFLOWS=prev; }
});
