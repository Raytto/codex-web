import assert from "node:assert/strict";
import test from "node:test";
import { mobileViewportUpdate } from "../src/mobile-viewport";

test("mobile viewport height follows an open keyboard without moving the root", () => {
  assert.deepEqual(mobileViewportUpdate(true, 412.4, 780), {
    rootHeight: "412px",
    resetRootScroll: false,
  });
});

test("mobile viewport clears a stale keyboard height immediately after blur", () => {
  assert.deepEqual(mobileViewportUpdate(false, 412.4, 412.4), {
    rootHeight: null,
    resetRootScroll: true,
  });
});

test("mobile viewport restores root scroll when the keyboard closes without blur", () => {
  assert.deepEqual(mobileViewportUpdate(true, 780, 412.4), {
    rootHeight: "780px",
    resetRootScroll: true,
  });
  assert.equal(mobileViewportUpdate(true, 730, 780).resetRootScroll, false);
});
