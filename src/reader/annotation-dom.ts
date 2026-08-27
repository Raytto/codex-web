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

function markRange(range: Range, annotationId: string): boolean {
  const mark = document.createElement("mark");
  mark.className = "reader-local-highlight";
  mark.dataset.readerAnnotation = annotationId;
  try {
    range.surroundContents(mark);
    return true;
  } catch {
    // A quote crossing two inline elements cannot be surrounded as one DOM
    // node. Extracting the fragment still preserves the publisher's text and
    // gives the user a continuous visual mark.
    try {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
      return true;
    } catch {
      return false;
    }
  }
}

function findAndMark(container: ReaderTextContainer, quote: string, annotationId: string): boolean {
  const nodes = textNodes(container);
  if (nodes.length === 0) return false;
  const direct = nodes.find((node) => node.data.includes(quote));
  if (direct) {
    const start = direct.data.indexOf(quote);
    const range = document.createRange();
    range.setStart(direct, start);
    range.setEnd(direct, start + quote.length);
    return markRange(range, annotationId);
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
    marked = markRange(range, annotationId) || marked;
  }
  return marked;
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
    if (annotation.type !== "highlight") continue;
    const quote = annotation.quote_text.trim();
    if (!quote) continue;
    const container = matchingContainer(root, annotation);
    if (container) findAndMark(container, quote, annotation.id);
  }
}
