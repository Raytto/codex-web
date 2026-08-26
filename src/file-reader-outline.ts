export type FileReaderOutlineItem = {
  id: string;
  label: string;
};

export type PreparedHtmlDocument = {
  content: string;
  outline: FileReaderOutlineItem[];
};

/**
 * HTML reports are stitched into the Codex Web document rather than loaded in
 * an iframe. Keep their author CSS inside the reader surface so generic rules
 * such as `main`, `body`, `*`, and `button` cannot restyle the outer shell.
 * The report templates only use ordinary CSS rules and media/supports blocks;
 * this small parser deliberately preserves declarations and keyframe bodies
 * while recursively scoping selector-bearing blocks.
 */
export const HTML_READER_SCOPE = ".file-reader-html .codex-web-reader-body";

const SCOPED_CSS_AT_RULES = new Set(["media", "supports", "layer", "container", "document", "scope", "starting-style", "nest"]);

function collectKeyframeNames(source: string): Map<string, string> {
  const names = new Map<string, string>();
  const pattern = /@(?:-webkit-)?keyframes\s+([-\w]+)/gi;
  for (const match of source.matchAll(pattern)) {
    const original = match[1];
    const key = original.toLowerCase();
    if (!names.has(key)) names.set(key, `codex-web-reader-kf-${names.size}-${original}`);
  }
  return names;
}

function rewriteAnimationDeclarations(source: string, keyframes: Map<string, string>): string {
  if (!keyframes.size) return source;
  return source.replace(/(\banimation(?:-name)?\s*:\s*)([^;{}]+)/gi, (_match, prefix: string, value: string) => {
    const rewritten = value.replace(/[-\w]+/g, (token) => keyframes.get(token.toLowerCase()) ?? token);
    return `${prefix}${rewritten}`;
  });
}

function cssTopLevelToken(source: string, start: number, token: string): number {
  let quote = "";
  let comment = false;
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (comment) {
      if (current === "*" && next === "/") { comment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (current === "\\") index += 1;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "*") { comment = true; index += 1; continue; }
    if (current === "\"" || current === "'") { quote = current; continue; }
    if (current === "(") { parentheses += 1; continue; }
    if (current === ")") { parentheses = Math.max(0, parentheses - 1); continue; }
    if (current === "[") { brackets += 1; continue; }
    if (current === "]") { brackets = Math.max(0, brackets - 1); continue; }
    if (!parentheses && !brackets && current === token) return index;
  }
  return -1;
}

function cssMatchingBrace(source: string, open: number): number {
  let quote = "";
  let comment = false;
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (comment) {
      if (current === "*" && next === "/") { comment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (current === "\\") index += 1;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "*") { comment = true; index += 1; continue; }
    if (current === "\"" || current === "'") { quote = current; continue; }
    if (current === "{") depth += 1;
    else if (current === "}" && --depth === 0) return index;
  }
  return -1;
}

function splitCssSelectors(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let comment = false;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (comment) {
      if (current === "*" && next === "/") { comment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (current === "\\") index += 1;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "*") { comment = true; index += 1; continue; }
    if (current === "\"" || current === "'") { quote = current; continue; }
    if (current === "(") { parentheses += 1; continue; }
    if (current === ")") { parentheses = Math.max(0, parentheses - 1); continue; }
    if (current === "[") { brackets += 1; continue; }
    if (current === "]") { brackets = Math.max(0, brackets - 1); continue; }
    if (current === "," && !parentheses && !brackets) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function selectorStartsWithScope(selector: string, scope: string): boolean {
  return selector === scope
    || selector.startsWith(`${scope} `)
    || selector.startsWith(`${scope}>`)
    || selector.startsWith(`${scope}+`)
    || selector.startsWith(`${scope}~`)
    || selector.startsWith(`${scope}:`)
    || selector.startsWith(`${scope}[`);
}

function scopeCssSelector(selector: string, scope: string): string {
  const leading = selector.match(/^\s*/)?.[0] ?? "";
  const trailing = selector.match(/\s*$/)?.[0] ?? "";
  const trimmed = selector.trim();
  if (!trimmed) return selector;
  if (trimmed === "*") return `${leading}${scope}, ${scope} *${trailing}`;

  let rewritten = trimmed
    .replace(/:root\b/gi, scope)
    .replace(/:host\b/gi, scope)
    .replace(/(^|[\s>+~,(])(?:html|body)(?=$|[\s.#:[>+~\]])/gi, `$1${scope}`);
  while (rewritten.includes(`${scope} ${scope}`)) rewritten = rewritten.replaceAll(`${scope} ${scope}`, scope);
  if (rewritten.startsWith("&")) rewritten = `${scope}${rewritten.slice(1)}`;
  if (!selectorStartsWithScope(rewritten, scope)) rewritten = `${scope} ${rewritten}`;
  return `${leading}${rewritten}${trailing}`;
}

function scopeCssPrelude(prelude: string, scope: string): string {
  const withoutComments = prelude.replace(/\/\*[\s\S]*?\*\//g, "");
  const leading = withoutComments.match(/^\s*/)?.[0] ?? "";
  const trailing = withoutComments.match(/\s*$/)?.[0] ?? "";
  const trimmed = withoutComments.trim();
  if (!trimmed) return prelude;
  const selectors = splitCssSelectors(trimmed).map((selector) => scopeCssSelector(selector, scope));
  return `${leading}${Array.from(new Set(selectors)).join(",")}${trailing}`;
}

/** Scope selector-bearing CSS while preserving declarations and at-rules. */
export function scopeReaderStyles(source: string, scope = HTML_READER_SCOPE): string {
  const keyframes = collectKeyframeNames(source);
  return scopeReaderStylesInternal(source, scope, keyframes);
}

function scopeReaderStylesInternal(source: string, scope: string, keyframes: Map<string, string>): string {
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const open = cssTopLevelToken(source, cursor, "{");
    const semicolon = cssTopLevelToken(source, cursor, ";");
    if (semicolon !== -1 && (open === -1 || semicolon < open)) {
      const statement = source.slice(cursor, semicolon + 1);
      if (!/^\s*@import\b/i.test(statement.replace(/\/\*[\s\S]*?\*\//g, ""))) output += statement;
      cursor = semicolon + 1;
      continue;
    }
    if (open === -1) { output += source.slice(cursor); break; }
    const close = cssMatchingBrace(source, open);
    // A malformed rule cannot be safely scoped. Dropping its tail is safer
    // than accidentally placing a raw `body`/`*` selector in the host page.
    if (close === -1) break;
    const prelude = source.slice(cursor, open);
    const body = source.slice(open + 1, close);
    const normalizedPrelude = prelude.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (/^@/i.test(normalizedPrelude)) {
      const atName = normalizedPrelude.slice(1).match(/^[\w-]+/)?.[0]?.toLowerCase() ?? "";
      if (/^(?:-webkit-)?keyframes$/i.test(atName)) {
        const rewrittenPrelude = prelude.replace(/(@(?:-webkit-)?keyframes\s+)([-\w]+)/i, (_match, prefix: string, name: string) => `${prefix}${keyframes.get(name.toLowerCase()) ?? name}`);
        output += `${rewrittenPrelude}{${body}}`;
      } else {
        output += `${prelude}{${SCOPED_CSS_AT_RULES.has(atName) ? scopeReaderStylesInternal(body, scope, keyframes) : body}}`;
      }
    } else {
      output += `${scopeCssPrelude(prelude, scope)}{${rewriteAnimationDeclarations(body, keyframes)}}`;
    }
    cursor = close + 1;
  }
  return output;
}

function uniqueHeadingId(preferred: string, index: number, used: Set<string>): string {
  const normalized = preferred.trim() || `section-${index + 1}`;
  let candidate = normalized;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${normalized}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function markdownHeadingLabel(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1")
    .trim();
}

function markdownHeadingId(label: string, index: number, used: Set<string>): string {
  const slug = label
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return uniqueHeadingId(slug, index, used);
}

/** Extract document sections from Markdown. H1 is the document title; H2 is the reader outline level. */
export function markdownReaderOutline(source: string): FileReaderOutlineItem[] {
  const outline: FileReaderOutlineItem[] = [];
  const used = new Set<string>();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;

    const atx = line.match(/^\s{0,3}##(?!#)\s+(.+?)\s*#*\s*$/);
    const setext = index + 1 < lines.length && /^\s{0,3}-{2,}\s*$/.test(lines[index + 1])
      ? line.trim()
      : "";
    const label = markdownHeadingLabel(atx?.[1] ?? setext);
    if (!label) continue;
    outline.push({ id: markdownHeadingId(label, outline.length, used), label });
    if (setext) index += 1;
  }
  return outline;
}

/**
 * Prepare an HTML deliverable for the Codex Web reader.
 *
 * Parsing is deliberately performed in the browser with DOMParser. Active
 * content is removed and every author stylesheet is scoped before the final
 * fragment is stitched into the reader DOM. This keeps mobile text selection
 * and scrolling native without allowing generic report CSS to restyle Codex Web.
 */
export function prepareHtmlReaderDocument(source: string, theme: "light" | "dark" = "light"): PreparedHtmlDocument {
  if (typeof DOMParser === "undefined") return { content: source, outline: [] };

  const document = new DOMParser().parseFromString(source, "text/html");
  const used = new Set<string>();
  const outline = Array.from(document.querySelectorAll("h2")).map((heading, index) => {
    const id = uniqueHeadingId(heading.id, index, used);
    heading.id = id;
    return { id, label: heading.textContent?.trim() || `第 ${index + 1} 节` };
  });

  // Older report templates embedded their own desktop and mobile TOCs. The
  // surrounding reader now owns this UI, so remove those duplicate controls.
  document.querySelectorAll("nav.toc, details.toc-mobile, [data-codex-web-toc]").forEach((node) => node.remove());

  // Keep the document static before it enters Codex Web's own DOM. Stylesheet
  // links are removed because their selectors cannot be reliably rewritten;
  // user-facing reports are already required to be self-contained.
  document.querySelectorAll("script, noscript, form, iframe, object, embed, base, link, meta, title").forEach((node) => node.remove());
  document.querySelectorAll<HTMLElement>("*").forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") node.removeAttribute(attribute.name);
    });
  });

  // Reader links must never navigate the Codex Web shell itself.
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (/^javascript:/i.test(href)) { anchor.removeAttribute("href"); return; }
    if (href.startsWith("#")) return;
    anchor.target = "_blank";
    const rel = new Set((anchor.rel || "").split(/\s+/).filter(Boolean));
    rel.add("noopener");
    rel.add("noreferrer");
    anchor.rel = Array.from(rel).join(" ");
  });

  const contentRoot = document.body.querySelector<HTMLElement>("main.report-content, main, article, [data-report-root], .report-shell");
  contentRoot?.classList.add("codex-web-reader-content");
  const contentShell = contentRoot?.closest<HTMLElement>(".report-shell");
  contentShell?.classList.add("codex-web-reader-shell");

  const authorStyles = Array.from(document.querySelectorAll("style"), (style) => scopeReaderStyles(style.textContent ?? ""));
  document.querySelectorAll("style").forEach((style) => style.remove());

  const contentSelectors = `${HTML_READER_SCOPE} .codex-web-reader-content,
    ${HTML_READER_SCOPE} .codex-web-reader-shell,
    ${HTML_READER_SCOPE} > main:first-of-type,
    ${HTML_READER_SCOPE} > article:first-of-type,
    ${HTML_READER_SCOPE} > .report-shell`;
  const contentPaddingSelectors = `${HTML_READER_SCOPE} .codex-web-reader-content,
    ${HTML_READER_SCOPE} .codex-web-reader-shell > main:first-of-type,
    ${HTML_READER_SCOPE} > main:first-of-type,
    ${HTML_READER_SCOPE} > article:first-of-type`;
  const viewerStyles = `
    ${HTML_READER_SCOPE} { display:flow-root !important; position:static !important; box-sizing:border-box !important; width:100% !important; height:auto !important; max-height:none !important; min-width:0 !important; min-height:100% !important; margin:0 !important; padding:0 !important; overflow:visible !important; inset:auto !important; isolation:isolate; color-scheme:${theme}; }
    ${theme === "dark" ? `${HTML_READER_SCOPE} { --canvas:#17181b; --paper:#222327; --surface:#292a2f; --text:#ececf1; --ink:#ececf1; --ink-soft:#b7b8bf; --muted:#9a9ca5; --line:#3b3d45; --accent:#b9c3ff; --indigo:#b9c3ff; --tint:#303342; --indigo-pale:#303342; }` : ""}
    ${contentSelectors} { display:block !important; box-sizing:border-box !important; width:min(100% - 32px, 820px) !important; max-width:820px !important; margin:0 auto 24px !important; }
    @media (max-width:852px) {
      ${contentSelectors} { width:100% !important; max-width:none !important; min-height:100% !important; margin:0 !important; border-right:0 !important; border-bottom:0 !important; border-left:0 !important; border-radius:0 !important; box-shadow:none !important; }
      ${contentPaddingSelectors} { padding-top:24px !important; }
    }
  `;

  return {
    content: `${authorStyles.map((style) => `<style data-codex-web-author>${style}</style>`).join("")}<style data-codex-web-reader>${viewerStyles}</style><div class="codex-web-reader-body">${document.body.innerHTML}</div>`,
    outline,
  };
}
