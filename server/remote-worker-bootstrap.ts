export type RemoteWorkerBootstrapPlatform = "win32-x64" | "darwin-universal";

export function bootstrapScript(platform: RemoteWorkerBootstrapPlatform, input: { baseUrl: string; token: string; version: string }): { fileName: string; contentType: string; body: string } {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return platform === "win32-x64"
    ? { fileName: "install-codex-web-worker.ps1", contentType: "text/plain; charset=utf-8", body: windowsScript(baseUrl, input.token, input.version) }
    : { fileName: "install-codex-web-worker.command", contentType: "text/plain; charset=utf-8", body: macScript(baseUrl, input.token, input.version) };
}

function windowsScript(baseUrl: string, token: string, version: string): string {
  return [
    "# Codex Web Remote Worker 安装器（Windows）",
    "# 右键此文件，选择“使用 PowerShell 运行”。它会自动准备 Node.js、安装 Codex、配置开机启动并连接 Codex Web。",
    "$ErrorActionPreference = \"Stop\"",
    "$server = " + psQuote(baseUrl),
    "$bootstrapToken = " + psQuote(token),
    "$machineName = Read-Host \"请输入这台电脑在 Codex Web 中显示的名称（例如 家用电脑）\"",
    "if ([string]::IsNullOrWhiteSpace($machineName)) { throw \"机器名称不能为空\" }",
    "$body = @{ token = $bootstrapToken; platform = \"win32-x64\" } | ConvertTo-Json -Compress",
    "$session = Invoke-RestMethod -Method Post -Uri \"$server/api/remote-worker-bootstrap/exchange\" -ContentType \"application/json\" -Body $body",
    "$download = Join-Path ([System.IO.Path]::GetTempPath()) \"codex-web-worker-" + version + ".zip\"",
    "$headers = @{ Authorization = \"Bearer $($session.enrollmentToken)\" }",
    "Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $session.archiveUrl -OutFile $download",
    "$extract = Join-Path ([System.IO.Path]::GetTempPath()) \"codex-web-worker-install-$([guid]::NewGuid())\"",
    "Expand-Archive -LiteralPath $download -DestinationPath $extract -Force",
    "try {",
    "  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $extract \"scripts\\install-package.ps1\") -EnrollmentToken $session.enrollmentToken -MachineName $machineName -ServerHttpUrl $server",
    "} finally {",
    "  Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue",
    "}",
    "Write-Host \"Codex Web Remote Worker 已安装。请回到网页刷新执行机器列表。\"",
    "Read-Host \"按 Enter 关闭\"",
    "",
  ].join("\n");
}

function macScript(baseUrl: string, token: string, version: string): string {
  return [
    "#!/bin/bash",
    "# Codex Web Remote Worker 安装器（macOS）",
    "# 在“终端”中运行：bash ~/Downloads/install-codex-web-worker.command",
    "set -Eeuo pipefail",
    "server=" + shQuote(baseUrl),
    "bootstrap_token=" + shQuote(token),
    "read -r -p \"请输入这台 Mac 在 Codex Web 中显示的名称（例如 MacBook）: \" machine_name",
    "[[ -n \"$machine_name\" ]] || { echo \"机器名称不能为空\" >&2; exit 1; }",
    "exchange=$(curl -fsSL --retry 3 -X POST -H 'Content-Type: application/json' --data \"{\\\"token\\\":\\\"$bootstrap_token\\\",\\\"platform\\\":\\\"darwin-universal\\\"}\" \"$server/api/remote-worker-bootstrap/exchange\")",
    "enrollment_token=$(printf '%s' \"$exchange\" | sed -n 's/.*\"enrollmentToken\":\"\\([^\" ]*\\)\".*/\\1/p')",
    "archive_url=$(printf '%s' \"$exchange\" | sed -n 's/.*\"archiveUrl\":\"\\([^\" ]*\\)\".*/\\1/p')",
    "[[ -n \"$enrollment_token\" && -n \"$archive_url\" ]] || { echo \"配对信息无效或已过期，请回网页重新下载安装器\" >&2; exit 1; }",
    "tmp_root=$(mktemp -d)",
    "trap 'rm -rf \"$tmp_root\"' EXIT",
    "curl -fsSL --retry 3 -H \"Authorization: Bearer $enrollment_token\" \"$archive_url\" -o \"$tmp_root/worker.tar.gz\"",
    "mkdir -p \"$tmp_root/package\"",
    "tar -xzf \"$tmp_root/worker.tar.gz\" -C \"$tmp_root/package\"",
    "bash \"$tmp_root/package/scripts/install-posix.sh\" --server-url \"$server\" --enrollment-token \"$enrollment_token\" --machine-name \"$machine_name\"",
    "echo \"Codex Web Remote Worker 已安装。请回到网页刷新执行机器列表。\"",
    "",
  ].join("\n");
}

function psQuote(value: string): string {
  const tick = String.fromCharCode(96);
  return "\"" + value.replaceAll(tick, tick + tick).replaceAll("\"", tick + "\"") + "\"";
}

function shQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
