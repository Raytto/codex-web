#!/usr/bin/env bash
# Build immutable tracked source, then remove only this invocation's builder/cache.
set -Eeuo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
ref="${CODEX_WEB_BUILD_REF:-HEAD}"
target="${CODEX_WEB_BUILD_TARGET:-runtime}"
case "$target" in runtime|documents) ;; *) echo 'Target must be runtime or documents' >&2; exit 2 ;; esac
commit="$(git rev-parse --verify "$ref^{commit}")"
image="${CODEX_WEB_IMAGE:-codex-web:local}"
cli_version="${CODEX_CLI_VERSION:-0.162.1}"
[[ "$cli_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Pin a numeric Codex CLI version' >&2; exit 2; }
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Commit or preserve tracked changes first; builds use only the selected Git commit.' >&2; exit 2
fi
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-web-build.XXXXXXXX")"
builder="codex-web-build-$(date +%s)-$$"
created=0
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$created" == 1 ]]; then docker buildx rm --force "$builder" || status=1; fi
  rm -rf -- "$build_dir"
  exit "$status"
}
trap cleanup EXIT
printf '[worker.oci]\n  max-parallelism = 1\n' > "$build_dir/buildkitd.toml"
# 3 GiB bounds this build on a 4 GiB machine. Swap policy belongs to the operator.
driver_network=()
# Optional for an operator-managed Docker daemon without a default bridge.
if [[ -n "${CODEX_WEB_BUILDER_NETWORK:-}" ]]; then
  driver_network=(--driver-opt "network=$CODEX_WEB_BUILDER_NETWORK")
fi
docker buildx create --name "$builder" --driver docker-container "${driver_network[@]}" \
  --driver-opt "memory=${CODEX_WEB_BUILD_MEMORY:-3g}" \
  --buildkitd-config "$build_dir/buildkitd.toml" >/dev/null
created=1
mkdir "$build_dir/source"
git archive "$commit" | tar -x -C "$build_dir/source"
args=(--builder "$builder" --progress plain --build-arg "CODEX_CLI_VERSION=$cli_version" \
  --build-arg "WORKER_RELEASE_COMMIT=$commit" --build-arg 'NODE_OPTIONS=--max-old-space-size=1536')
if [[ "${CODEX_WEB_VERIFY_BUILD:-0}" == 1 ]]; then
  # No test image is loaded into the engine. Its layers leave with the builder.
  docker buildx build "${args[@]}" --target test "$build_dir/source"
fi
docker buildx build "${args[@]}" --target "$target" --load --tag "$image" \
  --label "org.opencontainers.image.revision=$commit" "$build_dir/source"
printf 'Built %s from %s (%s); dedicated build cache removed on exit.\n' "$image" "$commit" "$target"
