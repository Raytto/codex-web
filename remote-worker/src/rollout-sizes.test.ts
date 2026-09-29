import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RolloutSizes } from "./rollout-sizes.js";

const id = "01990000-1111-7111-8111-111111111111";
test("rollout size reads physical bytes without thread/path metadata and follows growth", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollout-size-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions", "2026", "09", "28");
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-2026-09-28-${id}.jsonl`);
  await fs.writeFile(file, "你好\n");
  const sizes = new RolloutSizes(root);
  assert.equal(await sizes.read(id), 7);
  await fs.appendFile(file, "more");
  assert.equal(await sizes.read(id), 11);
  assert.equal(await sizes.read("../../auth.json"), null);
  await fs.mkdir(path.join(root, "archived_sessions"));
  await fs.rename(file, path.join(root, "archived_sessions", path.basename(file)));
  assert.equal(await sizes.read(id), null, "a move invalidates the cached index");
  assert.equal(await sizes.read(id), 11);
});

test("missing rollout remains unknown and a later file is discovered", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollout-size-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sizes = new RolloutSizes(root);
  assert.equal(await sizes.read(id), null);
  await fs.mkdir(path.join(root, "sessions"));
  await fs.writeFile(path.join(root, "sessions", `rollout-date-${id}.jsonl`), "");
  assert.equal(await sizes.read(id), 0);
});
