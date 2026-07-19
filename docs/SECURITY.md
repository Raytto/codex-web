# Security

- Keep `.env` private and use a unique password plus a random session secret.
- Bind the application to loopback and expose it only through an HTTPS reverse proxy.
- Codex can execute code and modify files inside its tenant workspace. Only upload files you trust and review generated changes.
- The container is not a complete security boundary for hostile workloads. Its Codex sandbox requires relaxed seccomp/AppArmor settings for user namespaces.
- The public edition intentionally contains no host-root bridge, Docker socket, or host filesystem mount.
- Voice recordings are sent to the DashScope endpoint configured by the operator. Disable voice by leaving `DASHSCOPE_API_KEY` empty.
- Back up state volumes and test restore procedures before upgrades.

Please report vulnerabilities privately through GitHub's security advisory feature instead of opening a public issue.
