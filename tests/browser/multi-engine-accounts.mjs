import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.CWW_BROWSER_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'multi-engine-ui-'));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const browserTemp = `/tmp/multi-engine-ui-${crypto.randomUUID()}`;
fs.symlinkSync(output, browserTemp, 'dir');
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || '/root/.cache/ms-playwright';
process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
const playwrightRoot = process.env.PLAYWRIGHT_MODULE_PATH || fs.readdirSync(cache + '/.links').map(name => fs.readFileSync(cache + '/.links/' + name, 'utf8').trim()).find(root => fs.existsSync(root + '/index.mjs'));
const { chromium } = await import(playwrightRoot + '/index.mjs');
const source = `import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';import{CodexAccountDialog}from'/src/codex-account-dialog.tsx';import{ConversationComposer}from'/src/conversation/ConversationComposer.tsx';import{reasoningForModel}from'/src/agent-model-options.ts';import '/src/styles.css';
function Test(){const[open,setOpen]=useState(true),[options,setOptions]=useState(null),[selection,setSelection]=useState({model:'codex-fixture',reasoningEffort:'high'}),[text,setText]=useState('');useEffect(()=>{const refresh=()=>fetch('/api/agent-options').then(r=>r.json()).then(setOptions);refresh();window.addEventListener('codex-web-models-changed',refresh);return()=>window.removeEventListener('codex-web-models-changed',refresh)},[]);return <main style={{maxWidth:780,margin:'24px auto',padding:16}}><button onClick={()=>setOpen(true)}>打开账号管理</button><ConversationComposer conversationId="fixture" value={text} onChange={setText} files={[]} onFilesChange={()=>{}} model={selection.model} reasoningEffort={selection.reasoningEffort} agentOptions={options} canSend={false} onModelChange={model=>setSelection(s=>({model,reasoningEffort:reasoningForModel(options,model,s.model,s.reasoningEffort)}))} onReasoningChange={reasoningEffort=>setSelection(s=>({...s,reasoningEffort}))} onSend={()=>{}} onTranscript={()=>{}}/><output data-testid="selection">{JSON.stringify(selection)}</output>{open&&<CodexAccountDialog onClose={()=>setOpen(false)}/>}</main>};createRoot(document.getElementById('root')).render(<Test/>);`;
const vite = await createServer({ root: repo, configFile: false, plugins: [react(), {
  name: 'multi-engine-fixture',
  resolveId(id) { if (id === '/__multi_engine_fixture.tsx') return '\0multi-engine-fixture.tsx'; },
  load(id) { if (id === '\0multi-engine-fixture.tsx') return ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText; },
  configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url?.split('?')[0] !== '/__multi_engine_fixture') return next();res.setHeader('Content-Type', 'text/html');res.end(await server.transformIndexHtml(req.url, '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__multi_engine_fixture.tsx"></script></body></html>')); }); },
}], server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
const now = new Date().toISOString();
const account = (id, label, active = false) => ({ id, label, active, email: id + '@example.invalid', accountHint: 'fixture', createdAt: now, lastUsedAt: null, quotaRemainingPercent: 85, quotaResetAt: now, resetCredits: { availableCount: 2, earliestExpiresAt: null, expiryStatus: 'complete', state: 'ok', updatedAt: now } });
let codex = { accounts: [account('codex-a', '合成测试账号名称'.repeat(8), true), account('codex-b', '第二个 Codex 测试账号')], activeAccountId: 'codex-a' };
let gemini = { accounts: [], activeAccountId: null, runtimeAvailable: true };
let codexLogin = null, geminiLogin = null, failRefresh = false, failGeminiRead = false, failGeminiActivate = false;
let resetCalls = 0, activationCalls = 0, deleteCalls = 0, codeCalls = 0, cancellationCalls = 0, geminiActivationCalls = 0;
const report = { checks: [], errors: [] };
let browser, page;
const codexModel = { id: 'codex-fixture', label: 'Codex Fixture', description: 'Codex 合成测试模型', reasoningEfforts: ['low', 'high', 'ultra'] };
const geminiModel = { id: 'antigravity:gemini-fixture', label: 'Gemini Fixture', description: 'Gemini 合成测试模型', engineId: 'antigravity', reasoningEfforts: ['automatic', 'high'], defaultReasoningEffort: 'automatic', reasoningEffortOptions: [{ id: 'automatic', label: '自动' }, { id: 'high', label: 'Gemini 深度思考' }] };
try {
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--disable-gpu'], env: { ...process.env, TMPDIR: browserTemp } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname.slice(4), method = request.method();
    const payload = request.postData() ? JSON.parse(request.postData()) : {};
    const executorId = url.searchParams.get('executorId') || payload.executorId || 'local-host';
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    if (endpoint === '/executors') return json({ executors: [{ id: 'local-host', machineName: '服务器', kind: 'host_root', status: 'online', codexAccountManagementCapable: true }, { id: 'other-node', machineName: '另一台测试机器', kind: 'remote_worker', status: 'online', codexAccountManagementCapable: true, worker: { installedVersion: '1.20.0' } }] });
    if (endpoint === '/agent-options') return json({ models: [codexModel, ...(gemini.accounts.some(a => a.active && a.authenticated) ? [geminiModel] : [])], reasoningEfforts: [{ id: 'low', label: '低' }, { id: 'high', label: '高' }, { id: 'ultra', label: '极高' }], defaults: { model: codexModel.id, reasoningEffort: 'high' }, selection: { model: codexModel.id, reasoningEffort: 'high' } });
    if (endpoint === '/codex-accounts/reset-history') return json({ records: [], enabled: true, supported: true });
    if (endpoint === '/codex-accounts/refresh-usage') { if (failRefresh) { failRefresh = false; return json({ error: '合成额度刷新失败' }, 503); } return json(codex); }
    if (endpoint.includes('reset-credit') && method === 'POST') { resetCalls++; return json({ outcome: 'reset', refreshed: true }); }
    if (endpoint === '/codex-accounts/logins' && method === 'POST') { codexLogin = { id: 'codex-login', status: 'waiting_for_user', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234', account: null, error: null, createdAt: now, expiresAt: now }; return json({ login: codexLogin }); }
    if (endpoint.startsWith('/codex-accounts/logins/')) { if (method === 'DELETE') codexLogin.status = 'cancelled'; return json({ login: codexLogin }); }
    if (endpoint.startsWith('/codex-accounts/') && endpoint.endsWith('/activate')) { const id = endpoint.split('/')[2]; activationCalls++; codex = { accounts: codex.accounts.map(a => ({ ...a, active: a.id === id })), activeAccountId: id }; return json(codex); }
    if (endpoint.startsWith('/codex-accounts/') && method === 'DELETE') { const id = endpoint.split('/')[2]; deleteCalls++; codex.accounts = codex.accounts.filter(a => a.id !== id); return json(codex); }
    if (endpoint === '/codex-accounts') return json(executorId === 'other-node' ? { accounts: [], activeAccountId: '' } : codex);
    if (endpoint === '/gemini-accounts') { if (failGeminiRead) { failGeminiRead = false; return json({ error: '合成 Gemini 读取失败' }, 503); } return json(executorId === 'other-node' ? { accounts: [], activeAccountId: null, runtimeAvailable: false, error: '该节点尚未安装 Gemini 登录服务' } : gemini); }
    if (endpoint === '/gemini-accounts/logins' && method === 'POST') { gemini = { ...gemini, runtimeAvailable: true }; geminiLogin = { id: 'gemini-login', label: payload.label || 'Google 测试账号', status: 'waiting', verificationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?fixture=true', requiresCode: true, message: null, accountId: null, createdAt: now, expiresAt: now }; return json({ login: geminiLogin }); }
    if (endpoint.endsWith('/code')) { assert.equal(payload.code, 'synthetic-auth-code'); codeCalls++; geminiLogin = { ...geminiLogin, status: 'completed', accountId: 'gemini-a', requiresCode: false }; gemini = { ...gemini, accounts: [{ id: 'gemini-a', label: geminiLogin.label, email: 'synthetic-google-account-with-a-long-address@example.invalid', createdAt: now, lastUsedAt: null, active: false, authenticated: true }], activeAccountId: null }; return json({ login: geminiLogin }); }
    if (endpoint === '/gemini-accounts/gemini-a/activate' && method === 'POST') { geminiActivationCalls++; if (failGeminiActivate) { failGeminiActivate = false; return json({ error: '当前 Gemini 任务运行中，请结束后再启用。' }, 409); } gemini = { ...gemini, activeAccountId: 'gemini-a', accounts: gemini.accounts.map(a => ({ ...a, active: a.id === 'gemini-a' })) }; return json(gemini); }
    if (endpoint.startsWith('/gemini-accounts/logins/')) { if (method === 'DELETE') { cancellationCalls++; geminiLogin.status = 'cancelled'; } return json({ login: geminiLogin }); }
    return json({ error: 'Unexpected synthetic request: ' + method + ' ' + endpoint }, 404);
  });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => report.errors.push(String(error))); page.on('console', message => { if (message.type() === 'error') (report.consoleErrors ||= []).push(message.text()); }); page.on('requestfailed', request => (report.failedRequests ||= []).push(request.url())); page.on('dialog', dialog => dialog.accept());
  await page.goto(origin + '/__multi_engine_fixture');
  const dialog = () => page.getByRole('dialog', { name: '账号管理', exact: true });
  await dialog().getByRole('heading', { name: 'Codex', exact: false }).waitFor();
  await dialog().getByText('尚未添加 Google 账号。', { exact: false }).waitFor();
  for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 960 }); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const dimensions = await dialog().evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth, bodyScroll: el.querySelector('.codex-account-body').scrollWidth, bodyWidth: el.querySelector('.codex-account-body').clientWidth, buttons: [...el.querySelectorAll('button')].filter(e => e.getClientRects().length).map(e => ({ height: e.getBoundingClientRect().height, font: getComputedStyle(e).fontSize })) }));
    assert.ok(dimensions.scroll <= dimensions.width + 1 && dimensions.bodyScroll <= dimensions.bodyWidth + 1, JSON.stringify({ width, theme, dimensions }));
    assert.ok(dimensions.buttons.every(b => b.height >= 43.5 && b.font === '14px'), JSON.stringify(dimensions.buttons));
    await page.screenshot({ path: output + `/accounts-${width}-${theme}.png` });
  }
  report.checks.push('320_390_768_1440_light_dark_long_names_no_overflow_44px_controls');
  await dialog().locator('.codex-auto-reset-history summary').click(); await dialog().getByText('暂无自动使用记录。', { exact: true }).waitFor(); await page.screenshot({ path: output + '/accounts-auto-reset-history.png' }); await dialog().locator('.codex-auto-reset-history summary').click(); report.checks.push('codex_auto_reset_history_integrated_without_gemini_change');
  await page.setViewportSize({ width: 390, height: 960 }); await page.evaluate(() => document.documentElement.style.fontSize = '200%');
  assert.ok(await dialog().evaluate(el => el.querySelector('.codex-account-body').scrollWidth <= el.querySelector('.codex-account-body').clientWidth + 1));
  await page.screenshot({ path: output + '/accounts-200pct.png' }); await page.evaluate(() => document.documentElement.style.fontSize = ''); report.checks.push('200pct_text_reflows');
  await page.setViewportSize({ width: 1440, height: 960 });
  failRefresh = true; await dialog().getByRole('button', { name: '刷新重置卡', exact: true }).click(); await dialog().getByText('合成额度刷新失败', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: '刷新重置卡', exact: true }).click(); await page.waitForFunction(() => !document.body.textContent.includes('合成额度刷新失败'));
  await dialog().getByRole('button', { name: '使用重置卡', exact: true }).first().click(); await dialog().getByText('已使用 1 张最早到期的重置卡。', { exact: false }).waitFor(); assert.equal(resetCalls, 1);
  await dialog().getByRole('button', { name: '切换', exact: true }).click(); await page.waitForFunction(() => document.body.textContent.includes('已切换到 第二个 Codex 测试账号'));
  await dialog().getByRole('button', { name: /^删除 合成测试/ }).click(); await page.waitForFunction(() => document.querySelectorAll('.codex-account-card').length === 1); assert.equal(activationCalls, 1); assert.equal(deleteCalls, 1);
  report.checks.push('codex_quota_refresh_error_recovery_reset_activation_delete_preserved');
  await dialog().getByRole('button', { name: '新增账号', exact: true }).click(); assert.equal(await dialog().getByLabel('账号类型', { exact: true }).inputValue(), 'codex');
  await dialog().getByRole('button', { name: '生成登录验证链接', exact: true }).click(); await dialog().getByText('TEST-1234', { exact: true }).waitFor(); assert.equal(await dialog().getByRole('link', { name: '打开验证页面' }).getAttribute('href'), 'https://auth.openai.com/codex/device');
  assert.equal(await dialog().getByLabel('目标机器', { exact: true }).isDisabled(), true);
  codexLogin = { ...codexLogin, status: 'succeeded', account: account('codex-new', 'Codex 新账号') }; await page.waitForFunction(() => !document.querySelector('.codex-login-panel')); report.checks.push('codex_device_code_login_and_completion_preserved');
  await dialog().getByLabel('目标机器', { exact: true }).selectOption('other-node'); await dialog().getByText('该节点尚未安装 Gemini 登录服务', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: '新增账号', exact: true }).click(); await dialog().getByLabel('账号类型', { exact: true }).selectOption('gemini'); assert.equal(await dialog().getByRole('button', { name: '生成 Google 登录链接', exact: true }).isDisabled(), true);
  await dialog().getByLabel('目标机器', { exact: true }).selectOption('local-host'); await dialog().getByText('尚未添加 Google 账号。', { exact: false }).waitFor();
  report.checks.push('per_node_accounts_empty_and_unavailable_login_disabled');
  failGeminiRead = true; await dialog().getByRole('button', { name: '刷新 Gemini 账号', exact: true }).click(); await dialog().getByText('合成 Gemini 读取失败', { exact: true }).waitFor(); await dialog().getByRole('button', { name: '刷新 Gemini 账号', exact: true }).click(); await page.waitForFunction(() => !document.body.textContent.includes('合成 Gemini 读取失败'));
  await dialog().getByRole('button', { name: '关闭账号管理', exact: true }).click(); const composer = page.locator('.conversation-composer'); await composer.getByRole('button', { name: '模型', exact: true }).click(); assert.equal(await page.getByRole('option', { name: /Gemini Fixture/ }).count(), 0); await page.keyboard.press('Escape');
  gemini = { ...gemini, runtimeAvailable: false, loginAvailable: true }; await page.getByRole('button', { name: '打开账号管理', exact: true }).click(); await dialog().getByText('新增 Google 账号时会自动准备这台机器的 Gemini 服务。', { exact: true }).waitFor(); await dialog().getByRole('button', { name: '新增账号', exact: true }).click(); await dialog().getByLabel('账号类型', { exact: true }).selectOption('gemini'); await dialog().getByRole('button', { name: '生成 Google 登录链接', exact: true }).click();
  await dialog().getByRole('link', { name: '打开 Google 登录页面' }).waitFor(); assert.ok((await dialog().getByRole('link', { name: '打开 Google 登录页面' }).getAttribute('href')).startsWith('https://accounts.google.com/'));
  assert.equal(await dialog().getByLabel('账号类型', { exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 320, height: 960 }); await dialog().getByLabel('Google 一次性授权码', { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: output + '/google-login-320.png' });
  assert.ok(await dialog().evaluate(el => el.querySelector('.codex-account-body').scrollWidth <= el.querySelector('.codex-account-body').clientWidth + 1));
  await dialog().getByLabel('Google 一次性授权码', { exact: true }).fill('synthetic-auth-code'); await dialog().getByRole('button', { name: '确认授权码', exact: true }).click(); await dialog().getByText('synthetic-google-account-with-a-long-address@example.invalid', { exact: false }).waitFor(); assert.equal(codeCalls, 1);
  await dialog().getByText('Google 账号已登录，但尚未启用。请在账号列表中启用后再选择 Antigravity 模型。', { exact: true }).waitFor();
  await dialog().getByText('Google 账号已登录，但当前机器尚未启用账号。点击“启用”后会读取可用模型和思考深度。', { exact: true }).waitFor();
  assert.ok(await dialog().evaluate(el => el.querySelector('.codex-account-body').scrollWidth <= el.querySelector('.codex-account-body').clientWidth + 1)); await dialog().screenshot({ path: output + '/google-inactive-320.png' });
  await dialog().getByRole('button', { name: '关闭账号管理', exact: true }).click(); await page.setViewportSize({ width: 1440, height: 960 });
  await composer.getByRole('button', { name: '模型', exact: true }).click(); assert.equal(await page.getByRole('option', { name: /Gemini Fixture/ }).count(), 0); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '打开账号管理', exact: true }).click(); failGeminiActivate = true;
  await dialog().getByRole('button', { name: '启用', exact: true }).click(); await dialog().getByText('当前 Gemini 任务运行中，请结束后再启用。', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('button', { name: '启用', exact: true }).isEnabled(), true);
  await dialog().getByRole('button', { name: '启用', exact: true }).click(); await dialog().getByText('当前机器的 Gemini 账号已启用，正在刷新可用模型。', { exact: true }).waitFor(); assert.equal(geminiActivationCalls, 2);
  await dialog().getByRole('button', { name: '关闭账号管理', exact: true }).click();
  report.checks.push('logged_in_inactive_account_explicitly_requires_activation_and_does_not_advertise_models', 'gemini_busy_activation_error_recovers_and_activation_refreshes_catalog');
  await composer.getByRole('button', { name: '模型', exact: true }).click(); await page.getByRole('option', { name: /Gemini Fixture/ }).click(); assert.ok((await page.getByTestId('selection').textContent()).includes('"reasoningEffort":"automatic"'));
  await composer.getByRole('button', { name: '思考', exact: true }).click(); assert.equal(await page.getByRole('option', { name: '极高', exact: true }).count(), 0); await page.getByRole('option', { name: 'Gemini 深度思考', exact: true }).click();
  const savedGemini = gemini; gemini = { ...gemini, accounts: [], activeAccountId: null }; await page.evaluate(() => window.dispatchEvent(new Event('codex-web-models-changed')));
  await composer.getByText('antigravity:gemini-fixture（当前不可用）', { exact: true }).waitFor(); assert.ok((await page.getByTestId('selection').textContent()).includes('antigravity:gemini-fixture')); assert.equal(await composer.getByRole('button', { name: '思考', exact: true }).isDisabled(), true);
  await composer.getByRole('button', { name: '模型', exact: true }).click(); assert.equal(await page.getByRole('option', { name: /Gemini Fixture/ }).count(), 0); await page.keyboard.press('Escape');
  gemini = savedGemini; await page.evaluate(() => window.dispatchEvent(new Event('codex-web-models-changed'))); await composer.getByText('Gemini Fixture', { exact: true }).waitFor(); report.checks.push('unavailable_gemini_selection_preserved_without_silent_codex_fallback');
  await composer.getByRole('button', { name: '模型', exact: true }).click(); await page.getByRole('option', { name: /Codex Fixture/ }).click(); await composer.getByRole('button', { name: '思考', exact: true }).click(); await page.getByRole('option', { name: '极高', exact: true }).waitFor(); await page.keyboard.press('Escape');
  report.checks.push('first_google_login_allows_backend_runtime_install','google_official_link_code_login_and_catalog_refresh','model_first_engine_specific_effort_labels_and_defaults','codex_model_and_efforts_after_gemini_switch');
  const confirmedGemini = gemini;
  gemini = { ...gemini, accounts: gemini.accounts.map(a => ({ ...a, authenticated: false })), error: 'Gemini 账号状态读取超时，请稍后刷新。' };
  await page.getByRole('button', { name: '打开账号管理', exact: true }).click();
  const googleSection = dialog().getByRole('region', { name: 'Gemini 账号', exact: true });
  await googleSection.getByText('状态待确认，请刷新', { exact: false }).waitFor();
  await googleSection.getByRole('alert').getByText('Gemini 账号状态读取超时，请稍后刷新。', { exact: true }).waitFor();
  assert.equal(await googleSection.getByText('需要重新登录', { exact: false }).count(), 0);
  gemini = { ...gemini, error: null };
  await googleSection.getByRole('button', { name: '刷新 Gemini 账号', exact: true }).click();
  await googleSection.getByText('需要重新登录', { exact: false }).waitFor();
  assert.equal(await googleSection.getByText('状态待确认，请刷新', { exact: false }).count(), 0);
  gemini = confirmedGemini;
  await googleSection.getByRole('button', { name: '刷新 Gemini 账号', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('section[aria-label="Gemini 账号"]').textContent.includes('需要重新登录'));
  await dialog().getByRole('button', { name: '关闭账号管理', exact: true }).click();
  report.checks.push('gemini_status_probe_failure_is_unknown_not_logged_out_and_refresh_recovers');
  await page.getByRole('button', { name: '打开账号管理', exact: true }).click(); await dialog().getByRole('button', { name: '新增账号', exact: true }).click(); await dialog().getByLabel('账号类型', { exact: true }).selectOption('gemini'); await dialog().getByRole('button', { name: '生成 Google 登录链接', exact: true }).click(); await dialog().getByRole('link', { name: '打开 Google 登录页面' }).waitFor(); await dialog().getByRole('button', { name: '关闭账号管理', exact: true }).click(); assert.equal(cancellationCalls, 1); report.checks.push('closing_google_login_cancels_isolated_flow');
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) { report.error = String(error.stack); process.exitCode = 1; await page?.screenshot({ path: output + '/failure.png' }).catch(error => report.screenshotError = String(error)); if(page) { report.url=page.url(); report.body=await page.locator('body').innerText().catch(()=> 'unavailable'); } }
finally { await browser?.close(); await vite.close(); fs.unlinkSync(browserTemp); fs.writeFileSync(output + '/result.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
