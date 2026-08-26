# Security

- Keep `.env` private and use a unique password plus a random session secret.
- The default tenant identities are generic `owner`, `member-a`, and `member-b`
  examples only; replace their UID/GID mapping during provisioning and never
  commit real account names or credentials.
- The web process runs as UID/GID 10001; tenant workers use distinct UID/GID values
  (the bundled examples start at 11001) and do not access the application database.
- The supervisor is the only component that launches tenant worker processes.
- Bind the application to loopback and expose it only through an HTTPS reverse proxy.
- Codex can execute code and modify files inside its tenant workspace. Only upload files you trust and review generated changes.
- The bundled `html-report` skill is static guidance and templates only. It adds no permissions; reports still run under the low-privilege tenant worker and are subject to the same output, preview, and public-share controls.
- The container is not a complete security boundary for hostile workloads. Its Codex sandbox requires relaxed seccomp/AppArmor settings for user namespaces.
- The default profile contains no host-root bridge, Docker socket, or host filesystem mount. Optional bridge and Remote Worker modules are present for operators who make an explicit trust decision and supply their own paths and credentials.
- Voice recordings and their bounded spelling/topic context are sent to the DashScope endpoint configured by the operator. Context can include the draft, attachment names, text attachment heads, recent messages, and a small number of images. Disable voice by leaving `DASHSCOPE_API_KEY` empty.
- A complete recording is kept only in the signing browser's account/conversation-scoped IndexedDB for 24 hours when recognition fails. The retry card offers explicit retry or deletion. Server receipts retain only the bounded result, audio size/hash, and status for the same 24-hour window; they are keyed by a validated client UUID and reject a changed payload under the same UUID.
- Archiving is not deletion: archived conversations retain messages, files, and Codex thread references until explicitly deleted.
- Public report sharing is opt-in. Anyone holding an enabled link can read that report and its approved images without logging in; disable the share before the content should become private again.
- Set storage ceilings and a free-disk watermark. Resumable partial uploads expire automatically, while ordinary multipart uploads are rejected when the same limits would be exceeded.
- Interrupted jobs are never automatically retried because the previous turn may already have produced side effects.
- Back up state volumes and test restore procedures before upgrades.

Please report vulnerabilities privately through GitHub's security advisory feature instead of opening a public issue.
