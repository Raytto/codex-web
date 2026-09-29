import fs from "node:fs";
import path from "node:path";
export async function run({ page, context, origin, work, assert }) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const suffix = Date.now().toString().slice(-7),
    boardName = "PARA验收-" + suffix,
    ideaName = "项目闭环验收-" + suffix;
  const checks = [];
  let phase = "prepare", agentProbe = null, failure = null;
  const fileText = "PARA independent file acceptance · " + crypto.randomUUID();
  const save = () =>
    fs.writeFileSync(
      path.join(work, "para-ui-checks.json"),
      JSON.stringify({ checks, errors, phase, agentProbe, failure, boardId, projectId, conversationId: cid, expectedFileText: fileText }, null, 2),
    );
  const csrf = (
    await (await context.request.get(origin + "/api/auth/session")).json()
  ).csrfToken;
  const api = async (method, url, data) => {
    const r = await context.request.fetch(origin + "/api" + url, {
      method,
      data,
      headers: { "X-CSRF-Token": csrf },
    });
    if (!r.ok()) throw new Error(method + " " + url + " status " + r.status());
    return r.status() === 204 ? null : r.json();
  };
  let boardId, projectId, cid;
  try {
    await page.locator(".sidebar").waitFor();
    await page.getByRole("button", { name: "看板操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建看板", exact: true }).click();
    await page.getByRole("button", { name: /PARA 看板/ }).click();
    await page.getByLabel("看板名称", { exact: true }).fill(boardName);
    await page.getByRole("button", { name: "创建看板", exact: true }).click();
    const board = page.locator(".para-workspace:not(.para-hidden)");
    await board
      .getByRole("heading", { name: boardName, exact: true })
      .waitFor();
    boardId = (await api("GET", "/para/boards")).boards.find(
      (b) => b.name === boardName,
    ).id;
    await board.getByRole("button", { name: "记个想法", exact: true }).click();
    await page.getByLabel("一句话记录", { exact: true }).fill(ideaName);
    await page.getByRole("button", { name: "保存想法", exact: true }).click();
    await board.getByRole("heading", { name: ideaName, exact: true }).waitFor();
    projectId = (await api("GET", "/para/boards/" + boardId)).projects[0].id;
    checks.push("create_board_and_idea_via_ui");
    save();
    await board.getByRole("button", { name: "编辑项目", exact: true }).click();
    await page
      .getByLabel("目标", { exact: true })
      .fill("完成一次完整的项目资料与会话验收");
    await page
      .getByLabel("完成标准", { exact: true })
      .fill("资料、上下文、归档恢复均可验证");
    await page.getByLabel("下一步", { exact: true }).fill("检查本次带入的资料");
    await page.getByRole("button", { name: "保存简报", exact: true }).click();
    await board
      .getByText("完成一次完整的项目资料与会话验收", { exact: true })
      .waitFor();
    await board.getByRole("button", { name: /^资料 0$/ }).click();
    await board.getByRole("button", { name: "添加资料", exact: true }).click();
    await page.getByLabel("资料标题（可选）", { exact: true }).fill("验收笔记");
    await page
      .getByLabel("文字或摘录", { exact: true })
      .fill("这份笔记应该出现在新会话草稿。");
    await page.getByRole("button", { name: "收进资料库", exact: true }).click();
    await board.getByText("验收笔记", { exact: true }).waitFor();
    await board.getByRole("button", { name: "添加资料", exact: true }).click();
    await page
      .getByLabel("资料标题（可选）", { exact: true })
      .fill("独立资料文件");
    await page.getByLabel("文件或图片", { exact: true }).setInputFiles({
      name: "para-check.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(fileText),
    });
    await page.getByRole("button", { name: "收进资料库", exact: true }).click();
    await board.getByText("独立资料文件", { exact: true }).waitFor();
    await board.getByRole("button", { name: /独立资料文件.*KB/ }).click();
    await page.getByText(fileText, { exact: true }).waitFor();
    await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
    checks.push("brief_note_file_upload_preview");
    save();
    await board.getByRole("button", { name: "概览", exact: true }).click();
    await board.getByRole("button", { name: "编辑项目", exact: true }).click();
    await page.getByLabel("目标", { exact: true }).fill("我的未提交编辑");
    const beforeConflict = (await api("GET", "/para/projects/" + projectId))
      .project;
    await api("PATCH", "/para/projects/" + projectId, {
      revision: beforeConflict.revision,
      brief: {
        ...beforeConflict.brief,
        goal: "另一端已确认目标",
        constraints: "保留另一端约束",
      },
    });
    await board
      .locator(".para-brief-field")
      .getByText("另一端已确认目标", { exact: true })
      .waitFor({ timeout: 25000 });
    await page.getByRole("button", { name: "保存简报", exact: true }).click();
    await page.getByText(/其他窗口已更新此内容/).waitFor();
    assert.equal(
      await page.getByLabel("目标", { exact: true }).inputValue(),
      "我的未提交编辑",
    );
    await page
      .getByRole("button", { name: "查看服务器最新版本", exact: true })
      .click();
    await page.getByText("约束：保留另一端约束", { exact: true }).waitFor();
    await page.getByLabel("约束", { exact: true }).fill("保留另一端约束");
    // Reproduce a slow refresh after saving: a follow-up edit must use the
    // revision returned by the write, even before background reads finish.
    let delayProjectReads = true;
    const slowProjectRead = async (route) => {
      if (route.request().method() === "GET" && delayProjectReads) {
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.fulfill({ response });
      } else await route.continue();
    };
    await page.route(origin + "/api/para/projects/" + projectId, slowProjectRead);
    await page
      .getByRole("button", { name: "已合并，使用这个版本保存", exact: true })
      .click();
    await page.getByRole("button", { name: "保存简报", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      (await api("GET", "/para/projects/" + projectId)).project.brief
        .constraints,
      "保留另一端约束",
    );
    checks.push("cross_window_conflict_keeps_draft_and_explicit_merge");
    save();

    await board.getByRole("button", { name: "项目阶段", exact: true }).click();
    await page.getByRole("option", { name: "进行中", exact: true }).click();
    await board.getByRole("button", { name: "撤销", exact: true }).waitFor();
    await board.getByRole("button", { name: "撤销", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(
          '.para-workspace:not(.para-hidden) button[aria-label="项目阶段"]',
        )?.textContent.includes("想法"),
    );
    delayProjectReads = false;
    checks.push("immediate_stage_edit_after_save_with_delayed_refresh");
    save();
    await board.getByRole("button", { name: "概览", exact: true }).click();
    await board.getByRole("button", { name: "开始规划", exact: true }).click();
    await page
      .getByLabel("会话标题", { exact: true })
      .fill("PARA验收会话-" + suffix);
    if (process.env.CODEX_WEB_BROWSER_MODEL_PROBE === "true")
      await page
        .getByLabel("开场内容", { exact: true })
        .fill(
          "这是 PARA 功能验收。只读取本次带入的项目背景、选定笔记和附件 para-check.txt；不读取工程的其他文件，不联网，不修改任何业务文件，不创建其他任务。仅回复 JSON：goal 为主工作项目简报中的目标原文，note 为选定笔记的正文原文，file 为附件的完整文本。",
        );
    await page.getByLabel(/验收笔记/).check();
    await page.getByLabel(/独立资料文件/).check();
    await page.getByRole("button", { name: "创建并打开", exact: true }).click();
    const chat = page.locator("main.workspace:not(.para-workspace)");
    await chat.locator(".conversation-menu > summary").waitFor();
    const detail = await api("GET", "/para/projects/" + projectId);
    cid = detail.conversations[0].id;
    const conv = await api("GET", "/conversations/" + cid);
    assert.match(conv.composerDraft.content, /这份笔记应该出现在新会话草稿/);
    assert.equal(conv.composerDraft.files.length, 1);
    checks.push("stage_change_undo_and_draft_context_file");
    save();
    if (process.env.CODEX_WEB_BROWSER_MODEL_PROBE === "true") {
      phase = "send_agent_request";
      save();
      await chat.locator("textarea").waitFor();
      await chat.getByRole("button", { name: "发送", exact: true }).click();
      phase = "wait_for_agent";
      save();
      const deadline = Date.now() + 300000;
      let delivered;
      for (;;) {
        delivered = await api("GET", "/conversations/" + cid);
        if (
          delivered.latestJob &&
          ["succeeded", "failed", "interrupted", "cancelled", "completed"].includes(delivered.latestJob.status) &&
          !delivered.activeJob
        ) break;
        assert.ok(Date.now() < deadline, "Agent input probe exceeded 300 seconds");
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const answer =
        delivered.messages.filter((m) => m.role === "assistant").at(-1)
          ?.content ?? "";
      phase = "assert_agent_input";
      agentProbe = {
        status: delivered.latestJob?.status,
        answerCharacters: answer.length,
        brief: answer.includes("我的未提交编辑"),
        note: answer.includes("这份笔记应该出现在新会话草稿"),
        file: answer.includes(fileText),
      };
      save();
      assert.match(answer, /我的未提交编辑/);
      assert.match(answer, /这份笔记应该出现在新会话草稿/);
      assert.ok(
        answer.includes(fileText),
        "Agent must read the unpredictable file marker",
      );
      checks.push("real_agent_received_brief_selected_note_and_file");
      save();
    }

    phase = "remaining_ui";
    await chat.locator(".conversation-menu > summary").click();
    await chat.locator(".conversation-menu-panel").getByRole("menuitem", { name: "关联项目", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: ideaName, exact: true }).click();
    await board.getByRole("button", { name: boardName, exact: true }).click();
    await board
      .getByRole("heading", { name: boardName, exact: true })
      .waitFor();
    await board.screenshot({ path: path.join(work, "para-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await board
      .getByRole("button", { name: new RegExp(ideaName) })
      .first()
      .click();
    delayProjectReads = true;
    await board.getByRole("button", { name: "项目阶段", exact: true }).click();
    await page.getByRole("option", { name: "酝酿", exact: true }).click();
    assert.equal(
      await board.getByRole("button", { name: "归档", exact: true }).isEnabled(),
      false,
    );
    await board.getByRole("button", { name: "概览", exact: true }).click();
    await board.screenshot({ path: path.join(work, "para-mobile.png") });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    assert.equal(
      await board.evaluate((e) => e.scrollWidth <= e.clientWidth),
      true,
    );
    checks.push("mobile_tap_stage_and_no_page_overflow");
    save();
    page.once("dialog", (d) => d.accept());
    await board.getByRole("button", { name: "归档", exact: true }).click();
    await board
      .getByRole("button", { name: "恢复项目", exact: true })
      .waitFor();
    await board.getByRole("button", { name: "恢复项目", exact: true }).click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".para-workspace:not(.para-hidden)")
          ?.textContent.includes("项目已归档。"),
    );
    delayProjectReads = false;
    assert.equal(
      (await api("GET", "/para/projects/" + projectId)).project.stage,
      "incubating",
    );
    await page.setViewportSize({ width: 320, height: 780 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await board.screenshot({ path: path.join(work, "para-mobile-320.png") });
    checks.push("archive_restore_preserves_stage_320px");
    await page.setViewportSize({ width: 1440, height: 950 });
    await board.getByRole("button", { name: /^资料 2$/ }).click();
    await board.getByLabel("独立资料文件 的资料操作", { exact: true }).click();
    await board
      .getByRole("button", { name: "保存为成果", exact: true })
      .click();
    await board.getByRole("button", { name: "成果 1", exact: true }).click();
    await board.getByText("独立资料文件", { exact: true }).waitFor();
    await board.getByRole("button", { name: boardName, exact: true }).click();
    await board.getByRole("button", { name: "领域", exact: true }).click();
    await board.getByRole("button", { name: "添加领域", exact: true }).click();
    await page.getByLabel("领域名称", { exact: true }).fill("长期维护");
    await page
      .getByLabel("长期责任与回顾重点", { exact: true })
      .fill("定期核查资料和下一步");
    await page.getByRole("button", { name: "保存领域", exact: true }).click();
    await board
      .getByRole("heading", { name: "长期维护", exact: true })
      .waitFor();
    await board.getByRole("button", { name: "资源", exact: true }).click();
    await board.getByText("验收笔记", { exact: true }).waitFor();
    await board.getByRole("button", { name: "项目推进", exact: true }).click();
    await board.getByRole("button", { name: "阶段筛选", exact: true }).click();
    await page.getByRole("option", { name: "全部项目", exact: true }).click();
    await page.emulateMedia({ colorScheme: "dark" });
    await board.screenshot({ path: path.join(work, "para-dark.png") });
    checks.push("area_resource_library_outcome_and_dark_layout");
    save();

    assert.deepEqual(errors, []);
    save();
  } catch (e) {
    failure = { name: e.name, message: e.message };
    save();
    await page
      .locator(".para-workspace:not(.para-hidden)")
      .screenshot({ path: path.join(work, "para-failure.png") })
      .catch(() => {});
    throw e;
  } finally {
    // Cleanup only the unique objects created above, through their real routes.
    if (cid) await api("DELETE", "/conversations/" + cid);
    if (projectId) {
      const d = await api("GET", "/para/projects/" + projectId);
      for (const r of d.resources)
        await api("DELETE", `/para/projects/${projectId}/resources/${r.id}`);
      const p = await api("PATCH", "/para/projects/" + projectId, {
        revision: d.project.revision,
        archived: true,
        confirm_running: true,
      });
      await api("DELETE", "/para/projects/" + projectId, {
        revision: p.project.revision,
      });
    }
    if (boardId) {
      const d = await api("GET", "/para/boards/" + boardId);
      for (const r of d.resources) {
        const v = await api("PATCH", "/para/resources/" + r.id, {
          revision: r.revision,
          archived: true,
        });
        await api("DELETE", "/para/resources/" + r.id, {
          revision: v.resource.revision,
        });
      }
      const archived = await api("PATCH", "/para/boards/" + boardId, { revision: d.board.revision, archived: true });
      await api("DELETE", "/para/boards/" + boardId, { revision: archived.board.revision });
    }
  }
}
