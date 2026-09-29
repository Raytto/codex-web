// Real HTML/Markdown reader DOM with the production selection hook. No login/API.
// Run with PLAYWRIGHT_MODULE and optionally PLAYWRIGHT_CHROMIUM_EXECUTABLE.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const harness = `
import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FileReaderLayout, preparedReaderDocument, useOutlineState } from '/src/reader/LegacyReader.tsx';
import { useReaderSelection, ReaderSelectionAction } from '/src/reader-ask.tsx';
import '/src/styles.css';
const kind = new URLSearchParams(location.search).get('kind');
const file = {id: 'first-selection-' + kind, original_name: 'fixture.' + (kind === 'html' ? 'html' : 'md'), mime_type: kind === 'html' ? 'text/html' : 'text/markdown'};
const content = kind === 'html'
  ? '<h2>第一节</h2><p>点击正文后再框选。</p><p><strong>首次框选这段文字应该保持稳定，松手后可以直接复制。</strong></p><p><a href="#second">链接文字也应该保留选区。</a></p><table><tbody><tr><td>表格文字也应该保留选区。</td></tr></tbody></table><h2 id="second">第二节</h2><p>另一个正文段落。</p>'
  : '## 第一节\\n\\n点击正文后再框选。\\n\\n**首次框选这段文字应该保持稳定，松手后可以直接复制。**\\n\\n[链接文字也应该保留选区。](#second)\\n\\n| 表格文字也应该保留选区。 |\\n| --- |\\n| 正文 |\\n\\n## 第二节\\n\\n另一个正文段落。';
function SelectionLayer({root}) {
  const selection = useReaderSelection(root, file.id);
  return selection && <ReaderSelectionAction selection={selection} onAsk={text => window.quotedText = text} />;
}
function Fixture() {
  const root = useRef(null);
  const [revision, setRevision] = useState(0);
  const prepared = useMemo(() => preparedReaderDocument(file, content, 'light'), []);
  const outline = useOutlineState(prepared);
  window.refreshReader = () => setRevision(n => n + 1);
  window.toggleOutline = () => outline.setOpen(value => !value);
  return <main className="file-preview-page" data-revision={revision}>
    <header className="file-preview-header">阅读器选区回归</header>
    <section ref={root} className="file-preview-body">
      <FileReaderLayout file={{...file}} content={content} prepared={prepared} tocOpen={outline.open} activeAnchor={outline.activeAnchor} onSelect={outline.select} onActiveAnchorChange={outline.updateFromScroll} navigationToken={outline.navigationToken} />
      <SelectionLayer root={root} />
    </section>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;
const server = await createServer({
  base: "/",
  server: {host: '127.0.0.1', port: 0},
  plugins: [{
    name: 'reader-first-selection-fixture', enforce: 'pre',
    resolveId(id) { if (id === '/__first-selection.tsx') return id; },
    load(id) { if (id === '/__first-selection.tsx') return harness; },
    transform(code, id) {
      if (process.env.READER_FIRST_SELECTION_BASELINE_REF && (id.endsWith('/src/reader-ask.tsx') || id.endsWith('/src/reader/LegacyReader.tsx'))) {
        return execFileSync('git', ['show', process.env.READER_FIRST_SELECTION_BASELINE_REF + ':src/' + id.split('/src/')[1]], {encoding: 'utf8'});
      }
    },
    configureServer(instance) {
      instance.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/__first-selection') return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/__first-selection.tsx"></script></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--no-sandbox', '--disable-gpu']});
  const page = await browser.newPage({viewport: {width: 1100, height: 850}});
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = [];
  const failures = [];
  page.on('pageerror', error => errors.push(error.message));
  const open = async kind => {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__first-selection?kind=${kind}`);
    await page.locator('.reader-text-container strong').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
  };
  const text = () => page.evaluate(() => getSelection().toString());
  const drag = async (delay = 0) => {
    const points = await page.evaluate(() => {
      const node = document.querySelector('.reader-text-container strong').firstChild;
      const rect = (start, end) => {const r = document.createRange(); r.setStart(node, start); r.setEnd(node, end); return r.getBoundingClientRect();};
      const first = rect(0, 1), last = rect(9, 10);
      return {x1: first.left + 1, x2: last.right - 1, y: first.top + first.height / 2};
    });
    await page.mouse.move(points.x1, points.y);
    await page.mouse.down();
    await page.mouse.move(points.x2, points.y, {steps: 16});
    if (delay) await page.waitForTimeout(delay);
    const during = await text();
    assert.ok(during.includes('首次框选这段文字'), 'fixture drag did not select the expected text');
    await page.mouse.up();
    await page.waitForTimeout(650);
    return {during, after: await text()};
  };
  const check = (name, actual, expected) => {
    const passed = actual === expected;
    console.log(JSON.stringify({name, passed, actual, expected}));
    if (!passed) failures.push(name);
  };
  for (const kind of ['html', 'markdown']) {
    await open(kind);
    await page.locator('.reader-text-container p').first().click();
    assert.equal(await page.evaluate(() => getSelection().isCollapsed && getSelection().rangeCount === 1), true, 'initial click must leave a collapsed caret');
    const first = await drag();
    check(kind + ': first drag after an ordinary click', first.after, first.during);
    const second = await drag();
    check(kind + ': second drag', second.after, second.during);
    await page.keyboard.press('Control+c');
    check(kind + ': native clipboard copy', await page.evaluate(() => navigator.clipboard.readText()), second.during);
    await page.locator('.reader-text-container p').first().click();
    await page.waitForTimeout(650);
    check(kind + ': ordinary click dismisses selection', await text(), '');
    check(kind + ': ordinary click dismisses toolbar', await page.locator('.reader-selection-actions').count(), 0);

    await open(kind);
    const slow = await drag(2200);
    check(kind + ': selection held for more than two seconds', slow.after, slow.during);

    for (const selector of ['h2', 'a', 'table', 'strong']) {
      await open(kind);
      const before = await page.evaluate(selector => {
        const element = document.querySelector('.reader-text-container ' + selector);
        window.selectedElement = element;
        const range = document.createRange(); range.selectNodeContents(element);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        return getSelection().toString();
      }, selector);
      await page.locator('.reader-selection-actions').waitFor();
      await page.evaluate(() => window.refreshReader());
      await page.waitForTimeout(100);
      check(kind + ': DOM identity after refresh (' + selector + ')', await page.evaluate(() => window.selectedElement.isConnected), true);
      check(kind + ': selected text after refresh (' + selector + ')', await text(), before);
    }

    await open(kind);
    await drag();
    await page.locator('.reader-selection-actions').waitFor();
    const beforeResize = await text();
    await page.evaluate(() => {
      window.selectionWrites = 0;
      const original = Selection.prototype.removeAllRanges;
      Selection.prototype.removeAllRanges = function () { window.selectionWrites++; return original.call(this); };
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(650);
    check(kind + ': native selection writes during a layout refresh', await page.evaluate(() => window.selectionWrites), 0);
    check(kind + ': text after layout refresh', await text(), beforeResize);
    await page.evaluate(() => {
      const rect = getSelection().getRangeAt(0).getClientRects()[0];
      const point = {bubbles: true, pointerType: 'touch', clientX: rect.left + 2, clientY: rect.top + rect.height / 2};
      // Simulate a browser-owned handle reporting body as its DOM target.
      document.body.dispatchEvent(new PointerEvent('pointerdown', point));
      document.body.dispatchEvent(new PointerEvent('pointerup', point));
      document.body.dispatchEvent(new PointerEvent('click', point));
    });
    await page.waitForTimeout(650);
    check(kind + ': touch handle compatibility click preserves selection', await text(), beforeResize);
    await page.getByRole('button', {name: '询问 Agent', exact: true}).click();
    check(kind + ': Agent quote after touch sequence', await page.evaluate(() => window.quotedText), beforeResize);
  }
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual(failures, [], 'reader selection regressions');
  console.log('PASS: first selection, slow drag and reader DOM stability');
} finally {
  await browser?.close();
  await server.close();
}
