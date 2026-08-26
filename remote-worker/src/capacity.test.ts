import assert from "node:assert/strict";
import test from "node:test";
import { hasCapacity, isValidCapacity, normalizeCapacity } from "./capacity.js";

test("zero capacity means unlimited while positive capacities retain their limit", () => {
  assert.equal(normalizeCapacity(0), 0);
  assert.equal(normalizeCapacity("0"), 0);
  assert.equal(normalizeCapacity(undefined), 2);
  assert.equal(normalizeCapacity(99), 8);
  assert.equal(hasCapacity(0, 0), true);
  assert.equal(hasCapacity(100, 0), true);
  assert.equal(hasCapacity(1, 2), true);
  assert.equal(hasCapacity(2, 2), false);
  assert.equal(isValidCapacity(0), true);
  assert.equal(isValidCapacity(8), true);
  assert.equal(isValidCapacity(-1), false);
  assert.equal(isValidCapacity(9), false);
  assert.equal(isValidCapacity(1.5), false);
});
