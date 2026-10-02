import fs from "node:fs";
import path from "node:path";
import { run as exerciseSelection } from "./feature-selection.mjs";

export async function run(args) {
  const { page, context, origin, work, assert } = args;
  const report = { defaultOff: false, checkboxUnchecked: false, hiddenAfterReload: false, restoredOff: false };
  const save = () => fs.writeFileSync(path.join(work, "feature-default-off.json"), JSON.stringify(report, null, 2));
  const before = await (await context.request.get(origin + "/api/user-settings/features")).json();
  // Verify before making any test writes; never turn an unexpected state off to
  // manufacture a default-off pass. Existing user opt-ins need investigation.
  assert.equal(before.paraBoard, false, "this account starts with PARA disabled");
  report.defaultOff = true; save();
  await page.locator(".account-profile").click();
  await page.getByRole("button", { name: "功能选择", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: "项目看板", exact: true });
  await checkbox.waitFor(); assert.equal(await checkbox.isChecked(), false);
  assert.equal(await page.locator(".para-sidebar").count(), 0);
  report.checkboxUnchecked = true; save();
  await page.getByRole("dialog", { name: "功能选择", exact: true }).screenshot({ path: path.join(work, "feature-default-off.png") });
  await page.getByRole("button", { name: "关闭功能选择", exact: true }).click();
  await page.reload(); await page.locator(".account-profile").waitFor();
  assert.equal(await page.locator(".para-sidebar").count(), 0);
  report.hiddenAfterReload = true; save();
  await exerciseSelection(args);
  const after = await (await context.request.get(origin + "/api/user-settings/features")).json();
  assert.equal(after.paraBoard, false);
  report.restoredOff = true; save();
}
