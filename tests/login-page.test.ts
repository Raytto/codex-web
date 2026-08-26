import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("login page uses one navy background and server-local wording", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");

  assert.match(appSource, /任务与文件仅在你的本机处理/);
  assert.doesNotMatch(appSource, /任务与文件仅在 Codex 服务器本机处理/);
  assert.match(styles, /\.login-page \{[^}]*background: var\(--navy\);/);
  assert.doesNotMatch(styles, /\.login-page \{[^}]*background:[^}]*linear-gradient/);
});
