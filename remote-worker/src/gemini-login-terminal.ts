import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

type Pty = { pid: number; write(data: string): void; kill(signal?: string): void; onData(handler: (data: string) => void): unknown; onExit(handler: (event: { exitCode: number; signal?: number }) => void): unknown };
type PtyModule = { spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; useConpty: boolean }): Pty };
const require = createRequire(import.meta.url);
export function windowsGeminiTerminalAvailable(): boolean { try { return typeof (require("node-pty") as PtyModule).spawn === "function"; } catch { return false; } }

/** ConPTY keeps Google's interactive login on the worker; the web only gets URL/code state. */
export function launchWindowsGeminiTerminal(executable: string, home: string, environment: NodeJS.ProcessEnv): ChildProcess {
  const env = Object.fromEntries(Object.entries(environment).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
  const pty = (require("node-pty") as PtyModule).spawn(executable, [], { name: "xterm-256color", cols: 240, rows: 80, cwd: home, env, useConpty: true });
  return childProcessFromPty(pty);
}

export function childProcessFromPty(pty: Pty): ChildProcess {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new Writable({ write(chunk, _encoding, done) { try { pty.write(chunk.toString()); done(); } catch (error) { done(error as Error); } } });
  stdin.on("error", error => events.emit("error", error));
  const child = Object.assign(events, { pid: pty.pid, stdout, stderr: null, stdin, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals | number) { try { pty.kill(typeof signal === "string" ? signal : undefined); return true; } catch { return false; } },
  });
  pty.onData(data => stdout.write(data));
  pty.onExit(event => { child.exitCode = event.exitCode; stdin.end(); stdout.end(); events.emit("close", event.exitCode); });
  return child as unknown as ChildProcess;
}
