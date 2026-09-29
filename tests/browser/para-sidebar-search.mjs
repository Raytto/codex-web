import fs from "node:fs";
import path from "node:path";

// Creates only named fixtures, never starts an Agent, and deletes only recorded IDs.
export async function run({ page, context, origin, work, assert }) {
  const report = { phase: "setup", checks: [], errors: [], boardIds: [], projectIds: [], conversationIds: [], cleanup: false, requestKeys: [] };
  const save = () => fs.writeFileSync(path.join(work, "para-sidebar-search.json"), JSON.stringify(report, null, 2));
  page.on("pageerror", (error) => { report.errors.push(error.message); save(); });
  const session = await (await context.request.get(origin + "/api/auth/session")).json();
  report.accountId = session.accountId;
  const api = async (method, route, data) => {
    if (data?.key) { report.requestKeys.push(data.key); save(); }
    const r = await context.request.fetch(origin + "/api" + route, { method, data, headers: { "X-CSRF-Token": session.csrfToken } });
    assert.ok(r.ok(), `${method} ${route}: ${r.status()}`);
    return r.status() === 204 ? null : r.json();
  };
  const until = async (fn) => {
    const end = Date.now() + 15000;
    do { if (await fn()) return; await new Promise((r) => setTimeout(r, 80)); } while (Date.now() < end);
    assert.fail("condition timed out in " + report.phase);
  };
  const stamp = Date.now().toString().slice(-8);
  const name = "侧栏验收-" + stamp, projectName = "花园计划-" + stamp, taskName = "任务检索-" + stamp;
  const search = page.getByRole("textbox", { name: "搜索", exact: true });
  const workspace = page.locator(".para-workspace:not(.para-hidden)");
  const dialog = page.getByRole("dialog");
  let boardId, group, projectIds, releaseSlow, releaseArchiveRefresh;
  let archiveReads = 0;
  const projectRow = (id) => page.locator(`[data-para-project="${id}"]`);
  const sidebarOrder = async () => (await api("GET", `/para/boards/${boardId}/sidebar-projects?limit=100`)).projects.map((p) => p.id);
  const visibleOrder = () => group.locator("[data-para-project]").evaluateAll((rows) => rows.map((el) => el.dataset.paraProject));
  const ensureSidebar = async () => {
    if (!(await page.locator(".sidebar").evaluate((el) => el.classList.contains("open")))) await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  };
  try {
    boardId = (await api("POST", "/para/boards", { key: crypto.randomUUID(), name })).board.id;
    report.boardIds.push(boardId); save();
    const second = (await api("POST", "/para/boards", { key: crypto.randomUUID(), name: "另一个验收板-" + stamp })).board.id;
    report.boardIds.push(second); save();
    for (let i = 0; i < 8; i++) {
      const p = (await api("POST", `/para/boards/${boardId}/projects`, { key: crypto.randomUUID(), title: `${projectName}-${i}` })).project;
      report.projectIds.push(p.id); save();
    }
    projectIds = report.projectIds.slice();
    const p2 = (await api("POST", `/para/boards/${second}/projects`, { key: crypto.randomUUID(), title: "独立项目-" + stamp })).project;
    report.projectIds.push(p2.id); save();
    const conversation = (await api("POST", "/conversations", { reuseEmpty: false })).conversation;
    report.conversationIds.push(conversation.id); save();
    await api("PATCH", `/conversations/${conversation.id}`, { title: taskName });
    await page.reload(); await search.waitFor();
    const local = /^(localhost|127\.)/.test(new URL(origin).hostname);
    const folder = page.locator(`.project-group[data-project-id="${conversation.project_id}"]`);
    if (local && await folder.locator(".project-select").getAttribute("aria-expanded") === "true") {
      await folder.locator(".project-select").click();
    }
    assert.equal(await search.getAttribute("placeholder"), "搜索");
    group = page.locator(".para-sidebar-board").filter({ has: page.locator(`[data-board-id="${boardId}"]`) });
    const boardButton = () => group.locator(`[data-board-id="${boardId}"] > .para-sidebar-item`);
    report.phase = "expand_navigation_paging"; save();
    await boardButton().click();
    await workspace.getByRole("heading", { name, exact: true }).waitFor();
    await until(async () => (await visibleOrder()).length === 5);
    assert.deepEqual(await visibleOrder(), projectIds.slice(3).reverse());
    await projectRow(projectIds[7]).locator(".para-sidebar-project-select").click();
    await workspace.getByRole("heading", { name: `${projectName}-7`, exact: true }).waitFor();
    assert.equal(await projectRow(projectIds[7]).locator("[aria-current=page]").count(), 1);
    assert.deepEqual(await sidebarOrder(), [...projectIds].reverse());
    await boardButton().click();
    await workspace.getByRole("heading", { name, exact: true }).waitFor();
    assert.equal(await group.locator("[data-para-project]").count(), 0);
    await group.getByRole("button", { name: `展开看板 ${name}`, exact: true }).click();
    await group.getByRole("button", { name: "展开显示", exact: true }).click();
    await until(async () => (await visibleOrder()).length === 8);
    await page.reload(); await until(async () => (await visibleOrder()).length === 5);
    report.checks.push("board_expand_collapse_persistence_project_detail_and_recent_paging"); save();

    report.phase = "hierarchical_search";
    await search.fill(`${projectName}-0`);
    await until(async () => (await visibleOrder()).join() === projectIds[0]);
    assert.equal(await page.locator(".para-sidebar-board").count(), 1);
    await projectRow(projectIds[0]).locator(".para-sidebar-project-select").click();
    await workspace.getByRole("heading", { name: `${projectName}-0`, exact: true }).waitFor();
    assert.equal(await search.inputValue(), `${projectName}-0`);
    assert.equal(await projectRow(projectIds[0]).locator(".para-board-grip").isDisabled(), true);
    await search.fill(name);
    await until(async () => (await visibleOrder()).length === 5);
    assert.equal(await page.locator(".para-sidebar-board").count(), 1);
    await group.screenshot({ path: path.join(work, "sidebar-search-desktop.png") });
    if (local) {
      await search.fill("");
      await until(async () => await folder.locator(".project-select").getAttribute("aria-expanded") === "false");
    }
    await search.fill(taskName);
    const taskRow = page.locator(`[data-conversation-id="${conversation.id}"]`);
    await taskRow.locator(".conversation-select").click();
    assert.equal(await search.inputValue(), taskName);
    await page.locator(".workspace-header").getByText(taskName, { exact: true }).waitFor();
    if (local) {
      assert.equal(await folder.locator(".project-select").getAttribute("aria-expanded"), "true");
      await search.fill("");
      await until(async () => await folder.locator(".project-select").getAttribute("aria-expanded") === "false");
      report.collapsedFolderSearch = "passed";
    }
    report.checks.push("search_boards_nested_projects_and_tasks_keep_query_on_selection"); save();

    report.phase = "stale_queries_and_failure";
    let slowSeen = false, slowDone = false;
    await page.route("**/api/para/sidebar?**", async (route) => {
      if (!slowSeen && new URL(route.request().url()).searchParams.get("q") === `${projectName}-0`) {
        const response = await route.fetch(); slowSeen = true;
        await new Promise((r) => { releaseSlow = r; }); await route.fulfill({ response }); slowDone = true;
      } else await route.continue();
    });
    await search.fill(`${projectName}-0`); await until(() => slowSeen);
    await search.fill(`${projectName}-1`); await until(async () => (await visibleOrder()).join() === projectIds[1]);
    releaseSlow(); releaseSlow = null;
    await until(() => slowDone);
    await page.unroute("**/api/para/sidebar?**");
    await page.waitForTimeout(250);
    assert.deepEqual(await visibleOrder(), [projectIds[1]]);
    let failed = false;
    await page.route("**/api/para/boards/*/sidebar-projects?**", async (route) => {
      if (!failed && new URL(route.request().url()).pathname.includes(boardId)) { failed = true; await route.fulfill({ status: 503, json: { error: "验收模拟网络中断" } }); }
      else await route.continue();
    });
    await search.fill(`${projectName}-2`);
    await group.getByRole("alert").getByText("验收模拟网络中断", { exact: false }).waitFor();
    await group.getByRole("button", { name: "重试", exact: true }).click();
    await until(async () => (await visibleOrder()).join() === projectIds[2]);
    await page.unroute("**/api/para/boards/*/sidebar-projects?**");
    report.checks.push("old_search_response_ignored_network_failure_retry_keeps_selection"); save();

    report.phase = "project_drag";
    await search.fill(""); await until(async () => (await visibleOrder()).length === 5);
    const before = (await api("GET", `/para/projects/${projectIds[6]}`)).project;
    await projectRow(projectIds[6]).getByRole("button", { name: `拖动项目 ${projectName}-6`, exact: true }).press("ArrowUp");
    await until(async () => (await sidebarOrder())[0] === projectIds[6]);
    await until(async () => (await visibleOrder())[0] === projectIds[6]);
    const after = (await api("GET", `/para/projects/${projectIds[6]}`)).project;
    for (const key of ["revision", "position", "updated_at", "stage", "brief"]) assert.deepEqual(after[key], before[key]);
    await projectRow(projectIds[6]).dragTo(projectRow(projectIds[5]), { targetPosition: { x: 70, y: 34 } });
    await until(async () => (await sidebarOrder()).indexOf(projectIds[6]) > (await sidebarOrder()).indexOf(projectIds[5]));
    const mouseOrder = await sidebarOrder();
    await page.reload(); await until(async () => (await visibleOrder()).join() === mouseOrder.slice(0, 5).join());
    report.checks.push("keyboard_mouse_drag_survives_reload_without_changing_project_or_kanban"); save();

    report.phase = "project_menu_lifecycle";
    const target = projectIds[6], renamed = "改名后计划-" + stamp;
    await projectRow(target).getByRole("button", { name: `看板内项目 ${projectName}-6 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "改名", exact: true }).click();
    await dialog.getByLabel("项目名称", { exact: true }).fill(renamed);
    await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
    await until(async () => (await sidebarOrder())[0] === target);
    await projectRow(target).getByRole("button", { name: `看板内项目 ${renamed} 操作`, exact: true }).click();
    await page.getByRole("menu").screenshot({ path: path.join(work, "project-menu.png") });
    await page.getByRole("menuitem", { name: "归档项目", exact: true }).click();
    await dialog.getByRole("button", { name: "归档项目", exact: true }).click();
    await until(async () => !(await projectRow(target).count()));
    await page.getByRole("button", { name: "查看归档看板与项目", exact: true }).click();
    await projectRow(target).getByRole("button", { name: `看板内项目 ${renamed} 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "恢复项目", exact: true }).click();
    await dialog.getByRole("button", { name: "恢复项目", exact: true }).click();
    await until(async () => !(await api("GET", `/para/projects/${target}`)).project.archived_at);
    report.checks.push("project_menu_rename_archive_restore_and_real_edit_bumps_recent_order"); save();

    report.phase = "mobile_touch";
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureSidebar();
    await until(async () => (await page.locator(".sidebar").boundingBox()).x >= -1);
    await group.scrollIntoViewIfNeeded();
    const order = await visibleOrder();
    await until(async () => await projectRow(order[0]).locator(".para-board-grip").isEnabled());
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const grip = await projectRow(order[0]).locator(".para-board-grip").boundingBox(), dest = await projectRow(order[2]).boundingBox();
    report.touch = { order, grip, dest, sidebar: await page.locator(".sidebar").boundingBox(), sourceEnabled: await projectRow(order[0]).locator(".para-board-grip").isEnabled() }; save();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: dest.x + 80, y: dest.y + dest.height - 5 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(async () => (await sidebarOrder()).indexOf(order[0]) > (await sidebarOrder()).indexOf(order[2]));
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }); await cdp.detach();
    await group.screenshot({ path: path.join(work, "sidebar-mobile.png") });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.locator(".sidebar").evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      assert.ok(await group.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await group.screenshot({ path: path.join(work, "sidebar-mobile-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 900 });
    report.checks.push("touch_drag_mobile_390_320_and_dark_layout"); save();

    report.phase = "delete_cancel_confirm";
    await projectRow(target).locator(".para-sidebar-project-select").click();
    await workspace.getByRole("heading", { name: renamed, exact: true }).waitFor();
    const archiveGate = new Promise((resolve) => { releaseArchiveRefresh = resolve; });
    await page.route(`**/api/para/boards/${boardId}/sidebar-projects?**`, async (route) => {
      archiveReads++;
      try { const response = await route.fetch(); await archiveGate; await route.fulfill({ response }); }
      finally { archiveReads--; }
    });
    await projectRow(target).getByRole("button", { name: `看板内项目 ${renamed} 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "归档项目", exact: true }).click();
    await dialog.getByRole("button", { name: "归档项目", exact: true }).click();
    await until(async () => Boolean((await api("GET", `/para/projects/${target}`)).project.archived_at));
    const remove = async () => {
      await projectRow(target).getByRole("button", { name: `看板内项目 ${renamed} 操作`, exact: true }).click();
      await page.getByRole("menuitem", { name: "删除项目", exact: true }).click();
    };
    await remove(); // Must expose deletion before the intentionally delayed list refresh.
    report.archiveReceiptImmediatelyApplied = true; save();
    releaseArchiveRefresh(); releaseArchiveRefresh = null;
    await until(() => archiveReads === 0);
    await page.unroute(`**/api/para/boards/${boardId}/sidebar-projects?**`);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await api("GET", `/para/projects/${target}`);
    await remove(); await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await until(async () => !(await projectRow(target).count()));
    await workspace.getByRole("heading", { name, exact: true }).waitFor();
    assert.equal((await context.request.get(origin + `/api/para/projects/${target}`)).status(), 404);
    report.checks.push("archived_project_delete_requires_confirmation_and_returns_to_board");
    assert.deepEqual(report.errors, []); report.phase = "passed"; save();
  } catch (error) { report.failure = error.message; save(); throw error; }
  finally {
    releaseSlow?.(); releaseArchiveRefresh?.();
    for (let i = 0; i < 50 && archiveReads; i++) await page.waitForTimeout(100);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const cleanupErrors = [];
    for (const id of report.boardIds) {
      try {
        const data = await api("GET", `/para/boards/${id}`);
        for (const p of data.projects) {
          if (!report.projectIds.includes(p.id)) throw new Error("Unexpected fixture project");
          const archived = p.archived_at ? p : (await api("PATCH", `/para/projects/${p.id}`, { revision: p.revision, archived: true })).project;
          await api("DELETE", `/para/projects/${p.id}`, { revision: archived.revision });
        }
        const board = data.board.archived_at ? data.board : (await api("PATCH", `/para/boards/${id}`, { revision: data.board.revision, archived: true })).board;
        await api("DELETE", `/para/boards/${id}`, { revision: board.revision });
        assert.equal((await context.request.get(origin + `/api/para/boards/${id}`)).status(), 404);
      } catch (e) { cleanupErrors.push(e.message); }
    }
    for (const id of report.conversationIds) {
      try { await api("DELETE", `/conversations/${id}`); assert.equal((await context.request.get(origin + `/api/conversations/${id}`)).status(), 404); }
      catch (e) { cleanupErrors.push(e.message); }
    }
    report.cleanup = !cleanupErrors.length; report.cleanupErrors = cleanupErrors; save();
    assert.ok(report.cleanup, "fixture cleanup must complete");
  }
}
