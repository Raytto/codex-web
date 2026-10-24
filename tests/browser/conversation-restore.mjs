import fs from 'node:fs';
import path from 'node:path';

// Real fixture CRUD; inject restore responses to cover failure/wait UI without
// corrupting a user's cloud archive. Backend tests exercise actual flock/restore.
export async function run({page, context, origin, work, assert}) {
  const report = {checks: [], stage: 'setup', cleanup: false};
  const save = () => fs.writeFileSync(path.join(work, 'feature.json'), JSON.stringify(report, null, 2));
  const session = await (await context.request.get(origin + '/api/auth/session')).json();
  const api = async (method, route, data) => {
    const r = await context.request.fetch(origin + '/api' + route, {method, data, headers:{Origin:origin,'X-CSRF-Token':session.csrfToken}});
    assert.ok(r.ok(), 'Fixture API status ' + r.status());
    return r.status() === 204 ? null : r.json();
  };
  const projects = (await api('GET','/projects')).projects;
  const project = projects.find(p => !p.archived_at && !p.executor_id.startsWith('remote:'));
  const c = (await api('POST','/conversations',{projectId:project.id,reuseEmpty:false})).conversation;
  report.fixtureId = c.id; save();
  let mode = 'waiting', detailReads = 0, activations = 0;
  const routePath = '**/api/conversations/' + c.id;
  // Exercise the polling fallback independently of unrelated live quota and
  // conversation pushes, which legitimately cause extra detail refreshes.
  await page.route('**/api/system/events', route => route.fulfill({status:204}));
  const cold = () => ({...c,cold_storage_state:mode === 'error' ? 'error' : 'restoring',cold_storage_error:mode === 'waiting' ? 'codex_runtime_active' : mode === 'error' ? 'fixture_archive_error' : null});
  const reply = (route, body) => route.fulfill({status:202,contentType:'application/json',body:JSON.stringify(body)});
  await page.route(routePath+'/activate', async route => {
    activations++;
    if (mode === 'local') return route.continue();
    return reply(route,{state:'restoring',restoring:true,conversation:cold()});
  });
  await page.route(routePath, async route => {
    detailReads++;
    if (mode === 'local') return route.continue();
    return reply(route,{state:mode === 'error' ? 'error' : 'restoring',restoring:true,conversation:cold()});
  });
  try {
    for (const width of [1440,390]) {
      report.stage = 'waiting-' + width; save(); mode = 'waiting';
      await page.setViewportSize({width,height:844});
      await page.goto(origin+'/?conversation='+c.id);
      await page.getByText('同账号其他任务正在运行，结束后会自动恢复。',{exact:true}).waitFor();
      assert.equal(await page.locator('.conversation-loading .spin').count(),1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      mode = 'error';
      const retry = page.getByRole('button',{name:'重试恢复历史',exact:true});
      await retry.waitFor();
      assert.equal(await page.locator('.conversation-loading .spin').count(),0);
      const count = detailReads;
      await page.waitForTimeout(3500); assert.equal(detailReads,count,'permanent failure must stop polling');
      const before = activations; mode = 'local';
      await retry.click();
      await page.locator('.conversation-loading').waitFor({state:'hidden'});
      assert.equal(activations,before+1,'retry must explicitly reactivate once');
      report.checks.push('waiting_error_retry_' + width); save();
    }
    report.stage = 'automatic-recovery'; save(); mode = 'waiting';
    await page.reload();
    await page.getByText('正在等待恢复历史',{exact:true}).waitFor();
    const before = activations; mode = 'local';
    await page.locator('.conversation-loading').waitFor({state:'hidden'});
    assert.equal(activations,before,'polling must not reactivate or duplicate restores');
    report.checks.push('waiting_automatically_displays_restored_history'); save();
  } catch (error) {
    report.error = String(error.message).split('\n')[0].slice(0,250); save(); throw error;
  } finally {
    await page.unroute('**/api/system/events');
    await page.unroute(routePath); await page.unroute(routePath+'/activate');
    await api('DELETE','/conversations/'+c.id); report.cleanup = true; save();
  }
}
