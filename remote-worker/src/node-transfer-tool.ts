export const NODE_TRANSFER_TOOL_NAME = "pp_agent_transfer";
export const NODE_TRANSFER_TOOL_SPEC = {
  type: "function" as const,
  name: NODE_TRANSFER_TOOL_NAME,
  description:
    "Create, inspect or cancel a PPA server-managed file transfer between registered nodes, including the server. Workers only execute; state survives this model turn. Direct first, encrypted memory relay fallback; no attachment copy. Use nodes to resolve IDs and create with a stable idempotency key. Never poll in a sleep loop; schedule a continuation for long transfers.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["nodes", "create", "list", "get", "cancel"],
      },
      id: { type: "string" },
      source: {
        type: "object",
        additionalProperties: false,
        required: ["executorId", "path"],
        properties: {
          executorId: { type: "string" },
          path: { type: "string" },
        },
      },
      target: {
        type: "object",
        additionalProperties: false,
        required: ["executorId", "path"],
        properties: {
          executorId: { type: "string" },
          path: { type: "string" },
        },
      },
      overwrite: { type: "boolean" },
      idempotencyKey: { type: "string" },
      route: { type: "string", enum: ["auto", "relay"] },
    },
  },
};
export async function callNodeTransferTool(
  config: { baseUrl: string; token: string; jobId: string },
  raw: unknown,
): Promise<string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid transfer request");
  const v = raw as Record<string, unknown>,
    action = String(v.action);
  if (!["nodes", "create", "list", "get", "cancel"].includes(action))
    throw new Error("Invalid transfer action");
  let suffix = "",
    method = "GET",
    body: unknown;
  if (action === "nodes") suffix = "/nodes";
  if (action === "get" || action === "cancel") {
    if (typeof v.id !== "string" || !/^[a-f0-9-]{36}$/.test(v.id))
      throw new Error("Transfer id required");
    suffix = `/${v.id}`;
  }
  if (action === "cancel") {
    method = "POST";
    suffix += "/cancel";
    body = {};
  }
  if (action === "create") {
    method = "POST";
    body = {
      source: v.source,
      target: v.target,
      overwrite: v.overwrite ?? false,
      idempotencyKey: v.idempotencyKey,
      route: v.route ?? "auto",
    };
  }
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/api/automation/jobs/${encodeURIComponent(config.jobId)}/transfers${suffix}`,
    {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : `Transfer request failed (${response.status})`,
    );
  return JSON.stringify(result);
}
