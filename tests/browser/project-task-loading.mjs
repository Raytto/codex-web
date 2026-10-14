import fs from "node:fs";
import path from "node:path";

// Real authenticated API responses are held at the browser boundary to exercise
// both response orders. Only the explicit failure case injects a network error.
export async function run({ page, context, origin, work, assert }) {
  const report = { phase: "setup", checks: [] };
  const save = () => fs.writeFileSync(path.join(work, "project-task-loading.json"), JSON.stringify(report, null, 2));
  const until = async (fn) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await fn()) return;
      await page.waitForTimeout(50);
    }
    assert.fail(`Timed out: ${report.phase}`);
  };
  const projects = (await (await context.request.get(origin + "/api/projects")).json()).projects;
  const tasks = (await (await context.request.get(origin + "/api/recurring-tasks")).json()).tasks;
  const expanded = projects.filter(project => !project.sidebar_collapsed);
  assert.ok(expanded.length >= 2, "Acceptance requires multiple expanded projects");
  const target = expanded.find(project => tasks.some(task => task.project_id === project.id) && project.conversation_count > 0);
  assert.ok(target, "Acceptance requires an expanded project with both task types");
  const group = page.locator(`.project-group[data-project-id="${target.id}"]`);
  const children = group.locator(".project-conversations");
  const openSidebar = async () => {
    if (await page.locator(".sidebar").evaluate(el => matchMedia("(max-width: 720px)").matches && !el.classList.contains("open"))) {
      await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
    }
  };
  let releaseConversations, releaseRecurring;
  const conversationsPattern = "**/api/conversations?*";
  const recurringPattern = "**/api/recurring-tasks";
  try {
    for (const width of [1440, 390]) {
      for (const first of ["recurring", "conversations"]) {
        report.phase = `${width}_${first}_first`; save();
        await page.setViewportSize({ width, height: 900 });
        const conversationsGate = new Promise(resolve => { releaseConversations = resolve; });
        const recurringGate = new Promise(resolve => { releaseRecurring = resolve; });
        const requested = new Set();
        await page.route(conversationsPattern, async route => {
          requested.add(new URL(route.request().url()).searchParams.get("projectId"));
          await conversationsGate;
          await route.continue();
        });
        await page.route(recurringPattern, async route => { await recurringGate; await route.continue(); });
        await page.reload({ waitUntil: "domcontentloaded" });
        await children.locator(".list-loading").waitFor({ state: "attached" });
        await openSidebar();
        await until(() => expanded.every(project => requested.has(project.id)));
        assert.equal(await page.locator(".project-conversations .recurring-sidebar").count(), 0);
        assert.equal(await page.locator(".project-conversations .conversation-row").count(), 0);
        const response = page.waitForResponse(response => first === "recurring"
          ? new URL(response.url()).pathname === new URL(origin).pathname.replace(/\/$/, "") + "/api/recurring-tasks"
          : new URL(response.url()).pathname === new URL(origin).pathname.replace(/\/$/, "") + "/api/conversations" && new URL(response.url()).searchParams.get("projectId") === target.id);
        if (first === "recurring") releaseRecurring(); else releaseConversations();
        await response;
        await page.waitForTimeout(150);
        assert.equal(await children.locator(".list-loading").count(), 1, "one unified loading indicator");
        assert.equal(await children.locator(".recurring-sidebar, .conversation-row").count(), 0, "neither type appears alone");
        releaseConversations(); releaseRecurring();
        await until(async () => await children.locator(".recurring-sidebar").count() === 1 && await children.locator(".conversation-row").count() > 0);
        await until(async () => await children.getAttribute("aria-busy") === "false");
        assert.equal(await children.locator(".list-loading").count(), 0);
        assert.ok(await page.locator(".sidebar-content").evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        await page.unroute(conversationsPattern); await page.unroute(recurringPattern);
        report.checks.push(report.phase); save();
      }
    }
    report.phase = "failure_and_retry"; save();
    let fail = true;
    await page.route(conversationsPattern, route => new URL(route.request().url()).searchParams.get("projectId") === target.id && fail
      ? route.abort("failed") : route.continue());
    await page.reload({ waitUntil: "domcontentloaded" });
    await openSidebar();
    const retry = children.getByRole("button", { name: "重试", exact: true });
    await retry.waitFor();
    assert.equal(await children.locator(".list-loading, .recurring-sidebar, .conversation-row").count(), 0);
    fail = false;
    await retry.click();
    await until(async () => await children.locator(".recurring-sidebar").count() === 1 && await children.locator(".conversation-row").count() > 0);
    report.checks.push(report.phase); report.phase = "passed"; save();
  } finally {
    releaseConversations?.(); releaseRecurring?.();
    await page.unroute(conversationsPattern); await page.unroute(recurringPattern);
  }
}
