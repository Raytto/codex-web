import fs from "node:fs";
import path from "node:path";

// Independent empty conversations only: no model calls, private content or voice.
export async function run({ page, context, origin, work, assert }) {
  const report = { phase: "setup", checks: [], errors: [], boardIds: [], projectIds: [], conversationIds: [], requestKeys: [], cleanup: false };
  const save = () => fs.writeFileSync(path.join(work, "para-conversation-projects.json"), JSON.stringify(report, null, 2));
  page.on("pageerror", (e) => { report.errors.push(e.message); save(); });
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
    do { if (await fn()) return; await new Promise(r => setTimeout(r, 70)); } while (Date.now() < end);
    assert.fail("condition timed out in " + report.phase);
  };
  const stamp = Date.now().toString().slice(-8), prefix = "关联入口验收-" + stamp;
  const dialog = page.getByRole("dialog");
  const search = page.getByRole("textbox", { name: "搜索", exact: true });
  const row = id => page.locator(`[data-conversation-id="${id}"]`);
  const linkRow = id => dialog.locator(`[data-linked-project="${id}"]`);
  const links = async id => (await api("GET", `/para/conversations/${id}/projects`)).projects;
  const ensureSidebar = async () => {
    if (page.viewportSize().width <= 720 && !(await page.locator(".sidebar").evaluate(el => el.classList.contains("open")))) {
      await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
      await until(async () => (await page.locator(".sidebar").boundingBox()).x >= -1);
    }
  };
  const open = async (id) => {
    await ensureSidebar(); await row(id).hover(); await row(id).locator(".task-menu-trigger").click();
    const menu = page.locator(".task-menu-panel");
    const b = await menu.boundingBox();
    assert.ok(b.y >= 0 && b.y + b.height <= page.viewportSize().height + 1, "menu fits viewport");
    await menu.getByRole("menuitem", { name: "关联项目", exact: true }).click();
    await dialog.getByRole("heading", { name: "关联项目", exact: true }).waitFor();
  };
  const openHeader = async () => {
    await page.locator(".conversation-menu > summary").click();
    await page.locator(".conversation-menu-panel").getByRole("menuitem", { name: "关联项目", exact: true }).click();
    await dialog.getByRole("heading", { name: "关联项目", exact: true }).waitFor();
    assert.equal(await page.locator(".conversation-menu").evaluate(el => el.open), false);
  };
  const close = async () => { await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click(); };
  let releaseSlow, slowFinished, releaseRestore;
  try {
    const board = (await api("POST", "/para/boards", { key: crypto.randomUUID(), name: prefix })).board;
    report.boardIds.push(board.id); save();
    for (const title of ["主项目-" + stamp, "参考项目-" + stamp]) {
      const p = (await api("POST", `/para/boards/${board.id}/projects`, { key: crypto.randomUUID(), title })).project;
      report.projectIds.push(p.id); save();
    }
    const [p1, p2] = report.projectIds;
    const conversations = [];
    for (const suffix of ["正在查看", "菜单目标"]) {
      const c = (await api("POST", "/conversations", { reuseEmpty: false })).conversation;
      report.conversationIds.push(c.id); save();
      await api("PATCH", `/conversations/${c.id}`, { title: prefix + suffix }); conversations.push(c);
    }
    const [a, b] = conversations;
    // Restore a known fixture, but hold the real validation response while the
    // user chooses another visible conversation and opens a sidebar menu.
    await page.evaluate(({ accountId, projectId, conversationId }) => {
      const scope = encodeURIComponent(accountId);
      localStorage.setItem(`cww:account:${scope}:selected-project`, projectId);
      localStorage.setItem(`cww:account:${scope}:selected-conversation`, conversationId);
    }, { accountId: report.accountId, projectId: b.project_id, conversationId: b.id });
    const restoreGate = new Promise(resolve => { releaseRestore = resolve; });
    const restoreRequests = [];
    let restoreSeen = false;
    const restorePattern = "**/api/conversation-selection?**";
    await page.route(restorePattern, async route => {
      if (new URL(route.request().url()).searchParams.get("conversationId") !== b.id) return route.continue();
      const response = await route.fetch();
      restoreSeen = true;
      const pending = restoreGate.then(() => route.fulfill({ response }));
      restoreRequests.push(pending);
      await pending;
    });
    let projectReads = 0;
    const countRead = request => { if (request.url().includes(`/para/conversations/${a.id}/projects`)) projectReads++; };
    page.on("request", countRead);
    await page.reload(); await until(() => restoreSeen);
    await search.fill(prefix); await row(a.id).locator(".conversation-select").click();
    await page.locator(".workspace-header").getByText(prefix + "正在查看", { exact: true }).waitFor();
    assert.equal(await page.locator(".para-conversation-bar").count(), 0);
    assert.equal(projectReads, 0, "chat does not fetch project links until requested");
    page.off("request", countRead);
    report.checks.push("clean_chat_no_permanent_project_bar_or_eager_link_reads"); save();

    report.phase = "sidebar_target_and_linking";
    await open(b.id);
    await dialog.getByText("尚未关联项目", { exact: true }).waitFor();
    await dialog.getByText(prefix + "菜单目标", { exact: true }).waitFor();
    releaseRestore(); releaseRestore = null;
    await Promise.all(restoreRequests); await page.unroute(restorePattern);
    await until(async () => await page.locator(".list-loading").count() === 0);
    await page.locator(".composer").waitFor();
    await page.locator(".workspace-header").getByText(prefix + "正在查看", { exact: true }).waitFor();
    assert.ok(await row(a.id).evaluate(el => el.classList.contains("active")));
    report.manualSelectionSurvivedLateRestore = true; save();
    const chooseProject = async (id) => {
      await dialog.getByRole("button", { name: "添加关联", exact: true }).click();
      report.phase = "choose_board"; save();
      await until(async () => await dialog.getByRole("combobox").nth(0).locator(`option[value="${board.id}"]`).count());
      await dialog.getByRole("combobox").nth(0).selectOption(board.id);
      report.phase = "choose_project"; save();
      await until(async () => await dialog.getByRole("combobox").nth(1).locator(`option[value="${id}"]`).count());
      await dialog.getByRole("combobox").nth(1).selectOption(id);
      report.phase = "sidebar_target_and_linking"; save();
    };
    await chooseProject(p1);
    await dialog.getByRole("button", { name: "确认收录", exact: true }).click();
    await linkRow(p1).getByText("主项目", { exact: true }).waitFor();
    assert.equal((await links(a.id)).length, 0);
    assert.equal((await links(b.id))[0].id, p1);
    await chooseProject(p2);
    const postPattern = `**/api/para/projects/${p2}/conversations`;
    await page.route(postPattern, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "验收：网络暂不可用" }) }));
    await dialog.getByRole("button", { name: "确认收录", exact: true }).click();
    await dialog.getByText("验收：网络暂不可用", { exact: true }).waitFor();
    assert.equal((await links(b.id)).length, 1);
    await page.unroute(postPattern);
    await dialog.getByRole("button", { name: "确认收录", exact: true }).click();
    await linkRow(p2).getByText("参考关联", { exact: true }).waitFor();
    assert.equal((await links(b.id)).length, 2);
    await dialog.screenshot({ path: path.join(work, "linked-projects-desktop.png") });
    report.checks.push("sidebar_target_isolated_add_primary_reference_and_write_failure_retry"); save();

    report.phase = "primary_and_unlink";
    page.once("dialog", d => d.dismiss());
    await linkRow(p2).getByRole("button", { name: "设为主项目", exact: true }).click();
    assert.equal((await links(b.id)).find(p => p.id === p1).relation, "primary");
    page.once("dialog", d => d.accept());
    await linkRow(p2).getByRole("button", { name: "设为主项目", exact: true }).click();
    await linkRow(p2).getByText("主项目", { exact: true }).waitFor();
    await linkRow(p1).getByText("参考关联", { exact: true }).waitFor();
    await until(async () => (await links(b.id)).find(p => p.id === p2).relation === "primary");
    page.once("dialog", d => d.dismiss());
    await linkRow(p1).getByRole("button", { name: "取消关联", exact: true }).click();
    assert.equal((await links(b.id)).length, 2);
    page.once("dialog", d => d.accept());
    await linkRow(p1).getByRole("button", { name: "取消关联", exact: true }).click();
    await until(async () => (await links(b.id)).length === 1);
    await until(async () => !(await linkRow(p1).count()));
    assert.equal((await api("GET", `/conversations/${b.id}`)).conversation.project_id, b.project_id);
    await api("GET", `/para/projects/${p1}`);
    report.checks.push("primary_switch_and_unlink_confirmation_preserve_conversation_and_project"); save();

    report.phase = "reload_failure_stale_reads";
    await close(); await page.reload(); await search.fill(prefix);
    const readPattern = `**/api/para/conversations/${b.id}/projects`;
    await page.route(readPattern, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "验收：关联读取失败" }) }));
    await open(b.id); await dialog.getByRole("alert").getByText("验收：关联读取失败").waitFor();
    assert.ok(await dialog.getByRole("button", { name: "添加关联", exact: true }).isDisabled());
    assert.equal(await dialog.getByText("尚未关联项目", { exact: true }).count(), 0);
    await page.unroute(readPattern); await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await linkRow(p2).getByText("主项目", { exact: true }).waitFor();
    await close();
    const gate = new Promise(r => { releaseSlow = r; }); let slowSeen = false;
    let finishSlow;
    slowFinished = new Promise(resolve => { finishSlow = resolve; });
    await page.route(readPattern, async route => {
      try {
        const response = await route.fetch(); slowSeen = true;
        await gate; await route.fulfill({ response });
      } finally { finishSlow(); }
    });
    await open(b.id); await until(() => slowSeen); await close(); await open(a.id);
    await dialog.getByText("尚未关联项目", { exact: true }).waitFor();
    releaseSlow(); releaseSlow = null; await slowFinished; await page.unroute(readPattern);
    assert.equal(await linkRow(p2).count(), 0);
    await dialog.getByText(prefix + "正在查看", { exact: true }).waitFor(); await close();
    report.checks.push("reload_persistence_read_retry_and_closed_dialog_stale_response_isolation"); save();

    report.phase = "header_current_conversation";
    await row(a.id).locator(".conversation-select").click();
    await openHeader(); await dialog.getByText(prefix + "正在查看", { exact: true }).waitFor();
    await dialog.getByText("尚未关联项目", { exact: true }).waitFor(); await close();
    await row(b.id).locator(".conversation-select").click();
    await openHeader(); await dialog.getByText(prefix + "菜单目标", { exact: true }).waitFor();
    await linkRow(p2).getByText("主项目", { exact: true }).waitFor(); await close();
    report.checks.push("header_menu_opens_current_conversation_and_matches_sidebar_links"); save();

    report.phase = "project_navigation_mobile";
    await open(b.id); await linkRow(p2).locator(".para-linked-project-open").click();
    await page.locator(".para-workspace:not(.para-hidden)").getByRole("heading", { name: "参考项目-" + stamp, exact: true }).waitFor();
    assert.equal(await dialog.count(), 0);
    await row(b.id).locator(".conversation-select").click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 }); await openHeader();
      await linkRow(p2).getByText("主项目", { exact: true }).waitFor();
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await dialog.screenshot({ path: path.join(work, `linked-projects-${width}.png`) });
      await close();
    }
    await page.emulateMedia({ colorScheme: "dark" }); await open(b.id);
    await linkRow(p2).getByText("主项目", { exact: true }).waitFor();
    await dialog.screenshot({ path: path.join(work, "linked-projects-dark.png") });
    await close(); await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(b.id); page.once("dialog", d => d.accept());
    await linkRow(p2).getByRole("button", { name: "取消关联", exact: true }).click();
    await dialog.getByText("尚未关联项目", { exact: true }).waitFor(); await close();
    assert.equal((await links(b.id)).length, 0); assert.equal((await links(a.id)).length, 0);
    assert.equal(await page.locator(".para-conversation-bar").count(), 0);
    report.checks.push("project_navigation_mobile390_320_dark_and_remove_last_link");
    assert.deepEqual(report.errors, []); report.phase = "passed"; save();
  } catch (e) {
    report.failure = e.message;
    if (/^(localhost|127\.)/.test(new URL(origin).hostname) && await dialog.count()) {
      report.localDialog = await dialog.innerText();
      await dialog.screenshot({ path: path.join(work, "local-failure.png") }).catch(() => {});
    }
    save(); throw e;
  }
  finally {
    releaseRestore?.();
    releaseSlow?.();
    await page.unrouteAll({ behavior: "wait" });
    const errors = [];
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
        assert.equal((await context.request.get(origin + `/api/para/boards/${id}`)).status(), 404);
      } catch (e) { errors.push(e.message); }
    }
    for (const id of report.conversationIds) {
      try { await api("DELETE", `/conversations/${id}`); assert.equal((await context.request.get(origin + `/api/conversations/${id}`)).status(), 404); }
      catch (e) { errors.push(e.message); }
    }
    report.cleanup = !errors.length; report.cleanupErrors = errors; save(); assert.ok(report.cleanup, "fixture cleanup completes");
  }
}
