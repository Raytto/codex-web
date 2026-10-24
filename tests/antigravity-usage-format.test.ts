import assert from "node:assert/strict";
import test from "node:test";
import { quotaRemaining, quotaReset, quotaWindow } from "../src/antigravity-usage-format.js";

const bucket = { id: "new", label: "Future native window", window: null, remainingPercent: null, remainingAmount: null, resetAt: null, disabled: false };
test("quota display distinguishes unknown/zero and avoids rounding consumed quota to 100%", () => {
  assert.equal(quotaRemaining(bucket), "暂无数据");
  assert.equal(quotaRemaining({ ...bucket, remainingPercent: 0 }), "0%");
  assert.equal(quotaRemaining({ ...bucket, remainingAmount: 0 }), "0");
  assert.equal(quotaRemaining({ ...bucket, remainingPercent: 99.99 }), ">99.9%");
  assert.equal(quotaRemaining({ ...bucket, remainingPercent: 0.01 }), "<0.1%");
  assert.equal(quotaRemaining({ ...bucket, remainingPercent: 100 }), "100%");
  assert.equal(quotaRemaining({ ...bucket, disabled: true }), "暂不可用");
  assert.equal(quotaWindow(bucket), "Future native window");
  assert.equal(quotaReset(null), "重置时间暂未提供");
  assert.match(quotaReset("2026-10-24T03:00:00Z", Date.parse("2026-10-24T01:00:00Z")), /约 2 小时 0 分钟后/);
  assert.match(quotaReset("2026-10-24T00:00:00Z", Date.parse("2026-10-24T01:00:00Z")), /已到重置时间，待刷新/);
});
