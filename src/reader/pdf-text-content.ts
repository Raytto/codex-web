import type { PDFPageProxy } from "pdfjs-dist";

type PdfTextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
type PdfTextContentParameters = Parameters<PDFPageProxy["getTextContent"]>[0];

/**
 * PDF.js 6 implements PDFPageProxy.getTextContent() with `for await` over the
 * ReadableStream returned by streamTextContent().  Some Safari releases expose
 * the stream reader but omit the async-iterator interface, so the otherwise
 * successful canvas render is followed by a text-layer failure.  Consume the
 * portable reader API directly and keep the same TextContent shape PDF.js
 * returns from getTextContent().
 */
export async function readPdfTextContent(page: PDFPageProxy, params?: PdfTextContentParameters): Promise<PdfTextContent> {
  // XFA pages are handled by PDF.js through its dedicated text extractor;
  // retain that path instead of asking an XFA page for a normal text stream.
  if (page.isPureXfa) return page.getTextContent(params);

  const reader = page.streamTextContent(params).getReader() as ReadableStreamDefaultReader<Partial<PdfTextContent>>;
  const textContent: PdfTextContent = { items: [], styles: Object.create(null), lang: null };
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      textContent.lang ??= value.lang ?? null;
      if (value.styles) Object.assign(textContent.styles, value.styles);
      if (value.items) textContent.items.push(...value.items);
    }
    completed = true;
    return textContent;
  } finally {
    if (!completed) {
      try { await reader.cancel(); } catch { /* the page may already be shutting down */ }
    }
    reader.releaseLock();
  }
}
