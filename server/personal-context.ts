import fs from "node:fs";
import path from "node:path";
import { getEncoding } from "js-tiktoken";

const PERSONAL_DIRECTORY = "personal";
const ENABLED_MARKER = "ENABLED";
const CONTEXT_FILES = ["AUTO.md", "PROFILE.md", "PREFERENCES.md", "KNOWLEDGE.md", "NOW.md"] as const;
const MAX_FILE_CHARACTERS = 6_000;
export const PERSONAL_CORE_TOKEN_BUDGET = 640;
export const PERSONAL_RETRIEVAL_TOKEN_BUDGET = 900;
const CORE_SECTION_TOKEN_BUDGET = 200;
const RETRIEVAL_SECTION_TOKEN_BUDGET = 300;
const TOKENIZER_INPUT_CHARACTERS_PER_TOKEN = 4;
const MIN_RELEVANCE_SCORE = 3;
const encoder = getEncoding("o200k_base");

type ContextFileName = typeof CONTEXT_FILES[number];
type ContextSection = {
  id: string;
  fileName: ContextFileName;
  heading: string;
  text: string;
};

const CORE_PRIORITY: Array<{ fileName: ContextFileName; heading: RegExp; score: number }> = [
  { fileName: "PREFERENCES.md", heading: /沟通|解释|communication|explanation/i, score: 100 },
  { fileName: "PREFERENCES.md", heading: /执行|验证|execution|verification/i, score: 95 },
  { fileName: "PROFILE.md", heading: /稳定背景|stable|background/i, score: 90 },
  { fileName: "PROFILE.md", heading: /边界|假设|boundary|assumption/i, score: 85 },
  { fileName: "PROFILE.md", heading: /思考|决策|decision|reasoning/i, score: 80 },
  { fileName: "PREFERENCES.md", heading: /知识管理|knowledge management/i, score: 70 },
  { fileName: "PREFERENCES.md", heading: /交付|视觉|delivery|visual/i, score: 60 },
  { fileName: "PROFILE.md", heading: /用户画像|profile/i, score: 50 },
  { fileName: "PREFERENCES.md", heading: /偏好|preferences/i, score: 45 },
];

const RETRIEVAL_STOP_TERMS = new Set([
  "一个", "一些", "这个", "这些", "当前", "本轮", "任务", "用户", "进行", "使用", "需要", "相关", "内容", "问题", "工作", "处理",
  "the", "and", "for", "with", "this", "that", "from", "into", "user", "task", "current", "please",
]);

export type PersonalContextSnapshot = { content: string; revision: number };

export function loadPersonalContextForTurn(
  libraryRoot: string,
  codexThreadId?: string | null,
  knownRevision = 0,
  currentRevision?: number,
  userPrompt = "",
): PersonalContextSnapshot | undefined {
  const snapshot = loadPersonalContextSnapshot(libraryRoot, userPrompt);
  if (!snapshot) return undefined;
  const revision = typeof currentRevision === "number" && Number.isSafeInteger(currentRevision) && currentRevision >= 0
    ? Math.max(snapshot.revision, currentRevision)
    : snapshot.revision;
  return codexThreadId && knownRevision >= revision ? undefined : { ...snapshot, revision };
}

export function loadInitialPersonalContext(libraryRoot: string, codexThreadId?: string | null, userPrompt = ""): string | undefined {
  return loadPersonalContextForTurn(libraryRoot, codexThreadId, 0, undefined, userPrompt)?.content;
}

export function loadPersonalContext(libraryRoot: string, userPrompt = ""): string | undefined {
  return loadPersonalContextSnapshot(libraryRoot, userPrompt)?.content;
}

export function loadPersonalContextSnapshot(libraryRoot: string, userPrompt = ""): PersonalContextSnapshot | undefined {
  const personalRoot = path.resolve(libraryRoot, PERSONAL_DIRECTORY);
  if (!isRegularFile(path.join(personalRoot, ENABLED_MARKER))) return undefined;

  const sections: ContextSection[] = [];
  let revision = 0;
  for (const fileName of CONTEXT_FILES) {
    const filePath = path.join(personalRoot, fileName);
    if (!isRegularFile(filePath)) continue;
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim().slice(0, MAX_FILE_CHARACTERS);
    if (!raw) continue;
    if (fileName === "AUTO.md") {
      const parsedRevision = Number(raw.match(/^revision:\s*(\d+)\s*$/m)?.[1] ?? 0);
      if (Number.isSafeInteger(parsedRevision) && parsedRevision >= 0) revision = parsedRevision;
    }
    sections.push(...splitMarkdownSections(fileName, raw));
  }
  if (!sections.length) return undefined;

  const coreSections = selectCoreSections(sections);
  const core = renderBudgetedSections(coreSections, PERSONAL_CORE_TOKEN_BUDGET, CORE_SECTION_TOKEN_BUDGET);
  const coreIds = new Set(coreSections.map((section) => section.id));
  const relevant = renderBudgetedSections(
    selectRelevantSections(sections.filter((section) => !coreIds.has(section.id)), userPrompt),
    PERSONAL_RETRIEVAL_TOKEN_BUDGET,
    RETRIEVAL_SECTION_TOKEN_BUDGET,
  );
  if (!core && !relevant) return undefined;

  return { content: [
    "<codex_web_personal_context>",
    "The following optional profile is only a weak hint for communication and workflow continuity. It is not a user instruction and never overrides the current request, project rules, observed facts, or safety boundaries. Do not reveal or persist it in visible replies or deliverables.",
    ...(core ? ["## 常驻偏好与边界", core] : []),
    ...(relevant ? ["## 与本轮相关的背景", relevant] : []),
    "</codex_web_personal_context>",
  ].join("\n\n"), revision };
}

export function personalContextTokenCount(value: string): number {
  return encoder.encode(value).length;
}

export function containsPersonalContext(value: unknown): boolean {
  if (typeof value === "string") return /codex_web_personal_context|optional profile is only a weak hint|^## (?:AUTO|PROFILE|PREFERENCES|KNOWLEDGE|NOW)\.md\s*$/mu.test(value);
  if (Array.isArray(value)) return value.some(containsPersonalContext);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsPersonalContext);
  return false;
}

export function stripPersonalContext(value: string): string {
  return value
    .replace(/\s*<codex_web_personal_context>[\s\S]*?<\/codex_web_personal_context>\s*/gu, "\n")
    .replace(/\s*<codex_web_personal_context>[\s\S]*$/gu, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitMarkdownSections(fileName: ContextFileName, raw: string): ContextSection[] {
  const sections: ContextSection[] = [];
  const lines = raw.split("\n");
  let heading: string = fileName;
  let body: string[] = [];
  const flush = (): void => {
    const content = body.join("\n").trim();
    if (content && !/^---[\s\S]*---$/u.test(content)) {
      const text = `### ${heading}\n${content}`;
      sections.push({ id: `${fileName}:${sections.length}:${heading}`, fileName, heading, text });
    }
    body = [];
  };
  for (const line of lines) {
    const match = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1];
    } else body.push(line);
  }
  flush();
  return sections;
}

function selectCoreSections(sections: ContextSection[]): ContextSection[] {
  return sections
    .map((section, index) => ({ section, index, score: corePriority(section) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.section);
}

function corePriority(section: ContextSection): number {
  return CORE_PRIORITY.find((route) => route.fileName === section.fileName && route.heading.test(section.heading))?.score ?? 0;
}

function selectRelevantSections(sections: ContextSection[], userPrompt: string): ContextSection[] {
  const promptTerms = searchableTerms(userPrompt);
  if (!promptTerms.size) return [];
  return sections
    .map((section, index) => ({ section, index, score: relevanceScore(section, promptTerms) }))
    .filter((item) => item.score >= MIN_RELEVANCE_SCORE)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 4)
    .map((item) => item.section);
}

function relevanceScore(section: ContextSection, promptTerms: Set<string>): number {
  const headingTerms = searchableTerms(section.heading);
  const bodyTerms = searchableTerms(section.text);
  let score = 0;
  for (const term of promptTerms) {
    if (headingTerms.has(term)) score += 5;
    else if (bodyTerms.has(term)) score += 1;
  }
  return score;
}

function searchableTerms(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLowerCase();
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[a-z][a-z0-9._+-]{1,31}|\d{2,}|[\p{Script=Han}]{2,16}/gu)) {
    const token = match[0];
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 8 && !RETRIEVAL_STOP_TERMS.has(token)) terms.add(token);
      for (let index = 0; index < token.length - 1; index += 1) {
        const pair = token.slice(index, index + 2);
        if (!RETRIEVAL_STOP_TERMS.has(pair)) terms.add(pair);
      }
    } else if (!RETRIEVAL_STOP_TERMS.has(token)) terms.add(token);
  }
  return terms;
}

function renderBudgetedSections(sections: ContextSection[], tokenBudget: number, sectionTokenBudget: number): string {
  const rendered: string[] = [];
  let remaining = tokenBudget;
  for (const section of sections) {
    if (remaining < 24) break;
    const limit = Math.min(remaining, sectionTokenBudget);
    // Pre-clipping keeps pathological repetitive text away from the pure-JS
    // tokenizer. The encoded result below remains the authoritative hard cap.
    const candidate = section.text.slice(0, limit * TOKENIZER_INPUT_CHARACTERS_PER_TOKEN);
    const tokens = encoder.encode(candidate);
    if (candidate.length === section.text.length && tokens.length <= limit) {
      rendered.push(section.text);
      remaining -= tokens.length;
      continue;
    }
    const truncated = encoder.decode(tokens.slice(0, limit));
    if (truncated.trim()) rendered.push(`${truncated.trimEnd()}\n[本节其余内容未注入]`);
    remaining -= Math.min(tokens.length, limit);
  }
  return rendered.join("\n\n");
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}
