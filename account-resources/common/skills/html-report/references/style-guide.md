# Codex Web HTML report style guide

## Document contract

- Produce one complete HTML5 document encoded as UTF-8.
- Include `<meta charset="utf-8">` near the start of `<head>` and `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- Keep CSS inline in a `<style>` element. Embed images as data URIs or inline SVG. External `http(s)` links are allowed only as user-activated citations or references.
- Avoid scripts, forms, iframes, objects, and embeds. The Codex Web reader strips those active elements and inline event handlers, then renders the remaining static HTML in its own page DOM.
- Keep the finished file below 5 MiB when browser reading is expected; larger files are download-only.

## Reading layout

- Use `Inter, "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif`.
- Use about 16px body text on desktop, 15px on mobile, and line-height around 1.75.
- Use one centered long-form reading surface near 820px. The Codex Web preview/share shell adds the two-column desktop layout and its wider (270px) sticky TOC card, plus the mobile drawer and top-bar three-line toggle.
- Baseline light palette: canvas `#fafbff`, surface `#ffffff`, text `#242630`, indigo `#354381`, pale indigo `#eef0f8`, border `#dfe2ec`.
- Provide `prefers-color-scheme: dark` and `@media print` rules.
- Use a distinct `h1`, underlined `h2`, restrained `h3`, left-bar blockquotes, dark code blocks, tinted table headers, and horizontally scrollable wide tables.
- Use only solid color fills. Do not use linear, radial, conic, or repeating gradients; glass/translucent showcase panels; glow effects; decorative background shapes; or large ornamental hero sections.
- Prefer a plain reading surface, restrained borders, modest corner radii, and little or no shadow. Let type scale, weight, spacing, and a small number of solid accent fills carry the hierarchy.

## Numbering and navigation contract

- Keep exactly one `h1`. Give each `h2` and `h3` a stable ASCII `id`; the Codex Web outer reader derives its single-level TOC from `h2` and same-document navigation links.
- Let the template CSS generate section labels: `h2` uses Chinese ideographic counters (`一、`, `二、`), while `h3` uses decimal nesting (`1.1`, `1.2`). Do not hard-code those labels into heading text, so reordering sections cannot leave stale numbers.
- Use heading levels for structure, not visual size. A paragraph is not a heading; use `<ol>` only when the content is an ordered sequence.
- Keep h2 labels short enough for a 270px outer rail. Do not add a report-local TOC; this avoids duplicated controls in previews and shared pages.

## Information design

- Start with the answer, executive conclusion, or decision-relevant summary.
- Make key claims explicit in text. A reader should not need to decode color, decoration, or a dashboard arrangement to find the conclusion.
- Use a table for exact mappings and repeated comparisons; a flow/timeline for sequence; a tree for hierarchy. Skip decorative dashboards.
- Avoid turning ordinary paragraphs into cards. Use a bordered or tinted group only when the boundary itself conveys meaning, such as a conclusion, warning, comparison, or grouped evidence.
- When two views materially benefit from side-by-side comparison, use a responsive grid on wide screens and stack it below about 760px.
- Every chart needs a title, direct labels or legend, units where relevant, and a prose conclusion. Prefer static inline SVG or locally generated raster images.
- Preserve evidence boundaries: distinguish confirmed facts, source-backed inference, assumptions, and unresolved questions.

## Codex Web viewer boundary

The surrounding viewer already supplies the filename, back, download, and preview controls. Do not repeat them inside the report. Keep one clear document title in the report itself.
