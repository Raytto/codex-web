import type { ReaderAnnotation } from "../api";
import { isReaderTextNode, normalizeReaderAnchorQuote, readerDocumentContainers, restoreReaderTextAnchor, type ReaderTextAnchor } from "./selection-anchor";

type ReaderTextContainer = HTMLElement;

export type ReaderAnnotationLocator = { unitId?: string; page?: number; startOffset?: number; endOffset?: number; textLength?: number };

export function readerAnnotationLocator(annotation: ReaderAnnotation): ReaderAnnotationLocator {
  try {
    const value = JSON.parse(annotation.locator_json) as { unitId?: unknown; page?: unknown; startOffset?: unknown; endOffset?: unknown; textLength?: unknown };
    const relationalUnit = typeof annotation.unit_id === "string" && annotation.unit_id.length > 0 ? annotation.unit_id : undefined;
    return {
      // The relational unit is validated by the API and is therefore the
      // authoritative identity when both representations are present. Keep
      // the JSON value only for legacy rows that predate that column.
      unitId: relationalUnit ?? (typeof value.unitId === "string" && value.unitId.length > 0 ? value.unitId : undefined),
      page: typeof value.page === "number" && Number.isFinite(value.page) ? Math.trunc(value.page) : undefined,
      startOffset: typeof value.startOffset === "number" && Number.isFinite(value.startOffset) ? Math.trunc(value.startOffset) : undefined,
      endOffset: typeof value.endOffset === "number" && Number.isFinite(value.endOffset) ? Math.trunc(value.endOffset) : undefined,
      textLength: typeof value.textLength === "number" && Number.isFinite(value.textLength) ? Math.trunc(value.textLength) : undefined,
    };
  } catch {
    return annotation.unit_id ? { unitId: annotation.unit_id } : {};
  }
}

/** Match a persisted annotation to a durable selection identity.
 *
 * Offset-bearing rows are compared by unit/page and document offsets. Legacy
 * quote-only rows deliberately return false here; their visual mark (when
 * mounted) is the stronger signal, and falling back to an equal quote would
 * pick the wrong duplicate passage.
 */
export function readerAnnotationMatchesAnchor(annotation: ReaderAnnotation, anchor: Pick<ReaderTextAnchor, "unitId" | "page" | "startOffset" | "endOffset" | "textLength" | "normalizedText">): boolean {
  const locator = readerAnnotationLocator(annotation);
  if (locator.startOffset === undefined || locator.endOffset === undefined) return false;
  if (anchor.unitId !== locator.unitId || anchor.page !== locator.page) return false;
  if (locator.startOffset !== anchor.startOffset || locator.endOffset !== anchor.endOffset) return false;
  if (locator.textLength !== undefined && locator.textLength > 0 && locator.textLength !== anchor.textLength) return false;
  const expected = normalizeReaderAnchorQuote(annotation.quote_text);
  const actual = normalizeReaderAnchorQuote(anchor.normalizedText);
  if (!expected) return true;
  if (!actual) return false;
  return actual === expected || (annotation.quote_text.length >= 4_000 && actual.startsWith(expected));
}

function readerContainers(root: HTMLElement): ReaderTextContainer[] {
  // Keep annotation replay on the same innermost document set used by the
  // selection anchor. This prevents nested renderer shells from indexing the
  // same text twice.
  return readerDocumentContainers(root);
}

function matchingContainer(root: HTMLElement, annotation: ReaderAnnotation): ReaderTextContainer | null {
  const locator = readerAnnotationLocator(annotation);
  const candidates = readerContainers(root);
  const hasIdentity = Boolean(locator.unitId) || locator.page !== undefined;
  const identityMatch = candidates.find((candidate) => {
    const unitId = candidate.dataset.readerUnit ?? candidate.closest<HTMLElement>("[data-reader-unit]")?.dataset.readerUnit;
    const pageValue = candidate.dataset.readerPage ?? candidate.closest<HTMLElement>("[data-reader-page]")?.dataset.readerPage;
    const page = pageValue === undefined ? undefined : Number(pageValue);
    if (locator.unitId && unitId !== locator.unitId) return false;
    if (locator.page !== undefined && page !== locator.page) return false;
    return true;
  });
  if (identityMatch) return identityMatch;
  // A unit/page locator is an identity, not a hint.  The requested source may
  // be outside the bounded PDF/EPUB render window; waiting for that container
  // to mount is safer than marking an identical quote in another chapter/page.
  if (hasIdentity) return null;
  return candidates[0] ?? null;
}

function normalizedAnnotationColor(value: string | null | undefined): string {
  const color = String(value || "orange").trim().toLowerCase();
  return ["orange", "yellow", "green", "blue", "pink"].includes(color) ? color : "orange";
}

/** Return the visible-text portion of one selected text-node slice.
 *
 * HTML commonly keeps indentation/newlines in standalone text nodes between
 * list items and block elements. Wrapping those nodes in a <mark> creates a
 * real inline box, which can paint a vertical highlight and add an otherwise
 * nonexistent line to the document. Keep annotation storage unchanged, but
 * only paint characters that contain visible text. */
export function readerHighlightSliceBounds(text: string, from = 0, to = text.length): { from: number; to: number } | null {
  const boundedFrom = Math.max(0, Math.min(text.length, from));
  const boundedTo = Math.max(boundedFrom, Math.min(text.length, to));
  const value = text.slice(boundedFrom, boundedTo);
  const leadingWhitespace = value.match(/^\s*/u)?.[0].length ?? 0;
  const trailingWhitespace = value.match(/\s*$/u)?.[0].length ?? 0;
  const visibleFrom = boundedFrom + leadingWhitespace;
  const visibleTo = boundedTo - trailingWhitespace;
  return visibleTo > visibleFrom ? { from: visibleFrom, to: visibleTo } : null;
}

/** Normalize only the layout whitespace used when locating a stored quote.
 * The original quote is kept in the annotation payload, while this form lets
 * replay survive HTML indentation, EPUB line wrapping, and PDF.js span
 * boundaries changing between visits. */
export function normalizeReaderQuoteForSearch(value: string): string {
  return normalizeReaderAnchorQuote(value);
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

function findAndMark(container: ReaderTextContainer, quote: string, annotationId: string, color = "orange", type: ReaderAnnotation["type"] = "highlight", locator?: ReaderAnnotationLocator): boolean {
  // New annotations carry a document-text offset in addition to the quote.
  // Prefer that identity so duplicate prose in one chapter cannot make replay
  // mark the first matching sentence.  Quotes remain the compatibility
  // fallback for annotations created before the offset locator existed.
  const startOffsetLocator = locator?.startOffset;
  const endOffsetLocator = locator?.endOffset;
  const hasOffsetLocator = startOffsetLocator !== undefined && endOffsetLocator !== undefined;
  if (hasOffsetLocator) {
    const anchor: ReaderTextAnchor = {
      text: quote,
      normalizedText: "",
      startOffset: startOffsetLocator,
      endOffset: endOffsetLocator,
      textLength: locator?.textLength ?? 0,
      unitId: locator?.unitId,
      page: locator?.page,
    };
    const offsetRange = restoreReaderTextAnchor(container, anchor);
    if (offsetRange) {
      const expected = normalizeReaderAnchorQuote(quote);
      let actual = "";
      try { actual = normalizeReaderAnchorQuote(offsetRange.toString()); } catch { return false; }
      // The UI may intentionally truncate a very long quote. In that case a
      // prefix check still guards against an offset accidentally pointing at a
      // different paragraph after publisher markup changed.
      const compatible = !expected || actual === expected || (quote.length >= 4_000 && actual.startsWith(expected));
      if (compatible && markReaderRange(offsetRange, annotationId, color, type)) return true;
    }
    // An explicit offset is an identity. Do not silently mark the first equal
    // quote elsewhere in the same chapter if the source changed or the target
    // is not mounted yet; the bounded replay pass can try again later.
    return false;
  }
  // Legacy annotations do not have offsets. Locate their quote through the
  // same normalized anchor engine, then use the existing per-text-node marker
  // so PDF.js spans and EPUB block structure are never extracted or moved.
  const quoteRange = restoreReaderTextAnchor(container, {
    text: quote,
    normalizedText: normalizeReaderAnchorQuote(quote),
    startOffset: 0,
    endOffset: 0,
    textLength: 0,
  });
  return quoteRange ? markReaderRange(quoteRange, annotationId, color, type) : false;
}

function textNodesInRange(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) {
    const text = root as Text;
    return text.data && isReaderTextNode(text) ? [text] : [];
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const result: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (!text.data || !isReaderTextNode(text)) continue;
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
  try {
    nodeRange.selectNodeContents(node);
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
      const node = range.startContainer as Text;
      const bounds = readerHighlightSliceBounds(node.data, range.startOffset, range.endOffset);
      if (bounds) {
        const visibleRange = document.createRange();
        visibleRange.setStart(node, bounds.from);
        visibleRange.setEnd(node, bounds.to);
        if (markRange(visibleRange, annotationId, color, type)) return true;
      }
    } catch {
      // Fall through to the per-text-node path below.
    }
  }
  const slices = textNodesInRange(range).map((node) => ({
    node,
    from: textBoundaryOffset(range, node, range.startContainer, range.startOffset),
    to: textBoundaryOffset(range, node, range.endContainer, range.endOffset),
  })).flatMap((slice): Array<{ node: Text; from: number; to: number }> => {
    if (slice.from === null || slice.to === null) return [];
    const bounds = readerHighlightSliceBounds(slice.node.data, slice.from, slice.to);
    return bounds ? [{ node: slice.node, ...bounds }] : [];
  });
  let marked = false;
  // Wrap from the end so DOM mutations cannot invalidate the text nodes and
  // offsets belonging to earlier slices in the same selection.
  for (let index = slices.length - 1; index >= 0; index -= 1) {
    const { node, from, to } = slices[index];
    try {
      const slice = document.createRange();
      slice.setStart(node, from);
      slice.setEnd(node, to);
      marked = markRange(slice, annotationId, color, type) || marked;
    } catch {
      // The renderer may commit a new text layer between slices. Keep any
      // slices already marked and let the next bounded replay pass retry.
    }
  }
  return marked;
}

/** Return the annotation mark intersected by a live reader selection. */
export function readerAnnotationIdForRange(range: Range): string | null {
  const boundaryMarks = [range.startContainer, range.endContainer]
    .map((node) => node instanceof Element ? node : node.parentElement)
    .map((element) => element?.closest<HTMLElement>("mark.reader-local-highlight[data-reader-annotation]") ?? null)
    .filter((mark): mark is HTMLElement => Boolean(mark));
  if (boundaryMarks[0]?.dataset.readerAnnotation) return boundaryMarks[0].dataset.readerAnnotation;
  const root = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!root) return null;
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>("mark.reader-local-highlight[data-reader-annotation]"))) {
    try {
      if (range.intersectsNode(mark)) return mark.dataset.readerAnnotation ?? null;
    } catch { /* The renderer may replace the mark during a page turn. */ }
  }
  return null;
}

/** Re-select an annotation's mounted text and bring it into view.  The native
 * Range is intentionally used here so the browser's own selection handles and
 * the existing Agent action remain available after a user taps a highlight. */
export function selectReaderAnnotation(root: HTMLElement, annotationId: string): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  // Filter the data value after a fixed selector instead of interpolating an
  // annotation ID into CSS. Besides avoiding escaping edge cases, this keeps
  // malformed/legacy IDs from turning annotation focus into a selector error.
  const marks = Array.from(root.querySelectorAll<HTMLElement>("mark.reader-local-highlight[data-reader-annotation]"))
    .filter((mark) => mark.dataset.readerAnnotation === annotationId);
  if (marks.length === 0) return false;
  const first = marks[0];
  const last = marks[marks.length - 1];
  const range = document.createRange();
  try {
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
  } catch {
    return false;
  }
  const selection = window.getSelection();
  if (!selection) return false;
  try {
    selection.removeAllRanges();
    selection.addRange(range);
    if (typeof first.scrollIntoView === "function") first.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  } catch {
    return false;
  }
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
    if (container) findAndMark(container, quote, annotation.id, annotation.color, annotation.type, readerAnnotationLocator(annotation));
  }
}
