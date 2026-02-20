# Version History
# v1.0 - SQLite helpers for subscriptions and answered date tracking.

from __future__ import annotations

import os
import sqlite3
from datetime import datetime
from typing import Any

DB_PATH = os.getenv("FASTING_DB_PATH", os.path.join(os.path.dirname(__file__), "fasting.db"))


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS subscriptions (
                endpoint TEXT PRIMARY KEY,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                last_answered_date TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


def upsert_subscription(subscription: dict[str, Any]) -> None:
    now_iso = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    endpoint = subscription["endpoint"]
    p256dh = subscription["keys"]["p256dh"]
    auth = subscription["keys"]["auth"]

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO subscriptions (endpoint, p256dh, auth, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
                p256dh=excluded.p256dh,
                auth=excluded.auth,
                updated_at=excluded.updated_at
            """,
            (endpoint, p256dh, auth, now_iso),
        )
        conn.commit()


def list_subscriptions() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT endpoint, p256dh, auth, last_answered_date FROM subscriptions"
        ).fetchall()

    return [dict(row) for row in rows]


def update_last_answered_date(endpoint: str, date_iso: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE subscriptions
            SET last_answered_date = ?, updated_at = ?
            WHERE endpoint = ?
            """,
            (date_iso, datetime.utcnow().isoformat(timespec="seconds") + "Z", endpoint),
        )
        conn.commit()
        return cur.rowcount > 0


def remove_subscription(endpoint: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM subscriptions WHERE endpoint = ?", (endpoint,))
        conn.commit()
