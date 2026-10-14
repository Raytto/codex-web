// Run inside the built image, with this file mounted read-only at /check.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const profile = process.argv[2] ?? 'base';
assert.ok(['base', 'documents'].includes(profile));
assert.equal(process.env.CODEX_WEB_TOOL_PROFILE, profile);
const require = createRequire('/app/package.json');
for (const name of ['@openai/codex-sdk', '@openai/codex', 'react', 'lucide-react', 'pdfjs-dist', 'typescript', 'vite']) {
  assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
}
assert.match(execFileSync('/opt/codex-baked/bin/codex', ['--version'], { encoding: 'utf8' }), /codex-cli \d+\.\d+\.\d+/);
assert.ok(fs.existsSync('/app/dist/index.html'));
assert.equal(fs.existsSync('/app/.git'), false);
assert.equal(fs.existsSync('/app/.env'), false);
assert.equal(fs.existsSync('/opt/codex-runtime/current/bin/codex'), false);
for (const dir of ['/app/data', '/app/tenants']) assert.deepEqual(fs.readdirSync(dir), []);
execFileSync('ffmpeg', ['-version']);
const python = '/opt/cww-python/shared/bin/python';
execFileSync(python, ['-c', 'import ssl, sqlite3, json; assert ssl.OPENSSL_VERSION']);
if (profile === 'base') {
  execFileSync(python, ['-c', 'import importlib.util; assert importlib.util.find_spec("pandas") is None; assert importlib.util.find_spec("openpyxl") is None']);
  assert.throws(() => execFileSync('libreoffice', ['--version']), { code: 'ENOENT' });
  assert.throws(() => execFileSync('pdftotext', ['-v']), { code: 'ENOENT' });
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-profile-'));
  try {
    execFileSync(python, ['-c', `import sys, pathlib, pandas, matplotlib, openpyxl, docx, pptx, pypdf, PIL, bs4, cryptography, urllib3
assert bs4.BeautifulSoup('<p class="note">ok</p>', "html.parser").select_one("p.note").text == "ok"
r=pathlib.Path(sys.argv[1]); w=openpyxl.Workbook(); w.active['A1']='中文'; w.active['B1']=42; w.active['C1']='Codex Web'; w.save(r/'sheet.xlsx'); assert openpyxl.load_workbook(r/'sheet.xlsx').active['B1'].value==42
d=docx.Document(); d.add_paragraph('Codex Web 文档验证'); d.save(r/'document.docx')
p=pptx.Presentation(); slide=p.slides.add_slide(p.slide_layouts[6]); slide.shapes.add_textbox(0,0,5000000,1000000).text='Codex Web 中文'; p.save(r/'slides.pptx')`, root]);
    execFileSync('libreoffice', ['-env:UserInstallation=file://' + root + '/profile', '--headless', '--convert-to', 'pdf', '--outdir', root, root + '/document.docx', root + '/sheet.xlsx', root + '/slides.pptx']);
    for (const name of ['document', 'sheet', 'slides']) {
      assert.ok(fs.statSync(root + '/' + name + '.pdf').size > 0);
      assert.match(execFileSync('pdftotext', [root + '/' + name + '.pdf', '-'], { encoding: 'utf8' }), /Codex Web/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ profile, runtimeImports: 'pass', codex: 'pass', userState: 'empty', documentBehavior: 'pass' }));
