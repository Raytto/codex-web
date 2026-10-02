// Shared by the isolated regression runner and authenticated production acceptance.
// Every write is confined to a newly created conversation held by a future wake.
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
    page.setDefaultTimeout(15000);
    await page.setViewportSize(viewport);
    const input = page.locator('.composer textarea');
    const idle = async (value) => page.waitForFunction((expected) => {
      const input = document.querySelector('.composer textarea');
      return input && !input.disabled && input.value === expected;
    }, value);
    const submit = () => page.getByRole('button', { name: '发送', exact: true }).click();
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const holdDetail = async () => {
      let release, captured, complete;
      const hold = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { captured = resolve; });
      const done = new Promise((resolve) => { complete = resolve; });
      releases.push(release);
      const url = `${origin}/api/conversations/${id}`;
      let once = true;
      const handler = async (route) => {
        if (!once || route.request().method() !== 'GET') return route.continue();
        once = false;
        const response = await route.fetch();
        captured(await response.json());
        await hold;
        await route.fulfill({ response });
        complete();
      };
      await page.route(url, handler);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const snapshot = await ready;
      return { snapshot, deliver: async () => {
        const response = page.waitForResponse((value) => value.url() === url && value.request().method() === 'GET');
        release(); await done; await response; await settle();
      } };
    };
    try {
      await api(`/conversations/${id}`, 'PATCH', { title: 'Composer regression acceptance' });
      await api(`/conversations/${id}/wake-plans`, 'POST', {
        delaySeconds: 86400, label: 'Isolated composer verification', prompt: 'Isolated verification; removed before execution.',
        newConversation: false, ...created.agentSelection,
      });
      const seeded = await context.request.post(`${origin}/api/conversations/${id}/messages`, {
        headers, multipart: { message: 'queued text before edit' },
      });
      assert.ok(seeded.ok());
      // Select only this fixture; never click or inspect personal conversation content.
      await page.addInitScript(({ accountId, projectId, id }) => {
        const prefix = `cww:account:${encodeURIComponent(accountId)}:`;
        localStorage.setItem(prefix + 'selected-project', projectId);
        localStorage.setItem(prefix + 'selected-conversation', id);
      }, { accountId: session.accountId, projectId, id });
      await page.goto(origin);
      await idle('');
      await page.locator('.pending-queue-actions button[title="编辑"]').first().click();
      await idle('queued text before edit');
      await input.fill('edited submitted text');
      const oldEdit = await holdDetail();
      assert.ok(oldEdit.snapshot.editingPrompt);
      await submit();
      await idle('');
      await oldEdit.deliver();
      if (expectBug) {
        assert.equal(await input.inputValue(), 'queued text before edit', 'Baseline must reproduce stale text restoration');
        results.push({ viewport, reproduced: true });
        continue;
      }
      assert.equal(await input.inputValue(), '', 'A stale editing snapshot must not restore submitted text');
      await page.waitForTimeout(1700);
      let detail = await api(`/conversations/${id}`);
      assert.equal(detail.editingPrompt, null);
      assert.equal(detail.composerDraft, null, 'Submitted text must not be autosaved as a new draft');
      assert.equal(detail.pendingPrompts.length, 1);
      assert.equal(detail.pendingPrompts[0].content, 'edited submitted text');

      // Normal submission clears the draft, and an older GET cannot replace new typing.
      await input.fill('ordinary submitted text');
      await page.waitForTimeout(1700);
      const oldDraft = await holdDetail();
      assert.equal(oldDraft.snapshot.composerDraft.content, 'ordinary submitted text');
      await submit();
      await idle('');
      await input.fill('next unsent text');
      await oldDraft.deliver();
      assert.equal(await input.inputValue(), 'next unsent text');

      // A failed write retains the text and can be retried once without duplication.
      const messageUrl = `${origin}/api/conversations/${id}/messages`;
      await page.route(messageUrl, (route) => route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated simulated failure' }),
      }), { times: 1 });
      await submit();
      await idle('next unsent text');
      detail = await api(`/conversations/${id}`);
      assert.equal(detail.pendingPrompts.length, 2);
      await submit();
      await idle('');
      detail = await api(`/conversations/${id}`);
      assert.equal(detail.pendingPrompts.length, 3);
      assert.equal(detail.composerDraft, null);

      // An unrelated ordinary draft survives editing and cancelling a queued item.
      await input.fill('unrelated saved draft');
      await page.locator('.pending-queue-actions button[title="编辑"]').first().click();
      await idle('edited submitted text');
      await input.fill('second successful edit');
      const delayedEdit = await holdDetail();
      await submit();
      await idle('unrelated saved draft');
      await delayedEdit.deliver();
      assert.equal(await input.inputValue(), 'unrelated saved draft');
      await page.locator('.pending-queue-actions button[title="编辑"]').first().click();
      await idle('second successful edit');
      const cancelledEdit = await holdDetail();
      await page.getByRole('button', { name: '取消编辑', exact: true }).click();
      await idle('unrelated saved draft');
      await cancelledEdit.deliver();
      assert.equal(await input.inputValue(), 'unrelated saved draft');
      // Verify persistence using a fresh page, not just React state.
      await page.reload();
      await idle('unrelated saved draft');
      detail = await api(`/conversations/${id}`);
      assert.equal(detail.activeJob, null);
      assert.equal(detail.pendingPrompts.length, 3);
      await submit();
      await idle('');
      // File-only submission must still enter instruction mode and retain its file.
      const uploaded = page.waitForResponse((response) => response.url().endsWith(`/conversations/${id}/draft/files`) && response.ok());
      await page.locator('.composer input[type="file"]').setInputFiles({
        name: 'composer-check.txt', mimeType: 'text/plain', buffer: Buffer.from('isolated fixture'),
      });
      await uploaded;
      await page.getByRole('button', { name: '发送', exact: true }).waitFor();
      await submit();
      await page.locator('.editing-pending-banner.awaiting-instruction').waitFor();
      await idle('');
      await input.fill('instruction for fixture file');
      const fileEdit = await holdDetail();
      assert.equal(fileEdit.snapshot.editingPrompt.files.length, 1);
      await submit();
      await idle('');
      await fileEdit.deliver();
      assert.equal(await page.locator('.editing-pending-banner').count(), 0);
      detail = await api(`/conversations/${id}`);
      assert.equal(detail.pendingPrompts.length, 5);
      assert.equal(detail.pendingPrompts.find((prompt) => prompt.content === 'instruction for fixture file').files.length, 1);
      assert.equal(detail.editingPrompt, null);
      assert.equal(detail.composerDraft, null);
      results.push({ viewport, queuedEditRace: true, normalSend: true, nextDraftPreserved: true,
        failedSendAndRetry: true, unrelatedDraftPreserved: true, cancelEditRace: true, reload: true,
        fileOnlyInstruction: true, modelJobsStarted: 0 });
    } finally {
      for (const release of releases) release();
      await page.unrouteAll({ behavior: 'wait' });
      await page.close();
      await api(`/conversations/${id}`, 'DELETE');
    }
  }
  return results;
}
