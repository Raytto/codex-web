# Optional per-task memory protection

This host integration adds a 4 GiB `MemAvailable` admission watermark and a 4 GiB per-task systemd scope, including child processes. A complete-workflow capacity of `-1` never disables this guard, disk watermarks, per-device limits or container quotas. It uses no external account or API and creates no cloud charges.

The base installation keeps it disabled and retains Compose memory/process/CPU limits. Enabling it requires Linux systemd with cgroup v2, `busctl`, `systemctl`, an explicitly authorized host bridge and an operator-owned tenant container. It is an advanced host deployment, not an extra authority granted to ordinary web tenants.

1. Complete the [host bridge setup](DEPLOYMENT_OPTIONS.md#4-hostroot-bridge-high-risk-explicit-consent). Keep the web-to-host socket authenticated and scoped to this instance.
2. In the host service's private environment set `TASK_MEMORY_GUARD=true`, `CODEX_WEB_TASK_SCOPE_OWNER=codex-web-host-root.service` (replace with the actual owning service), and `CODEX_WEB_TENANT_CONTAINER_NAME=<actual-app-container-name>`. Resolve the container locally with `docker compose ps`; the caller cannot supply its own host PID/container/cgroup. Install/enable a `system-codexwebtenants.slice` under `system.slice` with memory accounting; do not impose a hidden aggregate two-task cap.
3. Also set `TASK_MEMORY_GUARD=true` in the app `.env` and recreate the app. Compose forwards this switch into the supervisor as well as the web configuration. Host-only owner/container settings belong to the host service, not to untrusted jobs. Apply service changes to your installation only.
4. Verify with a dedicated small task: the new `codex-web-task-<UUID>.scope` must list the task PID, `MemoryMax=4294967296`, `MemorySwapMax=0`, and group OOM behavior. The helper verifies the real cgroup values before allowing the bootstrap process to execute. Never run an intentional OOM drill against live user work.
5. Check that an unavailable guard or low memory leaves the request queued with its input intact and that recovery resumes it. A guard failure must not silently start an unprotected task. Remote devices continue to enforce their own capacity; this host guard does not change their limits.
6. To disable it, first drain this installation's tasks, set the switch false in both app and host service, recreate/restart those components and check ordinary task startup. Preserve Compose limits. Do not stop another installation's scopes or prune unrelated processes.

Unit tests exercise admission, identity validation, bootstrap ordering and OOM error propagation. A real systemd/cgroup/physical-device deployment still needs an installer-run acceptance check; a synthetic test is not proof of that host's enforcement.
