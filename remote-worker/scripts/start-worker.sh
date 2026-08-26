#!/usr/bin/env bash
set -Eeuo pipefail

config_path="${2:-${CODEX_WEB_WORKER_CONFIG:-$HOME/.local/share/CodexWebWorker/config.json}}"
if [[ "${1:-}" == "--config" ]]; then config_path="${2:?missing config path}"; fi
state_root="$(dirname "$config_path")"
log_path="$state_root/worker.log"

read_config_value() {
  "$node_path" -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const path=process.argv[2].split("."); let current=value; for(const key of path) current=current?.[key]; if(current!==undefined && current!==null) process.stdout.write(String(current));' "$config_path" "$1"
}

node_path="$(command -v node || true)"
if [[ -z "$node_path" && -x "$state_root/node/bin/node" ]]; then node_path="$state_root/node/bin/node"; fi
[[ -n "$node_path" ]] || { echo "Node.js is not installed; run the package installer first." >&2; exit 1; }

root=""
if [[ -f "$state_root/worker-current.json" ]]; then
  root="$("$node_path" -e 'const fs=require("node:fs"); const p=process.argv[1]; try { const v=JSON.parse(fs.readFileSync(p,"utf8")); if(typeof v.root==="string") process.stdout.write(v.root); } catch {}' "$state_root/worker-current.json")"
fi
if [[ -z "$root" ]]; then root="$(cd "$(dirname "$0")/.." && pwd)"; fi
codex_path="$(read_config_value codexRuntimePath || true)"
if [[ -z "$codex_path" ]]; then codex_path="$(command -v codex || true)"; fi

mkdir -p "$state_root"
while true; do
  if [[ -n "$codex_path" ]]; then export CODEX_RUNTIME_PATH="$codex_path"; fi
  "$node_path" "$root/dist/src/main.js" --config "$config_path" >>"$log_path" 2>&1
  exit_code=$?
  [[ "$exit_code" == "75" ]] || exit "$exit_code"
  sleep 3
done
