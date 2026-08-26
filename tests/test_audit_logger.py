import importlib.util
import gzip
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / ".deploy" / "codex-web-audit.py"
SPEC = importlib.util.spec_from_file_location("chatgpt_work_audit", SCRIPT)
assert SPEC and SPEC.loader
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class AuditLoggerTests(unittest.TestCase):
    def test_parses_login_and_message_without_content(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "audit.sqlite3"
            connection = audit.connect(database)
            records = [
                {
                    "request_id": "login-1",
                    "occurred_at": "2026-07-16T12:00:00+08:00",
                    "ip_address": "::ffff:203.0.113.7",
                    "method": "POST",
                    "uri": "/api/auth/login",
                    "status": 200,
                    "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1",
                    "client_hint_platform": "-",
                },
                {
                    "request_id": "message-1",
                    "occurred_at": "2026-07-16T12:01:00+08:00",
                    "ip_address": "2001:db8::1",
                    "method": "POST",
                    "uri": "/api/conversations/conversation-123/messages",
                    "status": 202,
                    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
                    "client_hint_platform": '"Windows"',
                },
            ]
            for record in records:
                raw = (json.dumps(record) + "\n").encode()
                event = audit.parse_event(raw)
                self.assertIsNotNone(event)
                audit.insert_event(connection, event)
                audit.insert_event(connection, event)
            connection.commit()

            rows = connection.execute(
                "SELECT event_type,outcome,ip_address,device,conversation_id,user_agent FROM audit_events ORDER BY id"
            ).fetchall()
            connection.close()

            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0][0:3], ("login", "success", "203.0.113.7"))
            self.assertIn("iPhone", rows[0][3])
            self.assertEqual(rows[0][4], None)
            self.assertEqual(rows[1][0:3], ("message", "accepted", "2001:db8::1"))
            self.assertIn("Windows PC", rows[1][3])
            self.assertEqual(rows[1][4], "conversation-123")
            self.assertNotIn("message", rows[1][5].lower())

    def test_classifies_failed_and_rejected_attempts(self):
        self.assertEqual(
            audit.classify("/api/auth/login", 401),
            ("login", "denied", None),
        )
        self.assertEqual(
            audit.classify("/api/auth/login", 429),
            ("login", "rate_limited", None),
        )
        self.assertEqual(
            audit.classify(
                "/api/conversations/id/messages", 409
            ),
            ("message", "busy", "id"),
        )
        self.assertIsNone(audit.classify("/api/conversations", 201))

    def test_backfill_reads_compressed_rotations_idempotently_without_resetting_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "codex-web-audit.jsonl"
            database = root / "audit.sqlite3"
            rotated = {
                "request_id": "rotated-login",
                "occurred_at": "2026-08-03T10:00:00Z",
                "ip_address": "203.0.113.4",
                "method": "POST",
                "uri": "/api/auth/login",
                "status": 401,
                "user_agent": "Synthetic Rotation",
            }
            current = {
                **rotated,
                "request_id": "current-message",
                "occurred_at": "2026-08-04T10:00:00Z",
                "uri": "/api/conversations/test/messages",
                "status": 202,
            }
            with gzip.open(root / "codex-web-audit.jsonl.2.gz", "wb") as handle:
                handle.write((json.dumps(rotated) + "\n").encode())
            source.write_text(
                json.dumps(current) + "\n" + json.dumps(rotated) + "\n",
                encoding="utf-8",
            )

            first = audit.backfill_sources(source, database)
            second = audit.backfill_sources(source, database)
            self.assertEqual(first["inserted"], 2)
            self.assertEqual(second["inserted"], 0)
            connection = sqlite3.connect(database)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0], 2)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM ingest_state").fetchone()[0], 0)
            connection.close()

    def test_status_reports_inode_offset_lag_and_parse_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "codex-web-audit.jsonl"
            database = root / "audit.sqlite3"
            record = {
                "request_id": "health-login",
                "occurred_at": "2026-08-04T10:00:00Z",
                "ip_address": "203.0.113.8",
                "method": "POST",
                "uri": "/api/auth/login",
                "status": 401,
                "user_agent": "Health Test",
            }
            raw = (json.dumps(record) + "\n").encode()
            source.write_bytes(raw)
            connection = audit.connect(database)
            stat = source.stat()
            audit.consume_line(connection, raw, str(source), stat.st_dev, stat.st_ino, len(raw))
            audit.consume_line(connection, b"not-json\n", str(source), stat.st_dev, stat.st_ino, len(raw))
            connection.close()
            metrics, healthy = audit.audit_status(source, database, 300)
            self.assertTrue(healthy)
            self.assertEqual(metrics["source_inode"], stat.st_ino)
            self.assertEqual(metrics["ingest_offset"], len(raw))
            self.assertEqual(metrics["pending_bytes"], 0)
            self.assertEqual(metrics["parse_failures"], 1)
            self.assertEqual(metrics["database_max_occurred_at"], record["occurred_at"])


if __name__ == "__main__":
    unittest.main()
