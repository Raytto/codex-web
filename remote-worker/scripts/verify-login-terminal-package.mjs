import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) throw new Error("A packaged node-pty directory is required");
const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (metadata.name !== "node-pty" || metadata.version !== "1.1.0") throw new Error("Windows login terminal package version mismatch");
for (const file of ["lib/index.js", "lib/windowsTerminal.js", "lib/windowsPtyAgent.js", "lib/utils.js", "lib/conpty_console_list_agent.js"]) {
  if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Windows login terminal runtime missing: ${file}`);
}
for (const arch of ["x64", "arm64"]) for (const file of ["conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"]) {
  const target = path.join(root, "prebuilds", `win32-${arch}`, file);
  const descriptor = fs.openSync(target, "r");
  const signature = Buffer.alloc(2);
  try { fs.readSync(descriptor, signature, 0, 2, 0); } finally { fs.closeSync(descriptor); }
  if (signature.toString("ascii") !== "MZ") throw new Error(`Windows login terminal binary invalid: ${arch}/${file}`);
}
console.log("Windows Gemini login terminal: pinned ConPTY runtime and PE binaries verified");
