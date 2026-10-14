import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installRecorder } from './fixtures/recorder.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.CWW_BROWSER_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'opportunity-ui-report-'));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opportunity-ui-'));
const require = createRequire(repo + '/package.json');
const { createApp } = await import(repo + '/dist-server/server/app.js');
const { OpportunityStore, contentInput } = await import(repo + '/dist-server/server/opportunity-store.js');
const { TranscriptionService } = await import(repo + '/dist-server/server/transcription.js');
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache/ms-playwright');
const playwrightRoot = process.env.PLAYWRIGHT_MODULE_PATH || fs.readdirSync(cache + '/.links').map(n => fs.readFileSync(cache + '/.links/' + n, 'utf8').trim()).find(p => fs.existsSync(p + '/index.mjs'));
process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
const { chromium } = await import(playwrightRoot + '/index.mjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const gates = []; let attempt = 0;
TranscriptionService.prototype.transcribe = async () => {
  const n = attempt++; const gate = deferred(); gates.push(gate); await gate.promise;
  if (n === 1) throw new Error('Controlled feedback recognition failure');
  return 'recognized feedback ' + n;
};
const instance = createApp({ projectRoot: repo, dataRoot: root + '/data', tenantRoot: root + '/tenants', username: 'opportunity-fixture', passwordHash: require('bcryptjs').hashSync('feedback-test', 4), sessionSecret: 'opportunity-ui-secret-atleast32characters', queueAutoStart: false, basePath: '/codex-web', codexHome: root + '/codex-home', pythonRuntimeRoot: root + '/python', hostRootSocketPath: '', hostTenantRoot: '', hostKnowledgeRoot: '', personalMemoryApiKey: '', personalMemoryBaseUrl: '', dashscopeApiKey: '', dashscopeBaseUrl: '', minimumFreeDiskBytes: 0 });
const server = instance.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const origin = 'http://127.0.0.1:' + server.address().port + '/codex-web';
const requestOrigin = new URL(origin).origin;
const report = { checks: [], pageErrors: [] }; let browser, page;
const save = () => fs.writeFileSync(output + '/result.json', JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { throw new Error('Opportunity UI regression timed out'); }, 240000);
try {
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--disable-gpu'], env: { ...process.env, HOME: root, TMPDIR: root } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await installRecorder(context, Buffer.from('synthetic microphone fixture').toString('base64'));
  // Exercise the real Web Audio analyser/canvas with a generated microphone signal.
  await context.addInitScript(() => {
    window.__denyMicrophone = false;
    navigator.mediaDevices.getUserMedia = async () => {
      if (window.__denyMicrophone) throw new DOMException('Microphone denied', 'NotAllowedError');
      const audio = new AudioContext(); const oscillator = audio.createOscillator(); const destination = audio.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      for (const track of destination.stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { stop(); oscillator.stop(); void audio.close(); }; }
      return destination.stream;
    };
  });
  const login = await context.request.post(origin + '/api/auth/login', { data: { username: 'opportunity-fixture', password: 'feedback-test' } }); assert.equal(login.status(), 200);
  const session = await login.json();
  const api = async (method, url, data) => {
    const r = await context.request.fetch(origin + '/api' + url, { method, headers: { Origin: requestOrigin, 'X-CSRF-Token': session.csrfToken }, ...(data === undefined ? {} : { data }) });
    assert.ok(r.ok(), url + ': ' + r.status()); return r.status() === 204 ? null : r.json();
  };
  const prefs = await api('GET', '/user-settings/features');
  await api('PUT', '/user-settings/features', { ...prefs, opportunityCards: true, paraBoard: true });
  const user = session.accountId;
  const project = (await api('GET', '/projects')).projects.find(p => p.executor_id === 'tenant-local'); assert.ok(project);
  const store = new OpportunityStore(instance.db);
  const names = ['合成游戏主题', '合成服务主题']; const topics = [], ideas = [];
  for (let n = 0; n < 2; n++) {
    const topic = (await api('POST', '/opportunities/topics', { requestKey: crypto.randomUUID(), name: names[n], project_id: project.id, goal: '独立浏览器验收主题 ' + n })).topic; topics.push(topic);
    const c = (await api('POST', '/conversations', { projectId: project.id, reuseEmpty: false })).conversation;
    const batch = store.begin(user, topic.id, c.id, null);
    const content = contentInput.parse({ title: '专属卡片 ' + n, summary: '只属于主题 ' + n, audience: '浏览器验收', problem: '测试问题 ' + n, mechanism: '独立机制 ' + n, value: '可验证反馈', fit: '小型测试', facts: '合成数据', assumptions: '假设', doubt: '不用于业务', validation: '点击录音', difference: '独立编号 ' + n, category: '测试', keywords: ['测试', '主题' + n], sources: [{ title: 'Fixture', url: 'https://example.org/' + n, date: new Date().toISOString().slice(0,10), finding: '合成来源' }] });
    const idea = store.ingest(user, batch.id, c.id, [{ key: 'fixture-' + n, content }])[0].idea; ideas.push(idea);
    store.review(user, batch.id, c.id, [{ idea_id: idea.id, verdict: 'approve', score: 90, quality: 90, rationale: '合成数据符合测试', compared: store.neighbors(user, content, idea.id).map(x => ({ id: x.id, difference: '编号对应不同的测试机制' })) }]);
    store.publish(user, batch.id, c.id, { ids: [idea.id], summary: '合成验收', feedbackRevision: store.feedbackRevision(user, topic.id) });
  }
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => report.pageErrors.push(String(e)));
  await page.goto(origin);
  const workspace = () => page.locator('.opportunity-workspace:visible');
  const sidebar = () => page.getByRole('region', { name: '机会卡片主题' });
  const dialog = () => page.getByRole('dialog');
  const ensureSidebar = async () => { if (!(await page.locator('.sidebar').evaluate(e => e.classList.contains('open'))) && (await page.viewportSize()).width <= 720) await page.getByRole('button', { name: '打开侧栏', exact: true }).first().click(); };
  const openTopic = async n => { await ensureSidebar(); await sidebar().locator('[data-opportunity-topic="' + topics[n].id + '"] .project-select').click(); await workspace().locator('h1').filter({ hasText: names[n] }).waitFor(); };
  const openCard = async n => { if (store.idea(user, ideas[n].id).manual_processed) await workspace().getByRole('navigation', { name: '已处理卡片总览' }).getByRole('button', { name: /暂放 \/ 已反馈/ }).click(); await workspace().locator('[data-opportunity-idea="' + ideas[n].id + '"]').getByRole('button', { name: /查看与反馈|查看详情/ }).click(); await dialog().getByRole('heading', { name: '专属卡片 ' + n, exact: true }).waitFor(); await dialog().getByRole('textbox', { name: '反馈（可选）' }).waitFor(); };
  const until = async fn => { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(50); } throw new Error('UI condition timed out'); };
  await openTopic(0); assert.equal(await workspace().locator('.opportunity-card').count(), 1); assert.ok((await workspace().innerText()).includes('专属卡片 0')); assert.ok(!(await workspace().innerText()).includes('专属卡片 1'));
  assert.equal(await sidebar().locator('[aria-current=page]').count(), 1);
  await openTopic(1); assert.ok((await workspace().innerText()).includes('专属卡片 1'));
  await workspace().getByRole('combobox', { name: '发现主题' }).selectOption(topics[0].id); await until(async () => (await sidebar().locator('[aria-current=page]').innerText()).includes(names[0]));
  await sidebar().getByRole('button', { name: '查看全部主题', exact: true }).click(); await until(async () => (await workspace().locator('.opportunity-card').count()) === 2);
  await openTopic(1); await page.reload(); await sidebar().locator('[data-opportunity-topic="' + topics[1].id + '"] .project-select').click(); await workspace().locator('h1').filter({ hasText: names[1] }).waitFor();
  report.checks.push('direct_topic_navigation_filter_dropdown_sync_all_topics_reload'); save();
  const search = page.getByRole('textbox', { name: '搜索', exact: true }); await search.fill('合成游戏'); assert.equal(await sidebar().locator('[data-opportunity-topic]').count(), 1); await search.fill('');
  await sidebar().getByRole('button', { name: '新建机会主题', exact: true }).click(); await dialog().getByRole('textbox', { name: '主题名称' }).fill('新建主题验收'); await dialog().getByRole('combobox', { name: '服务器项目' }).selectOption(project.id); await dialog().getByRole('textbox', { name: '目标与方向' }).fill('验证侧栏即时更新'); await dialog().getByRole('button', { name: '保存主题', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); await sidebar().locator('.project-select').filter({ hasText: '新建主题验收' }).waitFor();
  await workspace().getByRole('button', { name: '主题设置', exact: true }).click(); await dialog().getByRole('textbox', { name: '主题名称' }).fill('已改名主题'); await dialog().getByRole('button', { name: '保存主题', exact: true }).click(); await sidebar().locator('.project-select').filter({ hasText: '已改名主题' }).waitFor();
  await workspace().getByRole('button', { name: '主题设置', exact: true }).click(); page.once('dialog', d => d.accept()); await dialog().getByRole('button', { name: '归档主题', exact: true }).click(); await sidebar().locator('.project-select').filter({ hasText: '已改名主题' }).waitFor({ state: 'hidden' });
  await sidebar().getByRole('button', { name: '查看归档主题', exact: true }).click(); await sidebar().locator('.project-select').filter({ hasText: '已改名主题' }).click(); await workspace().getByRole('button', { name: '主题设置', exact: true }).click(); await dialog().getByRole('button', { name: '恢复主题', exact: true }).click(); await workspace().getByRole('button', { name: '主题设置', exact: true }).click(); page.once('dialog', d => d.accept()); await dialog().getByRole('button', { name: '删除主题', exact: true }).click(); await sidebar().locator('.project-select').filter({ hasText: '已改名主题' }).waitFor({ state: 'hidden' });
  report.checks.push('sidebar_search_create_rename_archive_restore_delete_live_sync'); save();
  await page.route('**/api/opportunities/topics', r => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled topic-list failure' }) })); await page.evaluate(() => window.dispatchEvent(new Event('opportunities-updated'))); await sidebar().getByRole('alert').waitFor(); assert.equal(await sidebar().locator('[data-opportunity-topic]').count(), 2); await page.unroute('**/api/opportunities/topics'); await sidebar().getByRole('button', { name: '重试读取主题', exact: true }).click(); await sidebar().getByRole('alert').waitFor({ state: 'hidden' });
  report.checks.push('topic_read_failure_preserves_list_and_retry_recovers'); save();
  const slow = deferred(); let held = false;
  await page.route('**/api/opportunities?*', async route => { const url = new URL(route.request().url()); const response = await route.fetch(); if (url.searchParams.get('topicId') === topics[0].id && !held) { held = true; await slow.promise; } await route.fulfill({ response }); });
  await sidebar().locator('[data-opportunity-topic="' + topics[0].id + '"] .project-select').click(); await until(() => held);
  await openTopic(1); slow.resolve(); await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await workspace().locator('.opportunity-card').count(), 1); assert.ok((await workspace().innerText()).includes('专属卡片 1'));
  report.checks.push('late_topic_response_cannot_replace_new_selection'); save();

  await openTopic(0); await openCard(0);
  const note = () => dialog().getByRole('textbox', { name: '反馈（可选）' }); const mic = () => dialog().getByRole('button', { name: '语音输入', exact: true }); const stop = () => dialog().getByRole('button', { name: '停止录音并识别', exact: true });
  await note().fill('先输入'); await page.evaluate(() => window.__denyMicrophone = true); await mic().click(); await dialog().locator('.voice-error').waitFor(); assert.equal(await note().inputValue(), '先输入'); await page.evaluate(() => window.__denyMicrophone = false); report.checks.push('microphone_permission_failure_preserves_typed_feedback'); await mic().click(); await dialog().locator('canvas[aria-label="实时音量波形"]').waitFor(); await until(async () => dialog().locator('canvas').evaluate(c => c.width > 1 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some(v => v !== 0))); await note().fill('先输入，录音时补充'); assert.equal(await dialog().getByRole('button', { name: '保存反馈', exact: true }).isDisabled(), true); await stop().click(); await until(() => gates.length === 1); assert.equal(await dialog().getByRole('button', { name: '关闭弹窗', exact: true }).isDisabled(), true); await page.keyboard.press('Escape'); assert.equal(await dialog().count(), 1); gates[0].resolve(); await until(async () => (await note().inputValue()).includes('recognized feedback 0'));
  assert.equal(await note().inputValue(), '先输入，录音时补充\nrecognized feedback 0'); await note().fill((await note().inputValue()) + '，确认后保存'); const saved = page.waitForResponse(r => r.url().endsWith('/feedback') && r.request().method() === 'POST'); await dialog().getByRole('button', { name: '保存反馈', exact: true }).click(); assert.equal((await saved).status(), 200); await until(async () => (await api('GET', '/opportunities/ideas/' + ideas[0].id)).idea.note.endsWith('确认后保存'));
  report.checks.push('recording_waveform_latest_typed_text_stop_recognition_manual_save_real_api'); save();
  await mic().click(); await dialog().getByRole('button', { name: '取消录音', exact: true }).click(); assert.equal(attempt, 1); assert.ok((await note().inputValue()).endsWith('确认后保存'));
  await mic().click(); await stop().click(); await until(() => gates.length === 2); gates[1].resolve(); await dialog().getByRole('button', { name: '重试识别语音', exact: true }).waitFor(); await dialog().getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await openTopic(1); await openCard(1); assert.equal(await note().inputValue(), ''); assert.equal(await dialog().getByRole('button', { name: '重试识别语音', exact: true }).count(), 0); await dialog().getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await openTopic(0); await openCard(0); await dialog().getByRole('button', { name: '重试识别语音', exact: true }).click(); await until(() => gates.length === 3); gates[2].resolve(); await until(async () => (await note().inputValue()).includes('recognized feedback 2'));
  report.checks.push('cancel_no_request_failure_audio_restores_only_same_card_retry_appends'); save();
  await note().fill('测'.repeat(6000)); await mic().click(); await stop().click(); await until(() => gates.length === 4); gates[3].resolve();
  await until(async () => (await note().inputValue()).includes('recognized feedback 3')); assert.ok((await note().inputValue()).length > 6000); await dialog().getByText('文字已保留，请精简到 6000 字以内再保存。', { exact: true }).waitFor(); assert.equal(await dialog().getByRole('button', { name: '保存反馈', exact: true }).isDisabled(), true); await note().fill('缩短后的可编辑备注');
  report.checks.push('long_transcript_retained_with_explicit_limit_before_save'); save();
  const typed = await note().inputValue(); await dialog().getByRole('button', { name: '关闭弹窗', exact: true }).click(); await openCard(0); assert.equal(await note().inputValue(), typed);
  report.checks.push('unsaved_feedback_text_restores_per_account_and_card'); save();
  for (const width of [1440, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow ' + width);
    assert.ok(await dialog().evaluate(e => e.scrollWidth <= e.clientWidth), 'dialog overflow ' + width);
    await mic().scrollIntoViewIfNeeded(); const box = await mic().boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
    await mic().click(); await stop().scrollIntoViewIfNeeded(); assert.ok(await dialog().evaluate(e => e.scrollWidth <= e.clientWidth), 'recording overflow ' + width);
    if (width === 390) await dialog().screenshot({ path: output + '/feedback-' + theme + '.png' });
    await dialog().getByRole('button', { name: '取消录音', exact: true }).click();
  }
  await page.evaluate(() => document.documentElement.style.fontSize = '200%'); assert.ok(await dialog().evaluate(e => e.scrollWidth <= e.clientWidth)); await page.evaluate(() => document.documentElement.style.fontSize = '');
  await dialog().getByRole('button', { name: '关闭弹窗', exact: true }).click(); await ensureSidebar(); await sidebar().screenshot({ path: output + '/sidebar-mobile.png' });
  report.checks.push('light_dark_320_390_768_1440_waveform_touch_targets_200_percent_text');
  assert.deepEqual(report.pageErrors, []); report.ok = true;
} catch (e) { report.error = String(e.stack); process.exitCode = 1; await page?.screenshot({ path: output + '/failure.png' }).catch(() => {}); }
finally { clearTimeout(deadline); for (const gate of gates) gate.resolve(); await browser?.close(); instance.beginShutdown(); await instance.waitForBackgroundTasks(); server.closeAllConnections(); await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); save(); console.log(JSON.stringify(report)); }
