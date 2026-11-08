/** Shared no-tools CLI profile for trusted structured auxiliary tasks. */
export function constrainedCodexArguments(model: string, effort: string, schemaPath: string, outputPath: string): string[] {
  return [
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--sandbox", "read-only", "--model", model,
    "--config", `model_reasoning_effort=${JSON.stringify(effort)}`,
    "--config", "web_search=\"disabled\"", "--config", "tools.web_search=false",
    "--config", "tools.view_image=false", "--config", "features.shell_tool=false",
    "--config", "features.unified_exec=false", "--config", "agents.enabled=false",
    "--config", "approval_policy=\"never\"", "--config", "history.persistence=\"none\"",
    "--output-schema", schemaPath, "--output-last-message", outputPath, "--json", "-",
  ];
}
