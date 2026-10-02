// Browser regression for the production reader with deliberately stalled resources.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIpsAAAAASUVORK5CYII=', 'base64');
const server = await createServer({ server: { host: '127.0.0.1', port: 0, proxy: {} } });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
let browser;
let checks = 0;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}/codex-web`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--no-sandbox', '--disable-gpu'] });
  for (const width of [390, 1440]) for (const kind of ['html', 'markdown']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const firstImage = gate(), manifest = gate();
    const starts = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const content = kind === 'html'
      ? '<h1>正文立即可读</h1><p id="stable">选区在图片补载后仍然保留。</p><picture><source srcset="/api/image/0 1x"><img src="/api/image/fallback" width="300" height="100" alt="图片一"></picture><img src="/api/image/1" alt="坏图片"><img src="/api/image/2" alt="图片三">'
      : '# 正文立即可读\n\n选区在图片补载后仍然保留。\n\n![图片一](/api/image/0)\n\n![坏图片](/api/image/1)\n\n![图片三](/api/image/2)';
    const features = { paraBoard: true, revision: 1 };
    await context.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname.replace(/^\/codex-web(?=\/)/, "");
      const json = body => route.fulfill({ json: body });
      if (pathname === '/api/auth/session') return json({ authenticated: true, accountId: 'fixture-account', username: 'demo-owner', csrfToken: 'fixture', features });
      if (pathname === '/api/user-settings/features') return json(features);
      if (pathname === '/api/para/boards') return json({ boards: [] });
      if (pathname.endsWith('/activity')) return json({});
      if (pathname.endsWith('/preview')) return json({ file: { id: 'fixture', original_name: `report.${kind === 'html' ? 'html' : 'md'}`, mime_type: kind === 'html' ? 'text/html' : 'text/markdown', size: content.length, kind: 'output' }, conversation: { id: 'conversation', title: 'Fixture', status: 'idle' }, share: { enabled: false } });
      if (pathname.endsWith('/preview/content')) return json({ content });
      if (pathname.endsWith('/manifest')) { await manifest.promise; return json({ source: { format: kind }, version: { id: 'version' } }); }
      if (pathname.endsWith('/annotations')) return json({ annotations: [{ id: 'saved-mark', quote_text: '选区在图片补载后仍然保留。', color: 'orange', type: 'highlight', locator_json: '{}' }] });
      if (pathname.startsWith('/api/image/')) {
        const index = pathname.split('/').pop(); starts.push(index);
        if (index === '0') await firstImage.promise;
        if (index === '1') return route.fulfill({ status: 404 });
        return route.fulfill({ contentType: 'image/png', body: png });
      }
      return route.fulfill({ status: 404, json: { error: 'Unknown fixture API' } });
    });
    try {
      await page.goto(`${origin}/files/fixture/preview`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: '正文立即可读' }).waitFor();
      await page.waitForFunction(() => document.querySelector('img[data-reader-image-state="loading"]'));
      assert.deepEqual(starts, ['0'], 'only the first image starts while it is pending');
      assert.equal(await page.getByText('正在安全读取原文件…').count(), 0);
      assert.equal(await page.getByRole('button', { name: '加入项目', exact: true }).isVisible(), false);
      await page.getByLabel('阅读器设置', { exact: true }).click();
      await page.getByRole('menuitem', { name: '加入项目' }).click();
      await page.getByRole('dialog').waitFor();
      assert.equal(await page.locator('.file-reader-settings-menu').getAttribute('open'), null);
      await page.getByLabel('关闭对话框').click();
      await page.evaluate(() => {
        window.stableParagraph = document.querySelector('.reader-text-container p');
        const range = document.createRange(); range.selectNodeContents(window.stableParagraph);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      manifest.release(); firstImage.release();
      await page.waitForFunction(() => document.querySelectorAll('img[data-reader-image-state="loaded"]').length === 2);
      assert.deepEqual(starts, ['0', '1', '2']);
      assert.equal(await page.locator('img[data-reader-image-state="error"]').count(), 1);
      assert.equal(await page.evaluate(() => window.stableParagraph.isConnected && getSelection().toString().includes('选区在图片补载')), true);
      await page.evaluate(() => getSelection().removeAllRanges());
      await page.locator('mark[data-reader-annotation="saved-mark"]').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      checks += 11;
      console.log(`${width}px ${kind}: text, ordered images, failure continuation, selection and menu passed`);
    } finally { firstImage.release(); manifest.release(); await context.close(); }
  }

  // A hung image times out; disposing the queue never starts later images.
  const page = await browser.newPage();
  await page.route('**/api/**', route => route.fulfill({ json: { authenticated: false } }));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.route('**/__pending/**', route => route.abort());
  const queueChecks = await page.evaluate(async () => {
    const { loadReaderImages } = await import('/codex-web/src/reader/image-queue.ts');
    const root = document.createElement('div');
    root.innerHTML = '<img data-reader-src="/never-one"><img data-reader-src="/never-two">';
    document.body.append(root);
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    const starts = [];
    // Stall load/error delivery without replacing the real queue or its timers.
    Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, set(value) { starts.push(value); }, get() { return ''; } });
    try {
      const cancel = loadReaderImages(root, 50);
      await new Promise(resolve => setTimeout(resolve, 180)); cancel();
      const progressed = starts.join(',') === '/never-one,/never-two';
      starts.length = 0;
      const cancelAgain = loadReaderImages(root, 100);
      await new Promise(resolve => setTimeout(resolve, 40)); cancelAgain();
      await new Promise(resolve => setTimeout(resolve, 180));
      return { progressed, cancelled: starts.join(',') === '/never-one' };
    } finally { Object.defineProperty(HTMLImageElement.prototype, 'src', original); root.remove(); }
  });
  assert.deepEqual(queueChecks, { progressed: true, cancelled: true }); checks += 2;
  console.log(JSON.stringify({ passed: true, checks }));
} finally { await browser?.close(); await server.close(); }
