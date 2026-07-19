#!/bin/sh
set -eu

codex_path="${CODEX_RUNTIME_PATH:-/opt/codex-runtime/current/bin/codex}"
if [ ! -x "$codex_path" ]; then
  echo "Codex runtime is unavailable: $codex_path" >&2
  exit 127
fi
exec "$codex_path" "$@"
