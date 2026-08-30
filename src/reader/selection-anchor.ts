/**
 * A browser Range is a view object, not a durable identity.  PDF text layers
 * are routinely remounted and an EPUB CSS multi-column layout can invalidate
 * Range geometry without replacing its boundary nodes.  This module keeps the
 * durable part of a reader selection as a document-text offset and recreates
 * a fresh Range whenever the current layout needs to be painted again.
 */

export type ReaderTextAnchor = {
  /** The original browser quote, retained as a fallback locator. */
  text: string;
  /** Quote with layout whitespace collapsed for fallback matching. */
  normalizedText: string;
  /** Offsets in the concatenated text nodes of one reader document. */
  startOffset: number;
  endOffset: number;
  textLength: number;
  unitId?: string;
  page?: number;
};

/** Compare the durable identity, excluding view-only geometry and DOM nodes. */
export function readerTextAnchorsEqual(left: ReaderTextAnchor, right: ReaderTextAnchor): boolean {
  return left.unitId === right.unitId && left.page === right.page
    && left.startOffset === right.startOffset && left.endOffset === right.endOffset
    && left.textLength === right.textLength && left.normalizedText === right.normalizedText;
}

type ReaderTextContainer = HTMLElement;

// `.file-reader-document` is retained for the PDF/EPUB renderers and for the
// legacy outer shell.  The latter also contains the optional table of
// contents, so HTML/Markdown mark their actual scrollable prose root with the
// neutral `reader-text-container` class below.  Treat both as candidates and
// keep only the innermost one.
const READER_TEXT_CONTAINER_SELECTOR = ".reader-text-container, .file-reader-document";
const READER_IGNORED_TEXT_SELECTOR = "script,style,textarea,.reader-annotations,.file-reader-outline,.reader-reader-controls,.reader-page-indicator,.reader-document-loading,.reader-document-error,.reader-inline-error,.reader-page-placeholder,[hidden],[aria-hidden=\"true\"]";

function elementFor(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

export function isReaderTextNode(node: Text): boolean {
  const parent = node.parentElement;
  return Boolean(parent && !parent.closest(READER_IGNORED_TEXT_SELECTOR));
}

type ReaderTextIndex = {
  nodes: Text[];
  totalLength: number;
  starts: WeakMap<Node, number>;
  lengths: WeakMap<Node, number>;
};

/**
 * Build one linear text index for a mounted reader document.
 *
 * Selectionchange can fire repeatedly while a handle is moving. The previous
 * boundary walk searched every sibling again for each call, which made a
 * large PDF text layer increasingly expensive. Keeping subtree starts and
 * lengths gives capture/restoration one consistent text model and avoids the
 * repeated O(n²) traversal.
 */
function buildReaderTextIndex(container: ReaderTextContainer): ReaderTextIndex {
  const nodes: Text[] = [];
  const starts = new WeakMap<Node, number>();
  const lengths = new WeakMap<Node, number>();
  let cursor = 0;
  const visit = (node: Node, excluded = false): void => {
    const start = cursor;
    starts.set(node, start);
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if (!excluded && text.data && isReaderTextNode(text)) {
        nodes.push(text);
        cursor += text.data.length;
      }
      lengths.set(node, cursor - start);
      return;
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : null;
    const nextExcluded = excluded || Boolean(element?.matches(READER_IGNORED_TEXT_SELECTOR));
    if (nextExcluded) {
      lengths.set(node, 0);
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
    lengths.set(node, cursor - start);
  };
  visit(container);
  return { nodes, totalLength: cursor, starts, lengths };
}

/** Return text nodes in document order without counting reader chrome. */
export function readerTextNodes(container: ReaderTextContainer): Text[] {
  return buildReaderTextIndex(container).nodes;
}

/** Return the innermost reader documents under a shell, once each. */
export function readerDocumentContainers(root: ReaderTextContainer): ReaderTextContainer[] {
  const candidates = [
    ...(root.matches(READER_TEXT_CONTAINER_SELECTOR) ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>(READER_TEXT_CONTAINER_SELECTOR)),
  ];
  const candidateSet = new Set(candidates);
  const nested = new Set<ReaderTextContainer>();
  for (const candidate of candidates) {
    // Mark candidate ancestors, not descendants.  This keeps the deepest
    // renderer-owned text root and avoids indexing the same legacy HTML text
    // once through its outer shell and once through its scroll viewport.
    let parent = candidate.parentElement;
    while (parent) {
      if (candidateSet.has(parent)) nested.add(parent);
      if (parent === root) break;
      parent = parent.parentElement;
    }
  }
  return candidates.filter((candidate) => !nested.has(candidate));
}

/**
 * Calculate a raw-text offset for a DOM boundary without using Range#toString.
 * Range#toString may insert implicit newlines between block elements; those
 * are presentation text and must not shift the durable offsets.
 */
function offsetAtBoundary(root: Node, target: Node, offset: number, index = buildReaderTextIndex(root as ReaderTextContainer)): number | null {
  const start = index.starts.get(target);
  if (start === undefined) return null;
  if (!Number.isFinite(offset)) return null;
  if (target.nodeType === Node.TEXT_NODE) {
    const text = target as Text;
    if (!isReaderTextNode(text)) return null;
    return start + Math.max(0, Math.min(text.data.length, Math.trunc(offset)));
  }
  const children = Array.from(target.childNodes);
  const boundary = Math.max(0, Math.min(children.length, Math.trunc(offset)));
  let result = start;
  for (let indexAtChild = 0; indexAtChild < boundary; indexAtChild += 1) {
    result += index.lengths.get(children[indexAtChild]) ?? 0;
  }
  return result;
}

export function normalizeReaderAnchorQuote(value: string): string {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function containerForRange(root: HTMLElement, range: Range): ReaderTextContainer | null {
  const start = elementFor(range.startContainer)?.closest<HTMLElement>(READER_TEXT_CONTAINER_SELECTOR);
  const end = elementFor(range.endContainer)?.closest<HTMLElement>(READER_TEXT_CONTAINER_SELECTOR);
  if (!start || start !== end || !root.contains(start)) return null;
  const boundaryIsIgnored = (node: Node): boolean => Boolean(elementFor(node)?.closest(READER_IGNORED_TEXT_SELECTOR));
  return boundaryIsIgnored(range.startContainer) || boundaryIsIgnored(range.endContainer) ? null : start;
}

function containerForAnchor(root: HTMLElement, anchor: Pick<ReaderTextAnchor, "unitId" | "page">): ReaderTextContainer | null {
  const candidates = readerDocumentContainers(root);
  const wantedPage = anchor.page === undefined || !Number.isFinite(anchor.page) ? undefined : Math.trunc(anchor.page);
  const matching = candidates.find((candidate) => {
    const unitId = candidate.dataset.readerUnit ?? candidate.closest<HTMLElement>("[data-reader-unit]")?.dataset.readerUnit;
    const pageValue = candidate.dataset.readerPage ?? candidate.closest<HTMLElement>("[data-reader-page]")?.dataset.readerPage;
    const page = pageValue === undefined ? undefined : Number(pageValue);
    if (anchor.unitId && unitId !== anchor.unitId) return false;
    if (wantedPage !== undefined && page !== wantedPage) return false;
    return true;
  });
  if (matching) return matching;

  // An explicit unit/page is part of the identity. Never fall back to another
  // mounted document while the requested source is temporarily out of the
  // bounded render window. This is also why annotation replay can safely pass
  // an individual `.file-reader-document` as `root`: its closest unit/page is
  // checked above before we give up.
  if (anchor.unitId || anchor.page !== undefined) return null;
  return candidates[0] ?? null;
}

function pointAtOffset(index: ReaderTextIndex, offset: number, endPoint: boolean): { node: Text; offset: number } | null {
  const { nodes } = index;
  if (nodes.length === 0 || !Number.isFinite(offset)) return null;
  const total = index.totalLength;
  const bounded = Math.max(0, Math.min(total, Math.trunc(offset)));
  let cursor = 0;
  for (const node of nodes) {
    const next = cursor + node.data.length;
    if (bounded < next || (bounded === next && !endPoint)) return { node, offset: bounded - cursor };
    if (bounded === next && endPoint) return { node, offset: node.data.length };
    cursor = next;
  }
  const last = nodes[nodes.length - 1];
  return last ? { node: last, offset: last.data.length } : null;
}

function rangeFromRawOffsets(container: ReaderTextContainer, startOffset: number, endOffset: number, index = buildReaderTextIndex(container)): Range | null {
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || endOffset <= startOffset) return null;
  const start = pointAtOffset(index, startOffset, false);
  const end = pointAtOffset(index, endOffset, true);
  if (!start || !end || start.node === end.node && start.offset >= end.offset) return null;
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range;
}

type NormalizedChar = { node: Text; offset: number; endNode: Text; endOffset: number; char: string };

type ReaderTextFlow = { nodes: Text[]; breakBefore: Set<Text> };

/** Walk one reader document once and retain explicit `<br>` boundaries for
 * the quote fallback. A raw offset intentionally ignores these presentation
 * breaks, while Range#toString() exposes them as line separators. */
function readerTextFlow(container: ReaderTextContainer): ReaderTextFlow {
  const nodes: Text[] = [];
  const breakBefore = new Set<Text>();
  let pendingBreak = false;
  const visit = (current: Node, excluded = false): void => {
    if (current.nodeType === Node.TEXT_NODE) {
      const text = current as Text;
      if (!excluded && text.data && isReaderTextNode(text)) {
        if (pendingBreak) breakBefore.add(text);
        pendingBreak = false;
        nodes.push(text);
      }
      return;
    }
    const element = current.nodeType === Node.ELEMENT_NODE ? current as Element : null;
    const nextExcluded = excluded || Boolean(element?.matches(READER_IGNORED_TEXT_SELECTOR));
    if (element?.tagName === "BR") {
      if (!nextExcluded) pendingBreak = true;
      return;
    }
    for (const child of Array.from(current.childNodes)) visit(child, nextExcluded);
  };
  visit(container);
  return { nodes, breakBefore };
}

const READER_BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

function readerBlockAncestor(node: Text): Element | null {
  let parent = node.parentElement;
  while (parent) {
    if (READER_BLOCK_TAGS.has(parent.tagName)) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function normalizedChars(flow: ReaderTextFlow): { text: string; chars: NormalizedChar[] } {
  const { nodes, breakBefore } = flow;
  const chars: NormalizedChar[] = [];
  let pendingSpace = false;
  let previousNode: Text | null = null;
  for (const node of nodes) {
    // Range#toString() exposes a separator when a selection crosses block
    // elements even if the source has no whitespace text node between them.
    // Keep the fallback locator consistent with the visible quote without
    // adding that presentation separator to the raw offset identity.
    const previousBlock = previousNode ? readerBlockAncestor(previousNode) : null;
    const currentBlock = readerBlockAncestor(node);
    const crossesBlock = previousBlock && currentBlock && previousBlock !== currentBlock;
    if (previousNode && (breakBefore.has(node) || crossesBlock)
      && !/\s$/u.test(previousNode.data) && !/^\s/u.test(node.data)) {
      // This is a presentation separator, not a character in either text
      // node. Its end boundary is the start of the next node; treating it as
      // `previousNode.length + 1` would skip the first real character when a
      // fallback quote ends at the block boundary.
      chars.push({ node: previousNode, offset: previousNode.data.length, endNode: node, endOffset: 0, char: " " });
      pendingSpace = true;
    }
    for (let offset = 0; offset < node.data.length; offset += 1) {
      const char = node.data[offset] ?? "";
      if (/\s/u.test(char)) {
        if (chars.length > 0 && !pendingSpace) {
          chars.push({ node, offset, endNode: node, endOffset: offset + 1, char: " " });
          pendingSpace = true;
        }
      } else {
        chars.push({ node, offset, endNode: node, endOffset: offset + 1, char });
        pendingSpace = false;
      }
    }
    previousNode = node;
  }
  while (chars[chars.length - 1]?.char === " ") chars.pop();
  return { text: chars.map((item) => item.char).join(""), chars };
}

function rangeFromNormalizedQuote(container: ReaderTextContainer, quote: string, preferredOffset = 0): Range | null {
  const target = normalizeReaderAnchorQuote(quote);
  if (!target) return null;
  const flow = readerTextFlow(container);
  const nodes = flow.nodes;
  const normalized = normalizedChars(flow);
  let start = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let searchFrom = 0;
  const offsets: number[] = [];
  const nodeOffsets = new Map<Text, number>();
  let rawCursor = 0;
  for (const node of nodes) {
    offsets.push(rawCursor);
    nodeOffsets.set(node, rawCursor);
    rawCursor += node.data.length;
  }
  while (searchFrom <= normalized.text.length - target.length) {
    const candidate = normalized.text.indexOf(target, searchFrom);
    if (candidate < 0) break;
    const mapped = normalized.chars[candidate];
    const rawStart = mapped ? (nodeOffsets.get(mapped.node) ?? 0) + mapped.offset : candidate;
    const distance = Math.abs(rawStart - preferredOffset);
    if (distance < bestDistance) {
      start = candidate;
      bestDistance = distance;
    }
    searchFrom = candidate + 1;
  }
  if (start < 0) return null;
  const first = normalized.chars[start];
  const last = normalized.chars[start + target.length - 1];
  if (!first || !last) return null;
  const startIndex = nodes.indexOf(first.node);
  const endIndex = nodes.indexOf(last.endNode);
  if (startIndex < 0 || endIndex < startIndex) return null;
  const rawStart = (nodeOffsets.get(first.node) ?? offsets[startIndex] ?? 0) + first.offset;
  const rawEnd = (nodeOffsets.get(last.endNode) ?? offsets[endIndex] ?? 0) + last.endOffset;
  return rangeFromRawOffsets(container, rawStart, rawEnd);
}

/** Capture a selection as a durable document-text anchor. */
export function captureReaderTextAnchor(root: HTMLElement, range: Range): ReaderTextAnchor | null {
  if (range.collapsed) return null;
  const container = containerForRange(root, range);
  if (!container) return null;
  const index = buildReaderTextIndex(container);
  const startOffset = offsetAtBoundary(container, range.startContainer, range.startOffset, index);
  const endOffset = offsetAtBoundary(container, range.endContainer, range.endOffset, index);
  const textLengthValue = index.totalLength;
  if (startOffset === null || endOffset === null || endOffset <= startOffset) return null;
  let rawText: string;
  try { rawText = range.toString(); } catch { return null; }
  if (!rawText || !normalizeReaderAnchorQuote(rawText)) return null;
  const unitElement = elementFor(range.startContainer)?.closest<HTMLElement>("[data-reader-unit]");
  const pageElement = elementFor(range.startContainer)?.closest<HTMLElement>("[data-reader-page]");
  const containerScope = container.closest<HTMLElement>("[data-reader-unit], [data-reader-page]");
  const containerUnit = container.closest<HTMLElement>("[data-reader-unit]");
  const containerPage = container.closest<HTMLElement>("[data-reader-page]");
  const pageValue = pageElement?.dataset.readerPage ?? containerPage?.dataset.readerPage ?? containerScope?.dataset.readerPage;
  const pageNumber = pageValue === undefined ? undefined : Number(pageValue);
  return {
    text: rawText,
    normalizedText: normalizeReaderAnchorQuote(rawText),
    startOffset,
    endOffset,
    textLength: textLengthValue,
    unitId: unitElement?.dataset.readerUnit || containerUnit?.dataset.readerUnit || containerScope?.dataset.readerUnit || undefined,
    page: typeof pageNumber === "number" && Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : undefined,
  };
}

/** Recreate a fresh Range from an anchor in the currently mounted layout. */
export function restoreReaderTextAnchor(root: HTMLElement, anchor: ReaderTextAnchor): Range | null {
  const container = containerForAnchor(root, anchor);
  if (!container) return null;
  const index = buildReaderTextIndex(container);
  const currentLength = index.totalLength;
  // A length change means text was inserted/removed before the anchor. Do not
  // trust coincidentally equal prose at the old numeric offset (especially in
  // books that repeat a sentence); fall back to the normalized quote index.
  const lengthMatches = anchor.textLength <= 0 || anchor.textLength === currentLength;
  const offsetsFit = lengthMatches && anchor.startOffset >= 0 && anchor.endOffset > anchor.startOffset
    && anchor.startOffset <= currentLength && anchor.endOffset <= currentLength;
  if (offsetsFit) {
    const range = rangeFromRawOffsets(container, anchor.startOffset, anchor.endOffset, index);
    if (range && !anchor.normalizedText) return range;
    if (range) {
      try {
        if (normalizeReaderAnchorQuote(range.toString()) === anchor.normalizedText) return range;
      } catch {
        // A renderer can detach a text node between the offset walk and the
        // validation read. Let the normalized quote fallback try the next DOM.
      }
    }
  }
  // Mark replay and publisher reflow can alter raw whitespace.  The quote is
  // intentionally only a fallback: offsets remain the primary identity.
  try {
    return rangeFromNormalizedQuote(container, anchor.normalizedText || anchor.text, anchor.startOffset);
  } catch {
    // A renderer can replace the container during an asynchronous commit.
    // Treat that pass as a miss; the next mutation/scroll refresh will retry.
    return null;
  }
}

export function readerRangeBelongsTo(root: HTMLElement, range: Range): boolean {
  return Boolean(containerForRange(root, range));
}
