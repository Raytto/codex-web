# Codex Web Remote Worker guidance

- Keep this package self-contained; it must build from a sparse checkout containing only `remote-worker/` plus Git metadata.
- Never commit enrollment tokens, generated device IDs, logs, downloaded attachments, Codex state, or local machine paths.
- The Worker must only initiate outbound HTTPS/WSS connections and must never expose a listening port.
- Run `npm test` after changes.
