import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { callWaitDynamicTool, WAIT_DYNAMIC_TOOL_SPEC, type WaitToolConfig } from "./wait-dynamic-tool.js";
import { callNodeTransferTool, NODE_TRANSFER_TOOL_SPEC } from "./node-transfer-tool.js";

type JsonObject = Record<string, unknown>;
export type PlatformMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: unknown): Promise<string>;
};
export type PlatformAutomationConfig = WaitToolConfig;

/** Per-run credentials arrive only in the environment; never in MCP config. */
export function platformAutomationConfig(env: NodeJS.ProcessEnv = process.env): PlatformAutomationConfig | null {
  const baseUrl = env.CODEX_WEB_AUTOMATION_BASE_URL;
  const token = env.CODEX_WEB_AUTOMATION_TOKEN;
  const jobId = env.CODEX_WEB_AUTOMATION_JOB_ID;
  const receiptDirectory = env.CODEX_WEB_AUTOMATION_RECEIPT_DIR || env.CWW_JOB_RUNTIME;
  if (!baseUrl || !token || !jobId || !receiptDirectory) return null;
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Codex Web automation endpoint is invalid");
  return { baseUrl, token, jobId, receiptDirectory };
}

export function workerPlatformTools(config: PlatformAutomationConfig | null): PlatformMcpTool[] {
  return config ? [
    { ...WAIT_DYNAMIC_TOOL_SPEC, call: (args) => callWaitDynamicTool(config, args) },
    { ...NODE_TRANSFER_TOOL_SPEC, call: (args) => callNodeTransferTool(config, args) },
  ] : [];
}

export function createPlatformMcpHandler(tools: PlatformMcpTool[]): (message: unknown) => Promise<unknown | null> {
  const registered = new Map(tools.map((tool) => [tool.name, tool]));
  return async (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    const request = message as JsonObject;
    if (request.id === undefined) return null; // initialized/cancelled notifications
    const id = request.id;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const error = (code: number, value: string) => ({ jsonrpc: "2.0", id, error: { code, message: value } });
    if (request.jsonrpc !== "2.0" || !["string", "number"].includes(typeof id)) return error(-32600, "Invalid request");
    if (request.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "codex-web-platform", version: "1.0.0" } });
    if (request.method === "ping") return reply({});
    if (request.method === "tools/list") return reply({ tools: [...registered.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (request.method !== "tools/call") return error(-32601, "Method not found");
    const params = request.params && typeof request.params === "object" ? request.params as JsonObject : {};
    const tool = typeof params.name === "string" ? registered.get(params.name) : null;
    if (!tool) return error(-32602, "Tool is not available for this run");
    try {
      const result = await tool.call(params.arguments ?? {});
      return reply({ content: [{ type: "text", text: result }], isError: false });
    } catch (cause) {
      return reply({ content: [{ type: "text", text: cause instanceof Error ? cause.message : "Codex Web tool failed" }], isError: true });
    }
  };
}

export function runPlatformMcpServer(tools: PlatformMcpTool[]): void {
  const handle = createPlatformMcpHandler(tools);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
  lines.on("line", (line) => {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) { write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }); return; }
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    void handle(message).then((result) => { if (result !== null) write(result); }, () => write({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPlatformMcpServer(workerPlatformTools(platformAutomationConfig()));
}
