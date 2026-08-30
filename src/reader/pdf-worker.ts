import { ensurePdfJsCompatibility } from "./pdf-compat";

// Run before loading PDF.js itself. The dynamic import is intentionally
// started only after this synchronous bridge; Vite's worker bundle is emitted
// in an IIFE format where top-level await is not available.
ensurePdfJsCompatibility();
void import("pdfjs-dist/legacy/build/pdf.worker.mjs");
