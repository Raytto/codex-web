import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("shared auth commits tenant rotation without DAC capabilities and releases the lock on invalid auth", (context) => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    context.skip("requires Linux root with SETUID/SETGID");
    return;
  }
  const root = fs.mkdtempSync("/tmp/shared-auth-no-dac-");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o711);
  const source = path.join(root, "source", "auth.json");
  const target = path.join(root, "tenant", "auth.json");
  const lock = path.join(root, "source", "refresh.lock");
  fs.mkdirSync(path.dirname(source), { mode: 0o700 });
  fs.mkdirSync(path.dirname(target), { mode: 0o700 });
  fs.chownSync(path.dirname(target), 65_534, 65_534);
  fs.writeFileSync(source, JSON.stringify({ tokens: { access_token: "initial", refresh_token: "initial" } }), { mode: 0o600 });
  const moduleUrl = pathToFileURL(path.resolve("server/shared-codex-auth.ts")).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { acquireSharedCodexAuth } from ${JSON.stringify(moduleUrl)};
    const options = ${JSON.stringify({ sourceFile: source, targetFile: target, lockFile: lock, targetUid: 65_534, targetGid: 65_534, timeoutSeconds: 1 })};
    const writeTenant = (payload) => {
      const child = spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],process.argv[2])", options.targetFile, payload], { uid:65534, gid:65534 });
      assert.equal(child.status, 0);
    };
    const lease = await acquireSharedCodexAuth(options);
    assert.throws(() => fs.readFileSync(options.targetFile), {code:'EACCES'});
    writeTenant(JSON.stringify({tokens:{access_token:'rotated',refresh_token:'rotated'}}));
    await lease.commitAndRelease();
    assert.equal(JSON.parse(fs.readFileSync(options.sourceFile)).tokens.refresh_token, 'rotated');
    const invalid = await acquireSharedCodexAuth(options);
    writeTenant('{}');
    await assert.rejects(invalid.commitAndRelease(), /reusable ChatGPT login/);
    assert.equal(JSON.parse(fs.readFileSync(options.sourceFile)).tokens.refresh_token, 'rotated');
    const next = await acquireSharedCodexAuth(options);
    await next.releaseWithoutCommit();
  `;
  const child = spawnSync("setpriv", ["--bounding-set=-dac_override,-dac_read_search", process.execPath,
    "--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(target).uid, 65_534);
  assert.equal(fs.statSync(source).mode & 0o777, 0o600);
});
