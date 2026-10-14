#!/bin/bash
set -Eeuo pipefail
# Compose runs the isolated init-state service before starting this supervisor.
export CODEX_RUNTIME_PATH="${CODEX_RUNTIME_PATH:-/opt/codex-baked/bin/codex}"
test -x "$CODEX_RUNTIME_PATH"
exec node dist-server/server/supervisor.js
