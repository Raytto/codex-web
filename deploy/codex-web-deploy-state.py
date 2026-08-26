#!/usr/bin/env python3
"""Small root-owned deployment queue/state helper.

The application database is deliberately not used for deployment state.  This
file is the durable coordination boundary for both the request CLI and the
single systemd consumer.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path


STATUSES = {
    "queued",
    "building",
    "ready",
    "promoting",
    "deployed",
    "superseded",
    "conflict",
    "failed",
    "deferred",
}

PHASES = {
    "queued",
    "building",
    "candidate_ready",
    "waiting_for_jobs",
    "promoting",
    "health_check",
    "deployed",
    "superseded",
    "conflict",
    "deferred",
    "failed",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=30000")
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


def init(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS deployment_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_sha TEXT NOT NULL,
            base_sha TEXT,
            source TEXT NOT NULL DEFAULT 'manual',
            status TEXT NOT NULL,
            phase TEXT NOT NULL DEFAULT 'queued',
            phase_history TEXT NOT NULL DEFAULT '[]',
            requested_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            error_code INTEGER,
            error_summary TEXT,
            superseded_by INTEGER,
            worktree_path TEXT,
            candidate_image TEXT,
            candidate_digest TEXT
        );
        CREATE INDEX IF NOT EXISTS deployment_requests_status_idx
            ON deployment_requests(status, id);
        CREATE INDEX IF NOT EXISTS deployment_requests_target_idx
            ON deployment_requests(target_sha, id);
        CREATE TABLE IF NOT EXISTS deployment_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    columns = {row[1] for row in connection.execute("PRAGMA table_info(deployment_requests)")}
    if "phase" not in columns:
        connection.execute("ALTER TABLE deployment_requests ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued'")
    if "phase_history" not in columns:
        connection.execute("ALTER TABLE deployment_requests ADD COLUMN phase_history TEXT NOT NULL DEFAULT '[]'")
    connection.commit()


def redact_summary(value: object) -> str | None:
    if value is None:
        return None
    text = str(value)[:2000]
    text = __import__("re").sub(r"(?i)((?:password|passwd|token|secret|api[_ -]?key|authorization|credential|验证码|密码|口令)\s*[=:：]\s*)\S+", r"\1[REDACTED]", text)
    return __import__("re").sub(r"\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{48,})\b", "[REDACTED]", text)


def phase_history(row: sqlite3.Row) -> list[dict[str, str]]:
    try:
        value = json.loads(str(row["phase_history"] or "[]"))
    except (TypeError, ValueError, json.JSONDecodeError):
        value = []
    if not isinstance(value, list):
        return []
    result: list[dict[str, str]] = []
    for entry in value[-32:]:
        if not isinstance(entry, dict):
            continue
        phase = entry.get("phase")
        at = entry.get("at")
        if isinstance(phase, str) and phase in PHASES and isinstance(at, str):
            result.append({"phase": phase, "at": at})
    return result


def append_phase(row: sqlite3.Row, phase: str, at: str) -> str:
    history = phase_history(row)
    if history and history[-1]["phase"] == phase:
        return json.dumps(history, ensure_ascii=False, separators=(",", ":"))
    history.append({"phase": phase, "at": at})
    return json.dumps(history[-32:], ensure_ascii=False, separators=(",", ":"))


def write_status_snapshot(connection: sqlite3.Connection, status_file: Path) -> None:
    row = connection.execute("SELECT * FROM deployment_requests ORDER BY id DESC LIMIT 1").fetchone()
    if row is None:
        payload = {"requestId": None, "targetSha": None, "status": "idle", "phase": "idle", "message": "暂无发布请求。"}
    else:
        status = str(row["status"])
        phase = str(row["phase"] or status)
        messages = {
            "queued": "发布请求已入队，等待构建。",
            "building": "正在构建并测试候选版本。",
            "candidate_ready": "候选版本已就绪，等待进入生产切换。",
            "waiting_for_jobs": "发布准备中，等待当前任务完成。",
            "promoting": "生产切换中。",
            "health_check": "正在进行生产健康检查。",
            "deployed": "最近一次发布已完成。",
            "failed": "最近一次发布失败。",
            "conflict": "发布目标与当前生产版本冲突。",
            "deferred": "发布因排空超时而延期。",
            "superseded": "发布请求已被后续请求取代。",
        }
        payload = {
            "requestId": row["id"],
            "targetSha": row["target_sha"],
            "status": status,
            "phase": phase,
            "message": redact_summary(row["error_summary"]) or messages.get(phase, messages.get(status, "发布状态已更新。")),
            "requestedAt": row["requested_at"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "errorCode": row["error_code"],
            "errorSummary": redact_summary(row["error_summary"]),
            "phaseHistory": phase_history(row),
        }
    status_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = status_file.with_name(f".{status_file.name}.tmp.{os.getpid()}")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o644)
    os.replace(temporary, status_file)


def emit(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def cmd_enqueue(connection: sqlite3.Connection, args: argparse.Namespace) -> None:
    init(connection)
    connection.execute("BEGIN IMMEDIATE")
    existing = connection.execute(
        """
        SELECT * FROM deployment_requests
        WHERE target_sha = ? AND status IN ('queued','building','ready','promoting')
        ORDER BY id DESC LIMIT 1
        """,
        (args.target,),
    ).fetchone()
    if existing:
        connection.commit()
        write_status_snapshot(connection, Path(args.status_file))
        emit(dict(existing))
        return
    timestamp = now()
    cursor = connection.execute(
        """
        INSERT INTO deployment_requests
          (target_sha, base_sha, source, status, phase, phase_history, requested_at)
        VALUES (?, ?, ?, 'queued', 'queued', ?, ?)
        """,
        (args.target, args.base, args.source, json.dumps([{"phase": "queued", "at": timestamp}], separators=(",", ":")), timestamp),
    )
    row = connection.execute(
        "SELECT * FROM deployment_requests WHERE id = ?", (cursor.lastrowid,)
    ).fetchone()
    connection.commit()
    write_status_snapshot(connection, Path(args.status_file))
    emit(dict(row))


def cmd_claim(connection: sqlite3.Connection, args: argparse.Namespace) -> None:
    init(connection)
    connection.execute("BEGIN IMMEDIATE")
    row = connection.execute(
        "SELECT * FROM deployment_requests WHERE status = 'queued' ORDER BY id LIMIT 1"
    ).fetchone()
    if row is None:
        connection.commit()
        write_status_snapshot(connection, Path(args.status_file))
        emit(None)
        return
    timestamp = now()
    connection.execute(
        "UPDATE deployment_requests SET status='building', phase='building', phase_history=?, started_at=? WHERE id=?",
        (append_phase(row, "building", timestamp), timestamp, row["id"]),
    )
    row = connection.execute(
        "SELECT * FROM deployment_requests WHERE id = ?", (row["id"],)
    ).fetchone()
    connection.commit()
    write_status_snapshot(connection, Path(args.status_file))
    emit(dict(row))


def cmd_update(connection: sqlite3.Connection, args: argparse.Namespace) -> None:
    if args.status not in STATUSES:
        raise SystemExit(f"invalid status: {args.status}")
    init(connection)
    fields = ["status = ?"]
    values: list[object] = [args.status]
    phase = args.phase
    if phase is None and args.status in {"deployed", "superseded", "conflict", "failed", "deferred"}:
        phase = args.status
    if phase is not None:
        if phase not in PHASES:
            raise SystemExit(f"invalid phase: {phase}")
        fields.append("phase = ?")
        values.append(phase)
        current = connection.execute("SELECT * FROM deployment_requests WHERE id = ?", (args.id,)).fetchone()
        if current is not None:
            fields.append("phase_history = ?")
            values.append(append_phase(current, phase, now()))
    if args.error_code is not None:
        fields.append("error_code = ?")
        values.append(args.error_code)
    if args.error_summary is not None:
        fields.append("error_summary = ?")
        values.append(args.error_summary[:2000])
    if args.worktree_path is not None:
        fields.append("worktree_path = ?")
        values.append(args.worktree_path)
    if args.candidate_image is not None:
        fields.append("candidate_image = ?")
        values.append(args.candidate_image)
    if args.candidate_digest is not None:
        fields.append("candidate_digest = ?")
        values.append(args.candidate_digest)
    if args.status in {"deployed", "superseded", "conflict", "failed", "deferred"}:
        fields.append("finished_at = ?")
        values.append(now())
    values.append(args.id)
    connection.execute("UPDATE deployment_requests SET " + ", ".join(fields) + " WHERE id = ?", values)
    connection.commit()
    row = connection.execute("SELECT * FROM deployment_requests WHERE id = ?", (args.id,)).fetchone()
    if row is None:
        raise SystemExit(f"unknown deployment request: {args.id}")
    write_status_snapshot(connection, Path(args.status_file))
    emit(dict(row))


def cmd_list(connection: sqlite3.Connection, _args: argparse.Namespace) -> None:
    init(connection)
    rows = connection.execute("SELECT * FROM deployment_requests ORDER BY id").fetchall()
    emit([dict(row) for row in rows])


def parser() -> argparse.ArgumentParser:
    value = os.environ.get("CODEX_WEB_DEPLOY_STATE_DB", ".state/deploy/state.sqlite")
    root = argparse.ArgumentParser()
    root.add_argument("--db", default=value)
    root.add_argument("--status-file", default=os.environ.get("CODEX_WEB_DEPLOY_STATUS_FILE", ".state/deploy/status.json"))
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("init")
    enqueue = sub.add_parser("enqueue")
    enqueue.add_argument("--target", required=True)
    enqueue.add_argument("--base")
    enqueue.add_argument("--source", default="manual")
    sub.add_parser("claim")
    update = sub.add_parser("update")
    update.add_argument("--id", type=int, required=True)
    update.add_argument("--status", required=True)
    update.add_argument("--phase")
    update.add_argument("--error-code", type=int)
    update.add_argument("--error-summary")
    update.add_argument("--worktree-path")
    update.add_argument("--candidate-image")
    update.add_argument("--candidate-digest")
    sub.add_parser("list")
    return root


def main() -> int:
    args = parser().parse_args()
    path = Path(args.db)
    with connect(path) as connection:
        if args.command == "init":
            init(connection)
            write_status_snapshot(connection, Path(args.status_file))
        elif args.command == "enqueue":
            cmd_enqueue(connection, args)
        elif args.command == "claim":
            cmd_claim(connection, args)
        elif args.command == "update":
            cmd_update(connection, args)
        elif args.command == "list":
            cmd_list(connection, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
