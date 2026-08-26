import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const workerRoot = process.cwd();
const required = process.argv.includes("--required") || process.env.REQUIRE_POWERSHELL === "1";
const parserScript = path.join(workerRoot, "scripts", "test-powershell-syntax.ps1");
const candidates = process.env.POWERSHELL_EXE
  ? [process.env.POWERSHELL_EXE]
  : process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];

let executable = null;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
  if (!probe.error && probe.status === 0) {
    executable = candidate;
    break;
  }
}
if (!executable) {
  const message = "PowerShell parser test cannot run: no PowerShell executable is installed on this host.";
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.log(`${message} Skipping only because this is not a required CI gate.`);
  process.exit(0);
}

const result = spawnSync(executable, [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", parserScript, "-WorkerRoot", workerRoot,
], { encoding: "utf8", stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
