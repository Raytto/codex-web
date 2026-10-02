// Real composer UI/API, with synthetic microphone input supplied by the caller.
// Production callers use the real transcription endpoint; only dedicated fixtures
// are written, and a future wake prevents any model job from starting.
export async function run({ context, origin, assert, audioBase64, expectBug = false, cleanupFixture, onCheck }) {
  const session = await (await context.request.get(`${origin}/api/auth/session`)).json();
  const headers = { 'x-csrf-token': session.csrfToken };
  const api = async (url, method = 'GET', data) => {
    const r = await context.request.fetch(`${origin}/api${url}`, { method, headers, data });
    assert.ok(r.ok(), `${method} ${url}: ${r.status()}`);
    return r.status() === 204 ? null : r.json();
  };
  const projects = await api('/projects');
  const projectId = projects.defaultProjectId || projects.projects[0]?.id;
  const checks = [];
  const normalized = (value) => value.replace(/\r\n/g, '\n');
  let nextViewportAt = 0;
  for (const width of [1440, 390]) {
    // Respect the real account's 10/minute speech endpoint limit. Each viewport
    // makes at most eight requests; never disable/bypass the production limiter.
    if (nextViewportAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, nextViewportAt - Date.now()));
    nextViewportAt = Date.now() + 61000;
    const created = await api('/conversations', 'POST', { projectId, reuseEmpty: false });
    const id = created.conversation.id;
    const page = await context.newPage();
    const releases = [];
    const writes = [];
    page.setDefaultTimeout(25000);
    page.on('request', (r) => {
      if (r.url().includes(`/conversations/${id}/`) && r.method() !== 'GET') writes.push({ url: r.url(), method: r.method() });
    });
    const input = page.locator('.composer textarea');
    const detail = () => api(`/conversations/${id}`);
    const idle = (text) => page.waitForFunction((value) => {
      const input = document.querySelector('.composer textarea');
      return input && !input.disabled && input.value === value && !document.querySelector('.voice-panel');
    }, text);
    const send = () => page.getByRole('button', { name: '发送', exact: true }).click();
    const edit = async () => {
      await page.locator('.pending-queue-actions button[title="编辑"]').first().click();
      await page.locator('.editing-pending-banner').waitFor();
      await page.waitForFunction(() => !document.querySelector('.composer textarea').disabled);
    };
    const record = async (autoSend = true) => {
      await page.getByRole('button', { name: '录音输入', exact: true }).click();
      await page.locator('.voice-panel.recording').waitFor();
      const result = page.waitForResponse((r) => r.url().endsWith('/api/transcriptions'), { timeout: 90000 });
      await page.getByRole('button', { name: autoSend ? '识别语音并发送' : '停止录音并识别', exact: true }).click();
      const response = await result;
      assert.equal(response.status(), 200, 'The real transcription API must succeed');
      return response.json();
    };
    const noOrdinaryWrites = (since) => assert.ok(!writes.slice(since).some((r) => /\/(draft|messages)$/.test(r.url)), 'An edited voice prompt must never save/send an ordinary draft');
    const addCheck = (name) => { const check = `${width}: ${name}`; checks.push(check); onCheck?.(check); };
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(({ accountId, projectId, id, audioBase64 }) => {
        const prefix = `cww:account:${encodeURIComponent(accountId)}:`;
        localStorage.setItem(prefix + 'selected-project', projectId);
        localStorage.setItem(prefix + 'selected-conversation', id);
        // Keep only this fixture's recording UUIDs for receipt cleanup. Reading
        // FormData here also works when browser request metadata omits file bodies.
        const fetch = window.fetch.bind(window);
        window.fetch = (resource, options) => {
          if (options?.body instanceof FormData && String(resource).endsWith('/api/transcriptions')
            && options.body.get('conversationId') === id) {
            const key = `voice-test-recordings:${id}`;
            const ids = JSON.parse(sessionStorage.getItem(key) || '[]');
            const recordingId = options.body.get('clientRecordingId');
            if (typeof recordingId === 'string') sessionStorage.setItem(key, JSON.stringify([...new Set([...ids, recordingId])]));
          }
          return fetch(resource, options);
        };
        // Exercise the application's MediaRecorder callbacks without a physical mic.
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => new MediaStream() });
        window.MediaRecorder = class {
          static isTypeSupported() { return false; }
          mimeType = 'audio/wav'; state = 'inactive';
          start() { this.state = 'recording'; }
          requestData() { this.ondataavailable?.({ data: new Blob([Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0))], { type: this.mimeType }) }); }
          stop() { this.state = 'inactive'; this.onstop?.(); }
        };
      }, { accountId: session.accountId, projectId, id, audioBase64 });
      await api(`/conversations/${id}`, 'PATCH', { title: `Composer voice acceptance ${width}` });
      await api(`/conversations/${id}/wake-plans`, 'POST', { delaySeconds: 86400, label: 'Isolated voice edit check', prompt: 'Test fixture; deleted before execution.', newConversation: false, ...created.agentSelection });
      const seeded = await context.request.post(`${origin}/api/conversations/${id}/messages`, { headers, multipart: { message: 'original queued prompt' } });
      assert.ok(seeded.ok());
      await page.goto(origin);
      await idle('');
      await edit();
      await input.fill('edited with voice');
      let since = writes.length;
      let receipt = await record();
      let expected = `edited with voice\n${receipt.text}`;
      if (expectBug) {
        await page.getByText('请先完成或取消正在编辑的待发送任务。', { exact: true }).waitFor();
        await idle(expected);
        assert.equal((await detail()).composerDraft.content, expected);
        await send();
        await page.locator('.editing-pending-banner').waitFor({ state: 'hidden' });
        await idle(expected);
        assert.equal(normalized((await detail()).pendingPrompts[0].content), expected);
        addCheck('old build reproduces real 409, retry succeeds and duplicate ordinary draft returns');
        continue;
      }
      await idle('');
      noOrdinaryWrites(since);
      let d = await detail();
      assert.equal(d.pendingPrompts.length, 1); assert.equal(normalized(d.pendingPrompts[0].content), expected);
      assert.equal(d.composerDraft, null); assert.equal(d.editingPrompt, null);
      addCheck('record-and-send updates the existing queued prompt once and clears input');

      await edit(); await input.fill('stop before sending'); since = writes.length;
      receipt = await record(false); expected = `stop before sending\n${receipt.text}`;
      await idle(expected); assert.equal((await detail()).composerDraft, null);
      await send(); await idle(''); noOrdinaryWrites(since);
      addCheck('stop-to-text then manual send never creates an ordinary draft');

      await input.fill('independent ordinary draft'); await edit(); await input.fill('edit preserving draft');
      since = writes.length; await record(); await idle('independent ordinary draft');
      noOrdinaryWrites(since); assert.equal((await detail()).composerDraft.content, 'independent ordinary draft');
      addCheck('the ordinary draft saved before editing is preserved');
      await send(); await idle(''); assert.equal((await detail()).pendingPrompts.length, 2);
      addCheck('sending the restored ordinary draft does not reuse the edit transcription receipt');

      await edit(); await input.fill('retry edited voice'); since = writes.length;
      const pendingUrl = `${origin}/api/conversations/${id}/pending-prompts/${(await detail()).editingPrompt.id}`;
      await page.route(pendingUrl, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated edit failure' }) }), { times: 1 });
      receipt = await record(); expected = `retry edited voice\n${receipt.text}`;
      await page.getByText('Isolated edit failure', { exact: true }).waitFor(); await idle(expected);
      assert.equal((await detail()).composerDraft, null);
      await send(); await idle(''); noOrdinaryWrites(since);
      d = await detail(); assert.equal(d.pendingPrompts.length, 2); assert.equal(normalized(d.pendingPrompts[0].content), expected);
      addCheck('failed edit retains text and retry updates once without a duplicate');

      // An ASR response must stay tied to the recording's original pending edit.
      await edit(); await input.fill('delayed edit voice');
      let release, captured;
      const held = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { captured = resolve; }); releases.push(release);
      await page.route(`${origin}/api/transcriptions`, async (route) => {
        const response = await route.fetch(); captured(); await held; await route.fulfill({ response });
      }, { times: 1 });
      const delayed = record(); await ready;
      await page.getByRole('button', { name: '取消编辑', exact: true }).click();
      await page.locator('.editing-pending-banner').waitFor({ state: 'hidden' });
      release(); await delayed;
      await page.getByRole('button', { name: '重试识别语音', exact: true }).waitFor();
      assert.equal(await input.inputValue(), ''); assert.equal((await detail()).composerDraft, null);
      await edit();
      await page.getByRole('button', { name: '重试识别语音', exact: true }).click();
      await idle(''); d = await detail(); assert.equal(d.pendingPrompts.length, 2); assert.equal(d.composerDraft, null);
      assert.ok(normalized(d.pendingPrompts[0].content).startsWith('delayed edit voice\n'));
      addCheck('late recognition after cancel retains audio for the original edit and retries safely');

      await edit(); await input.fill('recover voice edit');
      await page.route(`${origin}/api/transcriptions`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated recognition failure' }) }), { times: 1 });
      await page.getByRole('button', { name: '录音输入', exact: true }).click();
      await page.getByRole('button', { name: '识别语音并发送', exact: true }).click();
      await page.getByRole('button', { name: '重试识别语音', exact: true }).waitFor();
      await page.reload(); await page.locator('.editing-pending-banner').waitFor();
      since = writes.length;
      await page.getByRole('button', { name: '重试识别语音', exact: true }).click();
      await idle(''); noOrdinaryWrites(since); assert.equal((await detail()).composerDraft, null);
      assert.ok(normalized((await detail()).pendingPrompts[0].content).startsWith('recover voice edit\n'));
      addCheck('retained audio restores its pending edit identity after a page reload');

      await input.fill('ordinary voice'); receipt = await record(); await idle('');
      d = await detail(); assert.equal(d.pendingPrompts.length, 3); assert.equal(d.composerDraft, null);
      assert.ok(d.pendingPrompts.some((p) => normalized(p.content) === `ordinary voice\n${receipt.text}`));
      await page.reload(); await idle(''); assert.equal((await detail()).activeJob, null);
      addCheck('ordinary voice sending and reload remain correct; no model job started');
    } finally {
      for (const release of releases) release();
      await page.unrouteAll({ behavior: 'wait' });
      const recordingIds = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || '[]'), `voice-test-recordings:${id}`);
      await page.close();
      await cleanupFixture?.({ conversationId: id, userId: session.accountId, recordingIds });
      await api(`/conversations/${id}`, 'DELETE');
    }
  }
  return checks;
}
