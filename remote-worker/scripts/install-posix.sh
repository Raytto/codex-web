#!/usr/bin/env bash
set -Eeuo pipefail

usage() { echo "Usage: $0 --server-url URL --enrollment-token TOKEN --machine-name NAME [--capacity N]" >&2; exit 2; }
server_url=""; enrollment_token=""; machine_name=""; capacity="2"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) server_url="${2:?missing URL}"; shift 2;;
    --enrollment-token) enrollment_token="${2:?missing token}"; shift 2;;
    --machine-name) machine_name="${2:?missing machine name}"; shift 2;;
    --capacity) capacity="${2:?missing capacity}"; shift 2;;
    *) usage;;
  esac
done
[[ "$server_url" =~ ^https?:// ]] && [[ -n "$enrollment_token" && -n "$machine_name" ]] || usage

package_root="$(cd "$(dirname "$0")/.." && pwd)"
state_root="${CODEX_WEB_WORKER_HOME:-$HOME/.local/share/CodexWebWorker}"
mkdir -p "$state_root"

node_path="$(command -v node || true)"
node_major=0
if [[ -n "$node_path" ]]; then node_major="$("$node_path" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; fi
if [[ "$node_major" -lt 22 ]]; then
  command -v curl >/dev/null 2>&1 || { echo "需要 curl 才能准备 Node.js" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "需要 tar 才能准备 Node.js" >&2; exit 1; }
  node_version="22.13.0"
  case "$(uname -s)" in Darwin) node_os="darwin";; Linux) node_os="linux";; *) echo "仅支持 macOS 和 Linux" >&2; exit 1;; esac
  case "$(uname -m)" in arm64|aarch64) node_arch="arm64";; x86_64|amd64) node_arch="x64";; *) echo "当前 CPU 架构暂不支持" >&2; exit 1;; esac
  node_dir="$state_root/node-v$node_version-$node_os-$node_arch"
  if [[ ! -x "$node_dir/bin/node" ]]; then
    archive="$state_root/node.tar.xz"
    curl -fL --retry 3 "https://nodejs.org/dist/v$node_version/node-v$node_version-$node_os-$node_arch.tar.xz" -o "$archive"
    tar -xJf "$archive" -C "$state_root"
    rm -f "$archive"
  fi
  node_path="$node_dir/bin/node"
fi
npm_path="$(dirname "$node_path")/npm"
[[ -x "$node_path" && -x "$npm_path" ]] || { echo "Node.js/npm 准备失败" >&2; exit 1; }
version="$("$node_path" -e 'const p=require(process.argv[1]); process.stdout.write(p.version)' "$package_root/package.json")"

release_root="$state_root/releases/$version"
mkdir -p "$state_root/releases"
if [[ "$package_root" != "$release_root" ]]; then
  rm -rf "$release_root"
  cp -R "$package_root" "$release_root"
fi

codex_root="$state_root/codex-runtime"
"$npm_path" install --prefix "$codex_root" @openai/codex@latest --omit=dev --no-audit --no-fund
codex_path="$codex_root/node_modules/@openai/codex/bin/codex.js"
[[ -f "$codex_path" ]] || { echo "Codex 安装完成但找不到可执行文件" >&2; exit 1; }

config_path="$state_root/config.json"
worker_id="$("$node_path" -e 'const fs=require("node:fs"); try { const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(typeof v.workerId==="string") process.stdout.write(v.workerId); } catch {}' "$config_path" 2>/dev/null || true)"
[[ -n "$worker_id" ]] || worker_id="$("$node_path" -e 'process.stdout.write(require("node:crypto").randomUUID())')"
"$node_path" - "$config_path" "$server_url" "$enrollment_token" "$machine_name" "$worker_id" "$capacity" "$state_root" "$node_path" "$codex_path" <<'NODE'
const fs=require("node:fs"); const [output,serverUrl,enrollmentToken,machineName,workerId,capacity,stateRoot,nodePath,codexRuntimePath]=process.argv.slice(2);
const wsUrl=serverUrl.replace(/^https:/,"wss:").replace(/^http:/,"ws:");
const value={serverWsUrl:`${wsUrl.replace(/\/$/,"")}/api/remote-workers/connect`,serverHttpUrl:serverUrl.replace(/\/$/,""),enrollmentToken,machineName,workerId,capacity:Number(capacity),stateRoot,nodePath,codexRuntimePath};
fs.writeFileSync(output,`${JSON.stringify(value,null,2)}\n`,{encoding:"utf8",mode:0o600});
NODE
printf '{"root":"%s"}\n' "$release_root" > "$state_root/worker-current.json"

start_script="$release_root/scripts/start-worker.sh"
chmod 700 "$start_script"
if [[ "$(uname -s)" == "Darwin" ]]; then
  launch_dir="$HOME/Library/LaunchAgents"; mkdir -p "$launch_dir"
  plist="$launch_dir/com.codex-web.remote-worker.plist"
  "$node_path" - "$plist" "$start_script" "$config_path" <<'NODE'
const fs=require("node:fs"); const [output,script,config]=process.argv.slice(2); const esc=(v)=>v.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
fs.writeFileSync(output,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.codex-web.remote-worker</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>${esc(script)}</string><string>--config</string><string>${esc(config)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`,"utf8");
NODE
  launchctl unload "$plist" 2>/dev/null || true; launchctl load "$plist"
else
  systemd_dir="$HOME/.config/systemd/user"; mkdir -p "$systemd_dir"
  cat > "$systemd_dir/codex-web-remote-worker.service" <<EOF
[Unit]
Description=Codex Web Remote Worker
After=network-online.target

[Service]
ExecStart=/bin/bash $start_script --config $config_path
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload; systemctl --user enable --now codex-web-remote-worker.service
fi
echo "Codex Web Remote Worker installed at $state_root"
