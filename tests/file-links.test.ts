import assert from "node:assert/strict";
import test from "node:test";
import type { WorkFile } from "../src/api.js";
import { resolveMessageFileLink } from "../src/file-links.js";

const original: WorkFile = {
  id: "old-reader", original_name: "交互作品.html", relative_path: "deliverables/old-reader/交互作品.html",
  source_path: "C:/workspace/work/outputs/交互作品.html", mime_type: "application/octet-stream", size: 100,
  presentation_mode: "reader", kind: "output",
};
const web: WorkFile = {
  ...original, id: "new-web", relative_path: "deliverables/new-web/交互作品.html",
  previous_file_id: original.id, presentation_mode: "web", mime_type: "text/html",
};

test("remote source aliases open the latest registered presentation version", () => {
  for (const href of [original.source_path!, "C:\\workspace\\work\\outputs\\交互作品.html", "file:///C:/workspace/work/outputs/%E4%BA%A4%E4%BA%92%E4%BD%9C%E5%93%81.html"]) {
    assert.deepEqual(resolveMessageFileLink(href, [original, web], true), { kind: "preview", href: "/files/new-web/preview", web: true });
  }
  const laterReader: WorkFile = { ...web, id: "latest-reader", relative_path: "deliverables/latest-reader/交互作品.html", presentation_mode: "reader", previous_file_id: web.id };
  assert.deepEqual(resolveMessageFileLink(original.source_path!, [original, web, laterReader], true), { kind: "preview", href: "/files/latest-reader/preview" });
});

test("immutable paths and explicit file URLs preserve their original version", () => {
  for (const href of [original.relative_path, "/example/data/app/" + original.relative_path]) {
    assert.deepEqual(resolveMessageFileLink(href, [original, web], true), { kind: "preview", href: "/files/old-reader/preview" });
  }
  assert.deepEqual(resolveMessageFileLink(web.relative_path, [original, web], true), { kind: "preview", href: "/files/new-web/preview", web: true });
  for (const href of ["/files/old-reader/preview", "/files/old-reader/preview/public", "/api/files/old-reader"]) {
    assert.deepEqual(resolveMessageFileLink(href, [original, web]), { kind: "regular", href });
  }
  const collidingAlias: WorkFile = { ...web, source_path: original.relative_path };
  assert.deepEqual(resolveMessageFileLink(original.relative_path, [original, collidingAlias], true), { kind: "preview", href: "/files/old-reader/preview" });
});
