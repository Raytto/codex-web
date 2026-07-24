# Security

- Keep `.env` private and use a unique password plus a random session secret.
- Bind the application to loopback and expose it only through an HTTPS reverse proxy.
- Codex can execute code and modify files inside its tenant workspace. Only upload files you trust and review generated changes.
- The container is not a complete security boundary for hostile workloads. Its Codex sandbox requires relaxed seccomp/AppArmor settings for user namespaces.
- The public edition intentionally contains no host-root bridge, Docker socket, or host filesystem mount.
- Voice recordings and their bounded spelling/topic context are sent to the DashScope endpoint configured by the operator. Context can include the draft, attachment names, text attachment heads, recent messages, and a small number of images. Disable voice by leaving `DASHSCOPE_API_KEY` empty.
- Archiving is not deletion: archived conversations retain messages, files, and Codex thread references until explicitly deleted.
- Interrupted jobs are never automatically retried because the previous turn may already have produced side effects.
- Back up state volumes and test restore procedures before upgrades.

Please report vulnerabilities privately through GitHub's security advisory feature instead of opening a public issue.
