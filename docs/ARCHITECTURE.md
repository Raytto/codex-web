# Architecture

Codex Web is a single-owner self-hosted application. Express serves the API and built React assets. SQLite stores users, sessions, conversations, messages, job events, settings, and server-side queue state.

The web process runs as UID 10001. A local supervisor launches Codex work as UID 11001 with a tenant-specific `HOME`, `CODEX_HOME`, conversation workspace, and library. The worker has no access to the application database. Files shared between the web process and worker use explicit filesystem ACLs.

Each conversation has an `uploads`, `outputs`, and temporary runtime area. Generated deliverables are copied to durable application storage. Deleting a conversation cancels queued/running jobs, removes its workspace and deliverables, and soft-deletes the database row so messages and events remain available for administrative diagnosis.

Queued prompts and their attachments are stored by the server. The browser is only a view of that state. A queued prompt can be reordered, edited, deleted, or converted into a live steering instruction for the currently running Codex turn.

The public edition deliberately excludes host-root execution, Docker socket access, host filesystem mounts, private network routing, and multi-user provisioning.
