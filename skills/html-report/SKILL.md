---
name: html-report
description: Create polished long-form reports, research summaries, analyses, and other browser-readable deliverables as a single self-contained UTF-8 HTML file with numbered sections and responsive navigation. Use whenever the user asks for a report or substantial reading material and does not explicitly require another format, or when converting findings into an HTML deliverable for Codex Web.
---

# HTML Report

Deliver one self-contained `.html` file unless the user explicitly requests another format.

## Workflow

1. Read [references/style-guide.md](references/style-guide.md) before designing the report.
2. Start from [assets/report-template.html](assets/report-template.html). Keep its document shell, responsive reading card, anchor IDs, and numbering CSS unless the subject genuinely needs a documented variation. The Codex Web reader derives the outer directory from the body and renders the sanitized body in the same page; do not embed a duplicate desktop/mobile directory in each report.
3. Put final files in the conversation output directory supplied by Codex Web. Keep research notes, charts, and intermediate assets in the job runtime directory.
4. Embed necessary CSS, SVG, charts, and images. Do not depend on JavaScript, CDNs, remote fonts, stylesheets, or remote media. Ordinary citation hyperlinks may remain external. The Codex Web reader may strip active/embed elements before previewing a report.
5. Give every `h2` and `h3` a stable, unique `id`. The template's CSS supplies Chinese section numbers (`一、`, `二、` and `1.1`) automatically; do not type duplicate numbers into heading text. The surrounding Codex Web reader shows an outer directory only when there are at least two `h2` sections, and lists `h2` only.
6. Use semantic headings: exactly one `h1`, then `h2` for major sections and `h3` for subsections. Use `<ol>` for genuinely ordered procedures and `<ul>` for unordered points; do not add artificial numbers to ordinary prose paragraphs.
7. Run `scripts/validate_report.py <report.html>` and fix every reported error before delivery.

## Quality bar

- Declare UTF-8 with `<meta charset="utf-8">` and include a responsive viewport.
- Use semantic headings and exactly one clear `h1`; lead with conclusions and preserve source dates, evidence, and uncertainty.
- Keep the report itself as one restrained reading card. The Codex Web preview/share shell supplies the sticky desktop TOC card, the mobile drawer, the three-line top-bar toggle, compact numbered entries, selected/focus state, and anchor navigation. The report must remain readable with scripts disabled and when downloaded standalone.
- Use a flat, solid-color visual system. Do not use CSS gradients, glassmorphism, glow effects, decorative background art, or oversized hero blocks. Create hierarchy with typography, spacing, restrained borders, and at most a few purposeful solid fills.
- Keep the layout simple, professional, and information-first. Use cards, badges, metric tiles, and multi-column sections only when they make a real comparison or grouping easier to understand.
- Optimize for long-form reading on desktop and mobile. Allow comparison grids only when they clarify genuine relationships, and collapse them to one column on narrow screens.
- Include accessible labels, alt text, units, legends, and textual takeaways for visual evidence.
- Keep the report static and independent after download. Never add a duplicate file toolbar inside the document; Codex Web supplies its own viewer controls.
- The reader shell supplies light/dark/system appearance. Do not hard-code the report to a single system color scheme.
- Mention only the final filename in the reply. Do not create a second Markdown copy unless explicitly requested.
