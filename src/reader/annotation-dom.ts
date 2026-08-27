import type { ReaderAnnotation } from "../api";

type ReaderTextContainer = HTMLElement;

function annotationLocator(annotation: ReaderAnnotation): { unitId?: string; page?: number } {
  try {
    const value = JSON.parse(annotation.locator_json) as { unitId?: unknown; page?: unknown };
    return {
      unitId: typeof value.unitId === "string" ? value.unitId : undefined,
      page: typeof value.page === "number" && Number.isFinite(value.page) ? Math.trunc(value.page) : undefined,
    };
  } catch {
    return {};
  }
}

function readerContainers(root: HTMLElement): ReaderTextContainer[] {
  const candidates = root.matches(".file-reader-document")
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>(".file-reader-document"));
  // A PDF text layer and an EPUB unit can be nested in a reader shell. Keep
  // the deepest containers so the same text node is never considered twice.
  return candidates.filter((candidate) => !candidate.parentElement?.closest(".file-reader-document"));
}

function textNodes(container: ReaderTextContainer): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const result: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent || parent.closest("script,style,textarea,[data-reader-annotation],.reader-annotations")) continue;
    if (text.data) result.push(text);
  }
  return result;
}

function matchingContainer(root: HTMLElement, annotation: ReaderAnnotation): ReaderTextContainer | null {
  const locator = annotationLocator(annotation);
  const candidates = readerContainers(root);
  if (locator.unitId) {
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(locator.unitId) : locator.unitId.replace(/[^A-Za-z0-9_-]/g, "\\$&");
    const unit = candidates.find((candidate) => candidate.closest(`[data-reader-unit="${escaped}"]`));
    if (unit) return unit;
  }
  if (locator.page !== undefined) {
    const page = candidates.find((candidate) => Number(candidate.closest<HTMLElement>("[data-reader-page]")?.dataset.readerPage) === locator.page);
    if (page) return page;
  }
  return candidates[0] ?? null;
}

function normalizedAnnotationColor(value: string | null | undefined): string {
  const color = String(value || "orange").trim().toLowerCase();
  return ["orange", "yellow", "green", "blue", "pink"].includes(color) ? color : "orange";
}

function markRange(range: Range, annotationId: string, color = "orange", type: ReaderAnnotation["type"] = "highlight"): boolean {
  const mark = document.createElement("mark");
  mark.className = "reader-local-highlight";
  mark.dataset.readerAnnotation = annotationId;
  mark.dataset.readerAnnotationColor = normalizedAnnotationColor(color);
  mark.dataset.readerAnnotationType = type;
  try {
    range.surroundContents(mark);
    return true;
  } catch {
    // A range crossing block/inline boundaries is handled by
    // markReaderRange/findAndMark one text node at a time. Never extract a
    // whole publisher element here: doing so can change EPUB flow or PDF.js
    // hit-testing while the user is reading.
    return false;
  }
}

function findAndMark(container: ReaderTextContainer, quote: string, annotationId: string, color = "orange", type: ReaderAnnotation["type"] = "highlight"): boolean {
  const nodes = textNodes(container);
  if (nodes.length === 0) return false;
  const direct = nodes.find((node) => node.data.includes(quote));
  if (direct) {
    const start = direct.data.indexOf(quote);
    const range = document.createRange();
    range.setStart(direct, start);
    range.setEnd(direct, start + quote.length);
    return markRange(range, annotationId, color, type);
  }

  // PDF.js and rich HTML commonly split a sentence over several spans. Build
  // a temporary index so a quote can still be located across those text nodes.
  const joined = nodes.map((node) => node.data).join("");
  const startIndex = joined.indexOf(quote);
  if (startIndex < 0) return false;
  const endIndex = startIndex + quote.length;
  let cursor = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  for (const node of nodes) {
    const next = cursor + node.data.length;
    if (!startNode && startIndex >= cursor && startIndex <= next) {
      startNode = node;
      startOffset = startIndex - cursor;
    }
    if (endIndex >= cursor && endIndex <= next) {
      endNode = node;
      endOffset = endIndex - cursor;
      break;
    }
    cursor = next;
  }
  if (!startNode || !endNode) return false;
  // Wrap only text slices in each participating node.  Extracting one range
  // spanning several absolutely-positioned PDF.js spans would move those
  // spans under a static <mark> and can change their hit-testing/layout. The
  // per-node marks preserve the renderer's structure while still presenting
  // one durable annotation ID.
  const startPosition = nodes.indexOf(startNode);
  const endPosition = nodes.indexOf(endNode);
  if (startPosition < 0 || endPosition < startPosition) return false;
  let marked = false;
  for (let index = endPosition; index >= startPosition; index -= 1) {
    const node = nodes[index];
    const from = index === startPosition ? startOffset : 0;
    const to = index === endPosition ? endOffset : node.data.length;
    if (to <= from) continue;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    marked = markRange(range, annotationId, color, type) || marked;
  }
  return marked;
}

function textNodesInRange(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return [root as Text];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const result: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (!text.data || text.parentElement?.closest("script,style,textarea,[data-reader-annotation],.reader-annotations")) continue;
    try {
      if (range.intersectsNode(text)) result.push(text);
    } catch {
      // A renderer may replace a text node between selection and persistence.
    }
  }
  return result;
}

function textBoundaryOffset(range: Range, node: Text, container: Node, offset: number): number | null {
  if (container === node) return Math.max(0, Math.min(node.data.length, offset));
  const nodeRange = document.createRange();
  nodeRange.selectNodeContents(node);
  try {
    const relation = nodeRange.comparePoint(container, offset);
    if (relation < 0) return 0;
    if (relation > 0) return node.data.length;
    const prefix = document.createRange();
    prefix.setStart(node, 0);
    prefix.setEnd(container, offset);
    return Math.max(0, Math.min(node.data.length, prefix.toString().length));
  } catch {
    // If a renderer replaced the boundary while an async annotation request
    // was in flight, leave this slice untouched instead of guessing a range.
    return null;
  }
}

/** Apply a just-created annotation to the live selection without extracting
 * whole block elements.  Safari commonly returns a range spanning several
 * PDF.js/EPUB inline nodes; wrapping each text slice preserves their layout. */
export function markReaderRange(range: Range, annotationId: string, color = "orange", type: ReaderAnnotation["type"] = "highlight"): boolean {
  if (range.collapsed) return false;
  // A one-text-node range can be wrapped directly. For every broader range,
  // deliberately use text slices even when `surroundContents` happens to
  // succeed: putting a `<mark>` around complete PDF.js spans or EPUB blocks
  // can alter their flow and hit-testing.
  if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
    try {
      if (markRange(range.cloneRange(), annotationId, color, type)) return true;
    } catch {
      // Fall through to the per-text-node path below.
    }
  }
  const slices = textNodesInRange(range).map((node) => ({
    node,
    from: textBoundaryOffset(range, node, range.startContainer, range.startOffset),
    to: textBoundaryOffset(range, node, range.endContainer, range.endOffset),
  })).filter((slice): slice is { node: Text; from: number; to: number } => slice.from !== null && slice.to !== null && slice.to > slice.from);
  let marked = false;
  // Wrap from the end so DOM mutations cannot invalidate the text nodes and
  // offsets belonging to earlier slices in the same selection.
  for (let index = slices.length - 1; index >= 0; index -= 1) {
    const { node, from, to } = slices[index];
    const slice = document.createRange();
    slice.setStart(node, from);
    slice.setEnd(node, to);
    marked = markRange(slice, annotationId, color, type) || marked;
  }
  return marked;
}

/** Re-select an annotation's mounted text and bring it into view.  The native
 * Range is intentionally used here so the browser's own selection handles and
 * the existing Agent action remain available after a user taps a highlight. */
export function selectReaderAnnotation(root: HTMLElement, annotationId: string): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(annotationId)
    : annotationId.replace(/[^A-Za-z0-9_-]/g, "\\$&");
  let marks: HTMLElement[];
  try {
    marks = Array.from(root.querySelectorAll<HTMLElement>(`mark.reader-local-highlight[data-reader-annotation="${escaped}"]`));
  } catch {
    return false;
  }
  if (marks.length === 0) return false;
  const first = marks[0];
  const last = marks[marks.length - 1];
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.childNodes.length);
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  if (typeof first.scrollIntoView === "function") first.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  return true;
}

/** Re-apply quote-backed highlights after a document is rendered.
 *
 * Locators remain the source of truth (PDF page coordinates/EPUB unit IDs are
 * kept server-side). This best-effort DOM pass only adds marks for text that
 * is currently mounted; it never injects publisher markup or HTML from the
 * annotation payload.
 */
export function applyReaderTextHighlights(root: HTMLElement, annotations: ReaderAnnotation[]): void {
  const containers = readerContainers(root);
  if (containers.length === 0) return;
  for (const container of containers) {
    for (const mark of Array.from(container.querySelectorAll<HTMLElement>("mark.reader-local-highlight"))) mark.replaceWith(...Array.from(mark.childNodes));
  }
  for (const annotation of annotations) {
    const quote = annotation.quote_text.trim();
    if (!quote) continue;
    const container = matchingContainer(root, annotation);
    if (container) findAndMark(container, quote, annotation.id, annotation.color, annotation.type);
  }
}
