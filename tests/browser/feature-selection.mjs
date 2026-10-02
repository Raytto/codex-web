import fs from "node:fs";
import path from "node:path";

// Two independent browser contexts share only this run's short-lived login.
// No model/voice calls. Account preference is restored in finally.
export async function run({ page, context, origin, work, assert }) {
  const report = { phase: "setup", checks: [], errors: [], boardIds: [], projectIds: [], conversationIds: [], requestKeys: [], preferenceWrites: [], cleanup: false };
  const save = () => fs.writeFileSync(path.join(work, "feature-selection.json"), JSON.stringify(report, null, 2));
  const session = await (await context.request.get(origin + "/api/auth/session")).json();
  report.accountId = session.accountId;
  const api = async (method, route, data) => {
    if (data?.key) { report.requestKeys.push(data.key); save(); }
    const r = await context.request.fetch(origin + "/api" + route, { method, data, headers: { "X-CSRF-Token": session.csrfToken } });
    assert.ok(r.ok(), `${method} ${route}: ${r.status()}`);
    const value = r.status() === 204 ? null : await r.json();
    if (method === "PUT" && route === "/user-settings/features") { report.preferenceWrites.push(value.revision); save(); }
    return value;
  };
  const until = async fn => {
    const end = Date.now() + 15000;
    do { if (await fn()) return; await new Promise(r => setTimeout(r, 70)); } while (Date.now() < end);
    assert.fail("condition timed out in " + report.phase);
  };
  const monitor = p => {
    p.on("pageerror", e => { report.errors.push(e.message); save(); });
    p.on("response", async r => {
      if (r.request().method() === "PUT" && r.url().endsWith("/api/user-settings/features") && r.ok()) {
        try { report.preferenceWrites.push((await r.json()).revision); save(); } catch { /* teardown */ }
      }
    });
  };
  const checkbox = p => p.getByRole("checkbox", { name: "项目看板", exact: true });
  const sidebar = p => p.locator(".para-sidebar");
  const dialog = p => p.getByRole("dialog", { name: "功能选择", exact: true });
  const ensureSidebar = async p => {
    if (p.viewportSize().width <= 720 && !(await p.locator(".sidebar").evaluate(e => e.classList.contains("open")))) {
      await p.getByRole("button", { name: "打开侧栏", exact: true }).click();
      await until(async () => (await p.locator(".sidebar").boundingBox()).x >= -1);
    }
  };
  const openSettings = async p => {
    if (await dialog(p).count()) return;
    await ensureSidebar(p); await p.locator(".account-profile").click();
    await p.getByRole("button", { name: "功能选择", exact: true }).click();
    await dialog(p).waitFor();
  };
  const close = async p => { await p.getByRole("button", { name: "关闭功能选择", exact: true }).click(); };
  const choose = async (p, enabled) => {
    await openSettings(p); await until(async () => !(await checkbox(p).isDisabled()));
    if ((await checkbox(p).isChecked()) !== enabled) await checkbox(p).click();
    await until(async () => !(await checkbox(p).isDisabled()) && (await checkbox(p).isChecked()) === enabled);
  };
  const original = await api("GET", "/user-settings/features"); report.originalFeatures = original; save();
  let secondContext, releaseSlow;
  const stamp = Date.now().toString().slice(-8), title = "功能选择验收-" + stamp;
  monitor(page);
  try {
    if (!original.paraBoard) await api("PUT", "/user-settings/features", { ...original, paraBoard: true });
    const board = (await api("POST", "/para/boards", { key: crypto.randomUUID(), name: title })).board;
    report.boardIds.push(board.id); save();
    const project = (await api("POST", `/para/boards/${board.id}/projects`, { key: crypto.randomUUID(), title: title + "项目" })).project;
    report.projectIds.push(project.id); save();
    const conversation = (await api("POST", "/conversations", { reuseEmpty: false })).conversation;
    report.conversationIds.push(conversation.id); save();
    await api("PATCH", `/conversations/${conversation.id}`, { title: title + "任务" });
    const selectFixture = async p => p.addInitScript(({ accountId, projectId, conversationId }) => {
      const scope = encodeURIComponent(accountId);
      localStorage.setItem(`cww:account:${scope}:selected-project`, projectId);
      localStorage.setItem(`cww:account:${scope}:selected-conversation`, conversationId);
    }, { accountId: session.accountId, projectId: conversation.project_id, conversationId: conversation.id });
    await selectFixture(page); await page.reload();
    await page.locator(`[data-board-id="${board.id}"] .para-sidebar-item`).waitFor();
    secondContext = await context.browser().newContext({ storageState: await context.storageState(), viewport: { width: 1440, height: 900 } });
    const second = await secondContext.newPage(); monitor(second); second.setDefaultTimeout(15000);
    await selectFixture(second); await second.goto(origin); await sidebar(second).waitFor();
    await openSettings(second); assert.equal(await checkbox(second).isChecked(), true);
    await page.locator(`[data-board-id="${board.id}"] .para-sidebar-item`).click();
    await page.locator(".para-workspace:not(.para-hidden)").waitFor();
    await openSettings(page);
    await dialog(page).screenshot({ path: path.join(work, "feature-choice-desktop.png") });
    report.checks.push("settings_entry_and_account_checkbox"); save();

    report.phase = "hide_live_clients";
    await choose(page, false);
    await until(async () => await sidebar(page).count() === 0 && await sidebar(second).count() === 0 && !(await checkbox(second).isChecked()));
    assert.equal(await page.locator(".para-workspace").count(), 0);
    await close(page);
    await page.locator(".workspace-header").getByText(title + "任务", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "搜索", exact: true }).fill(title);
    await page.locator(`[data-conversation-id="${conversation.id}"]`).waitFor();
    assert.equal(await page.locator("[data-board-id]").count(), 0);
    await page.locator(".conversation-menu > summary").click();
    assert.equal(await page.locator(".conversation-menu-panel").getByRole("menuitem", { name: "关联项目", exact: true }).count(), 0);
    await page.locator(".conversation-menu > summary").click();
    const data = await api("GET", `/para/boards/${board.id}`);
    assert.equal(data.projects[0].id, project.id);
    report.checks.push("hide_active_board_syncs_other_client_preserves_data_and_task_search"); save();

    report.phase = "reload_hidden";
    let paraReads = 0;
    const count = r => { if (r.url().includes("/api/para/")) paraReads++; };
    page.on("request", count); await page.reload();
    await page.locator(".account-profile").waitFor(); await openSettings(page);
    assert.equal(await checkbox(page).isChecked(), false); assert.equal(await sidebar(page).count(), 0);
    page.off("request", count); assert.equal(paraReads, 0, "hidden startup does not fetch PARA");
    report.checks.push("server_persistence_and_no_para_reads_after_reload"); save();

    report.phase = "late_read";
    let slowSeen = false, slowDone;
    const gate = new Promise(r => { releaseSlow = r; });
    const slowFinished = new Promise(r => { slowDone = r; });
    await second.route("**/api/user-settings/features", async route => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch(); slowSeen = true;
      await gate; try { await route.fulfill({ response }); } finally { slowDone(); }
    });
    await second.evaluate(() => window.dispatchEvent(new Event("focus"))); await until(() => slowSeen);
    await choose(page, true); await until(async () => await checkbox(second).isChecked());
    releaseSlow(); releaseSlow = null; await slowFinished; await second.unroute("**/api/user-settings/features");
    await second.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await checkbox(second).isChecked(), true);
    assert.equal(await sidebar(second).count(), 1);
    report.checks.push("enable_live_sync_and_late_read_cannot_revert_selection"); save();

    report.phase = "save_failure";
    await page.route("**/api/user-settings/features", async route => {
      if (route.request().method() === "PUT") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "验收：暂时无法保存，请重试。" }) });
      return route.continue();
    });
    await checkbox(page).click(); await dialog(page).getByRole("alert").waitFor();
    await until(async () => !(await checkbox(page).isDisabled()));
    assert.equal(await checkbox(page).isChecked(), true); assert.equal(await sidebar(page).count(), 1);
    await page.unroute("**/api/user-settings/features"); await choose(page, false);
    assert.equal(await dialog(page).getByRole("alert").count(), 0);
    report.checks.push("failed_save_keeps_confirmed_state_and_real_retry_succeeds"); save();

    report.phase = "reconnect";
    await second.route("**/api/system/events", route => route.abort()); await second.reload();
    await second.locator(".account-profile").waitFor(); await openSettings(second);
    assert.equal(await checkbox(second).isChecked(), false);
    await choose(page, true);
    await second.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(async () => await checkbox(second).isChecked());
    await second.unroute("**/api/system/events");
    report.checks.push("disconnected_client_reconciles_on_return"); save();

    report.phase = "mobile_theme_keyboard";
    await close(page); await page.getByRole("textbox", { name: "搜索", exact: true }).fill(title);
    await page.locator(`[data-board-id="${board.id}"] .para-sidebar-item`).waitFor();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await openSettings(page);
      const bounds = await dialog(page).boundingBox();
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1 && bounds.y >= -1 && bounds.y + bounds.height <= 845);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await checkbox(page).focus(); await page.keyboard.press("Space");
      await until(async () => !(await checkbox(page).isChecked()) && !(await checkbox(page).isDisabled()));
      await page.keyboard.press("Space");
      await until(async () => await checkbox(page).isChecked() && !(await checkbox(page).isDisabled()));
      await dialog(page).screenshot({ path: path.join(work, `feature-choice-${width}.png`) });
      await page.keyboard.press("Escape"); await until(async () => await dialog(page).count() === 0);
    }
    // Use the application's own theme control rather than only emulating OS dark.
    await ensureSidebar(page); await page.locator(".account-profile").click();
    await page.getByRole("button", { name: "显示设置", exact: true }).click();
    await page.getByRole("button", { name: "使用深色模式", exact: true }).click();
    await page.getByRole("button", { name: "关闭显示设置", exact: true }).click();
    await openSettings(page);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await dialog(page).screenshot({ path: path.join(work, "feature-choice-dark.png") });
    report.checks.push("mobile_390_320_actual_dark_and_keyboard_toggle");
    assert.deepEqual(report.errors, []); report.phase = "passed"; save();
  } catch (error) { report.phase = "failed"; report.failure = error.message; save(); throw error; }
  finally {
    releaseSlow?.();
    await page.unroute("**/api/user-settings/features");
    await secondContext?.close();
    const failures = [];
    try {
      const current = await api("GET", "/user-settings/features");
      if (current.paraBoard !== original.paraBoard) {
        assert.ok(report.preferenceWrites.includes(current.revision), "leave an unexpected concurrent user setting untouched");
        await api("PUT", "/user-settings/features", { ...current, paraBoard: original.paraBoard });
      }
      assert.equal((await api("GET", "/user-settings/features")).paraBoard, original.paraBoard);
      report.preferenceRestored = true;
    } catch (e) { failures.push("preference: " + e.message); }
    for (const id of report.conversationIds) { try { await api("DELETE", `/conversations/${id}`); } catch (e) { failures.push(e.message); } }
    for (const id of report.boardIds) {
      try {
        const data = await api("GET", `/para/boards/${id}`);
        for (const p of data.projects) {
          assert.ok(report.projectIds.includes(p.id));
          const archived = p.archived_at ? p : (await api("PATCH", `/para/projects/${p.id}`, { revision: p.revision, archived: true })).project;
          await api("DELETE", `/para/projects/${p.id}`, { revision: archived.revision });
        }
        const b = data.board.archived_at ? data.board : (await api("PATCH", `/para/boards/${id}`, { revision: data.board.revision, archived: true })).board;
        await api("DELETE", `/para/boards/${id}`, { revision: b.revision });
      } catch (e) { failures.push(e.message); }
    }
    report.cleanup = failures.length === 0; report.cleanupErrors = failures; save();
    assert.deepEqual(failures, [], "fixture cleanup and original preference restored");
  }
}
