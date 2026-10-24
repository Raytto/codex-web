// Internal storage protocol codes; never show them as user-facing copy.
export function isTransientRestoreBlock(reason: string | null | undefined): boolean {
  return reason === "codex_runtime_active" || reason === "rollout_open_by_runtime";
}
