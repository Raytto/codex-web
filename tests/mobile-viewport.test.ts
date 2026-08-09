import assert from "node:assert/strict";
import test from "node:test";
import { mobileViewportUpdate } from "../src/mobile-viewport";

test("mobile viewport height follows an open keyboard without moving the root", () => {
  assert.deepEqual(mobileViewportUpdate(true, 412.4, 0, 780), {
    rootHeight: "412px",
    resetRootScroll: false,
  });
});

test("mobile viewport includes Safari's focus pan when anchoring the composer", () => {
  assert.deepEqual(mobileViewportUpdate(true, 412.4, 238.2, 780), {
    rootHeight: "651px",
    resetRootScroll: false,
  });
  assert.equal(mobileViewportUpdate(true, 412.4, -10, 780).rootHeight, "412px");
});

test("mobile viewport clears a stale keyboard height immediately after blur", () => {
  assert.deepEqual(mobileViewportUpdate(false, 412.4, 238.2, 412.4), {
    rootHeight: null,
    resetRootScroll: true,
  });
});

test("mobile viewport restores root scroll when the keyboard closes without blur", () => {
  assert.deepEqual(mobileViewportUpdate(true, 780, 0, 412.4), {
    rootHeight: "780px",
    resetRootScroll: true,
  });
  assert.equal(mobileViewportUpdate(true, 730, 0, 780).resetRootScroll, false);
});
