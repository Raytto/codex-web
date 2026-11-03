import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Run with a private login context, initially on /?conversation=invalid so the
// application cannot automatically activate a personal historical conversation.
export async function run({ page, context, origin, work, assert }) {
  const report = { stage: 'setup', checks: [], viewports: [], pageErrors: [], unexpectedActivations: [], unexpectedWrites: [], cleanup: false };
  const save = () => fs.writeFileSync(path.join(work, 'sidebar-controls.json'), JSON.stringify(report, null, 2));
  const stage = name => { report.stage = name; save(); };
  const until = async fn => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await fn()) return; await page.waitForTimeout(40); }
    assert.fail('Timed out: ' + report.stage);
  };
  const session = await (await context.request.get(origin + '/api/auth/session')).json();
  const api = async (method, route, data) => {
    const response = await context.request.fetch(origin + '/api' + route, { method, data, headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken } });
    assert.ok(response.ok(), method + ' ' + route + ' ' + response.status());
    return response.status() === 204 ? null : response.json();
  };
  const before = (await api('GET', '/opportunities/topics')).topics;
  const active = before.filter(t => !t.archived_at), archived = before.filter(t => t.archived_at);
  assert.equal(active.length, 4); assert.equal(archived.length, 2);
  const stable = topics => topics.map(t => ({ id: t.id, name: t.name, archived_at: t.archived_at, revision: t.revision, task: t.task }));
  let fixture, mobile;
  const guard = async ctx => {
    await ctx.route('**/api/conversations/*/activate', route => {
      if (new URL(route.request().url()).pathname === `/codex-web/api/conversations/${fixture.id}/activate`) return route.continue();
      report.unexpectedActivations.push('blocked_nonfixture_activation'); save(); return route.abort();
    });
    await ctx.route('**/api/opportunities/**', route => {
      if (route.request().method() === 'GET') return route.fallback();
      report.unexpectedWrites.push(route.request().method()); save(); return route.abort();
    });
  };
  const observe = p => p.on('pageerror', () => { report.pageErrors.push('pageerror'); save(); });
  const group = p => p.locator('[data-extension-group="opportunities"]');
  const rows = p => group(p).locator('[data-opportunity-topic]');
  const absentFooters = async p => assert.equal(await group(p).locator('.opportunity-sidebar > button').filter({ hasText: /查看全部主题|展开全部|查看归档主题|隐藏归档主题/ }).count(), 0);
  const openSidebar = async (p, touch = false) => {
    const button = p.getByRole('button', { name: '打开侧栏', exact: true });
    if (await button.isVisible() && !(await p.locator('.sidebar').evaluate(e => e.classList.contains('open')))) await button[touch ? 'tap' : 'click']();
    await group(p).scrollIntoViewIfNeeded();
  };
  const expand = async (p, touch = false) => {
    await openSidebar(p, touch);
    const toggle = group(p).locator('.extension-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle[touch ? 'tap' : 'click']();
  };
  const toggleArchives = async (p, show, touch = false) => {
    await group(p).getByRole('button', { name: '机会卡片操作', exact: true })[touch ? 'tap' : 'click']();
    await p.getByRole('menuitem', { name: show ? '查看归档主题' : '隐藏归档主题', exact: true })[touch ? 'tap' : 'click']();
  };
  try {
    const projects = (await api('GET', '/projects')).projects;
    const project = projects.find(p => !p.archived_at && ['host', 'tenant-local', 'local'].includes(p.executor_id)) || projects.find(p => !p.archived_at && !p.executor_id.startsWith('remote:'));
    assert.ok(project);
    fixture = (await api('POST', '/conversations', { projectId: project.id, reuseEmpty: false })).conversation;
    report.fixtureId = fixture.id; save();
    const link = origin + '/?conversation=' + fixture.id;
    await guard(context); observe(page);
    await page.goto(link); await expand(page); await until(async () => await rows(page).count() === active.length);
    stage('real_default_four_active_two_archived');
    await absentFooters(page);
    assert.deepEqual(await rows(page).evaluateAll(es => es.map(e => e.dataset.opportunityTopic)), active.map(t => t.id));
    assert.deepEqual(await rows(page).locator('.opportunity-topic-count').allTextContents(), active.map(t => `（${t.pending_count}）`));
    report.checks.push('real_default_all_active_visible_no_footer_controls_counts_retained');

    stage('real_archive_menu_desktop_and_mobile_matrix');
    mobile = await context.browser().newContext({ storageState: await context.storageState(), viewport: { width: 382, height: 580 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await guard(mobile);
    const phone = await mobile.newPage(); observe(phone); await phone.goto(link);
    const matrix = [[1440,900],[1280,800],[382,580],[382,618],[594,368],[594,406],[669,867],[669,902],[951,585],[951,620],[385,571],[385,609],[390,844],[402,874]];
    for (const [width, height] of matrix) {
      const touch = width !== 1440 && width !== 1280, p = touch ? phone : page;
      await p.setViewportSize({ width, height }); await expand(p, touch);
      await until(async () => await rows(p).count() === active.length);
      const location = p.url();
      await absentFooters(p); await toggleArchives(p, true, touch);
      await until(async () => await rows(p).count() === before.length);
      assert.deepEqual(await rows(p).evaluateAll(es => es.map(e => e.dataset.opportunityTopic)), before.map(t => t.id));
      assert.equal(await group(p).locator('[data-sortable="false"] .opportunity-topic-grip:disabled').count(), archived.length);
      await absentFooters(p); await toggleArchives(p, false, touch);
      await until(async () => await rows(p).count() === active.length);
      assert.equal(p.url(), location); assert.equal(await p.locator('.opportunity-workspace:visible').count(), 0);
      const toggle = group(p).locator('.extension-toggle'); await toggle[touch ? 'tap' : 'click']();
      assert.equal(await group(p).locator('.extension-body').isVisible(), false);
      await toggle[touch ? 'tap' : 'click'](); assert.equal(await rows(p).count(), active.length);
      assert.ok(await p.locator('.sidebar-content').evaluate(e => e.scrollWidth <= e.clientWidth + 1));
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width === 1440 || width === 382 && height === 580) await group(p).screenshot({ path: path.join(work, `sidebar-${width}.png`) });
      report.viewports.push({ width, height, touch, archiveToggle: true, collapse: true, selectionPreserved: true }); save();
    }
    report.checks.push('real_archive_show_hide_and_group_collapse_14_viewports');
    await mobile.close(); mobile = null;
    await page.setViewportSize({ width: 1440, height: 900 }); await expand(page);

    stage('real_topic_and_overview_navigation');
    await rows(page).first().locator('.project-select').click();
    await page.locator('.opportunity-workspace:visible').waitFor();
    await until(async () => await page.locator('.opportunity-workspace:visible select').first().inputValue() === active[0].id);
    await group(page).getByRole('button', { name: '机会卡片操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '查看全部主题', exact: true }).click();
    await until(async () => await page.locator('.opportunity-workspace:visible select').first().inputValue() === '');
    report.checks.push('real_topic_click_and_menu_overview_keep_original_navigation_semantics');
    await page.goto(link); await expand(page);

    // Controlled responses exercise list boundaries without changing production
    // topics, archived state, order, cards or recurring discovery schedules.
    stage('controlled_list_boundaries');
    let synthetic = [], mode = 'ok', release;
    const template = active[0];
    const make = (count, archivedCount = 0) => Array.from({ length: count + archivedCount }, (_, i) => ({ ...template, id: crypto.randomUUID(), name: `Fixture ${i + 1}`, pending_count: i, archived_at: i >= count ? '2026-01-01T00:00:00Z' : null, task_id: null, task: null }));
    await page.route('**/api/opportunities/topics', async route => {
      if (mode === 'hold') await new Promise(resolve => { release = resolve; });
      await route.fulfill({ status: mode === 'fail' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(mode === 'fail' ? { error: 'Fixture read failure' } : { topics: synthetic }) });
    });
    const refresh = async expected => { await page.evaluate(() => window.dispatchEvent(new Event('opportunities-updated'))); await until(async () => await rows(page).count() === expected); };
    for (const [count, archivedCount] of [[0,0],[1,0],[4,2],[8,2],[0,2]]) {
      synthetic = make(count, archivedCount); await refresh(count); await absentFooters(page);
      assert.deepEqual(await rows(page).evaluateAll(es => es.map(e => e.dataset.opportunityTopic)), synthetic.slice(0, count).map(t => t.id));
      await toggleArchives(page, true); await until(async () => await rows(page).count() === count + archivedCount); await absentFooters(page);
      await toggleArchives(page, false); await until(async () => await rows(page).count() === count);
    }
    report.checks.push('controlled_empty_one_four_eight_and_archived_only_all_matching_rows_rendered');
    synthetic = make(8,2); await refresh(8);
    const search = page.getByRole('textbox', { name: '搜索', exact: true });
    await search.fill('Fixture 8'); await until(async () => await rows(page).count() === 1); await absentFooters(page);
    assert.equal(await rows(page).first().getAttribute('data-opportunity-topic'), synthetic[7].id);
    assert.equal(await rows(page).locator('.opportunity-topic-grip').isDisabled(), true);
    await toggleArchives(page, true); assert.equal(await rows(page).count(), 1);
    await search.fill('Fixture 10'); await until(async () => await rows(page).count() === 1);
    await toggleArchives(page, false); await until(async () => await rows(page).count() === 0); await absentFooters(page);
    await group(page).getByText('没有匹配的机会主题', { exact: true }).waitFor();
    await search.fill(''); await until(async () => await rows(page).count() === 8);
    report.checks.push('controlled_search_respects_archive_filter_and_disables_sort');

    stage('controlled_keyboard_and_pointer_sort');
    const moves = [];
    await page.route('**/api/opportunities/topics/reorder', async route => {
      const data = route.request().postDataJSON(); moves.push(data);
      const source = synthetic.find(t => t.id === data.sourceId); synthetic = synthetic.filter(t => t.id !== source.id);
      const index = synthetic.findIndex(t => t.id === data.targetId); synthetic.splice(index + (data.placement === 'after' ? 1 : 0), 0, source);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ topics: synthetic }) });
    });
    const first = synthetic[0].id, second = synthetic[1].id;
    await rows(page).first().locator('.opportunity-topic-grip').press('ArrowDown');
    await until(() => moves.length === 1); assert.deepEqual(moves[0], { sourceId: first, targetId: second, placement: 'after' });
    await until(async () => await rows(page).first().getAttribute('data-opportunity-topic') === second);
    const grip = rows(page).first().locator('.opportunity-topic-grip'); await grip.scrollIntoViewIfNeeded();
    const a = await grip.boundingBox(), b = await rows(page).nth(2).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height - 4, { steps: 10 }); await page.mouse.up();
    await until(() => moves.length === 2); assert.equal(moves[1].sourceId, second); assert.equal(moves[1].placement, 'after');
    report.checks.push('controlled_keyboard_and_pointer_sort_requests_and_visible_order');

    stage('controlled_loading_error_retry');
    mode = 'hold'; await page.reload({ waitUntil: 'domcontentloaded' }); await expand(page);
    await group(page).getByRole('status').waitFor(); await absentFooters(page);
    await until(() => Boolean(release)); mode = 'fail'; release();
    await group(page).getByRole('alert').waitFor(); await absentFooters(page);
    mode = 'ok'; await group(page).getByRole('button', { name: '重试读取主题' }).click();
    await until(async () => await rows(page).count() === 8);
    assert.equal(await group(page).getByRole('alert').count(), 0);
    report.checks.push('controlled_loading_failure_and_real_retry_button');
    await page.unroute('**/api/opportunities/topics'); await page.unroute('**/api/opportunities/topics/reorder');
    await refresh(active.length); await absentFooters(page);
    assert.deepEqual(stable((await api('GET', '/opportunities/topics')).topics), stable(before));
    assert.deepEqual(report.unexpectedActivations, []); assert.deepEqual(report.unexpectedWrites, []); assert.deepEqual(report.pageErrors, []);
    report.checks.push('production_topic_order_revision_archive_and_schedules_unchanged');
    report.ok = true;
  } catch (error) {
    report.ok = false; report.error = String(error.stack || error); throw error;
  } finally {
    await mobile?.close();
    await page.goto('about:blank');
    if (fixture) {
      await api('DELETE', `/conversations/${fixture.id}`);
      assert.equal((await context.request.get(origin + `/api/conversations/${fixture.id}/navigation`)).status(), 404);
    }
    report.cleanup = true; save();
  }
}
