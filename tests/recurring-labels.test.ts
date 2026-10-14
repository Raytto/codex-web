import assert from "node:assert/strict";
import test from "node:test";
import { recurrenceLabel } from "../src/recurring-labels.js";
import type { Recurrence } from "../src/recurring-types.js";

const schedule: Recurrence = { kind: "interval", intervalMinutes: 60, timeZone: "Asia/Shanghai", time: "09:00", weekdays: [1, 3, 5], monthDay: 28 };

test("interval labels use readable exact units across hour and day boundaries", () => {
  for (const [minutes, expected] of [
    [1, "每 1 分钟"], [60, "每 60 分钟"], [119, "每 119 分钟"],
    [120, "每 2 小时"], [121, "每 2 小时 1 分钟"], [150, "每 2 小时 30 分钟"],
    [360, "每 6 小时"], [1439, "每 23 小时 59 分钟"], [1440, "每 1 天"],
    [1441, "每 1 天 1 分钟"], [1500, "每 1 天 1 小时"],
    [3075, "每 2 天 3 小时 15 分钟"], [20160, "每 14 天"], [525600, "每 365 天"],
  ] as const) {
    const input = { ...schedule, intervalMinutes: minutes };
    assert.equal(recurrenceLabel(input), expected);
    assert.equal(input.intervalMinutes, minutes, "formatting must not change the saved interval");
  }
});

test("calendar labels preserve their calendar semantics and execution time", () => {
  assert.equal(recurrenceLabel({ ...schedule, kind: "daily" }), "每天 09:00");
  assert.equal(recurrenceLabel({ ...schedule, kind: "weekly" }), "每周一、三、五 09:00");
  assert.equal(recurrenceLabel({ ...schedule, kind: "monthly" }), "每月 28 日 09:00");
});
