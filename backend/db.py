# Version History
# v1.0 - SQLite helpers for subscriptions and answered date tracking.
# v1.1 - User/session auth storage and user-linked subscriptions.

from __future__ import annotations

import os
import secrets
import sqlite3
from datetime import datetime, timedelta
from typing import Any

DB_PATH = os.getenv("FASTING_DB_PATH", os.path.join(os.path.dirname(__file__), "fasting.db"))


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _utc_now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                google_sub TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                name TEXT,
                picture TEXT,
                last_answered_date TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS subscriptions (
                endpoint TEXT PRIMARY KEY,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_sub TEXT,
                last_answered_date TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )
        cols = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(subscriptions)").fetchall()
        }
        if "user_sub" not in cols:
            conn.execute("ALTER TABLE subscriptions ADD COLUMN user_sub TEXT")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                google_sub TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_subscriptions_user_sub ON subscriptions(user_sub)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)")
        conn.commit()


def upsert_user(user: dict[str, Any]) -> None:
    now_iso = _utc_now_iso()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO users (google_sub, email, name, picture, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(google_sub) DO UPDATE SET
                email=excluded.email,
                name=excluded.name,
                picture=excluded.picture,
                updated_at=excluded.updated_at
            """,
            (
                user["google_sub"],
                user["email"],
                user.get("name"),
                user.get("picture"),
                now_iso,
            ),
        )
        conn.commit()


def get_user(google_sub: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT google_sub, email, name, picture, last_answered_date, updated_at
            FROM users
            WHERE google_sub = ?
            """,
            (google_sub,),
        ).fetchone()
    return dict(row) if row else None


def upsert_subscription(subscription: dict[str, Any], user_sub: str) -> None:
    now_iso = _utc_now_iso()
    endpoint = subscription["endpoint"]
    p256dh = subscription["keys"]["p256dh"]
    auth = subscription["keys"]["auth"]

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO subscriptions (endpoint, p256dh, auth, user_sub, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
                p256dh=excluded.p256dh,
                auth=excluded.auth,
                user_sub=excluded.user_sub,
                updated_at=excluded.updated_at
            """,
            (endpoint, p256dh, auth, user_sub, now_iso),
        )
        conn.commit()


def list_subscriptions() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT s.endpoint, s.p256dh, s.auth, s.user_sub, u.last_answered_date
            FROM subscriptions s
            INNER JOIN users u ON s.user_sub = u.google_sub
            """
        ).fetchall()

    return [dict(row) for row in rows]


def update_last_answered_date_for_user(google_sub: str, date_iso: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE users
            SET
                last_answered_date = CASE
                    WHEN last_answered_date IS NULL OR ? > last_answered_date THEN ?
                    ELSE last_answered_date
                END,
                updated_at = ?
            WHERE google_sub = ?
            """,
            (date_iso, date_iso, _utc_now_iso(), google_sub),
        )
        conn.commit()
        return cur.rowcount > 0


def create_session(google_sub: str, ttl_days: int = 30) -> dict[str, Any]:
    token = secrets.token_urlsafe(48)
    now = datetime.utcnow()
    now_iso = now.isoformat(timespec="seconds") + "Z"
    expires_at = (now + timedelta(days=ttl_days)).isoformat(timespec="seconds") + "Z"

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO sessions (token, google_sub, expires_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (token, google_sub, expires_at, now_iso),
        )
        conn.commit()

    return {"token": token, "expires_at": expires_at}


def delete_session(token: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()


def cleanup_expired_sessions() -> None:
    now_iso = _utc_now_iso()
    with _connect() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_iso,))
        conn.commit()


def get_user_by_session(token: str) -> dict[str, Any] | None:
    cleanup_expired_sessions()
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT
                s.token,
                s.expires_at,
                u.google_sub,
                u.email,
                u.name,
                u.picture,
                u.last_answered_date
            FROM sessions s
            INNER JOIN users u ON s.google_sub = u.google_sub
            WHERE s.token = ?
            """,
            (token,),
        ).fetchone()

    return dict(row) if row else None


def remove_subscription(endpoint: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM subscriptions WHERE endpoint = ?", (endpoint,))
        conn.commit()
