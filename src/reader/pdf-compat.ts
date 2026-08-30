/**
 * PDF.js 6's generic build assumes the ES2025 Iterator global exists. Safari
 * versions that do not expose that constructor fail before a document can be
 * opened. The legacy build ships the remaining compatibility shims, while
 * this tiny bridge supplies the shared native iterator prototype it extends.
 */
export function ensurePdfJsCompatibility(): void {
  const globals = globalThis as typeof globalThis & {
    Iterator?: { prototype: object };
  };
  if (typeof globals.Iterator !== "function") {
    const sample = [][Symbol.iterator]();
    const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(sample));
    const IteratorPolyfill = function Iterator() {};
    IteratorPolyfill.prototype = iteratorPrototype;
    Object.defineProperty(globals, "Iterator", {
      configurable: true,
      writable: true,
      value: IteratorPolyfill,
    });
  }
}

/**
 * WebKit can accept the OpenType fonts that PDF.js synthesizes from an
 * embedded PDF font without throwing, but still paint no glyphs when the
 * source font has an unusual CID/name table.  That is particularly visible
 * on iOS: the canvas, lines and images render while every text operator is
 * blank.  PDF.js's path renderer is slower, but it does not depend on the
 * browser's font parser and is reliable across Safari, WKWebView, and the
 * other iOS browsers (which all use WebKit).
 *
 * Keep the decision pure/argument-driven so it can be regression-tested
 * without manufacturing a browser `navigator` in Node.
 */
export function shouldDisablePdfFontFace(
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "",
  platform = typeof navigator !== "undefined" ? navigator.platform : "",
  maxTouchPoints = typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0,
): boolean {
  const ua = userAgent || "";
  const isIos = /iPad|iPhone|iPod/i.test(ua)
    || (platform === "MacIntel" && maxTouchPoints > 1);
  if (isIos) return true;

  // Desktop Safari and embedded WebKit views expose AppleWebKit but do not
  // carry a Chromium/Firefox engine token.  Android Chrome is also branded
  // AppleWebKit, so leave that Blink path on the normal, faster font mode.
  return /AppleWebKit/i.test(ua)
    && !/(?:Chrome|Chromium|Edg|OPR|SamsungBrowser|Firefox)/i.test(ua);
}
