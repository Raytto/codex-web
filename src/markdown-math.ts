export type PreparedMarkdownMath = {
  content: string;
  hasMath: boolean;
};

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
