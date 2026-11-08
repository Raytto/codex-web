# Optional Gemini / Antigravity execution

Each request runs through the engine selected by its model. Codex keeps its existing app-server execution; optional Gemini uses the node-local, pinned Antigravity CLI. The website still uses username/password authentication. Google OAuth is a separate execution-account connection, available only to the configured host administrator and supported Remote Workers.

Add an account from Settings → Account management → choose the node → Add account → Gemini. Only this explicit action downloads the verified vendor CLI; the default server image does not include another model CLI. Complete Google OAuth in the vendor page. Credentials and native history stay on that node. Do not copy an existing account directory between installations.

Models and supported effort levels come from the active account's real catalog. Without a valid login, Gemini models remain unavailable. A saved Gemini request fails explicitly when its account is unavailable; it is never silently sent to Codex. New-conversation defaults are selected from the current node catalog without overwriting a preference saved for a different node. Account changes are blocked only by work using that engine or maintenance.

## Shared context and tools

Both engines read the same project instructions and skills. Switching engines starts a separate native session with up to 20 previous messages and about 24,000 characters of bounded original context. There is no extra summarization call. Database tables `agent_engine_sessions` and `agent_job_sessions` preserve engine, node, account and native-session bindings. Gemini native IDs never overwrite the Codex thread ID.

Job-scoped MCP credentials are passed in process environment, never written into MCP configuration. Server-side tools keep the existing authorization checks. A node with no job authority exposes no platform tools. Ordinary tenant isolation and optional host-bridge disabled defaults are unchanged.

## Naming and limitations

Gemini automatic naming is disabled until `CWW_ANTIGRAVITY_TITLE_MODEL` and `CWW_ANTIGRAVITY_TITLE_EFFORT` are explicitly configured to values in that node's authenticated catalog. Configure the same settings in the server/optional bridge and each relevant Worker process. The naming agent uses a temporary empty workspace with no tools or project skills; manual titles win. No production model choices are shipped.

Gemini messages sent during execution queue for the next request. Images are supplied as file paths; this does not claim preloaded visual input. Successful completion requires both a formal result and successful process exit. Started requests are not automatically replayed after uncertain failure. Platform deletion removes local managed records and owned Codex segments; vendor Gemini history requires the official client. Deleting a node-local Gemini account removes that account's local configuration.

The CLI is integrity-pinned; runtime installation and Windows ConPTY packaging are tested separately from real Google login. Automated synthetic tests do not prove a particular subscription's model access or physical-device behavior.

Cold storage now includes recursive Codex lineage archives (v3, with v1/v2 restore compatibility) and an optional chunk lifecycle. It does not claim automatic recovery of an unmanaged Google profile; configure explicit backup sources and verify recovery. See [storage setup](STORAGE_LIFECYCLE.md).

## Live steering and visible capabilities

Live steering now requires Codex with the same model and reasoning effort as the active turn. Antigravity additions stay queued; the composer explains image-file handling and the bounded cross-engine context handoff. Login and conversation menus scroll on short displays, chat text keeps the chosen size, and opportunity sidebar navigation stays in its section menu.

The model menu keeps both engines selectable. Changes apply to the next request and share project files plus at most 20 previous messages / about 24,000 characters; this is not a full native-context transfer. Pending messages and attachments survive a rejected steer. While a request runs, metrics follow its engine rather than the next selected model. Remote refresh imports Codex client history only.
