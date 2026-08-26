const APP_VIEWPORT_HEIGHT = "--app-viewport-height";
// Safari toolbar changes are much smaller than a software keyboard transition.
const KEYBOARD_HEIGHT_DELTA = 120;
// WebKit can publish the final visual viewport only after the keyboard animation.
const SETTLE_DELAYS_MS = [80, 240, 500] as const;
// Keep root-scroll recovery out of the browser's selection/loupe transaction.
// iOS may finish presenting its native edit menu well after the first
// selectionchange, especially inside an overflow reader.
const TEXT_SELECTION_RESET_GRACE_MS = 2_000;

export function isTextEntryElement(element: Element | null): boolean {
  return Boolean(element?.matches(
    'textarea, input:not([type="button"]):not([type="checkbox"]):not([type="color"]):not([type="file"]):not([type="hidden"]):not([type="radio"]):not([type="range"]):not([type="reset"]):not([type="submit"]), [contenteditable]:not([contenteditable="false"])',
  ));
}

export function mobileViewportUpdate(editing: boolean, height: number, offsetTop: number, previousHeight: number) {
  const validHeight = Number.isFinite(height) && height > 0;
  const validOffsetTop = Number.isFinite(offsetTop) && offsetTop > 0 ? offsetTop : 0;
  const keyboardClosed = validHeight
    && Number.isFinite(previousHeight)
    && height - previousHeight >= KEYBOARD_HEIGHT_DELTA;

  return {
    // Safari may pan the visual viewport while focusing a field. Its bottom
    // edge is offsetTop + height in layout coordinates; height alone would
    // compensate twice and lift the composer far above the keyboard.
    rootHeight: editing && validHeight ? `${Math.round(height + validOffsetTop)}px` : null,
    resetRootScroll: !editing || keyboardClosed,
  };
}

export function installMobileViewportRecovery(win: Window = window, doc: Document = document) {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};

  let frame = 0;
  let previousHeight = viewport.height;
  let resetRootScrollOnNextApply = false;
  let lastTextSelectionAt = 0;
  const settleTimers = new Set<number>();

  const resetRootScroll = () => {
    win.scrollTo(0, 0);
    doc.documentElement.scrollTop = 0;
    doc.body.scrollTop = 0;
  };

  const apply = () => {
    frame = 0;
    const shouldResetRootScroll = resetRootScrollOnNextApply;
    resetRootScrollOnNextApply = false;
    const next = mobileViewportUpdate(
      isTextEntryElement(doc.activeElement),
      viewport.height,
      viewport.offsetTop,
      previousHeight,
    );
    previousHeight = viewport.height;

    if (next.rootHeight) {
      doc.documentElement.style.setProperty(APP_VIEWPORT_HEIGHT, next.rootHeight);
    } else {
      doc.documentElement.style.removeProperty(APP_VIEWPORT_HEIGHT);
    }
    const nativeSelection = doc.getSelection();
    const textSelectionActive = Boolean(nativeSelection && !nativeSelection.isCollapsed && nativeSelection.rangeCount > 0);
    const textSelectionRecentlyActive = lastTextSelectionAt > 0 && Date.now() - lastTextSelectionAt < TEXT_SELECTION_RESET_GRACE_MS;
    if (next.resetRootScroll && shouldResetRootScroll && !textSelectionActive && !textSelectionRecentlyActive) resetRootScroll();
  };

  const schedule = (resetRootScroll = true) => {
    if (resetRootScroll) resetRootScrollOnNextApply = true;
    if (frame) win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(apply);
  };

  const scheduleSettled = () => {
    for (const timer of settleTimers) win.clearTimeout(timer);
    settleTimers.clear();
    schedule();
    for (const delay of SETTLE_DELAYS_MS) {
      const timer = win.setTimeout(() => {
        settleTimers.delete(timer);
        schedule();
      }, delay);
      settleTimers.add(timer);
    }
  };
  const handleViewportScroll = () => {
    const nativeSelection = doc.getSelection();
    const textSelectionActive = Boolean(nativeSelection && !nativeSelection.isCollapsed && nativeSelection.rangeCount > 0);
    const textSelectionRecentlyActive = lastTextSelectionAt > 0 && Date.now() - lastTextSelectionAt < TEXT_SELECTION_RESET_GRACE_MS;
    if (textSelectionActive || textSelectionRecentlyActive) {
      resetRootScrollOnNextApply = false;
      schedule(false);
    } else schedule();
  };
  const handleViewportResize = () => schedule();
  const handleSelectionChange = () => {
    const nativeSelection = doc.getSelection();
    if (nativeSelection && !nativeSelection.isCollapsed && nativeSelection.rangeCount > 0) lastTextSelectionAt = Date.now();
  };

  doc.addEventListener("focusin", scheduleSettled);
  doc.addEventListener("focusout", scheduleSettled);
  doc.addEventListener("selectionchange", handleSelectionChange);
  viewport.addEventListener("resize", handleViewportResize);
  viewport.addEventListener("scroll", handleViewportScroll);
  win.addEventListener("resize", handleViewportResize);
  win.addEventListener("orientationchange", scheduleSettled);
  win.addEventListener("pageshow", scheduleSettled);
  schedule();

  return () => {
    doc.removeEventListener("focusin", scheduleSettled);
    doc.removeEventListener("focusout", scheduleSettled);
    doc.removeEventListener("selectionchange", handleSelectionChange);
    viewport.removeEventListener("resize", handleViewportResize);
    viewport.removeEventListener("scroll", handleViewportScroll);
    win.removeEventListener("resize", handleViewportResize);
    win.removeEventListener("orientationchange", scheduleSettled);
    win.removeEventListener("pageshow", scheduleSettled);
    if (frame) win.cancelAnimationFrame(frame);
    for (const timer of settleTimers) win.clearTimeout(timer);
    doc.documentElement.style.removeProperty(APP_VIEWPORT_HEIGHT);
  };
}
