# Codex Web Remote Worker guidance

- Keep this package self-contained; it must build from a sparse checkout containing only `remote-worker/` plus Git metadata.
- Never commit enrollment tokens, generated device IDs, logs, downloaded attachments, Codex state, or local machine paths.
- Control connections must initiate outbound HTTPS/WSS. Server-authorized node transfers may additionally use short-lived ICE UDP sockets for an authenticated peer; no general-purpose listening file server, UPnP, or router port forwarding. The server owns transfer creation, routing, retries, and cleanup state; Workers only execute scoped commands.
- Run `npm test` after changes.
