import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import ts from 'typescript';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.CWW_BROWSER_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'notices-ui-'));
fs.mkdirSync(output, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/root/.cache/ms-playwright';
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH;
const moduleRoot = process.env.PLAYWRIGHT_MODULE_PATH || fs.readdirSync(cache + '/.links').map(name => fs.readFileSync(cache + '/.links/' + name, 'utf8').trim()).find(root => fs.existsSync(root + '/index.mjs'));
const { chromium } = await import(moduleRoot + '/index.mjs');
const source = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{TransientNotice,useNoticeState}from'/src/transient-notice.tsx';import{CodexAutoResetHistory}from'/src/codex-auto-reset-history.tsx';import '/src/styles.css';
function Test(){const[text,setText,revision]=useNoticeState();const[error,setError]=useState(false);const[scope,setScope]=useState(0);return <main className="ui-dialog" style={{maxWidth:780,margin:'24px auto',padding:16}}><button onClick={()=>{setError(false);setText('已完成操作')}}>提示一次</button><button onClick={()=>{setError(true);setText('操作失败')}}>错误提示</button><button onClick={()=>setText(s=>s)}>保留原状态</button><button onClick={()=>setScope(s=>s+1)}>切换上下文</button>{text&&<TransientNotice message={text} revision={revision+':'+scope} role={error?'alert':'status'} className={error?'error-toast':'info-toast'} onDismiss={()=>setText('')}><span>{text}</span><button aria-label="关闭提示" onClick={()=>setText('')}>×</button></TransientNotice>}<CodexAutoResetHistory executorId="fixture"/></main>}createRoot(document.getElementById('root')).render(<Test/>);`;
const vite = await createServer({ root: repo, cacheDir: path.join(output, 'vite-cache'), configFile: false, plugins: [react(), {
  name: 'notice-fixture', resolveId(id) { if (id === '/__fixture.tsx') return '\0notice-fixture.tsx'; },
  load(id) { if (id === '\0notice-fixture.tsx') return ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText; },
  configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== '/__fixture') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture.tsx"></script></body></html>')); }); },
}], server: { host: '127.0.0.1', port: 0 } });
await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
let browser, page, records = [], fail = false;
const report = { checks: [], errors: [] };
try {
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--disable-gpu'], env: { ...process.env, TMPDIR: '/tmp' } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/api/codex-accounts/reset-history**', route => route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: 'fixture unavailable' } : { records, enabled: true, supported: true } }));
  page = await context.newPage(); page.on('pageerror', e => report.errors.push(String(e))); page.setDefaultTimeout(8000);
  await page.goto(origin + '/__fixture'); await page.getByText('提示一次', { exact: true }).waitFor();
  await page.clock.install(); await page.clock.pauseAt(new Date());
  const show = () => page.getByRole('button', { name: '提示一次', exact: true }).click();
  const toast = () => page.locator('.info-toast,.error-toast');
  await show(); await page.clock.runFor(9999); assert.equal(await toast().count(), 1); await page.clock.runFor(1); assert.equal(await toast().count(), 0); report.checks.push('exact_ten_second_lifetime');
  await show(); await page.clock.runFor(3000); await page.getByRole('button', { name: '关闭提示' }).click(); assert.equal(await toast().count(), 0); await show(); await page.clock.runFor(7000); assert.equal(await toast().count(), 1); await page.clock.runFor(3000); assert.equal(await toast().count(), 0); report.checks.push('early_dismiss_clears_previous_timer');
  await show(); await page.clock.runFor(7000); await show(); await page.clock.runFor(7000); assert.equal(await toast().count(), 1); await page.clock.runFor(3000); assert.equal(await toast().count(), 0); report.checks.push('same_message_restarts_countdown');
  await show(); await page.clock.runFor(7000); await page.getByRole('button', { name: '保留原状态' }).click(); await page.clock.runFor(3000); assert.equal(await toast().count(), 0); report.checks.push('unchanged_functional_update_does_not_extend_timer');
  await page.getByRole('button', { name: '错误提示', exact: true }).click(); assert.equal(await toast().getAttribute('role'), 'alert'); await page.clock.runFor(10000); assert.equal(await toast().count(), 0); report.checks.push('error_toasts_expire');
  await show(); await page.clock.runFor(7000); await page.getByRole('button', { name: '切换上下文' }).click(); await page.clock.runFor(7000); assert.equal(await toast().count(), 1); await page.clock.runFor(3000); assert.equal(await toast().count(), 0); report.checks.push('context_revision_gets_new_lifetime');
  await page.locator('summary').click(); await page.getByText('暂无自动使用记录。', { exact: true }).waitFor();
  fail = true; await page.getByRole('button', { name: '刷新记录' }).click(); await page.getByText('记录读取失败，请重试。').waitFor();
  fail = false; records = ['completed','failed','unconfirmed','pending'].map((state, i) => ({ id: String(i), account_label: '合成测试账号名称'.repeat(8), state, outcome: state === 'completed' ? 'reset' : null, attempts: 2, updated_at: new Date().toISOString(), expires_at: new Date(Date.now()+1800000).toISOString() }));
  records.push({ ...records[0], id: 'skipped', outcome: 'notDue' });
  await page.getByRole('button', { name: '刷新记录' }).click(); await page.getByText(/到期卡已变化或过期，已跳过/).waitFor(); await page.getByText(/已使用重置卡/, { exact: false }).waitFor(); report.checks.push('history_empty_failure_recovery_and_result_states');
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 }); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const box = await page.getByRole('button', { name: '刷新记录' }).boundingBox(); assert.ok(box.height >= 44);
    const contrast = await page.getByRole('button', { name: '刷新记录' }).evaluate(button => {
      const style = getComputedStyle(button);
      const luminance = color => color.match(/[\d.]+/g).slice(0,3).map(Number).map(n => n/255).map(n => n <= .04045 ? n/12.92 : ((n+.055)/1.055)**2.4).reduce((sum,n,i) => sum+n*[.2126,.7152,.0722][i],0);
      const fg=luminance(style.color), bg=luminance(style.backgroundColor);
      return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
    });
    assert.ok(contrast >= 4.5, `${theme}: refresh button contrast ${contrast}`);
    await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
  }
  await page.evaluate(() => document.documentElement.style.fontSize = '200%'); await page.setViewportSize({ width: 390, height: 960 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); report.checks.push('history_responsive_light_dark_320_390_768_1440_and_200pct');
  report.checks.push('history_refresh_button_contrast_light_dark');
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) { report.error = String(error.stack); process.exitCode = 1; await page?.screenshot({ path: output + '/failure.png', fullPage: true }); }
finally { await browser?.close(); await vite.close(); fs.writeFileSync(output + '/result.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
