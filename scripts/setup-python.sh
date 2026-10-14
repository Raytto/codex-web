#!/usr/bin/env bash
set -euo pipefail

python_version="${PYTHON_VERSION:-3.12.12}"
uv_version="${UV_VERSION:-0.11.28}"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="${PYTHON_RUNTIME_ROOT:-$project_root/data/python}"
mkdir -p "$runtime_root/bin"

export UV_UNMANAGED_INSTALL="$runtime_root/bin"
export UV_PYTHON_INSTALL_DIR="$runtime_root/pythons"
export UV_CACHE_DIR="$runtime_root/cache"
export UV_PROJECT_ENVIRONMENT="$runtime_root/shared"
if [[ ! -x "$runtime_root/bin/uv" ]]; then
  curl -LsSf "https://astral.sh/uv/$uv_version/install.sh" | sh
fi
"$runtime_root/bin/uv" python install "$python_version"
"$runtime_root/bin/uv" lock --project "$project_root/python-runtime" --check
profile="${PYTHON_RUNTIME_PROFILE:-base}"
extras=()
case "$profile" in
  base) ;;
  documents) extras=(--extra documents) ;;
  *) echo "Unknown Python runtime profile: $profile" >&2; exit 2 ;;
esac
"$runtime_root/bin/uv" sync "${extras[@]}" --project "$project_root/python-runtime" --locked --no-dev --managed-python --python "$python_version"
"$runtime_root/shared/bin/python" -c "import json, ssl, sqlite3; print('Base Python runtime ready')"
if [[ "$profile" == documents ]]; then
  "$runtime_root/shared/bin/python" -c "import pandas, openpyxl, docx, pptx, pypdf, PIL; print('Document tools ready')"
fi
