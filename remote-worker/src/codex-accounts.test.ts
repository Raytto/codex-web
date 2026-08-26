import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RemoteCodexAccountManager } from "./codex-accounts.js";

function auth(accountId: string, email: string) {
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return {
    tokens: {
      account_id: accountId,
      id_token: `header.${payload}.signature`,
      access_token: `access-${accountId}`,
      refresh_token: `refresh-${accountId}`,
    },
  };
}

test("Remote Codex accounts stay local, switch atomically, and never expose credentials", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-codex-accounts-"));
  const stateRoot = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth("account-alpha", "alpha@example.com")));

  const fakeAuth = JSON.stringify(auth("account-bravo", "bravo@example.com"));
  const fakeCodex = path.join(root, "fake-codex.js");
  fs.writeFileSync(fakeCodex, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), ${JSON.stringify(fakeAuth)});`,
    "process.stdout.write('Open https://auth.example.test/device and enter ABCD-EFGHJ\\n');",
  ].join("\n"));

  let switchAllowed = false;
  const manager = new RemoteCodexAccountManager({
    stateRoot,
    codexHome,
    codexExecutable: () => fakeCodex,
    assertSwitchAllowed: () => { if (!switchAllowed) throw new Error("still running"); },
  });
  context.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const initial = manager.listAccounts();
  assert.equal(initial.accounts.length, 1);
  assert.equal(initial.accounts[0]?.email, "alpha@example.com");
  assert.doesNotMatch(JSON.stringify(initial), /access-alpha|refresh-alpha/);

  const started = manager.beginLogin("home Plus");
  let login = started;
  for (let attempt = 0; attempt < 100 && !["succeeded", "failed"].includes(login.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    login = manager.loginStatus(started.id);
  }
  assert.equal(login.status, "succeeded", login.error ?? undefined);
  assert.equal(login.account?.email, "bravo@example.com");
  assert.doesNotMatch(JSON.stringify(login), /access-bravo|refresh-bravo/);

  const beforeSwitch = manager.listAccounts();
  assert.equal(beforeSwitch.accounts.length, 2);
  assert.equal(beforeSwitch.activeAccountId, initial.activeAccountId);
  const bravo = beforeSwitch.accounts.find((account) => account.email === "bravo@example.com");
  assert.ok(bravo);
  assert.throws(() => manager.activate(bravo.id), /still running/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")).tokens.account_id, "account-alpha");

  switchAllowed = true;
  const switched = manager.activate(bravo.id);
  assert.equal(switched.activeAccountId, bravo.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")).tokens.account_id, "account-bravo");
  assert.equal(switched.accounts.filter((account) => account.active).length, 1);
  assert.equal(manager.delete(initial.activeAccountId).accounts.length, 1);
});
