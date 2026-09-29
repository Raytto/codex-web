// Isolated public-edition browser checks. No deployed login, provider or model calls.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import { createApp } from "../../server/app.ts";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright entry file");
if (process.env.CODEX_WEB_BROWSER_MODEL_PROBE || process.env.CODEX_WEB_BROWSER_REAL_ASR) throw new Error("The isolated runner never starts model probes");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-para-browser-")));
const artifacts = path.resolve(process.env.BROWSER_ARTIFACTS_DIR || path.join(root, "evidence"));
fs.mkdirSync(artifacts, { recursive: true });
// Keep static assets stable even if another local build/test modifies its own dist/.
for (const directory of ["dist", "skills", "account-resources"]) {
  const source = path.join(process.cwd(), directory);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(root, directory), { recursive: true });
}
const password = crypto.randomUUID();
let instance, browser;
const server = http.createServer((req, res) => instance.app(req, res));
const results = [];
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}/codex-web`;
  instance = createApp({ projectRoot: root, basePath: "/codex-web", publicBaseUrl: origin,
    dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    codexHome: path.join(root, "codex"), pythonRuntimeRoot: path.join(root, "python"),
    username: "demo-owner", passwordHash: bcrypt.hashSync(password, 4),
    sessionSecret: crypto.randomBytes(32).toString("hex"), queueAutoStart: false,
    remoteWorkerEnrollmentToken: "", remoteWorkerReleaseRoot: path.join(root, "no-release"),
    hostRootSocketPath: "", hostTenantRoot: "", hostKnowledgeRoot: "", hostRootCodexHome: "",
    personalMemoryApiKey: "", personalMemoryBaseUrl: "", dashscopeApiKey: "", dashscopeBaseUrl: "" });
  const now = new Date().toISOString();
  instance.db.createUser({ id: "00000000-0000-4000-8000-000000000002", username: "demo-member",
    display_name: "Example member", password_hash: bcrypt.hashSync(password, 4), role: "member",
    status: "active", created_at: now, updated_at: now });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    ignoreDefaultArgs: ["--disable-dev-shm-usage"], args: ["--no-sandbox", "--disable-gpu"] });
  const suites = (process.env.PARA_BROWSER_SUITES || "para-acceptance,para-interactions,para-sidebar-search,para-conversation-projects").split(",");
  for (const username of ["demo-owner", "demo-member"]) {
    for (const suite of suites) {
      assert.match(suite, /^para-(acceptance|interactions|sidebar-search|conversation-projects)$/);
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const work = path.join(artifacts, username, suite);
      fs.mkdirSync(work, { recursive: true });
      try {
        const login = await context.request.post(origin + "/api/auth/login", { data: { username, password } });
        assert.equal(login.status(), 200, "public password login");
        await page.goto(origin + "/");
        await page.locator(".sidebar").waitFor();
        const { run } = await import(`./${suite}.mjs`);
        await run({ page, context, origin, work, assert });
        assert.equal(instance.db.sqlite.prepare("SELECT count(*) AS n FROM jobs").get().n, 0, "browser checks never start model jobs");
        results.push({ account: username, suite, passed: true });
        console.log(`${username} ${suite}: passed`);
      } catch (error) {
        await page.screenshot({ path: path.join(work, "failure.png"), fullPage: true }).catch(() => undefined);
        results.push({ account: username, suite, passed: false, error: String(error) });
        throw error;
      } finally { await context.close(); }
    }
  }
} finally {
  fs.writeFileSync(path.join(artifacts, "summary.json"), JSON.stringify(results, null, 2));
  if (browser) await browser.close();
  if (instance) { instance.beginShutdown(); await instance.waitForBackgroundTasks(); instance.remoteWorkers.close(); }
  await new Promise((resolve) => server.close(resolve));
  if (instance) instance.db.close();
  // Keep requested evidence; all database, sessions and synthetic credentials are temporary.
  if (artifacts.startsWith(root + path.sep)) {
    for (const name of ["data", "tenants", "codex", "python"]) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    console.log("Browser evidence directory:", artifacts);
  } else fs.rmSync(root, { recursive: true, force: true });
}
