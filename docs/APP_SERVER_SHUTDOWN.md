# App-server shutdown ownership barrier

Codex Web previously turned an already completed model turn into a failed Job when the Codex CLI had not exited within ten seconds. The timeout also returned without cleaning up that runtime. A completed protocol turn alone does not prove that its session writer has exited.

The Linux app-server now has a private process group. It receives the same EOF and SIGTERM shutdown request, with a ten-second graceful interval. If runtime processes remain, shutdown records numeric PID/state diagnostics and sends SIGKILL only to that group. It then waits up to five seconds for both the direct child exit event and the absence of live group members. Zombies have no open descriptors and do not retain a writer. Inspection or termination errors fail closed. Non-Linux hosts retain the bounded graceful-only behavior.

The completed result is returned only after that barrier. A failed/interrupted turn still rejects with its original error when cleanup succeeds; cleanup does not replay any user action or change historical failed Jobs. This bounds the observed stuck-shutdown failure without claiming to identify every possible native runtime hang.

Regression coverage includes graceful exit, an unresponsive wrapper/native pair, an orphan native writer, an unrelated process group, missing exit confirmation, successful completion through escalation and preservation of the original failed-turn error. Production acceptance must include a real model turn followed by resume, along with deployment revision and service checks.
