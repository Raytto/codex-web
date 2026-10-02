import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Dedicated fixtures only. Wheel/touch events exercise the actual scroll owner.
export async function run({ page, context, origin, work, assert }) {
  const report = { phase: "setup", checks: [], errors: [], projectIds: [], requestKeys: [], cleanup: false };
  const save = () => fs.writeFileSync(path.join(work, "sidebar-scroll.json"), JSON.stringify(report, null, 2));
  page.on("pageerror", error => { report.errors.push(error.message); save(); });
  const session = await (await context.request.get(origin + "/api/auth/session")).json();
  report.accountId = session.accountId;
  const api = async (method, route, data) => {
    if (data?.key) { report.requestKeys.push(data.key); save(); }
    const response = await context.request.fetch(origin + "/api" + route, { method, data, headers: { "X-CSRF-Token": session.csrfToken } });
    assert.ok(response.ok(), `${method} ${route}: ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  };
  const until = async fn => {
    const end = Date.now() + 15000;
    do { if (await fn()) return; await page.waitForTimeout(80); } while (Date.now() < end);
    assert.fail("Timed out: " + report.phase);
  };
  const originalFeatures = await api("GET", "/user-settings/features");
  let featureRevision;
  const name = "侧栏滚动验收-" + Date.now().toString().slice(-7);
  const search = page.getByRole("textbox", { name: "搜索", exact: true });
  const sidebar = page.locator(".sidebar");
  const scroll = page.locator(".sidebar-content");
  const account = page.locator(".account-profile");
  const positions = () => sidebar.evaluate(el => Object.fromEntries(
    [".sidebar-top", ".search-box", ".para-sidebar", ".conversation-section", ".account-area"].map(selector => [selector, el.querySelector(selector)?.getBoundingClientRect().top])
  ));
  const openSidebar = async () => {
    if (await sidebar.evaluate(el => matchMedia("(max-width: 720px)").matches && !el.classList.contains("open"))) await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
    await until(async () => (await sidebar.boundingBox()).x >= -1);
  };
  const wheel = async delta => { await scroll.hover(); await page.mouse.wheel(0, delta); await page.waitForTimeout(160); };
  const assertMovement = (before, after) => {
    assert.ok(Math.abs(before[".sidebar-top"] - after[".sidebar-top"]) < 1, "brand stays fixed");
    const delta = before[".search-box"] - after[".search-box"];
    assert.ok(delta > 30, "search scrolls away");
    for (const selector of [".para-sidebar", ".conversation-section", ".account-area"]) {
      assert.ok(Math.abs(before[selector] - after[selector] - delta) < 2, selector + " moves with search");
    }
  };
  const assertLayout = async () => {
    assert.deepEqual(await sidebar.evaluate(el => [...el.querySelectorAll("*")].filter(n => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1).map(n => n.className)), ["sidebar-content"]);
    assert.ok(await scroll.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    assert.equal(await page.evaluate(() => scrollY), 0);
  };
  try {
    if (!originalFeatures.paraBoard) featureRevision = (await api("PUT", "/user-settings/features", { ...originalFeatures, paraBoard: true })).revision;
    report.boardId = (await api("POST", "/para/boards", { key: crypto.randomUUID(), name })).board.id; save();
    for (let i = 1; i <= 20; i++) {
      report.projectIds.push((await api("POST", `/para/boards/${report.boardId}/projects`, { key: crypto.randomUUID(), title: `示例计划 ${String(i).padStart(2, "0")}` })).project.id); save();
    }
    const conversation = (await api("POST", "/conversations", { reuseEmpty: false })).conversation;
    report.conversationId = conversation.id; save();
    await api("PATCH", `/conversations/${conversation.id}`, { title: name + "-文件夹任务" });
    await page.reload(); await search.fill(name);
    const group = sidebar.locator(".para-sidebar-board").filter({ has: page.locator(`[data-board-id="${report.boardId}"]`) });
    await until(async () => await group.locator("[data-para-project]").count() === 5);
    while (await group.getByRole("button", { name: "展开显示", exact: true }).count()) {
      const previous = await group.locator("[data-para-project]").count();
      await group.getByRole("button", { name: "展开显示", exact: true }).click();
      await until(async () => await group.locator("[data-para-project]").count() > previous);
    }
    assert.equal(await group.locator("[data-para-project]").count(), 20);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }]) {
      report.phase = "wheel_" + viewport.width; save();
      await page.setViewportSize(viewport); await wheel(-10000);
      const before = await positions(); await wheel(320);
      assertMovement(before, await positions()); await assertLayout();
      await wheel(-10000); await until(async () => await scroll.evaluate(el => el.scrollTop) === 0);
      if (viewport.width === 1440) await sidebar.screenshot({ path: path.join(work, "sidebar-scroll-top.png"), mask: [page.locator(".project-list"), page.locator(".account-copy")] });
      report.checks.push(report.phase); save();
    }
    report.phase = "mobile_touch"; save();
    await page.setViewportSize({ width: 390, height: 844 }); await openSidebar(); await wheel(-10000);
    const before = await positions(), box = await scroll.boundingBox();
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      const x = box.x + box.width - 70, y = box.y + 400;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 28 }] }); await page.waitForTimeout(35); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(250);
      assertMovement(before, await positions()); await assertLayout();
    } finally { await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }); await cdp.detach(); }
    await sidebar.screenshot({ path: path.join(work, "sidebar-scroll-mobile.png"), mask: [page.locator(".project-list"), page.locator(".account-copy")] });
    await sidebar.getByRole("button", { name: "关闭", exact: true }).click();
    await until(async () => await sidebar.evaluate(el => getComputedStyle(el).visibility === "hidden"));
    await openSidebar(); assert.ok(await scroll.evaluate(el => el.scrollTop) > 30);
    report.checks.push("mobile_touch_scroll_fixed_close_and_reopen"); save();

    report.phase = "account_settings_short_screen"; save();
    await page.setViewportSize({ width: 320, height: 400 }); await openSidebar();
    await wheel(10000); await account.click();
    const settings = page.getByRole("region", { name: "个人设置", exact: true });
    await settings.waitFor(); await assertLayout();
    await settings.getByRole("button", { name: "显示设置", exact: true }).click();
    await page.getByRole("dialog", { name: "显示设置", exact: true }).waitFor();
    await page.getByRole("dialog", { name: "显示设置", exact: true }).getByRole("button", { name: "关闭显示设置", exact: true }).click();
    await account.click(); await settings.waitFor();
    await settings.getByRole("button", { name: "退出登录", exact: true }).scrollIntoViewIfNeeded();
    const logoutBox = await settings.getByRole("button", { name: "退出登录", exact: true }).boundingBox();
    assert.ok(logoutBox.y >= 0 && logoutBox.y + logoutBox.height <= 400);
    await page.keyboard.press("Escape"); await until(async () => await settings.count() === 0);
    report.checks.push("account_settings_accessible_without_nested_scroll_on_short_screen"); save();

    report.phase = "search_and_navigation"; save();
    await page.setViewportSize({ width: 1440, height: 900 }); await wheel(-10000);
    await search.fill(name + "-文件夹任务");
    await sidebar.locator(`[data-conversation-id="${report.conversationId}"] .conversation-select`).click();
    await page.locator(".workspace-header").getByText(name + "-文件夹任务", { exact: true }).waitFor();
    await search.fill(name); await until(async () => await group.locator("[data-para-project]").count() >= 5);
    await group.locator(`[data-board-id="${report.boardId}"] > .para-sidebar-item`).click();
    await page.locator(".para-workspace:not(.para-hidden)").getByRole("heading", { name, exact: true }).waitFor();
    await search.fill(name + "-没有结果"); await until(async () => await sidebar.locator(".para-sidebar-board").count() === 0);
    await account.click(); await settings.waitFor();
    const settingsBox = await settings.boundingBox(), scrollBox = await scroll.boundingBox();
    assert.ok(settingsBox.y >= scrollBox.y && settingsBox.y + settingsBox.height <= scrollBox.y + scrollBox.height + 1);
    await page.keyboard.press("Escape");
    report.checks.push("search_folder_task_board_navigation_and_short_list_account_menu");
    assert.deepEqual(report.errors, []); report.phase = "passed"; save();
  } catch (error) {
    report.failure = error.message;
    report.failureLayout = await sidebar.evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), open: el.classList.contains("open"), scrollTop: el.querySelector(".sidebar-content").scrollTop }));
    save(); throw error;
  }
  finally {
    const cleanupErrors = [];
    try {
      if (report.boardId) {
        const data = await api("GET", `/para/boards/${report.boardId}`);
        for (const project of data.projects) {
          assert.ok(report.projectIds.includes(project.id));
          const archived = (await api("PATCH", `/para/projects/${project.id}`, { revision: project.revision, archived: true })).project;
          await api("DELETE", `/para/projects/${project.id}`, { revision: archived.revision });
        }
        await api("DELETE", `/para/boards/${report.boardId}`, { revision: data.board.revision });
        assert.equal((await context.request.get(origin + `/api/para/boards/${report.boardId}`)).status(), 404);
      }
      if (report.conversationId) {
        await api("DELETE", `/conversations/${report.conversationId}`);
        assert.equal((await context.request.get(origin + `/api/conversations/${report.conversationId}`)).status(), 404);
      }
      const features = await api("GET", "/user-settings/features");
      if (featureRevision) {
        assert.equal(features.revision, featureRevision, "Do not overwrite concurrent feature changes");
        await api("PUT", "/user-settings/features", { ...features, paraBoard: originalFeatures.paraBoard });
        report.featuresRestored = true;
      } else report.featuresRestored = "unchanged";
    } catch (error) { cleanupErrors.push(error.message); }
    report.cleanup = cleanupErrors.length === 0; report.cleanupErrors = cleanupErrors; save();
    assert.ok(report.cleanup, "fixture data deleted and feature preference restored");
  }
}
