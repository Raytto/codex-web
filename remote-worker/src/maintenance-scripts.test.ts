import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { WORKER_VERSION } from "./version.js";

function script(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "scripts", name), "utf8");
}

test("maintenance always restarts the worker after update failures", () => {
  const source = script("update.ps1");
  assert.match(source, /try \{[\s\S]*Stop-ScheduledTask[\s\S]*\} finally \{[\s\S]*Start-ScheduledTask/);
});

test("installation preserves device identity and self-heals external stops", () => {
  const source = script("install.ps1");
  assert.match(source, /\[switch\]\$RenameMachine/);
  assert.match(source, /\$existingConfig\.machineName[\s\S]*-not \$RenameMachine/);
  assert.match(source, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(source, /-Trigger @\(\$logonTrigger, \$recoveryTrigger\)/);
  assert.match(source, /-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable/);
  assert.match(source, /install-updater\.ps1/);
});

test("worker version and release updater stay aligned", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
  assert.equal(WORKER_VERSION, packageJson.version);
  assert.match(WORKER_VERSION, /^\d+\.\d+\.\d+$/);
});

test("package installer constructs URLs without the Windows PowerShell 5.1 parser trap", () => {
  const installer = script("install-package.ps1");
  assert.ok([...Buffer.from(installer, "utf8")].every((byte) => byte < 0x80), "install-package.ps1 must stay ASCII for Windows PowerShell 5.1");
  assert.match(installer, /\$serverHttpUrl = \$ServerHttpUrl -replace '\/\+\$', ''/);
  assert.match(installer, /\$serverWsUrl = \[string\]::Concat\(\$wsUrl, '\/api\/remote-workers\/connect'\)/);
  assert.doesNotMatch(installer, /\$\(/);
  assert.doesNotMatch(installer, /\$\(\$wsUrl\.TrimEnd\('\/'\)\)/);
});

test("independent update task installs a verified release package, authenticates it, and rolls back failures", () => {
  const bootstrap = script("bootstrap-package-updater.ps1");
  const installer = script("install-updater.ps1");
  const updater = script("update-worker.ps1");
  const startLauncher = script("start-worker-launcher.ps1");
  const updateLauncher = script("update-worker-launcher.ps1");
  const main = fs.readFileSync(path.join(process.cwd(), "src", "main.ts"), "utf8");
  assert.match(installer, /Codex Web Remote Worker Update/);
  assert.match(bootstrap, /The running Worker was not stopped/);
  assert.match(bootstrap, /update-worker-launcher\.ps1[\s\S]*Register-ScheduledTask/);
  assert.match(bootstrap, /codex-web-worker-launcher-supervisor-v1/);
  assert.doesNotMatch(bootstrap, /Stop-ScheduledTask|Start-ScheduledTask/);
  assert.match(installer, /start-worker-launcher\.ps1/);
  assert.match(installer, /update-worker-launcher\.ps1/);
  assert.match(installer, /codex-web-worker-launcher-supervisor-v1/);
  assert.match(installer, /core\.optionalLocks=false/);
  assert.match(startLauncher, /worker-current\.json[\s\S]*start-worker\.ps1/);
  assert.match(updateLauncher, /updater\\update-worker\.ps1/);
  assert.match(updateLauncher, /last-known-good Worker package updater/);
  assert.doesNotMatch(updateLauncher, /worker-current\.json|packageReleasePath/);
  assert.match(updateLauncher, /Publish-LauncherFailure/);
  assert.match(updateLauncher, /worker-update-result\.json/);
  assert.match(updateLauncher, /Restart-PreviousWorker/);
  assert.match(updateLauncher, /worker-update\.log/);
  assert.match(installer, /worker-release\.json/);
  assert.match(updater, /remote-worker-release[\s\S]*manifest\.json/);
  assert.match(updater, /Get-FileHash[\s\S]*SHA256/);
  assert.match(updater, /Expand-Archive/);
  assert.match(updater, /worker-current\.json/);
  assert.match(updater, /Initialize-LauncherSupervisorBaseline/);
  assert.match(updater, /Assert-CandidateLauncherCompatibility/);
  assert.match(updater, /codex-web-worker-launcher-supervisor-v1/);
  assert.match(updater, /explicit bootstrap protocol migration/);
  assert.match(updater, /Parser\]::ParseFile/);
  assert.match(updater, /Candidate PowerShell validation requires Windows PowerShell 5\.1/);
  assert.match(updater, /Assert-WorkerProcessIdentity/);
  assert.match(updater, /refusing to terminate it/);
  assert.match(updater, /Stop-Process -Id \$lockedWorkerPid -Force/);
  assert.match(updater, /updaterSha256/);
  assert.match(updater, /Assert-CandidatePowerShell \$extractedRoot[\s\S]*Assert-CandidateLauncherCompatibility \$extractedRoot[\s\S]*Move-Item -LiteralPath \$extractedRoot[\s\S]*Stop-WorkerTask/);
  assert.doesNotMatch(updater, /Copy-Item[\s\S]{0,240}(?:start|update)-worker-launcher\.ps1/);
  assert.doesNotMatch(updater, /Set-ScheduledTask|Register-ScheduledTask/);
  assert.match(updater, /worker-online\.json/);
  assert.match(updater, /Candidate Worker did not authenticate/);
  assert.match(updater, /Restore-PreviousWorker/);
  assert.match(updater, /worker-update-result\.json/);
  assert.match(updater, /worker-update\.log/);
  assert.match(updater, /TimeoutSec 60/);
  assert.match(updater, /TimeoutSec 120/);
  assert.match(updater, /Disable-ScheduledTask[\s\S]*Stop-ScheduledTask/);
  assert.match(updater, /finally \{[\s\S]*Enable-ScheduledTask/);
  assert.match(main, /worker-update-request\.json/);
  assert.match(main, /worker-online\.json/);
  assert.match(main, /schtasks\.exe/);
  assert.match(main, /worker_update_result_ack/);
  assert.match(main, /deferredFailure[\s\S]*finally \{[\s\S]*cleanupCurrentRunDirectory[\s\S]*activeRuns\.delete[\s\S]*if \(deferredFailure\) sendEvent/);
  assert.doesNotMatch(updater, /git\s+-C|npm ci|npm test|reset", "--hard/);
});

test("PowerShell CI requires both Windows PowerShell 5.1 and PowerShell 7", () => {
  const checker = fs.readFileSync(path.join(process.cwd(), "scripts", "check-powershell-syntax.mjs"), "utf8");
  const workflow = fs.readFileSync(path.join(process.cwd(), "..", ".github", "workflows", "remote-worker-powershell.yml"), "utf8");
  assert.match(checker, /--required/);
  assert.match(checker, /process\.exit\(1\)/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /POWERSHELL_EXE: powershell\.exe/);
  assert.match(workflow, /POWERSHELL_EXE: pwsh\.exe/);
  assert.equal((workflow.match(/npm run test:powershell:required/g) ?? []).length, 2);
  assert.equal((workflow.match(/test-update-hardening\.ps1/g) ?? []).length, 2);
});
