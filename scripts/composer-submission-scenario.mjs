// Real browser/API/SQLite; only network stalls and rejected steering are injected.
// Production-safe: all fixtures are held by a future wake, so no model jobs start.
export async function run({ context, origin, assert, expectBug = false }) {
  const session = await (await context.request.get(`${origin}/api/auth/session`)).json();
  const headers = { 'x-csrf-token': session.csrfToken };
  const api = async (url, method = 'GET', data) => {
    const response = await context.request.fetch(`${origin}/api${url}`, { method, headers, data });
    assert.ok(response.ok(), `${method} ${url}: ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  };
  const projects = await api('/projects');
  const projectId = projects.defaultProjectId || projects.projects[0]?.id;
  const results = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const created = await api('/conversations', 'POST', { projectId, reuseEmpty: false });
    const id = created.conversation.id;
    const page = await context.newPage();
    const releases = [];
    page.setDefaultTimeout(10000);
    await page.setViewportSize(viewport);
    const input = page.locator('.composer textarea');
    const idle = (value) => page.waitForFunction((expected) => {
      const element = document.querySelector('.composer textarea');
      return element && !element.disabled && element.value === expected;
    }, value);
    const hold = async (url, method, deliver) => {
      let release, captured;
      const paused = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { captured = resolve; });
      releases.push(release);
      let claimed = false;
      await page.route(url, async (route) => {
        if (claimed || route.request().method() !== method) return route.continue();
        claimed = true;
        const response = deliver ? null : await route.fetch();
        captured(); await paused;
        try { await route.fulfill(deliver || { response }); } catch { /* request may have timed out */ }
      });
      return { ready, release };
    };
    try {
      await api(`/conversations/${id}`, 'PATCH', { title: 'Composer submission acceptance' });
      await api(`/conversations/${id}/wake-plans`, 'POST', { delaySeconds: 86400,
        label: 'Composer submission verification', prompt: 'Removed before execution.', newConversation: false, ...created.agentSelection });
      await context.request.post(`${origin}/api/conversations/${id}/messages`, { headers, multipart: { message: 'queued fixture' } });
      await page.addInitScript(({ accountId, projectId, id }) => {
        const prefix = `cww:account:${encodeURIComponent(accountId)}:`;
        localStorage.setItem(prefix + 'selected-project', projectId);
        localStorage.setItem(prefix + 'selected-conversation', id);
      }, { accountId: session.accountId, projectId, id });
      await page.goto(origin); await idle('');
      await page.locator('.steer-action').first().waitFor();
      await input.fill('submitted while detail stalls');
      const refresh = await hold(`${origin}/api/conversations/${id}`, 'GET');
      const sent = page.waitForResponse((r) => r.url().endsWith(`/${id}/messages`) && r.request().method() === 'POST');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      assert.equal((await sent).status(), 202); await refresh.ready;
      if (expectBug) {
        await page.waitForTimeout(100);
        assert.equal(await input.isDisabled(), true);
        assert.equal(await page.locator('.steer-action').first().isDisabled(), true);
        results.push({ viewport, reproducedSharedLock: true });
        continue;
      }
      await idle('');
      assert.equal(await page.locator('.steer-action').first().isEnabled(), true);
      await input.fill('next draft remains editable');
      refresh.release();
      await page.unrouteAll({ behavior: 'wait' });
      await page.waitForTimeout(100);
      assert.equal(await input.inputValue(), 'next draft remains editable');

      const steer = await hold('**/pending-prompts/*/steer', 'POST', {
        status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Injected steering rejection' }),
      });
      await page.locator('.steer-action').first().click(); await steer.ready;
      assert.equal(await input.isEnabled(), true, 'Steering confirmation must not lock the composer');
      await input.fill('typed during steering');
      steer.release();
      await page.getByText('Injected steering rejection', { exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.steer-action').disabled);
      assert.equal(await input.inputValue(), 'typed during steering');
      await page.unrouteAll({ behavior: 'wait' });

      // Speed only the production 45-second deadline, preserving actual fetch abort behavior.
      await page.evaluate(() => {
        const original = window.setTimeout.bind(window);
        window.setTimeout = (fn, ms, ...args) => original(fn, ms === 45000 ? 250 : ms, ...args);
      });
      const draft = await hold(`${origin}/api/conversations/${id}/draft`, 'PUT', {
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected delayed draft failure' }),
      });
      await page.getByRole('button', { name: '发送', exact: true }).click(); await draft.ready;
      await page.getByText(/请求确认超时/).waitFor();
      await idle('typed during steering');
      draft.release(); await page.unrouteAll({ behavior: 'wait' });
      const before = (await api(`/conversations/${id}`)).pendingPrompts.length;
      await page.getByRole('button', { name: '发送', exact: true }).click(); await idle('');
      const detail = await api(`/conversations/${id}`);
      assert.equal(detail.pendingPrompts.length, before + 1);
      assert.equal(detail.activeJob, null);
      results.push({ viewport, refreshDoesNotLock: true, queueActionAvailable: true,
        nextDraftPreserved: true, steeringKeepsInputEditable: true, steeringFailureRecovers: true,
        stalledDraftTimesOut: true, retryExactlyOnce: true, modelJobsStarted: 0 });
    } finally {
      for (const release of releases) release();
      await page.unrouteAll({ behavior: 'wait' });
      await page.close(); await api(`/conversations/${id}`, 'DELETE');
    }
  }
  return results;
}
