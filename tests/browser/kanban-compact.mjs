import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Use dedicated data with real API writes; never modify existing projects.
export async function run({ page, context, origin, work, assert }) {
  const report = { phase: "setup", checks: [], errors: [], projectIds: [], cleanup: false };
  const save = () => fs.writeFileSync(path.join(work, "kanban-compact.json"), JSON.stringify(report, null, 2));
  page.on("pageerror", error => report.errors.push(error.message));
  const session = await (await context.request.get(origin + "/api/auth/session")).json();
  const api = async (method, route, data) => {
    const response = await context.request.fetch(origin + "/api" + route, { method, data, headers: { "X-CSRF-Token": session.csrfToken } });
    assert.ok(response.ok(), method + " " + route + ": " + response.status());
    return response.status() === 204 ? null : response.json();
  };
  const until = async fn => {
    const end = Date.now() + 15000;
    do { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 80)); } while (Date.now() < end);
    assert.fail("Timed out: " + report.phase);
  };
  const originalFeatures = await api("GET", "/user-settings/features");
  const originalPreferences = (await api("GET", "/para/summary")).preferences;
  let featureRevision, preferenceRevision;
  const view = page.locator(".para-workspace:not(.para-hidden)");
  const dialog = page.locator("dialog[open]");
  const stages = ["idea", "incubating", "active", "review", "done"];
  const labels = ["想法池", "准备中", "进行中", "待验收", "已完成"];
  const projects = [];
  const current = async id => (await api("GET", "/para/projects/" + id)).project;
  const card = index => view.locator('[data-project-id="' + projects[index].id + '"]');
  const badge = index => card(index).locator(".para-stage-badge button");
  const choose = async (index, label) => {
    await badge(index).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  };
  const boardName = "界面验收看板-" + Date.now().toString().slice(-7);
  try {
    if (!originalFeatures.paraBoard) {
      featureRevision = (await api("PUT", "/user-settings/features", { ...originalFeatures, paraBoard: true })).revision;
    }
    report.boardId = (await api("POST", "/para/boards", { key: crypto.randomUUID(), name: boardName })).board.id;
    save();
    const titles = ["整理一次旅行的想法", "准备个人作品集", "制作首页与作品页面", "检查平板上的阅读体验", "发布第一版作品集", "一个较长的项目名称，用来检查窄屏换行和标签的点击区域是否清晰"];
    for (let index = 0; index < titles.length; index++) {
      let project = (await api("POST", "/para/boards/" + report.boardId + "/projects", { key: crypto.randomUUID(), title: titles[index], stage: "idea" })).project;
      report.projectIds.push(project.id); save();
      if (index > 0 && index < stages.length) {
        project = (await api("PATCH", "/para/projects/" + project.id, {
          revision: project.revision, stage: stages[index], outcome: index === 4 ? "页面已发布，阅读检查通过。" : "",
          brief: { ...project.brief, next: ["", "选择三份代表作品", "完成首页的第一版布局", "核对文字、图片与导航", ""][index] },
        })).project;
      }
      projects.push(project);
    }
    await page.reload();
    await page.locator('[data-board-id="' + report.boardId + '"] .para-sidebar-item').click();
    await view.getByRole("heading", { name: boardName, exact: true }).waitFor();
    report.phase = "compact_layout"; save();
    assert.equal(await view.locator(".kanban-overview, .para-search, .para-card-stage").count(), 0);
    assert.equal(await view.getByRole("checkbox", { name: "只看暂停" }).count(), 0);
    assert.equal(await view.getByPlaceholder("搜索项目").count(), 0);
    assert.equal(await view.getByText("先完成手上的事，再开始下一件。", { exact: true }).count(), 0);
    assert.equal(await card(0).locator(".para-card-count, .para-card-body p").count(), 0);
    const colors = [];
    for (let index = 0; index < stages.length; index++) {
      assert.equal(await card(index).locator(".para-stage-select").count(), 1);
      assert.equal((await badge(index).innerText()).trim(), labels[index]);
      const color = await badge(index).locator(".para-stage-dot").evaluate(el => getComputedStyle(el).backgroundColor);
      const columnColor = await view.locator(".para-column.stage-" + stages[index] + " > h2 .para-stage-dot").evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(color, columnColor); colors.push(color);
    }
    assert.equal(new Set(colors).size, 5);
    assert.ok((await view.locator(".para-board").boundingBox()).y < 300, "projects appear near the top of the desktop viewport");
    report.checks.push("compact_header_one_colored_stage_per_card_no_duplicate_controls_or_empty_metadata");

    report.phase = "stage_interaction"; save();
    await badge(0).click();
    assert.equal(await page.getByRole("listbox").getByRole("option").count(), 6);
    for (let index = 0; index < stages.length; index++) {
      assert.equal(await page.getByRole("option", { name: labels[index], exact: true }).locator(".para-stage-dot").evaluate(el => getComputedStyle(el).backgroundColor), colors[index]);
    }
    await page.keyboard.press("Escape");
    assert.equal(await badge(0).evaluate(el => el === document.activeElement), true);
    await badge(0).press("ArrowDown"); await badge(0).press("ArrowDown"); await badge(0).press("Enter");
    await until(async () => (await current(projects[0].id)).stage === "incubating");
    await card(0).locator(".para-stage-badge.stage-incubating").waitFor();
    await choose(0, "想法池"); await until(async () => (await current(projects[0].id)).stage === "idea");
    await view.getByRole("button", { name: "撤销", exact: true }).click();
    await until(async () => (await current(projects[0].id)).stage === "incubating");
    await choose(0, "想法池"); await until(async () => (await current(projects[0].id)).stage === "idea");
    const route = origin + "/api/para/projects/" + projects[0].id;
    let fail = true;
    await page.route(route, async intercepted => {
      if (fail && intercepted.request().method() === "PATCH") {
        fail = false;
        return intercepted.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "验收模拟保存失败" }) });
      }
      return intercepted.continue();
    });
    await choose(0, "准备中"); await view.getByRole("alert").waitFor();
    assert.equal((await current(projects[0].id)).stage, "idea");
    await choose(0, "准备中"); await until(async () => (await current(projects[0].id)).stage === "incubating");
    await page.unroute(route);
    await choose(0, "想法池"); await until(async () => (await current(projects[0].id)).stage === "idea");
    if (await view.getByRole("button", { name: "关闭撤销提示" }).count()) await view.getByRole("button", { name: "关闭撤销提示" }).click();
    report.checks.push("colored_menu_keyboard_escape_stage_write_undo_failure_retry");

    report.phase = "settings_and_filter"; save();
    await view.getByRole("button", { name: "看板设置", exact: true }).click();
    await dialog.getByLabel("个人在制上限", { exact: true }).fill("1");
    await dialog.getByRole("button", { name: "保存上限", exact: true }).click();
    await dialog.getByText("已保存", { exact: true }).waitFor();
    preferenceRevision = (await api("GET", "/para/summary")).preferences.revision;
    assert.equal((await api("GET", "/para/summary")).preferences.wip_limit, 1);
    await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await choose(0, "进行中");
    await dialog.getByText(/已达到在制上限/).waitFor();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await current(projects[0].id)).stage, "idea");
    await view.getByRole("button", { name: "阶段筛选", exact: true }).click();
    await page.getByRole("option", { name: "已终止", exact: true }).click();
    await view.getByText("这个阶段还没有项目", { exact: true }).waitFor();
    await view.getByRole("button", { name: "查看全部项目", exact: true }).click();
    assert.equal(await view.locator(".para-column").count(), 5);
    await view.getByRole("button", { name: "切换为列表视图" }).click();
    const first = await card(0).boundingBox(), second = await card(5).boundingBox();
    assert.equal(Math.round(first.x), Math.round(second.x)); assert.ok(second.y >= first.y + first.height);
    await view.screenshot({ path: path.join(work, "kanban-list.png") });
    await view.getByRole("button", { name: "切换为看板视图" }).click();
    report.checks.push("preferences_moved_to_settings_preserved_limit_warning_empty_filter_recovery_true_list");

    report.phase = "responsive"; save();
    for (const width of [1440, 1366, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width > 720 ? 900 : 844 });
      await view.locator(".para-scroll").evaluate(el => { el.scrollTop = 0; });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no page overflow at " + width);
      assert.equal(await view.locator(".para-column").count(), 5);
      await badge(0).click();
      const menuBox = await page.getByRole("listbox").boundingBox();
      assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1 && menuBox.y >= 0 && menuBox.y + menuBox.height <= (width > 720 ? 900 : 844));
      if (width <= 720) assert.ok((await badge(0).boundingBox()).height >= 44);
      await page.keyboard.press("Escape");
      await view.screenshot({ path: path.join(work, "kanban-" + width + ".png") });
      await view.getByRole("button", { name: "看板设置", exact: true }).click();
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "settings has no overflow");
      assert.equal(await dialog.getByLabel("个人在制上限", { exact: true }).inputValue(), "1");
      assert.ok(await dialog.getByRole("button", { name: "保存上限", exact: true }).evaluate(el => el.getBoundingClientRect().height >= 44));
      if (width === 320) {
        await page.locator("html").evaluate(el => { el.style.fontSize = "200%"; });
        assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "enlarged settings text reflows");
        await page.locator("html").evaluate(el => { el.style.fontSize = ""; });
      }
      await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
    }
    report.checks.push("desktop_tablet768_tablet1366_mobile390_mobile320_menu_bounds_touch_targets_settings_zoom");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".account-profile").click();
    await page.getByRole("button", { name: "显示设置", exact: true }).click();
    await page.getByRole("button", { name: "使用深色模式", exact: true }).click();
    await page.getByRole("button", { name: "关闭显示设置", exact: true }).click();
    await view.screenshot({ path: path.join(work, "kanban-dark.png") });
    const touchContext = await context.browser().newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const touch = await touchContext.newPage(); await touch.goto(origin);
      const touchBadge = touch.locator('.para-workspace:not(.para-hidden) [data-project-id="' + projects[0].id + '"] .para-stage-badge button');
      await touchBadge.tap(); await touch.getByRole("option", { name: "准备中", exact: true }).tap();
      await until(async () => (await current(projects[0].id)).stage === "incubating");
      await touch.reload();
      await touch.locator('.para-workspace:not(.para-hidden) [data-project-id="' + projects[0].id + '"] .para-stage-badge.stage-incubating').waitFor();
    } finally { await touchContext.close(); }
    assert.deepEqual(report.errors, []);
    report.checks.push("dark_theme_touch_stage_selection_and_reload_persistence");
    report.phase = "passed"; save();
  } catch (error) {
    report.failure = error.message; save();
    await view.screenshot({ path: path.join(work, "kanban-failure.png"), timeout: 3000 }).catch(() => {});
    throw error;
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    const cleanupErrors = [];
    try {
      if (report.boardId) {
        const data = await api("GET", "/para/boards/" + report.boardId);
        for (const item of data.projects) {
          assert.ok(report.projectIds.includes(item.id));
          const archived = (await api("PATCH", "/para/projects/" + item.id, { revision: item.revision, archived: true, confirm_running: true })).project;
          await api("DELETE", "/para/projects/" + item.id, { revision: archived.revision });
        }
        await api("DELETE", "/para/boards/" + report.boardId, { revision: data.board.revision });
      }
    } catch (error) { cleanupErrors.push(error.message); }
    try {
      const latest = (await api("GET", "/para/summary")).preferences;
      if (latest.revision === preferenceRevision) await api("PATCH", "/para/preferences", { revision: latest.revision, wip_limit: originalPreferences.wip_limit });
      const features = await api("GET", "/user-settings/features");
      if (features.revision === featureRevision) await api("PUT", "/user-settings/features", { ...features, paraBoard: originalFeatures.paraBoard });
    } catch (error) { cleanupErrors.push(error.message); }
    report.cleanup = cleanupErrors.length === 0; report.cleanupErrors = cleanupErrors; save();
    assert.ok(report.cleanup, "dedicated data removed and settings restored");
  }
}
