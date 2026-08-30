import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus } from "lucide-react";
import { api, BASE_PATH, type ReaderAnnotation, type ReaderManifest, type ReaderUnitResponse } from "../api";
import { ReaderAnnotationPanel, type ReaderAnnotationAnchor } from "./ReaderAnnotations";
import { applyReaderTextHighlights, selectReaderAnnotation } from "./annotation-dom";
import { createReaderPdfRangeTransport, READER_PDF_RANGE_BYTES } from "./pdf-range-transport";
import { ensurePdfJsCompatibility, shouldDisablePdfFontFace } from "./pdf-compat";
import { readPdfTextContent } from "./pdf-text-content";
import "./ReaderDocument.css";

type ReaderDocumentProps = {
  manifest: ReaderManifest;
  annotations?: ReaderAnnotation[];
  onDeleteAnnotation?: (annotation: ReaderAnnotation) => void;
  onSelectAnnotation?: (annotation: ReaderAnnotation) => void;
  onAskAnnotation?: (annotation: ReaderAnnotation) => void;
};

function endpoint(path: string): string { return path.startsWith("http") ? path : `${BASE_PATH}${path}`; }

function ReaderPageIndicator({ label, ariaLabel }: { label: string; ariaLabel?: string }) {
  return <div className="reader-page-indicator" aria-live="polite" aria-label={ariaLabel ?? label}>{label}</div>;
}

function PdfPage({ pdf, pageNumber, scale, maxWidth, active, onRendered }: { pdf: import("pdfjs-dist").PDFDocumentProxy; pageNumber: number; scale: number; maxWidth: number; active: boolean; onRendered?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const measuredRef = useRef(false);
  const measuredScaleRef = useRef(scale);
  const measuredMaxWidthRef = useRef(maxWidth);
  const fallbackWidth = Math.max(180, Math.min(612, maxWidth)) * scale;
  const [size, setSize] = useState(() => ({ width: fallbackWidth, height: fallbackWidth * 792 / 612 }));
  useEffect(() => {
    if (measuredScaleRef.current !== scale || measuredMaxWidthRef.current !== maxWidth) measuredRef.current = false;
    if (!active) {
      // Drop the canvas/text layer when a page leaves the bounded render
      // window.  Keeping old canvases would make a long PDF consume memory
      // proportional to the whole book even though only nearby pages are
      // meant to be live.
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; }
      textRef.current?.replaceChildren();
      if (!measuredRef.current) {
        const width = Math.max(180, Math.min(612, maxWidth)) * scale;
        setSize((current) => current.width === width ? current : { width, height: width * 792 / 612 });
      }
      return;
    }
    let cancelled = false;
    let page: import("pdfjs-dist").PDFPageProxy | null = null;
    let renderTask: import("pdfjs-dist").RenderTask | null = null;
    let textLayer: import("pdfjs-dist").TextLayer | null = null;
    let pageCleaned = false;
    const cleanupPage = () => {
      if (pageCleaned || !page) return;
      pageCleaned = true;
      try { page.cleanup(); } catch { /* PDF.js may already have released the page. */ }
    };
    void (async () => {
      try {
        ensurePdfJsCompatibility();
        const module = await import("pdfjs-dist/legacy/build/pdf.mjs");
        page = await pdf.getPage(pageNumber);
        if (cancelled) { cleanupPage(); return; }
        const base = page.getViewport({ scale: 1 });
        // Fit the default page to the actual track.  A fixed 760 CSS-pixel
        // width is comfortable on desktop but would make a phone render a
        // second horizontal scroller inside the paginated track.  Explicit
        // zoom remains allowed to exceed the fit width.
        const availableWidth = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 760;
        const viewport = page.getViewport({ scale: scale * Math.min(1, availableWidth / base.width) });
        setSize({ width: viewport.width, height: viewport.height });
        const canvas = canvasRef.current;
        const textContainer = textRef.current;
        if (!canvas || !textContainer) { cleanupPage(); return; }
        measuredRef.current = true;
        measuredScaleRef.current = scale;
        measuredMaxWidthRef.current = maxWidth;
        // pdfjs-dist's display TextLayer deliberately leaves the page scale
        // to the host stylesheet. Without this variable its generated
        // `calc(var(--total-scale-factor) * ...)` dimensions/font sizes are
        // invalid, so selectable text can collapse or drift away from the
        // canvas even though rendering itself succeeds.
        textContainer.style.setProperty("--total-scale-factor", String(viewport.scale));
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) { cleanupPage(); return; }
        renderTask = page.render({ canvasContext: context, canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
        const textContent = await readPdfTextContent(page);
        if (cancelled) { renderTask.cancel(); await renderTask.promise.catch(() => undefined); cleanupPage(); return; }
        textContainer.replaceChildren();
        textLayer = new module.TextLayer({ textContentSource: textContent, container: textContainer, viewport });
        await Promise.all([renderTask.promise, textLayer.render()]);
        if (!cancelled) onRendered?.();
        cleanupPage();
      } catch (error) {
        // A text-layer failure can happen while the canvas render is still in
        // flight. Wait for PDF.js to settle before releasing the page so a
        // rejected/aborted render cannot retain a canvas-backed page proxy.
        if (renderTask) await renderTask.promise.catch(() => undefined);
        cleanupPage();
        if (!cancelled && !(error instanceof Error && /cancel/i.test(error.message))) console.warn("PDF page render failed", error);
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      // Do not release a page while PDF.js is still painting. Wait for the
      // render promise to settle, then clean it exactly once; this prevents
      // rapid horizontal swipes from accumulating page resources.
      if (renderTask) void renderTask.promise.catch(() => undefined).finally(cleanupPage);
      else cleanupPage();
    };
  }, [active, maxWidth, onRendered, pageNumber, pdf, scale]);
  return <article className={`reader-pdf-page${active ? "" : " is-inactive"}`} data-reader-page={pageNumber} style={{ width: size.width, minHeight: size.height }} aria-label={`第 ${pageNumber} 页`} aria-hidden={!active}>
    <canvas ref={canvasRef} aria-hidden="true" />
    <div ref={textRef} className="reader-pdf-text-layer textLayer file-reader-document reader-text-container" data-reader-page={pageNumber} />
    {!active && <div className="reader-page-placeholder"><LoaderCircle className="spin" size={18} /></div>}
  </article>;
}

function PdfReader({ manifest, onPageRendered }: { manifest: ReaderManifest; onPageRendered?: () => void }) {
  const [pdf, setPdf] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [activePage, setActivePage] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState("");
  const trackRef = useRef<HTMLDivElement>(null);
  const [pageMaxWidth, setPageMaxWidth] = useState(760);
  const progressReadyRef = useRef(false);
  const positionedVersionRef = useRef<string | null>(null);
  const [progressReady, setProgressReady] = useState(false);
  const scrollFrameRef = useRef<number | null>(null);
  const activePageRef = useRef(activePage);
  useEffect(() => { activePageRef.current = activePage; }, [activePage]);
  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const updatePageWidth = () => {
      const style = window.getComputedStyle(track);
      const horizontalPadding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      const available = track.clientWidth - horizontalPadding;
      if (available > 0) setPageMaxWidth(Math.max(180, Math.min(760, available)));
    };
    updatePageWidth();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updatePageWidth);
      observer.observe(track);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", updatePageWidth);
    return () => window.removeEventListener("resize", updatePageWidth);
  }, [pdf]);
  useEffect(() => {
    positionedVersionRef.current = null;
    activePageRef.current = 1;
    setActivePage(1);
    setPageCount(0);
    setPdf(null);
    setError("");
  }, [manifest.version.id]);
  useEffect(() => {
    progressReadyRef.current = false;
    setProgressReady(false);
    const controller = new AbortController();
    void api.readerProgress(manifest.version.id, controller.signal).then(({ progress }) => {
      if (!progress) return;
      try { const parsed = JSON.parse(progress.position_json) as { page?: unknown }; if (typeof parsed.page === "number" && Number.isFinite(parsed.page)) setActivePage(Math.max(1, Math.trunc(parsed.page))); } catch { /* ignore malformed legacy position */ }
    }).finally(() => {
      if (!controller.signal.aborted) {
        progressReadyRef.current = true;
        setProgressReady(true);
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [manifest.version.id]);
  // The paginator is restored from server progress, but the horizontal track
  // starts at scrollLeft=0 by default.  Position it once after both the PDF
  // metadata and progress are available; otherwise a restored "page 18" label
  // would still show page 1 until the user navigates.
  useEffect(() => {
    if (!pdf || pageCount <= 0 || !progressReady) return;
    if (positionedVersionRef.current === manifest.version.id) return;
    const track = trackRef.current;
    if (!track) return;
    let cancelled = false;
    let attempts = 0;
    let frame: number | null = null;
    const position = () => {
      if (cancelled) return;
      const target = track.querySelector<HTMLElement>(`[data-reader-page="${activePage}"]`);
      if (!target || target.offsetWidth <= 0) {
        if (attempts++ < 30) frame = window.requestAnimationFrame(position);
        return;
      }
      const left = target.offsetLeft - Math.max(0, (track.clientWidth - target.offsetWidth) / 2);
      const nextLeft = Math.max(0, left);
      if (typeof track.scrollTo === "function") track.scrollTo({ left: nextLeft, behavior: "auto" });
      else track.scrollLeft = nextLeft;
      positionedVersionRef.current = manifest.version.id;
    };
    frame = window.requestAnimationFrame(position);
    return () => { cancelled = true; if (frame !== null) window.cancelAnimationFrame(frame); };
  }, [activePage, pageCount, pdf, progressReady, manifest.version.id]);
  useEffect(() => {
    if (!progressReadyRef.current) return;
    const timer = window.setTimeout(() => { void api.saveReaderProgress(manifest.version.id, null, { page: activePage }).catch(() => undefined); }, 500);
    return () => window.clearTimeout(timer);
  }, [activePage, manifest.version.id]);
  useEffect(() => {
    let cancelled = false;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
    let transport: import("pdfjs-dist").PDFDataRangeTransport | null = null;
    let pdfModule: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null = null;
    let workerPort: Worker | null = null;
    let destroyStarted = false;
    const releaseWorker = () => {
      const port = workerPort;
      workerPort = null;
      if (!port) return;
      if (pdfModule?.GlobalWorkerOptions.workerPort === port) pdfModule.GlobalWorkerOptions.workerPort = null;
      port.terminate();
    };
    const destroyTask = async () => {
      if (destroyStarted) return;
      destroyStarted = true;
      transport?.abort();
      await task?.destroy().catch(() => undefined);
    };
    void (async () => {
      try {
        ensurePdfJsCompatibility();
        const module = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfModule = module;
        if (cancelled) return;
        workerPort = new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module" });
        module.GlobalWorkerOptions.workerPort = workerPort;
        if (!Number.isSafeInteger(manifest.version.sourceBytes) || manifest.version.sourceBytes <= 0) throw new Error("PDF 文件大小无效。");
        transport = createReaderPdfRangeTransport(module.PDFDataRangeTransport, {
          url: endpoint(manifest.endpoints.bytes),
          length: manifest.version.sourceBytes,
          filename: manifest.source.title,
          maxRangeBytes: READER_PDF_RANGE_BYTES,
          // Leave one server-side reader slot available for progress,
          // annotations, or a neighbouring EPUB/document request.
          maxConcurrent: 4,
          credentials: "include",
          onError: (reason) => {
            if (cancelled) return;
            setError(reason instanceof Error ? reason.message : "PDF Range 读取失败。");
            void destroyTask().finally(releaseWorker);
          },
        });
        if (cancelled) { transport.abort(); return; }
        task = module.getDocument({
          range: transport,
          rangeChunkSize: READER_PDF_RANGE_BYTES,
          disableStream: true,
          disableAutoFetch: true,
          // Safari/WebKit may silently reject PDF.js's synthesized OpenType
          // font while still painting the rest of the page.  Ask PDF.js to
          // use its glyph-path renderer there so Chinese and other CID text
          // remains visible on phones and WKWebViews.
          disableFontFace: shouldDisablePdfFontFace(),
        });
        const loaded = await task.promise;
        if (cancelled) { await loaded.cleanup(); return; }
        setPdf(loaded); setPageCount(loaded.numPages); setActivePage((value) => Math.max(1, Math.min(loaded.numPages, value)));
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : "PDF 加载失败。"); }
    })();
    return () => {
      cancelled = true;
      // Let PDF.js send its normal Terminate message before closing the
      // externally-owned worker port. This avoids leaving a loading promise
      // pending when a reader is switched quickly.
      void destroyTask().finally(releaseWorker);
    };
  }, [manifest.endpoints.bytes, manifest.source.title, manifest.version.id, manifest.version.sourceBytes]);

  const updateActivePage = useCallback(() => {
    const track = trackRef.current;
    if (!track || pageCount === 0) return;
    const center = track.scrollLeft + track.clientWidth / 2;
    const children = track.children;
    // Page slots stay in document order, so a binary search avoids walking
    // every placeholder on each scroll frame in a thousand-page PDF.
    let low = 0;
    let high = children.length - 1;
    while (low <= high) {
      const middleIndex = (low + high) >> 1;
      const element = children.item(middleIndex) as HTMLElement | null;
      if (!element) break;
      const middle = element.offsetLeft + element.offsetWidth / 2;
      if (middle < center) low = middleIndex + 1;
      else high = middleIndex - 1;
    }
    let nearest = 1;
    let distance = Infinity;
    for (const index of [Math.max(0, high), Math.min(children.length - 1, low)]) {
      const element = children.item(index) as HTMLElement | null;
      if (!element) continue;
      const page = Number(element.dataset.readerPage || 0);
      const nextDistance = Math.abs(element.offsetLeft + element.offsetWidth / 2 - center);
      if (page && nextDistance < distance) { distance = nextDistance; nearest = page; }
    }
    if (nearest !== activePageRef.current) {
      activePageRef.current = nearest;
      setActivePage(nearest);
    }
  }, [pageCount]);
  const scheduleActivePageUpdate = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateActivePage();
    });
  }, [updateActivePage]);
  const jump = (delta: number) => {
    const next = Math.max(1, Math.min(pageCount, activePage + delta));
    const track = trackRef.current;
    const target = track?.querySelector<HTMLElement>(`[data-reader-page="${next}"]`);
    // A PDF page may be narrower than a desktop viewport.  Centering the
    // target in that case leaves part of the previous page (and its text
    // selection) visible, so a page turn does not really take the source
    // page off-screen.  Align the target's leading edge instead; this keeps
    // the paging control deterministic while preserving the natural page
    // size and horizontal swipe behavior.
    if (track && target) {
      const left = Math.max(0, target.offsetLeft);
      if (typeof track.scrollTo === "function") track.scrollTo({ left, behavior: "smooth" });
      else track.scrollLeft = left;
    }
    activePageRef.current = next;
    setActivePage(next);
  };
  if (error) return <div className="reader-document-error">{error}</div>;
  if (!pdf) return <div className="reader-document-loading"><LoaderCircle className="spin" size={24} />正在按需加载 PDF…</div>;
  return <div className="reader-pdf-reader">
    <div ref={trackRef} className="reader-pdf-track" onScroll={scheduleActivePageUpdate}>
      {Array.from({ length: pageCount }, (_, index) => {
        const page = index + 1;
        return <div className="reader-pdf-page-slot" data-reader-page={page} key={page}><PdfPage pdf={pdf} pageNumber={page} scale={scale} maxWidth={pageMaxWidth} active={Math.abs(page - activePage) <= 2} onRendered={onPageRendered} /></div>;
      })}
    </div>
    <div className="reader-reader-controls" role="toolbar" aria-label="PDF 阅读控制">
      <button type="button" disabled={activePage <= 1} onClick={() => jump(-1)} title="上一页" aria-label="上一页"><ChevronLeft size={16} /></button>
      <button type="button" disabled={activePage >= pageCount} onClick={() => jump(1)} title="下一页" aria-label="下一页"><ChevronRight size={16} /></button>
      <span className="reader-reader-controls-divider" aria-hidden="true" />
      <button type="button" onClick={() => setScale((value) => Math.max(.6, value - .1))} title="缩小" aria-label="缩小"><Minus size={15} /></button>
      <button type="button" onClick={() => setScale((value) => Math.min(2, value + .1))} title="放大" aria-label="放大"><Plus size={15} /></button>
    </div>
    <ReaderPageIndicator label={`${activePage} / ${pageCount}`} ariaLabel={`第 ${activePage} 页，共 ${pageCount} 页`} />
  </div>;
}

function EpubUnit({ unit, content, active, initialScrollLeft = 0, fontScale = 1, onPageCount, onPosition, onRendered }: {
  unit: ReaderManifest["units"][number];
  content: string | undefined;
  active: boolean;
  initialScrollLeft?: number;
  fontScale?: number;
  onPageCount?: (count: number) => void;
  onPosition?: (scrollLeft: number, pageCount: number, page: number) => void;
  onRendered?: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const update = useCallback(() => {
    const node = viewportRef.current;
    if (!node) return;
    const pageCount = Math.max(1, Math.ceil(node.scrollWidth / Math.max(1, node.clientWidth)));
    const page = Math.min(pageCount, Math.floor(node.scrollLeft / Math.max(1, node.clientWidth)) + 1);
    onPageCount?.(pageCount);
    onPosition?.(node.scrollLeft, pageCount, page);
  }, [onPageCount, onPosition]);
  const scheduleUpdate = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      update();
    });
  }, [update]);
  useEffect(() => {
    if (!active) return;
    const node = viewportRef.current;
    if (!node) return;
    // Reset between spine units as well as restoring a saved position. Without
    // the explicit zero assignment, a reused viewport can carry the previous
    // chapter's horizontal offset into the newly selected chapter.
    node.scrollLeft = Math.max(0, initialScrollLeft);
    update();
    let frame: number | null = null;
    let secondFrame: number | null = null;
    if (content !== undefined) {
      // Column geometry settles after the first style/layout pass. Measure
      // again on the following frame so long chapters expose their complete
      // horizontal extent and a saved page is not clamped to zero.
      frame = window.requestAnimationFrame(() => {
        node.scrollLeft = Math.max(0, initialScrollLeft);
        update();
        onRendered?.();
        secondFrame = window.requestAnimationFrame(() => {
          node.scrollLeft = Math.max(0, initialScrollLeft);
          update();
          // Notify after the second layout pass as well. Long chapters can
          // settle their column geometry one frame after the first measure;
          // replaying annotations only after that pass avoids a highlight
          // being lost when the chapter DOM is still reflowing.
          onRendered?.();
        });
      });
    }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    observer?.observe(node);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      observer?.disconnect();
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    };
  }, [active, content, fontScale, initialScrollLeft, onRendered, scheduleUpdate, unit.id, update]);
  return <article className="reader-epub-unit" data-reader-unit={unit.id} aria-label={unit.title || `第 ${unit.ordinal + 1} 节`}>
    <div ref={viewportRef} className="reader-epub-page-viewport" onScroll={scheduleUpdate}>
      {content === undefined ? <div className="reader-document-loading"><LoaderCircle className="spin" size={18} />正在加载附近内容…</div> : <div ref={contentRef} className="reader-epub-content file-reader-document reader-text-container" style={{ "--reader-epub-scale": fontScale ?? 1 } as CSSProperties} dangerouslySetInnerHTML={{ __html: content }} />}
    </div>
  </article>;
}

function EpubReader({ manifest, onUnitRendered }: { manifest: ReaderManifest; onUnitRendered?: () => void }) {
  const [current, setCurrent] = useState(0);
  const [units, setUnits] = useState<Record<string, ReaderUnitResponse>>({});
  const unitsRef = useRef<Record<string, ReaderUnitResponse>>({});
  // Keep the generation that owns each request.  A Set is insufficient here:
  // when the user changes chapters, the old request is aborted but its
  // finally-handler may run after the new effect has already decided that the
  // unit is "loading", leaving the newly visible chapter blank forever.
  const loadingUnitsRef = useRef(new Map<string, number>());
  const loadGenerationRef = useRef(0);
  const [initialScrollLeft, setInitialScrollLeft] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const [fontScale, setFontScale] = useState(1);
  const scrollPositionRef = useRef(0);
  const [error, setError] = useState("");
  const unit = manifest.units[current];
  const progressReadyRef = useRef(false);
  useEffect(() => { unitsRef.current = units; }, [units]);
  useEffect(() => {
    // A manifest switch is a new document, not merely a new status snapshot.
    // Drop old chapter content and invalidate requests before the next load
    // effect runs; this also prevents annotations/content from crossing files.
    loadGenerationRef.current += 1;
    loadingUnitsRef.current.clear();
    unitsRef.current = {};
    setUnits({});
    setCurrent(0);
    setInitialScrollLeft(0);
    scrollPositionRef.current = 0;
    setPage(1);
    setPageCount(1);
    setFontScale(1);
    setError("");
  }, [manifest.version.id]);
  const handlePosition = useCallback((position: number, count: number, pageNumber: number) => {
    scrollPositionRef.current = position;
    setPageCount((value) => value === count ? value : count);
    setPage((value) => value === pageNumber ? value : pageNumber);
  }, []);
  useEffect(() => {
    progressReadyRef.current = false;
    const controller = new AbortController();
    void api.readerProgress(manifest.version.id, controller.signal).then(({ progress }) => {
      if (!progress) return;
      const index = manifest.units.findIndex((candidate) => candidate.id === progress.unit_id);
      if (index >= 0) setCurrent(index);
      try {
        const parsed = JSON.parse(progress.position_json) as { unit?: unknown; scrollLeft?: unknown };
        if (index < 0 && typeof parsed.unit === "number") setCurrent(Math.max(0, Math.min(manifest.units.length - 1, Math.trunc(parsed.unit))));
        if (typeof parsed.scrollLeft === "number" && Number.isFinite(parsed.scrollLeft)) {
          const position = Math.max(0, parsed.scrollLeft);
          scrollPositionRef.current = position;
          setInitialScrollLeft(position);
        }
      } catch { /* ignore malformed legacy position */ }
    }).finally(() => {
      if (!controller.signal.aborted) progressReadyRef.current = true;
    }).catch(() => undefined);
    return () => controller.abort();
  }, [manifest.units, manifest.version.id]);
  useEffect(() => {
    if (!progressReadyRef.current || !unit) return;
    const timer = window.setTimeout(() => { void api.saveReaderProgress(manifest.version.id, unit.id, { unit: current, scrollLeft: scrollPositionRef.current }).catch(() => undefined); }, 500);
    return () => window.clearTimeout(timer);
  }, [current, manifest.version.id, page, unit]);
  useEffect(() => {
    if (manifest.version.status !== "ready") return;
    setError("");
    // Request the visible chapter first, then fan out to its four neighbours.
    // A slow prefetch must never delay the chapter the user just opened.
    const wanted = [0, -1, 1, -2, 2]
      .map((offset) => manifest.units[current + offset])
      .filter((candidate): candidate is ReaderManifest["units"][number] => Boolean(candidate));
    const generation = ++loadGenerationRef.current;
    const controller = new AbortController();
    // Prune immediately, rather than waiting for an asynchronous unit
    // response, so a long book never retains all previously visited chapters.
    const wantedIds = new Set(wanted.map((candidate) => candidate.id));
    const retained = Object.fromEntries(Object.entries(unitsRef.current).filter(([id]) => wantedIds.has(id)));
    if (Object.keys(retained).length !== Object.keys(unitsRef.current).length) {
      unitsRef.current = retained;
      setUnits(retained);
    }
    for (const candidate of wanted) {
      if (unitsRef.current[candidate.id] || loadingUnitsRef.current.get(candidate.id) === generation) continue;
      loadingUnitsRef.current.set(candidate.id, generation);
      void api.readerUnit(manifest.version.id, candidate.id, controller.signal).then((result) => setUnits((old) => {
        if (controller.signal.aborted || generation !== loadGenerationRef.current) return old;
        const next = { ...old, [candidate.id]: result };
        const keep = new Set(manifest.units.slice(Math.max(0, current - 2), Math.min(manifest.units.length, current + 3)).map((item) => item.id));
        for (const key of Object.keys(next)) if (!keep.has(key)) delete next[key];
        unitsRef.current = next;
        return next;
      })).catch((reason) => { if (!controller.signal.aborted && generation === loadGenerationRef.current) setError(reason instanceof Error ? reason.message : "EPUB 单元加载失败。"); }).finally(() => {
        if (loadingUnitsRef.current.get(candidate.id) === generation) loadingUnitsRef.current.delete(candidate.id);
      });
    }
    return () => controller.abort();
  }, [current, manifest.units, manifest.version.id, manifest.version.status]);
  if (manifest.version.status === "processing") return <div className="reader-document-loading"><LoaderCircle className="spin" size={24} />正在后台解析 EPUB，稍后自动出现附近章节…</div>;
  if (manifest.version.status === "cold" || manifest.version.status === "restoring") return <div className="reader-document-loading"><LoaderCircle className="spin" size={24} />正在从冷存储恢复 EPUB…</div>;
  if (manifest.version.status === "failed") return <div className="reader-document-error">{manifest.version.error || "EPUB 解析失败。"}</div>;
  if (!unit) return <div className="reader-document-error">EPUB 没有可显示的章节。</div>;
  return <div className="reader-epub-reader">
    {error && <div className="reader-inline-error" role="alert">{error}</div>}
    <div className="reader-epub-track">
      <EpubUnit unit={unit} content={units[unit.id]?.content} active initialScrollLeft={initialScrollLeft} fontScale={fontScale} onPosition={handlePosition} onRendered={onUnitRendered} />
    </div>
    <div className="reader-reader-controls" role="toolbar" aria-label="EPUB 章节控制">
      <button type="button" disabled={current <= 0} onClick={() => { setCurrent((value) => Math.max(0, value - 1)); scrollPositionRef.current = 0; setInitialScrollLeft(0); setPage(1); setPageCount(1); }} title="上一章" aria-label="上一章"><ChevronLeft size={16} /></button>
      <select className="reader-epub-chapter-select" aria-label="选择章节" value={current} onChange={(event) => { const next = Math.max(0, Math.min(manifest.units.length - 1, Number(event.target.value))); setCurrent(next); scrollPositionRef.current = 0; setInitialScrollLeft(0); setPage(1); setPageCount(1); }}>
        {manifest.units.map((candidate, index) => <option key={candidate.id} value={index}>{candidate.title || `第 ${index + 1} 节`}</option>)}
      </select>
      <button type="button" disabled={current >= manifest.units.length - 1} onClick={() => { setCurrent((value) => Math.min(manifest.units.length - 1, value + 1)); scrollPositionRef.current = 0; setInitialScrollLeft(0); setPage(1); setPageCount(1); }} title="下一章" aria-label="下一章"><ChevronRight size={16} /></button>
      <span className="reader-reader-controls-divider" aria-hidden="true" />
      <button type="button" disabled={fontScale <= .8} onClick={() => setFontScale((value) => Math.max(.8, Number((value - .1).toFixed(2))))} title="缩小文字" aria-label="缩小文字"><Minus size={15} /></button>
      <button type="button" disabled={fontScale >= 1.4} onClick={() => setFontScale((value) => Math.min(1.4, Number((value + .1).toFixed(2))))} title="放大文字" aria-label="放大文字"><Plus size={15} /></button>
    </div>
    <ReaderPageIndicator label={`${page} / ${pageCount}`} ariaLabel={`第 ${current + 1} 个章节，第 ${page} 页，共 ${pageCount} 页${unit.title ? `，${unit.title}` : ""}`} />
  </div>;
}

export function ReaderDocument({ manifest, annotations, onDeleteAnnotation, onSelectAnnotation, onAskAnnotation }: ReaderDocumentProps) {
  const [liveManifest, setLiveManifest] = useState(manifest);
  const [loadedAnnotations, setLoadedAnnotations] = useState<ReaderAnnotation[]>([]);
  const [renderRevision, setRenderRevision] = useState(0);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [activeAnnotationAnchor, setActiveAnnotationAnchor] = useState<ReaderAnnotationAnchor | null>(null);
  const readerRootRef = useRef<HTMLDivElement>(null);
  const notifyRendered = useCallback(() => setRenderRevision((value) => value + 1), []);
  useEffect(() => setLiveManifest(manifest), [manifest]);
  useEffect(() => {
    if (liveManifest.version.status === "ready" || liveManifest.version.status === "failed") return;
    let stopped = false;
    let timer: number | null = null;
    const poll = async () => {
      if (stopped) return;
      try {
        const next = await api.readerManifest(liveManifest.version.id);
        if (stopped) return;
        setLiveManifest(next);
        if (next.version.status !== "ready" && next.version.status !== "failed") timer = window.setTimeout(() => void poll(), 1_000);
      } catch {
        if (!stopped) timer = window.setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => { stopped = true; if (timer !== null) window.clearTimeout(timer); };
  }, [liveManifest.version.id, liveManifest.version.status]);
  useEffect(() => {
    if (annotations) return;
    const controller = new AbortController();
    void api.readerAnnotations(liveManifest.version.id, controller.signal).then((result) => setLoadedAnnotations(result.annotations)).catch(() => undefined);
    return () => controller.abort();
  }, [annotations, liveManifest.version.id]);
  const visibleAnnotations = annotations ?? loadedAnnotations;
  const focusAnnotation = useCallback((annotation: ReaderAnnotation, anchor?: ReaderAnnotationAnchor) => {
    setActiveAnnotationId(annotation.id);
    setActiveAnnotationAnchor(anchor ?? null);
    const root = readerRootRef.current;
    if (!root) { onSelectAnnotation?.(annotation); return; }
    const focus = () => {
      // Most marks are already mounted in the bounded reader window. Only
      // delegate to the outer shell when this annotation is currently
      // outside that window; this avoids replacing the same native Range
      // twice and leaves room for future page/unit navigation there.
      if (!selectReaderAnnotation(root, annotation.id)) onSelectAnnotation?.(annotation);
    };
    if (typeof window !== "undefined") window.requestAnimationFrame(focus);
  }, [onSelectAnnotation]);
  useEffect(() => {
    const root = readerRootRef.current;
    if (!root) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const mark = target.closest<HTMLElement>("mark.reader-local-highlight[data-reader-annotation]");
      if (!mark || !root.contains(mark)) return;
      const annotationId = mark.dataset.readerAnnotation;
      if (!annotationId) return;
      const annotation = visibleAnnotations.find((item) => item.id === annotationId);
      if (annotation?.type === "note") {
        const rect = mark.getBoundingClientRect();
        focusAnnotation(annotation, { left: (rect.left + rect.right) / 2, top: rect.bottom + 8 });
      } else if (annotation) {
        setActiveAnnotationId(null);
        setActiveAnnotationAnchor(null);
        selectReaderAnnotation(root, annotation.id);
      }
      else selectReaderAnnotation(root, annotationId);
    };
    root.addEventListener("click", handleClick);
    return () => root.removeEventListener("click", handleClick);
  }, [focusAnnotation, visibleAnnotations]);
  useEffect(() => {
    if (activeAnnotationId && !visibleAnnotations.some((annotation) => annotation.id === activeAnnotationId)) {
      setActiveAnnotationId(null);
      setActiveAnnotationAnchor(null);
    }
  }, [activeAnnotationId, visibleAnnotations]);
  useEffect(() => {
    const root = readerRootRef.current;
    if (!root) return;
    // Always run the replay pass, including when the list becomes empty.  The
    // pass first removes marks owned by this reader, so deleting the last
    // annotation cannot leave a stale highlight in a mounted PDF/EPUB unit.
    // EPUB content is mounted after an asynchronous unit request and its
    // multi-column layout can settle one or two turns after innerHTML is
    // committed. A single frame can therefore race the first visit after a
    // reopen: the annotation is present in the API response but its text
    // node is not mounted yet. Replay across a short, bounded window (the
    // same four-frame budget used by the legacy HTML reader) and once after
    // the layout has had time to settle. This is deliberately bounded so a
    // large EPUB cannot keep a timer or animation loop alive indefinitely.
    let cancelled = false;
    let frame: number | null = null;
    let attempts = 0;
    const replay = () => {
      if (cancelled) return;
      applyReaderTextHighlights(root, visibleAnnotations);
      attempts += 1;
      if (attempts < 4) frame = window.requestAnimationFrame(replay);
    };
    frame = window.requestAnimationFrame(replay);
    const delayed = window.setTimeout(() => { if (!cancelled) applyReaderTextHighlights(root, visibleAnnotations); }, 180);
    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.clearTimeout(delayed);
    };
  }, [liveManifest.version.id, renderRevision, visibleAnnotations]);
  return <div ref={readerRootRef} className="reader-document-shell" data-reader-format={liveManifest.source.format}>
    {liveManifest.source.format === "pdf" ? <PdfReader manifest={liveManifest} onPageRendered={notifyRendered} /> : <EpubReader manifest={liveManifest} onUnitRendered={notifyRendered} />}
    <ReaderAnnotationPanel annotations={visibleAnnotations} onDelete={onDeleteAnnotation} onSelect={focusAnnotation} onAsk={onAskAnnotation} activeAnnotationId={activeAnnotationId} anchor={activeAnnotationAnchor} onClose={() => { setActiveAnnotationId(null); setActiveAnnotationAnchor(null); }} />
  </div>;
}
