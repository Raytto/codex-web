export type ParsedCodexFileMentionRequest = {
  content: string;
  fileNames: string[];
};

const FILES_HEADING = "# Files mentioned by the user:";
const REQUEST_HEADING = "## My request for Codex:";
const FILE_MENTION = /^#{2,6}[ \t]+([^:\r\n]+):[ \t]+([^\r\n]+)$/;

function safeFileName(value: string): string | null {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  const name = normalized.split(/[\\/]/).at(-1)?.trim() ?? "";
  return name && name.length <= 255 ? name : null;
}

export function parseCodexFileMentionRequest(value: string): ParsedCodexFileMentionRequest | null {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const lines = normalized.split("\n");
  if (lines[0] !== FILES_HEADING) return null;
  const markerIndexes = lines.flatMap((line, index) => line === REQUEST_HEADING ? [index] : []);
  if (markerIndexes.length !== 1 || markerIndexes[0] <= 1) return null;

  const fileNames: string[] = [];
  for (const line of lines.slice(1, markerIndexes[0]).filter((item) => item.trim())) {
    const match = FILE_MENTION.exec(line.trim());
    if (!match || !match[2].trim()) return null;
    const fileName = safeFileName(match[1]);
    if (!fileName) return null;
    if (!fileNames.includes(fileName)) fileNames.push(fileName);
    if (fileNames.length > 100) return null;
  }

  const content = lines.slice(markerIndexes[0] + 1).join("\n").trim();
  return fileNames.length > 0 ? { content, fileNames } : null;
}
