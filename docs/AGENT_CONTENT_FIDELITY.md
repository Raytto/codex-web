# Agent content fidelity

The product title and fixed interface labels use the Codex Web brand. Agent
responses, streaming feedback, commands, tool names, errors, code, paths and
URLs preserve their literal content. Replacing `codex.exe` or `.codex` with a
product name would corrupt copyable commands. Existing citation normalization
still uses `sanitizeAgentMarkdown`.

The regression suite compares real app-server streaming, progress and final
output, including PowerShell executable names, inline code and URLs. Historical
altered messages are not reverse-replaced because the intended original text
cannot be inferred reliably.
