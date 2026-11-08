import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInstancePaths, loadPublicInstanceConfig, publicInstanceConfig, renderInstanceHtml, instancePort, instanceBoolean } from '../server/instance-config.js';
import { workflowCapacity } from '../server/workflow-store.js';

const profiles = [
  {name:'Source Workstation', theme:'indigo', icon:'bolt', capacity:'-1', root:'/isolated/agent'},
  {name:'Maintenance Workstation', theme:'jade', icon:'wrench', capacity:'1', root:'/isolated/manage'},
  {name:'Codex Web', theme:'indigo', icon:'bolt', capacity:undefined, root:'/isolated/public'},
];
for (const p of profiles) test(`instance configuration: ${p.name}`, () => {
  const env = { APP_PRODUCT_NAME:p.name, APP_THEME:p.theme, APP_ICON:p.icon, APP_STATE_ROOT:p.root,
    SESSION_SECRET:'must-never-be-published', DASHSCOPE_API_KEY:'also-private', MAX_ACTIVE_WORKFLOWS:p.capacity };
  const config = loadPublicInstanceConfig(env);
  assert.equal(config.productName,p.name);
  assert.equal(workflowCapacity(env.MAX_ACTIVE_WORKFLOWS),p.name==='Maintenance Workstation'?1:-1);
  const paths=loadInstancePaths(env,'/unrelated/code');
  assert.equal(paths.hostHome,`${p.root}/host-home`);
  assert.equal(paths.dataRoot,`${p.root}/data`); assert.equal(paths.tenantRoot,`${p.root}/tenants`);
  assert.equal(paths.hostRootSocketPath,''); assert.equal(paths.ecsCredentialsSocketPath,'');
  assert.ok(!JSON.stringify(paths).includes('/srv/'));
  const allowed=publicInstanceConfig({...config,...env});
  assert.deepEqual(Object.keys(allowed).sort(),['productName','tagline','icon','theme','loginHint','privacyNote','basePath'].sort());
  assert.ok(!JSON.stringify(allowed).includes('private'));
});
test('defaults, explicit overrides and invalid configuration fail before side effects', () => {
  assert.equal(loadPublicInstanceConfig().productName,'Codex Web');
  for (const env of [{APP_THEME:'bad'},{APP_ICON:'https://tracker'},{APP_PRODUCT_NAME:''},{APP_PRODUCT_NAME:'a\nb'},{BASE_PATH:'//foreign/path'},{BASE_PATH:'/../private'}]) assert.throws(()=>loadPublicInstanceConfig(env));
  for (const n of [0,65536,1.2,'bad','']) assert.throws(()=>instancePort(n));
  assert.equal(instancePort('37822'),37822);
  assert.throws(()=>instanceBoolean('yes',false,'FLAG'));
  assert.equal(instanceBoolean('false',true,'FLAG'),false);
  assert.throws(()=>loadInstancePaths({DATA_ROOT:'relative'},'/tmp/test'));
  assert.throws(()=>loadInstancePaths({APP_STATE_ROOT:'relative'},'/tmp/test'));
  assert.equal(loadInstancePaths({APP_STATE_ROOT:'/tmp/state', DATA_ROOT:'/explicit'},'/tmp/code').pythonRuntimeRoot,'/explicit/python');
});
test('runtime HTML escapes branding and keeps nested base paths and icons coherent', () => {
  const config=loadPublicInstanceConfig({APP_PRODUCT_NAME:'X </script><img onerror="x"> $&',APP_ICON:'wrench',BASE_PATH:'/codex-web'});
  const html=renderInstanceHtml('<head><!--instance-config--><title>old</title><meta name="application-name" content="old"/><link href="/favicon.png"/><script src="/assets/test.js"></script></head>',config);
  assert.ok(!html.includes('<img')); assert.ok(html.includes('href="/codex-web/wrench.svg"'));
  assert.ok(html.includes('src="/codex-web/assets/test.js"')); assert.ok(html.includes(' $&'));
  const json=html.match(/type="application\/json">(.*?)<\/script>/)![1];
  assert.deepEqual(JSON.parse(json),config);
});

import { publicInstanceEnvironment } from '../server/instance-environment.js';
test('public adapter ignores legacy private authority keys and keeps optional capabilities empty', () => {
  const env=publicInstanceEnvironment({APP_STATE_ROOT:'/isolated/public', PPHK_HOST_SOCKET_PATH:'/unrelated/private.sock', PPHK_HOST_HOME:'/unrelated/home', PPHK_ECS_CREDENTIALS_SOCKET_PATH:'/unrelated/credentials.sock'},'/isolated/source');
  const roots=loadInstancePaths(env,'/isolated/source');
  assert.equal(roots.hostRootSocketPath,''); assert.equal(roots.ecsCredentialsSocketPath,'');
  assert.equal(roots.hostHome,'/isolated/public/host/home');
  assert.equal(roots.hostTenantRoot,'/isolated/public/host/tenants');
  const configured=loadInstancePaths(publicInstanceEnvironment({CODEX_WEB_HOST_SOCKET_PATH:'/isolated/explicit.sock',CODEX_WEB_HOST_HOME:'/isolated/home'},'/isolated/source'),'/isolated/source');
  assert.equal(configured.hostRootSocketPath,'/isolated/explicit.sock');assert.equal(configured.hostHome,'/isolated/home');
});
