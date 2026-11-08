import assert from "node:assert/strict";
import test from "node:test";
import { createAntigravityStageFeedback } from "../server/antigravity-progress.js";
import { mergeJobEvents } from "../src/recovery.js";
import { buildProcessJournal } from "../src/process-journal.js";
import type { JobEvent } from "../src/api.js";

test("AGY public preambles become one stage note before tools; answer snapshots remain hidden", () => {
  const stage = createAntigravityStageFeedback();
  const events: JobEvent[] = [];
  const progress = (event: JobEvent) => {
    const feedback = stage(event);
    if (feedback) events.push({ ...feedback, seq: events.length + 1 });
    events.push({ ...event, seq: events.length + 1 });
  };
  // Captured CLI 1.4.6 sequence: response snapshots, tool ACTIVE/DONE,
  // then final-answer snapshots. The adapter accumulates text_delta per step.
  progress({ kind: "assistant_stream", detail: "我将读取" });
  progress({ kind: "assistant_stream", detail: "我将读取文件并统计非空行数。\n" });
  assert.equal(events.filter(event => event.kind === "update").length, 0);
  progress({ kind: "tool", label: "Gemini 正在使用工具", detail: "read_file" });
  progress({ kind: "tool", label: "Gemini 工具步骤完成", detail: "read_file" });
  progress({ kind: "assistant_stream", detail: "共有 3" });
  progress({ kind: "assistant_stream", detail: "共有 3 个非空行。\n" });
  progress({ kind: "status", label: "工作已完成" });
  const updates = events.filter(event => event.kind === "update");
  assert.deepEqual(updates.map(event => event.detail), ["我将读取文件并统计非空行数。"]);
  assert.ok(updates[0].seq! < events.find(event => event.kind === "tool")!.seq!);
  const live = events.reduce((current, event) => mergeJobEvents(current, [event]), [] as JobEvent[]);
  assert.deepEqual(live, mergeJobEvents([], events));
  assert.deepEqual(buildProcessJournal(live).map(event => event.kind), ["update", "tool", "tool"]);
  assert.ok(live.every(event => !event.detail?.includes("共有 3")));
  const later = Array.from({ length: 60 }, (_, i) => ({ seq: 100 + i, kind: "tool", label: `工具 ${i}` }));
  assert.equal(mergeJobEvents(live, later)[0].detail, "我将读取文件并统计非空行数。");
});

test("AGY retry, new turn and failure cannot promote an old partial answer", () => {
  for (const kind of ["status", "input_accepted", "error", "retry"]) {
    const stage = createAntigravityStageFeedback();
    stage({ kind: "assistant_stream", detail: "上一轮未完成的回答" });
    stage({ kind });
    assert.equal(stage({ kind: "command", detail: "next operation" }), null);
  }
});

test("AGY feedback preserves multiple real stages and ignores empty or non-text streams", () => {
  const stage = createAntigravityStageFeedback();
  for (const detail of [undefined, 123, {}, "", " \n"]) {
    stage({ kind: "assistant_stream", detail });
    assert.equal(stage({ kind: "tool" }), null);
  }
  for (const kind of ["command", "file", "search", "tool", "agent"]) {
    const detail = `进入 ${kind} 阶段`;
    stage({ kind: "assistant_stream", detail });
    assert.deepEqual(stage({ kind }), { kind: "update", label: "阶段反馈", detail });
    assert.equal(stage({ kind }), null);
  }
  assert.equal(stage(null), null);
});
