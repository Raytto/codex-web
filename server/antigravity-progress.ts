type StageFeedback = { kind: "update"; label: "阶段反馈"; detail: string };

/** AGY uses the same stream for public preambles and the final answer.
 * A subsequent tool step confirms that the preceding text was intermediate.
 * Keep final-answer streaming hidden and never manufacture reasoning text.
 */
export function createAntigravityStageFeedback(): (payload: unknown) => StageFeedback | null {
  let pendingText = "";
  return (payload) => {
    if (!payload || typeof payload !== "object") return null;
    const event = payload as { kind?: unknown; detail?: unknown };
    if (event.kind === "assistant_stream") {
      // The adapter supplies a full per-step snapshot, not a delta.
      pendingText = typeof event.detail === "string" ? event.detail : "";
      return null;
    }
    if (["input_accepted", "status", "error", "retry"].includes(String(event.kind))) {
      pendingText = "";
      return null;
    }
    if (!["command", "file", "search", "tool", "agent"].includes(String(event.kind))) return null;
    const detail = pendingText.trim();
    pendingText = "";
    return detail ? { kind: "update", label: "阶段反馈", detail } : null;
  };
}
