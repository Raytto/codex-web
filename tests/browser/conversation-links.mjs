import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Dedicated conversations only; no model runs or edits to existing conversations.
export async function run({ page, context, origin, work, assert, regression = false }) {
  const report = { checks: [], conversationIds: [], createdConversationIds: [], cleanup: false, stage: 'setup', pageErrors: [] };
  const save = () => fs.writeFileSync(path.join(work, 'feature.json'), JSON.stringify(report, null, 2));
  const stage = name => { report.stage = name; save(); };
  const session = await (await context.request.get(origin + '/api/auth/session')).json();
  const api = async (method, route, data) => {
    const response = await context.request.fetch(origin + '/api' + route, { method, data, headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken } });
    assert.ok(response.ok(), method + ' ' + route + ' ' + response.status());
    return response.status() === 204 ? null : response.json();
  };
  const until = async fn => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(50); }
    assert.fail('Timed out: ' + report.stage);
  };
  const link = id => origin + '/?conversation=' + id;
  const selected = id => page.locator(`.conversation-row[data-conversation-id="${id}"]`);
  const ensureSidebar = async () => {
    if (page.viewportSize().width <= 720 && !(await page.locator('.sidebar').evaluate(el => el.classList.contains('open')))) {
      await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
    }
  };
  const open = async id => {
    await ensureSidebar();
    await selected(id).locator('.conversation-select').click();
  };
  const assertCurrent = async c => {
    await page.locator('.workspace-header').getByText(c.title, { exact: true }).waitFor();
    await until(async () => new URL(page.url()).searchParams.get('conversation') === c.id);
    await until(async () => await page.locator('.conversation-loading').count() === 0);
  };
  const projects = (await api('GET', '/projects')).projects.filter(p => !p.archived_at && !p.executor_id.startsWith('remote:'));
  assert.ok(projects.length >= 2, 'Two local fixture projects are required');
  const prefix = '链接验收-' + crypto.randomUUID().slice(0, 8), cards = [];
  let second, guest;
  page.on('pageerror', error => { report.pageErrors.push(error.message); save(); });
  try {
    for (let i = 0; i < 8; i++) {
      const c = (await api('POST', '/conversations', { projectId: projects[i === 1 ? 1 : 0].id, reuseEmpty: false })).conversation;
      report.conversationIds.push(c.id); report.createdConversationIds.push(c.id); save();
      c.title = prefix + '-' + i;
      await api('PATCH', `/conversations/${c.id}`, { title: c.title });
      cards.push(c);
    }
    const [a, b] = cards;
    stage('direct_link_overrides_saved_selection');
    await page.evaluate(({ account, wrong }) => {
      localStorage.setItem(`cww:account:${encodeURIComponent(account)}:selected-project`, wrong.project_id);
      localStorage.setItem(`cww:account:${encodeURIComponent(account)}:selected-conversation`, wrong.id);
    }, { account: session.accountId, wrong: b });
    await page.goto(link(a.id)); await assertCurrent(a);
    assert.ok(await selected(a.id).count(), 'Old conversation retained beyond first page');
    report.checks.push('direct_link_overrides_saved_selection_and_loads_old_conversation'); save();

    stage('reload_and_fresh_tab');
    await page.reload(); await assertCurrent(a);
    second = await context.newPage();
    await second.goto(link(a.id));
    await second.locator('.workspace-header').getByText(a.title, { exact: true }).waitFor();
    await second.close(); second = null;
    report.checks.push('reload_and_new_tab_open_same_conversation');

    stage('click_and_history');
    // The first sidebar page can contain an older retained selection too.
    await open(cards[7].id); await assertCurrent(cards[7]);
    await page.goBack(); await assertCurrent(a);
    await page.goForward(); await assertCurrent(cards[7]);
    report.checks.push('sidebar_click_updates_url_and_back_forward_restore_conversation');

    stage('cross_project_and_copy');
    await page.goto(link(b.id)); await assertCurrent(b);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.getByLabel('会话操作', { exact: true }).click();
    await page.getByRole('menuitem', { name: '复制会话链接', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link(b.id));
    report.checks.push('cross_project_resolution_and_header_copy');
    await ensureSidebar();
    await selected(b.id).hover();
    await selected(b.id).getByRole('button', { name: `任务 ${b.title} 操作`, exact: true }).click();
    await page.getByRole('menuitem', { name: '复制会话链接', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link(b.id));
    report.checks.push('sidebar_copy');

    stage('mobile');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(link(a.id)); await assertCurrent(a);
    await open(cards[7].id); await assertCurrent(cards[7]);
    await page.goBack(); await assertCurrent(a);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    report.checks.push('mobile_direct_navigation_switch_and_history');
    await page.setViewportSize({ width: 1440, height: 900 });

    stage('moved_conversation');
    await api('PUT', `/conversations/${a.id}/project`, { projectId: b.project_id });
    await page.goto(link(a.id)); await assertCurrent(a);
    assert.equal((await api('GET', `/conversations/${a.id}/navigation`)).conversation.project_id, b.project_id);
    report.checks.push('same_link_survives_conversation_move');

    stage('archived_link');
    await api('POST', `/conversations/${a.id}/archive`);
    await page.goto(link(a.id)); await assertCurrent(a);
    await page.locator('.archived-conversation-banner').waitFor();
    report.checks.push('archived_conversation_link_stays_readable');

    stage('deleted_and_invalid_links');
    await api('DELETE', `/conversations/${a.id}`);
    report.conversationIds = report.conversationIds.filter(id => id !== a.id); save();
    await page.goto(link(a.id));
    await page.getByRole('alert').filter({ hasText: '会话不存在或当前账号无权访问' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('conversation'), a.id);
    assert.equal(await page.locator('.composer').count(), 0);
    await page.goto(origin + '/?conversation=invalid');
    await page.getByRole('alert').filter({ hasText: '会话链接无效' }).waitFor();
    report.checks.push('deleted_and_invalid_links_do_not_open_other_conversation');

    if (regression) {
      stage('transient_failure_and_retry');
      let fail = true;
      await page.route('**/api/conversations/' + b.id + '/navigation', async route => {
        if (fail) { fail = false; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary test failure"}' }); }
        else await route.continue();
      });
      await page.goto(link(b.id)); await page.getByRole('alert').filter({ hasText: '暂时无法打开' }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('conversation'), b.id);
      await page.getByRole('button', { name: '重试打开会话' }).click(); await assertCurrent(b);
      await page.unroute('**/api/conversations/' + b.id + '/navigation');
      report.checks.push('transient_error_preserves_link_and_retry_recovers');

      stage('slow_link_loses_to_manual_selection');
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/conversations/' + cards[6].id + '/navigation', async route => { await gate; await route.continue().catch(() => {}); });
      await page.goto(link(cards[6].id));
      await open(b.id);
      release(); await page.unroute('**/api/conversations/' + cards[6].id + '/navigation');
      await assertCurrent(b); await page.waitForTimeout(200);
      assert.equal(new URL(page.url()).searchParams.get('conversation'), b.id);
      report.checks.push('late_link_response_cannot_override_manual_selection');

      stage('archive_selection_interrupts_link_loading');
      await api('POST', `/conversations/${b.id}/archive`);
      let releaseArchive;
      const archiveGate = new Promise(resolve => { releaseArchive = resolve; });
      await page.route('**/api/conversations/' + cards[6].id + '/navigation', async route => { await archiveGate; await route.continue().catch(() => {}); });
      await page.goto(link(cards[6].id));
      await page.locator('.account-profile').click();
      await page.getByRole('button', { name: '查看已归档的会话', exact: true }).click();
      await page.locator('.archived-conversation-open').filter({ hasText: b.title }).click();
      releaseArchive(); await page.unroute('**/api/conversations/' + cards[6].id + '/navigation');
      await assertCurrent(b);
      await page.locator('.archived-conversation-banner').waitFor();
      report.checks.push('manual_archive_navigation_cancels_pending_link_loading');
    }

    stage('guest_link_preserves_destination');
    guest = await context.browser().newContext();
    const gp = await guest.newPage(); await gp.goto(link(b.id));
    await gp.locator('.login-page').waitFor();
    assert.equal(new URL(gp.url()).searchParams.get('conversation'), b.id);
    await guest.close(); guest = null;
    report.checks.push('unauthenticated_visit_keeps_link_for_login');
    assert.deepEqual(report.pageErrors, []);
  } catch (error) {
    report.error = { name: error.name, summary: String(error.message).split('\n')[0].slice(0, 300), frames: String(error.stack).split('\n').filter(line => line.includes('conversation-links')).slice(0, 2) };
    throw error;
  } finally {
    await second?.close(); await guest?.close();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const id of [...report.conversationIds]) {
      await api('DELETE', `/conversations/${id}`);
      report.conversationIds = report.conversationIds.filter(value => value !== id); save();
    }
    report.cleanup = true; save();
  }
}
