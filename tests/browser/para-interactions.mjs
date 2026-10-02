import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Used locally with a marked ASR stub, and after deployment with real ASR.
// Audio comes from a synthetic speech fixture, not a person's microphone.
export async function run({ page, context, origin, work, assert }) {
  const realAsr = process.env.CODEX_WEB_BROWSER_REAL_ASR === "true";
  const report = { realAsr, phase: "setup", checks: [], errors: [], boardIds: [], deletedBoardIds: [], transcriptionIds: [], recordingIds: [], cleanup: false };
  const save = () => fs.writeFileSync(path.join(work, "para-interactions.json"), JSON.stringify(report, null, 2));
  page.on("pageerror", (e) => report.errors.push(e.message));
  const session = await (await context.request.get(origin + "/api/auth/session")).json();
  report.accountId = session.accountId;
  const api = async (method, route, data) => {
    const result = await context.request.fetch(origin + "/api" + route, { method, data, headers: { "X-CSRF-Token": session.csrfToken } });
    assert.ok(result.ok(), `${method} ${route}: ${result.status()}`);
    return result.status() === 204 ? null : result.json();
  };
  const until = async (fn, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    do { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } while (Date.now() < deadline);
    assert.fail("bounded condition did not become true in phase " + report.phase);
  };
  const name = "交互验收-" + Date.now().toString().slice(-7);
  const renamed = name + "-改名";
  const board = page.locator(".para-workspace:not(.para-hidden)");
  const dialog = page.getByRole("dialog");
  const audioFile = path.join(work, "fixture.wav");
  assert.equal(spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "flite=text='Plan a small garden this weekend':voice=slt", "-ar", "16000", "-ac", "1", "-y", audioFile]).status, 0);
  await page.evaluate((wav) => {
    const fixture = window.__paraAudio = { wav, calls: 0, delay: false, denied: false, streams: [], contexts: [] };
    navigator.mediaDevices.getUserMedia = async () => {
      fixture.calls += 1;
      if (fixture.denied) throw new DOMException("fixture denial", "NotAllowedError");
      const audio = new AudioContext();
      fixture.contexts.push(audio);
      const bytes = Uint8Array.from(atob(fixture.wav), (c) => c.charCodeAt(0));
      const buffer = await audio.decodeAudioData(bytes.buffer);
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const output = audio.createMediaStreamDestination();
      source.connect(output);
      await audio.resume();
      source.start();
      fixture.streams.push(output.stream);
      if (fixture.delay) await new Promise((resolve) => { fixture.resolve = resolve; });
      return output.stream;
    };
  }, fs.readFileSync(audioFile).toString("base64"));
  let failAsr = true;
  const transcriptRoute = async (route) => {
    if (failAsr) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "验收模拟断网，请重试" }) });
    if (!realAsr) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "Plan a small garden this weekend.", transcriptionId: crypto.randomUUID() }) });
    return route.continue();
  };
  await page.route(origin + "/api/transcriptions", transcriptRoute);
  page.on("request", (request) => {
    if (request.url() !== origin + "/api/transcriptions") return;
    const id = request.postData()?.match(/name="clientRecordingId"\r\n\r\n([^\r]+)/)?.[1];
    if (id && !report.recordingIds.includes(id)) { report.recordingIds.push(id); save(); }
  });
  page.on("response", async (response) => {
    if (response.url() !== origin + "/api/transcriptions" || response.status() !== 200) return;
    const body = await response.json();
    report.transcriptionIds.push(body.transcriptionId);
    report.transcriptContainsFixture = /garden|花园|周末/i.test(body.text);
    save();
  });
  let mainId;
  try {
    report.phase = "sidebar";
    await page.getByRole("button", { name: "看板操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建看板", exact: true }).click();
    await dialog.getByLabel("看板名称", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "创建看板", exact: true }).click();
    await board.getByRole("heading", { name, exact: true }).waitFor();
    mainId = (await api("GET", "/para/boards")).boards.find((b) => b.name === name).id;
    report.boardIds.push(mainId); save();
    for (let i = 1; i < 17; i++) {
      const b = (await api("POST", "/para/boards", { key: crypto.randomUUID(), name: i ? `${name}-${i}` : name })).board;
      report.boardIds.push(b.id);
      save();
    }
    await page.evaluate(() => window.dispatchEvent(new Event("para-updated")));
    await page.locator(".para-sidebar-item").filter({ hasText: name + "-12" }).waitFor();
    const headingPositions = await page.evaluate(() => [document.querySelector(".para-sidebar .section-label > span").getBoundingClientRect().left, document.querySelector(".project-section .section-label > span").getBoundingClientRect().left]);
    assert.ok(Math.abs(headingPositions[0] - headingPositions[1]) < 1);
    const menuPositions = await page.evaluate(() => [document.querySelector(".para-sidebar .section-label button").getBoundingClientRect().right, document.querySelector(".project-section .section-label button").getBoundingClientRect().right]);
    assert.ok(Math.abs(menuPositions[0] - menuPositions[1]) < 1);
    assert.deepEqual(await page.locator(".sidebar").evaluate((el) => Array.from(el.querySelectorAll("*")).filter((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1).map((n) => n.className)), ["sidebar-content"]);
    const scroll = page.locator(".sidebar-content");
    const before = await scroll.evaluate((el) => ({ para: el.querySelector(".para-sidebar").getBoundingClientRect().top, folders: el.querySelector(".project-section").getBoundingClientRect().top }));
    await scroll.hover();
    await page.mouse.wheel(0, 260);
    await until(async () => (await scroll.evaluate((el) => el.scrollTop)) > 100);
    const after = await scroll.evaluate((el) => ({ para: el.querySelector(".para-sidebar").getBoundingClientRect().top, folders: el.querySelector(".project-section").getBoundingClientRect().top }));
    assert.ok(Math.abs((before.para - after.para) - (before.folders - after.folders)) < 1);
    report.checks.push("headings_aligned_single_scroll_for_boards_and_folders");
    const firstRow = page.locator(`[data-board-id="${mainId}"]`);
    const thirdRow = page.locator(`[data-board-id="${report.boardIds[2]}"]`);
    await firstRow.dragTo(thirdRow, { targetPosition: { x: 80, y: 34 } });
    await until(async () => {
      const ids = (await api("GET", "/para/boards")).boards.map((b) => b.id);
      return ids.indexOf(mainId) > ids.indexOf(report.boardIds[2]);
    });
    const grip = firstRow.getByRole("button", { name: `拖动看板 ${name}`, exact: true });
    await grip.press("ArrowUp");
    await until(async () => {
      const ids = (await api("GET", "/para/boards")).boards.map((b) => b.id);
      return ids.indexOf(mainId) < ids.indexOf(report.boardIds[2]);
    });
    report.checks.push("header_new_board_mouse_drag_keyboard_reorder_persisted");
    await page.locator(".para-sidebar-item").filter({ hasText: new RegExp(`^${name}$`) }).click();
    await board.getByRole("heading", { name, exact: true }).waitFor();
    await page.getByRole("button", { name: `看板 ${name} 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "改名", exact: true }).click();
    await dialog.getByLabel("看板名称", { exact: true }).fill(renamed);
    await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
    await board.getByRole("heading", { name: renamed, exact: true }).waitFor();
    await page.getByRole("button", { name: `看板 ${renamed} 操作`, exact: true }).click();
    await page.getByRole("menu").screenshot({ path: path.join(work, "board-menu.png") });
    await page.getByRole("menuitem", { name: "归档看板", exact: true }).click();
    await board.getByText("看板已归档", { exact: false }).waitFor();
    await page.getByRole("button", { name: "查看归档看板与项目", exact: true }).click();
    await page.getByRole("button", { name: `看板 ${renamed} 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "恢复看板", exact: true }).click();
    await until(async () => !(await api("GET", "/para/boards/" + mainId)).board.archived_at);
    report.checks.push("sidebar_board_rename_archive_restore_persists");
    report.phase = "voice";
    await board.getByRole("button", { name: "记个想法", exact: true }).click();
    const field = dialog.getByLabel("一句话记录", { exact: true });
    await field.fill("测试想法");
    const frame = await dialog.locator(".para-voice-composer").boundingBox();
    const mic = await dialog.getByRole("button", { name: "语音输入", exact: true }).boundingBox();
    assert.ok(mic.x > frame.x && mic.x + mic.width < frame.x + frame.width && mic.y >= frame.y);
    assert.ok((await dialog.locator(".para-voice-mic svg").boundingBox()).width >= 19);
    await dialog.screenshot({ path: path.join(work, "idea-idle.png") });
    await page.evaluate(() => { window.__paraAudio.denied = true; });
    await dialog.getByRole("button", { name: "语音输入", exact: true }).click();
    await dialog.getByText("请允许浏览器使用麦克风，然后再试一次。", { exact: true }).waitFor();
    await page.evaluate(() => { window.__paraAudio.denied = false; window.__paraAudio.delay = true; });
    await dialog.getByRole("button", { name: "语音输入", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__paraAudio.resolve));
    assert.equal(await dialog.getByRole("button", { name: "正在开启麦克风", exact: true }).isDisabled(), true);
    await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await page.evaluate(() => { window.__paraAudio.resolve(); window.__paraAudio.delay = false; });
    await page.waitForFunction(() => window.__paraAudio.streams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")));
    await board.getByRole("button", { name: "记个想法", exact: true }).click();
    assert.equal(await field.inputValue(), "测试想法");
    await dialog.getByRole("button", { name: "语音输入", exact: true }).click();
    await dialog.getByRole("button", { name: "取消录音", exact: true }).waitFor();
    await field.fill("测试想法，录音中手动补充");
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".para-voice-composer canvas");
      return canvas && canvas.width > 50 && canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 === 3 && value > 0);
    });
    assert.equal(await dialog.getByRole("button", { name: "保存想法", exact: true }).isDisabled(), true);
    await dialog.screenshot({ path: path.join(work, "idea-recording.png") });
    await dialog.getByRole("button", { name: "取消录音", exact: true }).click();
    assert.equal(await field.inputValue(), "测试想法，录音中手动补充");
    await dialog.getByRole("button", { name: "语音输入", exact: true }).click();
    await dialog.getByRole("button", { name: "停止录音并识别", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".para-voice-composer time")?.textContent >= "00:03");
    await dialog.getByRole("button", { name: "停止录音并识别", exact: true }).click();
    await dialog.getByRole("button", { name: "重试识别语音", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "稍后继续", exact: true }).click();
    await board.getByRole("button", { name: "记个想法", exact: true }).click();
    await dialog.getByRole("button", { name: "重试识别语音", exact: true }).waitFor();
    failAsr = false;
    await dialog.getByRole("button", { name: "重试识别语音", exact: true }).click();
    await until(async () => /garden|花园|周末/i.test(await field.inputValue()), realAsr ? 150000 : 15000);
    assert.match(await field.inputValue(), /^测试想法，录音中手动补充/);
    assert.equal(report.transcriptContainsFixture, true);
    assert.equal(new Set(report.recordingIds).size, 1, "retry must reuse the same recording ID");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await dialog.screenshot({ path: path.join(work, `idea-${width}.png`) });
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    await dialog.screenshot({ path: path.join(work, "idea-dark.png") });
    await page.evaluate(() => document.documentElement.dataset.theme = "light");
    await page.emulateMedia({ colorScheme: "light" });
    await dialog.getByRole("button", { name: "保存想法", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    report.checks.push("mic_inside_field_permission_cancel_late_permission_waveform_typing_preserved");
    report.checks.push(realAsr ? "real_asr_retry_same_audio_speech_saved" : "local_asr_stub_retry_saved");
    report.checks.push("idea_390_320_dark_layout");
    report.phase = "stage";
    await board.getByRole("button", { name: "项目阶段", exact: true }).click();
    const mobileMenu = await page.getByRole("listbox").boundingBox();
    assert.ok(mobileMenu.x >= 0 && mobileMenu.x + mobileMenu.width <= 320 && mobileMenu.y >= 0 && mobileMenu.y + mobileMenu.height <= 844);
    await board.screenshot({ path: path.join(work, "stages-mobile.png") });
    await page.getByRole("option", { name: "准备中", exact: true }).click();
    report.checks.push("stage_menu_320px_fits_and_selects");
    await page.setViewportSize({ width: 1440, height: 900 });
    await board.getByRole("button", { name: "项目阶段", exact: true }).click();
    // A delayed scroll notification can arrive after the trigger was focused.
    // Its anchor is already measured at the final position; the menu must stay.
    await board.locator(".para-scroll").evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole("listbox").count(), 1);
    await page.getByRole("option", { name: "准备中", exact: true }).click();
    await until(async () => (await api("GET", "/para/boards/" + mainId)).projects[0]?.stage === "incubating");
    await board.getByRole("button", { name: renamed, exact: true }).click();
    const stage = board.locator(".para-card .setting-select").first();
    await stage.click();
    assert.equal(await page.getByRole("option", { name: "准备中", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await page.getByRole("option", { name: "准备中", exact: true }).locator("svg").count(), 1);
    const menu = await page.getByRole("listbox").boundingBox();
    assert.ok(menu.x >= 0 && menu.y >= 0 && menu.y + menu.height <= 900 && menu.height >= 140 && menu.width < 250);
    // Unrelated sidebar scrolling cannot move the stage trigger either.
    await scroll.evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole("listbox").count(), 1);
    await board.screenshot({ path: path.join(work, "stages-desktop.png") });
    await stage.press("ArrowDown");
    await stage.press("Enter");
    await dialog.getByRole("button", { name: "开始推进", exact: true }).click();
    await until(async () => (await api("GET", "/para/boards/" + mainId)).projects[0]?.stage === "active");
    report.checks.push("stage_chat_setting_menu_checkmark_keyboard_and_persistence");
    // The same field is used for notes; closing a recording must release it.
    await board.locator(".para-card-body").first().click();
    await board.getByRole("button", { name: /^资料 0$/ }).click();
    await board.getByRole("button", { name: "添加资料", exact: true }).click();
    await dialog.getByLabel("文字或摘录", { exact: true }).fill("仅验收录音关闭后释放麦克风");
    await dialog.getByRole("button", { name: "语音输入", exact: true }).click();
    await dialog.getByRole("button", { name: "取消录音", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await page.waitForFunction(() => window.__paraAudio.streams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")));
    report.checks.push("resource_voice_uses_shared_panel_and_closing_releases_tracks");
    report.phase = "mobile_sidebar";
    await page.setViewportSize({ width: 390, height: 844 });
    await board.getByRole("button", { name: "打开侧栏", exact: true }).click();
    await scroll.evaluate((el) => el.scrollTop = 0);
    const box = await scroll.boundingBox();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const x = box.x + box.width - 60, y = box.y + Math.min(box.height - 30, 320);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 24 }] }); await page.waitForTimeout(25); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(async () => (await scroll.evaluate((el) => el.scrollTop)) > 30);
    assert.equal(await page.locator(".sidebar .account-area").isVisible(), true);
    await firstRow.scrollIntoViewIfNeeded();
    await thirdRow.scrollIntoViewIfNeeded();
    const sourceBox = await firstRow.locator(".para-board-grip").boundingBox();
    const targetBox = await thirdRow.boundingBox();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: targetBox.x + 90, y: targetBox.y + targetBox.height - 6 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(async () => {
      const ids = (await api("GET", "/para/boards")).boards.map((b) => b.id);
      return ids.indexOf(mainId) > ids.indexOf(report.boardIds[2]);
    });
    await cdp.detach();
    report.checks.push("mobile_shared_sidebar_touch_scroll_and_handle_reorder");
    report.phase = "lifecycle";
    await page.setViewportSize({ width: 1440, height: 900 });
    const storedOrder = (await api("GET", "/para/boards")).boards.map((b) => b.id);
    await page.reload();
    await page.locator(".para-sidebar-row[data-board-id]").first().waitFor();
    assert.deepEqual(await page.locator(".para-sidebar-row[data-board-id]").evaluateAll((rows) => rows.map((r) => r.dataset.boardId)), (await api("GET", "/para/boards")).boards.filter((b) => !b.archived_at).map((b) => b.id));
    assert.deepEqual((await api("GET", "/para/boards")).boards.map((b) => b.id), storedOrder);
    await page.locator(".para-sidebar-item").filter({ hasText: new RegExp(`^${renamed}$`) }).click();
    await board.locator(".para-card .setting-select").first().click();
    await page.getByRole("option", { name: "已完成", exact: true }).click();
    await dialog.getByLabel("验收结论", { exact: true }).fill("交互验收通过");
    await dialog.getByRole("button", { name: "确认完成", exact: true }).click();
    await until(async () => (await api("GET", "/para/boards/" + mainId)).projects[0]?.stage === "done");
    await page.getByRole("button", { name: `看板 ${renamed} 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "归档看板", exact: true }).click();
    await page.getByRole("button", { name: "查看归档看板与项目", exact: true }).click();
    await page.getByRole("button", { name: `看板 ${renamed} 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "删除看板", exact: true }).click();
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await dialog.getByText("请先整理看板中的项目与资料。", { exact: true }).waitFor();
    assert.equal((await api("GET", "/para/boards/" + mainId)).projects.length, 1);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    const emptyName = name + "-16", emptyId = report.boardIds.at(-1);
    await page.getByRole("button", { name: `看板 ${emptyName} 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "归档看板", exact: true }).click();
    await until(async () => Boolean((await api("GET", "/para/boards/" + emptyId)).board.archived_at));
    await page.getByRole("button", { name: `看板 ${emptyName} 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "删除看板", exact: true }).click();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await api("GET", "/para/boards/" + emptyId)).board.id, emptyId);
    await page.getByRole("button", { name: `看板 ${emptyName} 操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "删除看板", exact: true }).click();
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await context.request.get(origin + "/api/para/boards/" + emptyId)).status(), 404);
    report.deletedBoardIds.push(emptyId);
    report.checks.push("reload_preserves_order_completed_stage_nonempty_delete_rejected_empty_delete_cancel_and_confirm");
    if (!realAsr) {
      // Small fixture-only sidebar for visual review; production screenshots
      // never include a person's existing folder/conversation labels.
      for (const id of report.boardIds.slice(2, -1)) {
        const b = (await api("GET", "/para/boards/" + id)).board;
        const archived = await api("PATCH", "/para/boards/" + id, { revision: b.revision, archived: true });
        await api("DELETE", "/para/boards/" + id, { revision: archived.board.revision });
        report.deletedBoardIds.push(id);
      }
      await page.evaluate(() => window.dispatchEvent(new Event("para-updated")));
      await until(async () => await page.locator(".para-sidebar-row[data-board-id]").count() === 2);
      await scroll.evaluate((el) => el.scrollTop = 0);
      await page.locator(".sidebar").screenshot({ path: path.join(work, "sidebar-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await board.getByRole("button", { name: "打开侧栏", exact: true }).click();
      await page.locator(".sidebar").screenshot({ path: path.join(work, "sidebar-mobile.png") });
      const spacing = await page.evaluate(() => ({
        boardHeight: document.querySelector(".para-sidebar-row[data-board-id]").getBoundingClientRect().height,
        projectHeight: document.querySelector(".project-row").getBoundingClientRect().height,
        searchGap: document.querySelector(".para-sidebar .section-label").getBoundingClientRect().top - document.querySelector(".search-box").getBoundingClientRect().bottom,
      }));
      assert.ok(Math.abs(spacing.boardHeight - spacing.projectHeight) <= 1);
      assert.ok(spacing.searchGap <= 21);
      report.spacing = spacing;
    }
    assert.deepEqual(report.errors, []);
    report.phase = "passed";
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    report.failureLayout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, viewport: { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale }, menu: Array.from(document.querySelectorAll(".floating-setting-menu")).map((el) => ({ rect: el.getBoundingClientRect().toJSON(), style: getComputedStyle(el).cssText })) })).catch(() => null);
    if (!realAsr) await page.screenshot({ path: path.join(work, "failure.png") }).catch(() => {});
    throw error;
  } finally {
    await page.unroute(origin + "/api/transcriptions", transcriptRoute);
    await page.evaluate(async () => { for (const audio of window.__paraAudio?.contexts ?? []) await audio.close().catch(() => {}); }).catch(() => {});
    // Only the unique fixtures created by this run are eligible for cleanup.
    try {
      for (const id of report.boardIds) {
        if (report.deletedBoardIds.includes(id)) continue;
        const data = await api("GET", "/para/boards/" + id);
        if (data.board.archived_at) data.board = (await api("PATCH", "/para/boards/" + id, { revision: data.board.revision, archived: false })).board;
        for (const project of data.projects) {
          const archived = await api("PATCH", "/para/projects/" + project.id, { revision: project.revision, archived: true });
          await api("DELETE", "/para/projects/" + project.id, { revision: archived.project.revision });
        }
        await api("DELETE", "/para/boards/" + id, { revision: data.board.revision });
      }
      report.cleanup = true;
    } finally { save(); }
  }
}
