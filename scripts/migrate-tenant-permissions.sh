#!/usr/bin/env bash
set -Eeuo pipefail

data_root="${DATA_ROOT:-/app/data}"
tenant_root="${TENANT_ROOT:-/app/tenants}"
owner_id="00000000-0000-4000-8000-000000000001"
web_uid=10001
tenant_uid=11001
tenant_gid=11001

for root in "$data_root" "$tenant_root"; do
  if [[ -z "$root" || "$root" == "/" || "$root" == "/app" ]]; then
    echo "Refusing unsafe state root: $root" >&2
    exit 1
  fi
done
command -v setfacl >/dev/null 2>&1 || { echo "setfacl is required" >&2; exit 1; }

mkdir -p "$data_root" "$tenant_root"
chown -R "$web_uid:$web_uid" "$data_root"
chmod 0700 "$data_root"
chown "$web_uid:$web_uid" "$tenant_root"
chmod 0711 "$tenant_root"

tenant="$tenant_root/$owner_id"
mkdir -p "$tenant"
chown -R "$tenant_uid:$tenant_gid" "$tenant"
chmod -R go-rwx "$tenant"

while IFS= read -r -d '' directory; do
  setfacl -b "$directory"
  setfacl -m "u::rwx,u:$web_uid:rwx,g::---,m::rwx,o::---" "$directory"
  setfacl -d -m "u::rwx,u:$web_uid:rwx,u:$tenant_uid:rwx,g::---,m::rwx,o::---" "$directory"
done < <(find "$tenant" -type d -print0)

while IFS= read -r -d '' file; do
  setfacl -b "$file"
  setfacl -m "u:$web_uid:rw-" "$file"
done < <(find "$tenant" -type f -print0)

echo "Codex Web state permissions are ready."
