export type CitationFile = {
  original_name: string;
  relative_path: string;
};

const FILE_CITATION_PATTERN = /:codex-file-citation\{([\s\S]*?)\}/gi;
const ATTRIBUTE_PATTERN = /([a-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/gi;

const ARTIFACT_LABELS: Record<string, string> = {
  presentation: "演示文稿",
  spreadsheet: "电子表格",
  document: "文档",
  pdf: "PDF",
  image: "图片",
};

function citationAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function normalizeCitationPath(value: string): string {
  let normalized = value.trim().replace(/\\/g, "/");
  try { normalized = decodeURIComponent(normalized); } catch { /* Keep malformed paths opaque. */ }
  return normalized.replace(/\/{2,}/g, "/").toLocaleLowerCase();
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]{}<>])/g, "\\$1");
}

function citedFile(path: string, files: readonly CitationFile[]): CitationFile | undefined {
  if (!path) return undefined;
  const normalizedPath = normalizeCitationPath(path);
  return files.find((file) => {
    const relativePath = normalizeCitationPath(file.relative_path);
    return Boolean(relativePath) && (normalizedPath === relativePath || normalizedPath.endsWith(`/${relativePath}`));
  });
}

function citationLocation(attributes: Record<string, string>): string {
  const slide = attributes.slide_number;
  if (slide && /^\d{1,6}$/.test(slide)) return `，第 ${Number(slide)} 页`;
  const page = attributes.page_number;
  if (page && /^\d{1,6}$/.test(page)) return `，第 ${Number(page)} 页`;
  const line = attributes.line_number ?? attributes.line_start;
  if (line && /^\d{1,9}$/.test(line)) return `，第 ${Number(line)} 行`;
  return "";
}

/** Convert private Codex file citations into safe, user-readable Markdown. */
export function sanitizeAgentMarkdown(value: string, files: readonly CitationFile[] = []): string {
  return value.replace(FILE_CITATION_PATTERN, (_full, rawAttributes: string) => {
    const attributes = citationAttributes(rawAttributes);
    const file = citedFile(attributes.path ?? "", files);
    const source = file?.original_name
      ?? ARTIFACT_LABELS[(attributes.artifact_kind ?? "").toLowerCase()]
      ?? "文件";
    return `（引用：${escapeMarkdownText(source)}${citationLocation(attributes)}）`;
  });
}
