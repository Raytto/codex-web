const APP_VIEWPORT_HEIGHT = "--app-viewport-height";
// Safari toolbar changes are much smaller than a software keyboard transition.
const KEYBOARD_HEIGHT_DELTA = 120;
// WebKit can publish the final visual viewport only after the keyboard animation.
const SETTLE_DELAYS_MS = [80, 240, 500] as const;

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
  const settleTimers = new Set<number>();

  const resetRootScroll = () => {
    win.scrollTo(0, 0);
    doc.documentElement.scrollTop = 0;
    doc.body.scrollTop = 0;
  };

  const apply = () => {
    frame = 0;
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
    if (next.resetRootScroll) resetRootScroll();
  };

  const schedule = () => {
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

  doc.addEventListener("focusin", scheduleSettled);
  doc.addEventListener("focusout", scheduleSettled);
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  win.addEventListener("resize", schedule);
  win.addEventListener("orientationchange", scheduleSettled);
  win.addEventListener("pageshow", scheduleSettled);
  schedule();

  return () => {
    doc.removeEventListener("focusin", scheduleSettled);
    doc.removeEventListener("focusout", scheduleSettled);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    win.removeEventListener("resize", schedule);
    win.removeEventListener("orientationchange", scheduleSettled);
    win.removeEventListener("pageshow", scheduleSettled);
    if (frame) win.cancelAnimationFrame(frame);
    for (const timer of settleTimers) win.clearTimeout(timer);
    doc.documentElement.style.removeProperty(APP_VIEWPORT_HEIGHT);
  };
}
