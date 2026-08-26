#!/usr/bin/env bash
set -Eeuo pipefail

worker_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_root="${1:?usage: build-release-package.sh OUTPUT_ROOT COMMIT}"
release_commit="${2:?usage: build-release-package.sh OUTPUT_ROOT COMMIT}"

[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'Worker release commit must be a full lowercase Git SHA\n' >&2
  exit 1
}
command -v zip >/dev/null 2>&1 || {
  printf 'zip is required to build the Worker release package\n' >&2
  exit 1
}

version="$(node -p "require('$worker_root/package.json').version")"
release_ref="remote-worker-v${version}"
archive_name="codex-web-remote-worker-${version}-win-x64.zip"
posix_archive_name="codex-web-remote-worker-${version}-macos-universal.tar.gz"
staging_root="$(mktemp -d)"
cleanup() { rm -rf -- "$staging_root"; }
trap cleanup EXIT

package_root="$staging_root/package"
mkdir -p "$package_root/scripts" "$output_root"
cp -a "$worker_root/dist" "$package_root/dist"
cp -a "$worker_root/node_modules" "$package_root/node_modules"
cp -a "$worker_root/package.json" "$worker_root/package-lock.json" "$package_root/"
cp -a \
  "$worker_root/scripts/start-worker.ps1" \
  "$worker_root/scripts/install-package.ps1" \
  "$worker_root/scripts/update-worker.ps1" \
  "$worker_root/scripts/start-worker-launcher.ps1" \
  "$worker_root/scripts/update-worker-launcher.ps1" \
  "$worker_root/scripts/bootstrap-package-updater.ps1" \
  "$package_root/scripts/"
cp -a "$worker_root/scripts/start-worker.sh" "$worker_root/scripts/install-posix.sh" "$package_root/scripts/"
chmod 0755 "$package_root/scripts/start-worker.sh" "$package_root/scripts/install-posix.sh"

node - "$package_root/release.json" "$version" "$release_ref" "$release_commit" <<'NODE'
const [output, version, ref, commit] = process.argv.slice(2);
const fs = require("node:fs");
fs.writeFileSync(output, `${JSON.stringify({
  format: "codex-web-remote-worker-release-v1",
  version,
  ref,
  commit,
  platform: "win32-x64",
  minimumNodeVersion: "22.13.0",
}, null, 2)}\n`, "utf8");
NODE

# ZIP timestamps and extra attributes otherwise make identical source commits
# produce different archives. All package names are repository-controlled and
# contain no newlines, so a sorted file list is a stable input to zip(1).
find "$package_root" -exec touch -h -d '2000-01-01T00:00:00Z' {} +
archive_path="$output_root/$archive_name"
posix_archive_path="$output_root/$posix_archive_name"
rm -f -- "$archive_path" "$posix_archive_path" "$output_root/manifest.json"
(
  cd "$package_root"
  LC_ALL=C find . -type f -print | LC_ALL=C sort | TZ=UTC zip -X -q "$archive_path" -@
)
(
  cd "$package_root"
  tar --sort=name --mtime='2000-01-01T00:00:00Z' --owner=0 --group=0 --numeric-owner -czf "$posix_archive_path" .
)

archive_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
archive_size="$(stat -c '%s' "$archive_path")"
posix_archive_sha256="$(sha256sum "$posix_archive_path" | awk '{print $1}')"
posix_archive_size="$(stat -c '%s' "$posix_archive_path")"
node - "$output_root/manifest.json" "$version" "$release_ref" "$release_commit" "$archive_name" "$archive_sha256" "$archive_size" "$posix_archive_name" "$posix_archive_sha256" "$posix_archive_size" <<'NODE'
const [output, version, ref, commit, fileName, sha256, size, posixFileName, posixSha256, posixSize] = process.argv.slice(2);
const fs = require("node:fs");
fs.writeFileSync(output, `${JSON.stringify({
  format: "codex-web-remote-worker-release-manifest-v1",
  version,
  ref,
  commit,
  platform: "win32-x64",
  archive: { fileName, sha256, size: Number(size) },
  platforms: {
    "win32-x64": { fileName, sha256, size: Number(size), format: "zip" },
    "darwin-universal": { fileName: posixFileName, sha256: posixSha256, size: Number(posixSize), format: "tar.gz" },
  },
}, null, 2)}\n`, "utf8");
NODE

printf 'Built %s (%s bytes, sha256 %s)\n' "$archive_name" "$archive_size" "$archive_sha256"
printf 'Built %s (%s bytes, sha256 %s)\n' "$posix_archive_name" "$posix_archive_size" "$posix_archive_sha256"
