import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../server/config.js";

const TWO_GIB = 2 * 1024 * 1024 * 1024;

test("web attachment uploads default to 2 GiB and clamp larger overrides", () => {
  assert.equal(loadConfig({ maxUploadFileBytes: TWO_GIB }).maxUploadFileBytes, TWO_GIB);
  assert.equal(loadConfig({ maxUploadFileBytes: TWO_GIB + 1 }).maxUploadFileBytes, TWO_GIB);
});

test("web sessions default to a fixed fourteen-day lifetime", () => {
  const previous = process.env.SESSION_TTL_HOURS;
  delete process.env.SESSION_TTL_HOURS;
  try {
    assert.equal(loadConfig().sessionTtlHours, 14 * 24);
  } finally {
    if (previous === undefined) delete process.env.SESSION_TTL_HOURS;
    else process.env.SESSION_TTL_HOURS = previous;
  }
});
