// Isolated Chromium fixture for the shared reader selection hook and toolbar.
// Run with PLAYWRIGHT_MODULE and optionally PLAYWRIGHT_CHROMIUM_EXECUTABLE.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import sharp from 'sharp';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const harness = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useReaderSelection, ReaderSelectionAction } from '/src/reader-ask.tsx';
import '/src/styles.css';
function Fixture() {
  const root = useRef(null);
  const [revision, setRevision] = useState(0);
  const selection = useReaderSelection(root, 'fixture');
  window.remountText = () => setRevision(n => n + 1);
  const record = (kind, text) => { window.actionResult = {kind, text}; };
  return <>
    <main ref={root} style={{margin: '140px auto', width: 620, height: 400, padding: 24, background: 'var(--paper)', color: 'var(--ink)'}}>
      <article className="reader-text-container" style={{fontSize: 20, lineHeight: '32px'}}>
        <p key={revision} id="prose">正文保持原有亮度。<strong id="quote">框选这段文字以后，等待悬浮工具栏出现，文字颜色和选区亮度应保持一致。</strong>这段文字不在选区内。</p>
        <p id="dismiss">点击这里清除选区。</p>
      </article>
    </main>
    {selection && <ReaderSelectionAction selection={selection}
      onAsk={text => record('ask', text)}
      onHighlight={value => record('highlight', value.text)}
      onNote={value => record('note', value.text)} />}
  </>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;
const server = await createServer({
 base: "/",
  server: {host: '127.0.0.1', port: 0},
  plugins: [{
    name: 'reader-selection-fixture', enforce: 'pre',
    resolveId(id) { if (id === '/__reader-selection.tsx') return id; },
    load(id) { if (id === '/__reader-selection.tsx') return harness; },
    configureServer(instance) {
      instance.middlewares.use((req, res, next) => {
        if (req.url !== '/__reader-selection') return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/__reader-selection.tsx"></script></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--no-sandbox', '--disable-gpu']});
  const page = await browser.newPage({viewport: {width: 1100, height: 850}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const theme of ['light', 'dark']) {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__reader-selection`);
    await page.locator('#quote').waitFor();
    await page.evaluate(async theme => {document.documentElement.dataset.theme = theme; await document.fonts.ready;}, theme);
    const expected = await page.locator('#quote').textContent();
    const selectQuote = () => page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('quote'));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    const bounds = await page.locator('#prose').boundingBox();
    // Capture only glyphs on the first selected line, away from toolbar shadows.
    const clip = {x: bounds.x, y: bounds.y, width: bounds.width, height: 30};
    await selectQuote();
    const before = await page.screenshot({clip});
    assert.equal(await page.locator('.reader-selection-actions').count(), 0, 'early capture missed the settle window');
    await page.locator('.reader-selection-actions').waitFor();
    await page.waitForTimeout(650);
    const after = await page.screenshot({clip});
    const earlyPixels = await sharp(before).raw().toBuffer();
    const latePixels = await sharp(after).raw().toBuffer();
    const changedChannels = earlyPixels.reduce((count, value, index) => count + Number(value !== latePixels[index]), 0);
    console.log(JSON.stringify({theme, changedChannels, nativeTextPreserved: await page.evaluate(() => window.getSelection().toString()) === expected}));
    if (process.env.READER_SELECTION_ARTIFACTS) {
      await fs.mkdir(process.env.READER_SELECTION_ARTIFACTS, {recursive: true});
      await fs.writeFile(path.join(process.env.READER_SELECTION_ARTIFACTS, `${theme}-before.png`), before);
      await fs.writeFile(path.join(process.env.READER_SELECTION_ARTIFACTS, `${theme}-after.png`), after);
      await page.screenshot({path: path.join(process.env.READER_SELECTION_ARTIFACTS, `${theme}-reader.png`)});
    }
    if (process.env.READER_SELECTION_EXPECT_OVERLAY) {
      assert.ok(changedChannels > 0, 'baseline did not reproduce the tint');
      continue;
    }
    assert.equal(changedChannels, 0, 'toolbar settling changed selected text pixels');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), expected);

    // A text-layer remount must still rebind the native selection from its anchor.
    await page.evaluate(() => window.remountText());
    await page.waitForFunction(expected => window.getSelection().toString() === expected, expected);
    await page.locator('.reader-selection-actions').waitFor();
    for (const [label, kind] of [['询问 Agent', 'ask'], ['标记选中文字', 'highlight'], ['给选中文字添加备注', 'note']]) {
      await page.keyboard.press('Escape');
      await selectQuote();
      await page.getByRole('button', {name: label, exact: true}).click();
      assert.deepEqual(await page.evaluate(() => window.actionResult), {kind, text: expected});
    }
    await page.keyboard.press('Escape');
    // Real mouse drag followed by delayed toolbar mount and click-away.
    const points = await page.evaluate(() => {
      const node = document.getElementById('quote').firstChild;
      const rect = (start, end) => {const range = document.createRange();range.setStart(node, start);range.setEnd(node, end);return range.getBoundingClientRect();};
      const first = rect(0, 1), last = rect(7, 8);
      return {x1: first.left + 1, y: first.top + first.height / 2, x2: last.right - 1};
    });
    await page.mouse.move(points.x1, points.y);
    await page.mouse.down();
    await page.mouse.move(points.x2, points.y, {steps: 16});
    await page.mouse.up();
    const dragged = await page.evaluate(() => window.getSelection().toString());
    assert.ok(dragged.includes('框选这段文字'), `mouse drag failed: ${dragged}`);
    await page.locator('.reader-selection-actions').waitFor();
    assert.equal(await page.evaluate(() => window.getSelection().toString()), dragged);
    await page.locator('#dismiss').click();
    assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
    assert.equal(await page.locator('.reader-selection-actions').count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log(process.env.READER_SELECTION_EXPECT_OVERLAY ? 'PASS: baseline delayed tint reproduced' : 'PASS: stable selection pixels, text-layer restoration, all three actions, mouse drag and click-away in both themes');
} finally {
  await browser?.close();
  await server.close();
}
