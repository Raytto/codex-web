// Real API + UI; no mocked responses or model tasks. Fixture deadlines are moved
// only on newly created test documents to exercise expiry without waiting 30 days.
import fs from 'node:fs';
import path from 'node:path';
export async function run({ page, context, origin, work, assert, fixtures }) {
  const session = await (await context.request.get(`${origin}/api/auth/session`)).json();
  const headers = { 'X-CSRF-Token': session.csrfToken, Origin: origin };
  const results = [];
  const conversations = [];
  const guest = await context.browser().newContext();
  const guestPage = await guest.newPage();
  let stage = 'setup';
  async function api(endpoint, method = 'GET', data) {
    const response = await context.request.fetch(origin + '/api' + endpoint, { method, headers, data });
    assert.ok(response.ok(), `${method} ${endpoint}: ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  }
  async function openShare(file) {
    await page.goto(`${origin}/files/${file.id}/preview`, { waitUntil: 'domcontentloaded' });
    await page.locator('.reader-text-container').waitFor();
    await page.locator('.file-reader-settings-button').click();
    await page.getByRole('menuitem', { name: '分享', exact: true }).click();
    await page.locator('#file-share-dialog').waitFor();
  }
  async function clickShare(file, name) {
    const response = page.waitForResponse(r => r.url() === `${origin}/api/files/${file.id}/share` && r.request().method() === 'POST');
    await page.getByRole('button', { name, exact: true }).click();
    const r = await response; assert.equal(r.status(), 200);
    const share = (await r.json()).share;
    assert.equal(share.enabled, true); assert.equal(share.expired, false);
    assert.ok(Math.abs(Date.parse(share.expiresAt) - Date.now() - 30 * 86400_000) < 10_000);
    return share;
  }
  async function publicStatus(file, status) {
    for (const suffix of ['', `/assets/${file.image}`]) {
      const url = `${origin}/api/files/${file.id}/preview/public${suffix}`;
      assert.equal((await guest.request.get(url)).status(), status);
      assert.equal((await guest.request.head(url)).status(), status === 200 && !suffix ? 204 : status);
    }
  }
  try {
    page.setDefaultTimeout(20_000);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport);
      const { conversation, reused } = await api('/conversations', 'POST', { reuseEmpty: false });
      assert.equal(reused, false); conversations.push(conversation.id);
      const label = `share-expiry-acceptance-${viewport.width}`;
      await api(`/conversations/${conversation.id}`, 'PATCH', { title: label });
      // Ensure home navigation stays on the fixture, never personal chat content.
      await page.addInitScript(({ accountId, project, id }) => {
        const prefix = `cww:account:${encodeURIComponent(accountId)}:`;
        localStorage.setItem(prefix + 'selected-project', project);
        localStorage.setItem(prefix + 'selected-conversation', id);
      }, { accountId: session.accountId, project: conversation.project_id, id: conversation.id });
      for (const format of ['html', 'markdown']) {
        stage = `${viewport.width}-${format}`;
        const file = fixtures.seed(conversation.id, session.accountId, format, label);
        await openShare(file);
        assert.match(await page.locator('#file-share-dialog').innerText(), /有效期为 30 天/);
        const enabled = await clickShare(file, '开启公开分享（30 天）');
        await page.getByLabel('公开链接', { exact: true }).waitFor();
        await publicStatus(file, 200);
        results.push(`${stage}: default 30 days, document/image GET+HEAD public`);

        fixtures.setExpiry(file.id, new Date(Date.now() + 3 * 86400_000).toISOString());
        await openShare(file);
        const renewed = await clickShare(file, '续期 30 天');
        assert.equal(renewed.publicUrl, enabled.publicUrl);
        assert.match(await page.locator('#file-share-dialog').innerText(), /剩余 30 天/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator('#file-share-dialog').screenshot({ path: path.join(work, `${stage}-share.png`) });
        results.push(`${stage}: renew, same URL, deadline/countdown fits viewport`);

        fixtures.setExpiry(file.id, new Date(Date.now() + 2500).toISOString());
        await openShare(file);
        await page.getByRole('button', { name: '重新开启分享（30 天）', exact: true }).waitFor();
        await publicStatus(file, 404);
        assert.equal((await api('/public-shares')).shares.some(s => s.fileId === file.id), false);
        results.push(`${stage}: deadline expires live, document/image rejected, manager excludes`);
        const reenabled = await clickShare(file, '重新开启分享（30 天）');
        assert.equal(reenabled.publicUrl, enabled.publicUrl);
        await guestPage.goto(enabled.publicUrl, { waitUntil: 'domcontentloaded' });
        await guestPage.locator('.reader-text-container').waitFor();
        assert.match(await guestPage.locator('.reader-text-container').innerText(), /期限功能验收/);
        await guestPage.waitForFunction(() => [...document.querySelectorAll('.reader-text-container img')].some(img => img.complete && img.naturalWidth > 0));
        results.push(`${stage}: explicit re-enable restores anonymous reader and image`);

        // Renew and revoke from the existing personal-settings manager too.
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        if (viewport.width < 768) await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
        await page.locator('.account-profile').click();
        await page.getByRole('button', { name: '公开分享管理', exact: true }).click();
        const row = page.locator('.public-share-row').filter({ has: page.getByRole('link', { name: file.name, exact: true }) });
        await row.waitFor();
        const response = page.waitForResponse(r => r.url() === `${origin}/api/files/${file.id}/share` && r.request().method() === 'POST');
        await row.getByRole('button', { name: '续期 30 天', exact: true }).click();
        assert.equal((await response).status(), 200);
        assert.match(await row.innerText(), /剩余 30 天/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await row.screenshot({ path: path.join(work, `${stage}-manager.png`) });
        page.once('dialog', d => d.accept());
        const closed = page.waitForResponse(r => r.url() === `${origin}/api/files/${file.id}/share` && r.request().method() === 'DELETE');
        await row.getByRole('button', { name: '关闭', exact: true }).click();
        assert.equal((await closed).status(), 200);
        await row.waitFor({ state: 'detached' });
        await publicStatus(file, 404);
        results.push(`${stage}: manager renew/revoke works, private after close`);
      }
    }
    return results;
  } catch (error) {
    fs.writeFileSync(path.join(work, 'share-expiry-failure.txt'), `${stage}\n${error.name}: ${error.message}\n`);
    throw error;
  } finally {
    await guest.close();
    const failures = [];
    for (const id of conversations) {
      const response = await context.request.delete(`${origin}/api/conversations/${id}`, { headers });
      if (!response.ok()) failures.push(`${id}: ${response.status()}`);
    }
    fixtures.close();
    assert.deepEqual(failures, [], 'All dedicated test conversations must be deleted');
  }
}
