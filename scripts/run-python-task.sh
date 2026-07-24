#!/usr/bin/env bash
set -euo pipefail

mode="shared"
with_packages=""
script=""
script_args=()

while (($#)); do
  case "$1" in
    --mode) mode="${2,,}"; shift 2 ;;
    --with) with_packages="$2"; shift 2 ;;
    --script) script="$2"; shift 2 ;;
    --) shift; script_args+=("$@"); break ;;
    *) script_args+=("$1"); shift ;;
  esac
done

: "${CWW_UV:?This helper must run inside a Codex Web task.}"
: "${CWW_SHARED_PYTHON:?This helper must run inside a Codex Web task.}"
: "${CWW_JOB_RUNTIME:?This helper must run inside a Codex Web task.}"
[[ -n "$script" ]] || { echo "--script is required" >&2; exit 2; }

if [[ "$mode" == "shared" ]]; then
  exec "$CWW_SHARED_PYTHON" "$script" "${script_args[@]}"
fi
[[ "$mode" == "temporary" ]] || { echo "--mode must be shared or temporary" >&2; exit 2; }

environment="$CWW_JOB_RUNTIME/venv-$(cat /proc/sys/kernel/random/uuid)"
trap 'rm -rf -- "$environment"' EXIT
"$CWW_UV" venv --python "$CWW_SHARED_PYTHON" "$environment"
IFS=',' read -r -a requirements <<< "$with_packages"
if [[ -n "$with_packages" ]]; then
  "$CWW_UV" pip install --python "$environment/bin/python" "${requirements[@]}"
fi
"$environment/bin/python" "$script" "${script_args[@]}"
