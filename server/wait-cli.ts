#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;
type Receipt = { version: 1; wakePlanId: string; eventUrl: string; eventToken: string; deadlineAt: string };

const [command = "--help", ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (["--help", "-h", "help"].includes(command)) return printHelp();
  if (command === "after") return armAfter();
  if (command === "event") return armEvent();
  if (command === "signal") return signalEvent();
  if (command === "cancel") return cancelWait();
  throw new Error(`Unknown command: ${command}. Use --help for usage.`);
}

async function armAfter(): Promise<void> {
  const seconds = requiredPositiveInteger("seconds");
  const prompt = requiredText("prompt", "prompt-file");
  safePrint(await agentRequest("POST", "/wake-plans", {
    mode: "time", delaySeconds: seconds,
    label: optional("label") || `Continue after ${formatDuration(seconds)}`,
    successPrompt: prompt,
  }));
}

async function armEvent(): Promise<void> {
  const seconds = requiredPositiveInteger("deadline-seconds");
  const receiptPath = required("receipt");
  const response = await agentRequest("POST", "/wake-plans", {
    mode: "event_or_deadline", delaySeconds: seconds,
    label: optional("label") || `Wait for an event, at most ${formatDuration(seconds)}`,
    runId: optional("run-id") || null,
    successPrompt: requiredText("success-prompt", "success-prompt-file"),
    failurePrompt: requiredText("failure-prompt", "failure-prompt-file"),
    timeoutPrompt: requiredText("timeout-prompt", "timeout-prompt-file"),
  }) as JsonObject;
  const wakePlan = response.wakePlan as JsonObject | undefined;
  const signal = response.signal as JsonObject | undefined;
  if (typeof wakePlan?.id !== "string" || typeof wakePlan.deadline_at !== "string"
    || typeof signal?.url !== "string" || typeof signal.token !== "string") throw new Error("Codex Web returned incomplete event credentials");
  writeReceipt(receiptPath, { version: 1, wakePlanId: wakePlan.id, eventUrl: signal.url, eventToken: signal.token, deadlineAt: wakePlan.deadline_at });
  safePrint({ wakePlan, receipt: path.resolve(receiptPath), signalCredentialStored: true });
}

async function signalEvent(): Promise<void> {
  const receipt = readReceipt(required("receipt"));
  const status = required("status");
  if (!["success", "failure", "heartbeat"].includes(status)) throw new Error("status must be success, failure, or heartbeat");
  const eventId = optional("event-id") || crypto.randomUUID();
  const deadline = Date.now() + Math.max(0, numberOption("retry-seconds", 60)) * 1000;
  let delay = 1_000;
  for (;;) {
    try {
      const response = await jsonRequest(receipt.eventUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${receipt.eventToken}`, "content-type": "application/json" },
        body: JSON.stringify({ eventId, kind: status, summary: textOption("summary", "summary-file") }),
      });
      safePrint({ ...response, wakePlanId: receipt.wakePlanId, eventId });
      return;
    } catch (error) {
      if (Date.now() >= deadline || (error instanceof HttpError && error.status < 500 && error.status !== 429)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
      delay = Math.min(30_000, delay * 2);
    }
  }
}

async function cancelWait(): Promise<void> {
  safePrint(await agentRequest("POST", `/wake-plans/${encodeURIComponent(required("id"))}/cancel`, {}));
}

async function agentRequest(method: string, suffix: string, body: JsonObject): Promise<JsonObject> {
  const baseUrl = requiredEnvironment("CODEX_WEB_AUTOMATION_BASE_URL").replace(/\/$/, "");
  const token = requiredEnvironment("CODEX_WEB_AUTOMATION_TOKEN");
  const jobId = requiredEnvironment("CODEX_WEB_AUTOMATION_JOB_ID");
  return jsonRequest(`${baseUrl}/api/automation/jobs/${encodeURIComponent(jobId)}${suffix}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function jsonRequest(url: string, init: RequestInit): Promise<JsonObject> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
  catch (error) { throw new Error(`Cannot connect to Codex Web: ${error instanceof Error ? error.message : String(error)}`); }
  const text = await response.text();
  let body: JsonObject = {};
  try { body = text ? JSON.parse(text) as JsonObject : {}; } catch { body = {}; }
  if (!response.ok) throw new HttpError(response.status, typeof body.error === "string" ? body.error : `Codex Web request failed (${response.status})`);
  return body;
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function parseArgs(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) throw new Error(`Unrecognized argument: ${item}`);
    const [rawName, inline] = item.slice(2).split("=", 2);
    const value = inline ?? values[++index];
    if (!rawName || value === undefined || value.startsWith("--")) throw new Error(`Argument --${rawName || item} needs a value`);
    parsed.set(rawName, value);
  }
  return parsed;
}

function required(name: string): string { const value = optional(name); if (!value) throw new Error(`Missing --${name}`); return value; }
function optional(name: string): string { return args.get(name)?.trim() ?? ""; }
function requiredPositiveInteger(name: string): number { const value = Number(required(name)); if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be positive integer seconds`); return value; }
function numberOption(name: string, fallback: number): number { const raw = optional(name); if (!raw) return fallback; const value = Number(raw); if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`); return value; }
function requiredText(inlineName: string, fileName: string): string { const value = textOption(inlineName, fileName); if (!value) throw new Error(`Missing --${inlineName} or --${fileName}`); return value; }
function textOption(inlineName: string, fileName: string): string { const inline = optional(inlineName); if (inline) return inline; const file = optional(fileName); return file ? fs.readFileSync(path.resolve(file), "utf8").replace(/^\uFEFF/, "").trim() : ""; }
function requiredEnvironment(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`This task has no ${name}; verify that Codex Web started this turn`); return value; }

function writeReceipt(filePath: string, receipt: Receipt): void {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.rmSync(absolute, { force: true });
  fs.renameSync(temporary, absolute);
  if (process.platform !== "win32") fs.chmodSync(absolute, 0o600);
}

function readReceipt(filePath: string): Receipt {
  const value = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8").replace(/^\uFEFF/, "")) as Partial<Receipt>;
  if (value.version !== 1 || typeof value.wakePlanId !== "string" || typeof value.eventUrl !== "string"
    || typeof value.eventToken !== "string" || typeof value.deadlineAt !== "string") throw new Error("Invalid wait receipt");
  return value as Receipt;
}

function safePrint(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function formatDuration(seconds: number): string { if (seconds % 3600 === 0) return `${seconds / 3600}h`; if (seconds % 60 === 0) return `${seconds / 60}m`; return `${seconds}s`; }
function printHelp(): void {
  process.stdout.write("Codex Web durable wait CLI\n\n");
  process.stdout.write("Timer:\n  node $CODEX_WEB_WAIT_CLI after --seconds 7200 --prompt-file continue.txt [--label text]\n\n");
  process.stdout.write("Event or deadline:\n  node $CODEX_WEB_WAIT_CLI event --deadline-seconds 3600 --success-prompt-file success.txt --failure-prompt-file failure.txt --timeout-prompt-file timeout.txt --receipt wait-receipt.json [--run-id ID]\n\n");
  process.stdout.write("Signal:\n  node <wait-cli.js> signal --receipt wait-receipt.json --status success|failure|heartbeat [--event-id ID] [--summary-file summary.txt] [--retry-seconds 3600]\n\n");
  process.stdout.write("Cancel:\n  node $CODEX_WEB_WAIT_CLI cancel --id WAIT_ID\n");
}
