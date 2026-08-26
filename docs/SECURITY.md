# Security

- Keep `.env` private and use a unique password plus a random session secret.
- Bind the application to loopback and expose it only through an HTTPS reverse proxy.
- Codex can execute code and modify files inside its tenant workspace. Only upload files you trust and review generated changes.
- The bundled `html-report` skill is static guidance and templates only. It adds no permissions; reports still run under the low-privilege tenant worker and are subject to the same output, preview, and public-share controls.
- The container is not a complete security boundary for hostile workloads. Its Codex sandbox requires relaxed seccomp/AppArmor settings for user namespaces.
- The public edition intentionally contains no host-root bridge, Docker socket, or host filesystem mount.
- Voice recordings and their bounded spelling/topic context are sent to the DashScope endpoint configured by the operator. Context can include the draft, attachment names, text attachment heads, recent messages, and a small number of images. Disable voice by leaving `DASHSCOPE_API_KEY` empty.
- Archiving is not deletion: archived conversations retain messages, files, and Codex thread references until explicitly deleted.
- Public report sharing is opt-in. Anyone holding an enabled link can read that report and its approved images without logging in; disable the share before the content should become private again.
- Set storage ceilings and a free-disk watermark. Resumable partial uploads expire automatically, while ordinary multipart uploads are rejected when the same limits would be exceeded.
- Interrupted jobs are never automatically retried because the previous turn may already have produced side effects.
- Back up state volumes and test restore procedures before upgrades.

Please report vulnerabilities privately through GitHub's security advisory feature instead of opening a public issue.
