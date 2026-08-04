import { useEffect, useMemo, useState } from "react";

export type PreparedMarkdownMath = {
  content: string;
  hasMath: boolean;
};

export type MarkdownMathPlugins = {
  remarkMath: typeof import("remark-math")["default"];
  rehypeKatex: typeof import("rehype-katex")["default"];
};

type AsyncMarkdownMath = {
  content: string;
  plugins: MarkdownMathPlugins | null;
  loading: boolean;
  failed: boolean;
};

let markdownMathPluginsPromise: Promise<MarkdownMathPlugins> | null = null;

const FENCE_START = /^ {0,3}(`{3,}|~{3,})/;

function backtickRun(value: string, start: number): number {
  let end = start;
  while (value[end] === "`") end += 1;
  return end - start;
}

export function prepareMarkdownMath(markdown: string): PreparedMarkdownMath {
  let fence: { marker: string; length: number } | null = null;
  let inlineCodeTicks = 0;
  let hasMath = false;
  const mathCandidate: string[] = [];
  const output = markdown.split(/(?<=\n)/).map((line) => {
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*(?:\r?\n)?$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = null;
      return line;
    }

    if (!inlineCodeTicks) {
      const opening = line.match(FENCE_START);
      if (opening) {
        fence = { marker: opening[1][0], length: opening[1].length };
        return line;
      }
    }

    let transformed = "";
    for (let index = 0; index < line.length;) {
      if (line[index] === "`") {
        const ticks = backtickRun(line, index);
        if (!inlineCodeTicks) inlineCodeTicks = ticks;
        else if (ticks === inlineCodeTicks) inlineCodeTicks = 0;
        transformed += line.slice(index, index + ticks);
        index += ticks;
        continue;
      }

      const next = line[index + 1];
      if (!inlineCodeTicks && line[index] === "\\" && line[index - 1] !== "\\" && (next === "[" || next === "]" || next === "(" || next === ")")) {
        const delimiter = next === "[" || next === "]" ? "$$" : "$";
        transformed += delimiter;
        mathCandidate.push(delimiter);
        hasMath = true;
        index += 2;
        continue;
      }

      transformed += line[index];
      if (!inlineCodeTicks) mathCandidate.push(line[index]);
      index += 1;
    }
    return transformed;
  }).join("");

  if (!hasMath) {
    const candidate = mathCandidate.join("");
    hasMath = /(^|[^\\$])\$\$(?!\$)[\s\S]+?\$\$(?!\$)/.test(candidate)
      || /(^|[^\\$])\$(?![\s$])(?:\\.|[^\\$\n])+(?<!\s)\$(?!\$)/.test(candidate);
  }

  return { content: output, hasMath };
}

function loadMarkdownMathPlugins(): Promise<MarkdownMathPlugins> {
  if (!markdownMathPluginsPromise) {
    markdownMathPluginsPromise = Promise.all([
      import("remark-math"),
      import("rehype-katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([remarkModule, rehypeModule]) => ({
      remarkMath: remarkModule.default,
      rehypeKatex: rehypeModule.default,
    })).catch((error) => {
      markdownMathPluginsPromise = null;
      throw error;
    });
  }
  return markdownMathPluginsPromise;
}

/** Keep the original Markdown visible, then replace it after the optional math bundle loads. */
export function useAsyncMarkdownMath(markdown: string): AsyncMarkdownMath {
  const prepared = useMemo(() => prepareMarkdownMath(markdown), [markdown]);
  const [plugins, setPlugins] = useState<MarkdownMathPlugins | null>(null);
  const [failedMarkdown, setFailedMarkdown] = useState<string | null>(null);
  const failed = prepared.hasMath && failedMarkdown === markdown;

  useEffect(() => {
    if (!prepared.hasMath || plugins || failed) return;
    let active = true;
    void loadMarkdownMathPlugins().then((loaded) => {
      if (active) setPlugins(loaded);
    }).catch(() => {
      if (active) setFailedMarkdown(markdown);
    });
    return () => { active = false; };
  }, [failed, markdown, plugins, prepared.hasMath]);

  return {
    content: plugins && prepared.hasMath ? prepared.content : markdown,
    plugins,
    loading: prepared.hasMath && !plugins && !failed,
    failed,
  };
}
