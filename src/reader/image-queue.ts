/** Start images in document order after the text has had a chance to paint. */
export function loadReaderImages(root: HTMLElement, timeoutMs = 15_000): () => void {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img[data-reader-src], img[data-reader-srcset]"));
  let stopped = false;
  let cancelCurrent: (() => void) | undefined;
  let timer: number | undefined;
  const frame = window.requestAnimationFrame(() => {
    timer = window.setTimeout(() => { void run(); }, 0);
  });

  async function run() {
    for (const image of images) {
      if (stopped) break;
      if (image.dataset.readerImageState === "loaded") continue;
      await new Promise<void>((resolve) => {
        const sources = image.parentElement?.tagName === "PICTURE"
          ? Array.from(image.parentElement.querySelectorAll<HTMLSourceElement>("source[data-reader-srcset]")) : [];
        const clearSources = () => {
          image.removeAttribute("src"); image.removeAttribute("srcset");
          sources.forEach((source) => source.removeAttribute("srcset"));
        };
        let timeout: number;
        const finish = (state: "loaded" | "error" | "queued") => {
          window.clearTimeout(timeout);
          image.removeEventListener("load", loaded);
          image.removeEventListener("error", failed);
          image.dataset.readerImageState = state;
          if (state !== "loaded") clearSources();
          cancelCurrent = undefined;
          resolve();
        };
        const loaded = () => finish("loaded");
        const failed = () => finish("error");
        cancelCurrent = () => finish("queued");
        image.addEventListener("load", loaded);
        image.addEventListener("error", failed);
        timeout = window.setTimeout(failed, timeoutMs);
        image.dataset.readerImageState = "loading";
        image.loading = "eager"; // Native lazy loading would stall the queue below the fold.
        image.decoding = "async";
        sources.forEach((source) => { source.srcset = source.dataset.readerSrcset!; });
        if (image.dataset.readerSrcset) image.srcset = image.dataset.readerSrcset;
        if (image.dataset.readerSrc) image.src = image.dataset.readerSrc;
      });
    }
  }
  return () => {
    stopped = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    cancelCurrent?.();
  };
}
