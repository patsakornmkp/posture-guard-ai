# database.py
# จัดการฐานข้อมูล SQLite ของระบบ PostureGuard Backend
#
# เวอร์ชันนี้:
# - ใช้ CVA สำหรับภาวะคอยื่น
# - ใช้ FSA สำหรับภาวะไหล่ห่อ
# - ไม่ใช้ Calibration / Baseline
# - เพิ่มเวลาที่ตรวจเจอผู้ใช้งานจริง: effective_seated_seconds
# - เพิ่มจำนวนแจ้งเตือนแยกตามสาเหตุ
# - เพิ่ม LINE binding แบบ multi-user โดยไม่ลบข้อมูล users เดิม

from __future__ import annotations

import hashlib
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Optional

import config


# ========================
# Connection helper
# ========================

def _ensure_db_folder() -> None:
    config.DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)


@contextmanager
def get_connection():
    _ensure_db_folder()
    conn = sqlite3.connect(config.DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ========================
# Schema
# ========================

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,

    line_user_id TEXT,
    line_notify_enabled INTEGER DEFAULT 0,
    line_link_code TEXT,
    line_link_code_expires_at DATETIME,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,

    planned_duration_min INTEGER,

    good_seconds REAL DEFAULT 0,
    bad_seconds REAL DEFAULT 0,
    effective_seated_seconds REAL DEFAULT 0,

    forward_head_seconds REAL DEFAULT 0,
    rounded_shoulder_seconds REAL DEFAULT 0,

    alert_count INTEGER DEFAULT 0,
    forward_head_alert_count INTEGER DEFAULT 0,
    rounded_shoulder_alert_count INTEGER DEFAULT 0,

    risk_level TEXT,

    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS posture_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    issue_type TEXT NOT NULL,
    cva_angle REAL,
    fsa_angle REAL,
    duration REAL,

    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    alert_type TEXT NOT NULL,
    message TEXT,

    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
"""


def _column_exists(
    conn: sqlite3.Connection,
    table_name: str,
    column_name: str,
) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return any(row["name"] == column_name for row in rows)


def _add_column_if_missing(
    conn: sqlite3.Connection,
    table_name: str,
    column_name: str,
    column_definition: str,
) -> None:
    if _column_exists(conn, table_name, column_name):
        return

    conn.execute(
        f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"
    )


def _create_index_if_missing(
    conn: sqlite3.Connection,
    index_name: str,
    sql: str,
) -> None:
    exists = conn.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type = 'index'
          AND name = ?
        LIMIT 1
        """,
        (index_name,),
    ).fetchone()

    if exists:
        return

    conn.execute(sql)


def init_database() -> None:
    """
    สร้างฐานข้อมูลและ migration แบบปลอดภัย

    หมายเหตุ:
    - ถ้าเป็น database ใหม่ จะสร้าง schema ใหม่ตาม SCHEMA_SQL
    - ถ้าเป็น database เก่า จะเพิ่ม column ใหม่ที่จำเป็นด้วย ALTER TABLE
    - ไม่ drop table
    - ไม่ลบข้อมูล users/sessions เดิม
    """
    with get_connection() as conn:
        conn.executescript(SCHEMA_SQL)

        # ---- users: migration จากฐานข้อมูลเก่า ----
        _add_column_if_missing(
            conn,
            table_name="users",
            column_name="full_name",
            column_definition="TEXT",
        )

        # ---- users: LINE binding columns ----
        _add_column_if_missing(
            conn,
            table_name="users",
            column_name="line_user_id",
            column_definition="TEXT",
        )

        _add_column_if_missing(
            conn,
            table_name="users",
            column_name="line_notify_enabled",
            column_definition="INTEGER DEFAULT 0",
        )

        _add_column_if_missing(
            conn,
            table_name="users",
            column_name="line_link_code",
            column_definition="TEXT",
        )

        _add_column_if_missing(
            conn,
            table_name="users",
            column_name="line_link_code_expires_at",
            column_definition="DATETIME",
        )

        _create_index_if_missing(
            conn,
            index_name="idx_users_line_link_code",
            sql="CREATE INDEX idx_users_line_link_code ON users(line_link_code)",
        )

        _create_index_if_missing(
            conn,
            index_name="idx_users_line_user_id",
            sql="CREATE INDEX idx_users_line_user_id ON users(line_user_id)",
        )

        # ---- sessions: migration จากฐานข้อมูลเก่า ----
        _add_column_if_missing(
            conn,
            table_name="sessions",
            column_name="effective_seated_seconds",
            column_definition="REAL DEFAULT 0",
        )

        _add_column_if_missing(
            conn,
            table_name="sessions",
            column_name="forward_head_seconds",
            column_definition="REAL DEFAULT 0",
        )

        _add_column_if_missing(
            conn,
            table_name="sessions",
            column_name="rounded_shoulder_seconds",
            column_definition="REAL DEFAULT 0",
        )

        _add_column_if_missing(
            conn,
            table_name="sessions",
            column_name="forward_head_alert_count",
            column_definition="INTEGER DEFAULT 0",
        )

        _add_column_if_missing(
            conn,
            table_name="sessions",
            column_name="rounded_shoulder_alert_count",
            column_definition="INTEGER DEFAULT 0",
        )

        _add_column_if_missing(
            conn,
            table_name="posture_logs",
            column_name="fsa_angle",
            column_definition="REAL",
        )


# ========================
# Password
# ========================

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def verify_password(password: str, password_hash: str) -> bool:
    return hash_password(password) == password_hash


# ========================
# User
# ========================

def create_user(username: str, password: str, full_name: str = "") -> int:
    with get_connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO users (username, password_hash, full_name)
            VALUES (?, ?, ?)
            """,
            (username, hash_password(password), full_name),
        )
        return cur.lastrowid


def get_user_by_id(user_id: int) -> Optional[dict]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()

        return dict(row) if row else None


def get_user_by_username(username: str) -> Optional[dict]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?",
            (username,),
        ).fetchone()

        return dict(row) if row else None


def authenticate(username: str, password: str) -> Optional[dict]:
    user = get_user_by_username(username)

    if not user:
        return None

    if not verify_password(password, user["password_hash"]):
        return None

    user.pop("password_hash", None)
    return user


# ========================
# LINE binding per user
# ========================

def _utc_datetime_string(value: datetime) -> str:
    """เก็บเวลาแบบ UTC ให้เทียบกับ SQLite CURRENT_TIMESTAMP ได้ตรงกัน"""
    return value.replace(microsecond=0).strftime("%Y-%m-%d %H:%M:%S")


def _normalize_line_code(code: str) -> str:
    return str(code or "").strip().upper()


def _generate_line_link_code() -> str:
    """สร้างรหัสรูปแบบ PG-482913"""
    return f"PG-{secrets.randbelow(900000) + 100000}"


def get_user_line_status(user_id: int) -> Optional[dict]:
    """
    คืนสถานะ LINE binding ของ user เดียว

    ไม่คืนค่า token หรือ secret ใด ๆ
    ใช้สำหรับ endpoint:
    GET /notification/line/status?user_id={user_id}
    """
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT
                id,
                username,
                full_name,
                line_user_id,
                COALESCE(line_notify_enabled, 0) AS line_notify_enabled,
                line_link_code,
                line_link_code_expires_at,
                CASE
                    WHEN line_link_code IS NOT NULL
                     AND line_link_code_expires_at IS NOT NULL
                     AND line_link_code_expires_at > CURRENT_TIMESTAMP
                    THEN 1 ELSE 0
                END AS line_link_code_active
            FROM users
            WHERE id = ?
            """,
            (user_id,),
        ).fetchone()

        return dict(row) if row else None


def create_line_link_code(user_id: int, ttl_minutes: int = 10) -> Optional[dict]:
    """
    สร้างรหัสผูก LINE ให้ user

    - ไม่แตะ password/session เดิม
    - ถ้ารหัสซ้ำจะสุ่มใหม่
    - รหัสหมดอายุตาม ttl_minutes
    """
    expires_at = _utc_datetime_string(
        datetime.utcnow() + timedelta(minutes=max(1, ttl_minutes))
    )

    with get_connection() as conn:
        user_exists = conn.execute(
            "SELECT 1 FROM users WHERE id = ? LIMIT 1",
            (user_id,),
        ).fetchone()

        if not user_exists:
            return None

        code = _generate_line_link_code()

        for _ in range(20):
            duplicate = conn.execute(
                """
                SELECT 1
                FROM users
                WHERE line_link_code = ?
                  AND line_link_code_expires_at > CURRENT_TIMESTAMP
                LIMIT 1
                """,
                (code,),
            ).fetchone()

            if not duplicate:
                break

            code = _generate_line_link_code()
        else:
            raise RuntimeError("Cannot generate unique LINE link code")

        conn.execute(
            """
            UPDATE users
            SET line_link_code = ?,
                line_link_code_expires_at = ?
            WHERE id = ?
            """,
            (code, expires_at, user_id),
        )

    return get_user_line_status(user_id)


def set_user_line_notify_enabled(user_id: int, enabled: bool) -> Optional[dict]:
    """
    เปิด/ปิด LINE notification เฉพาะ user นั้น

    หมายเหตุ:
    - ฟังก์ชันนี้ไม่ลบ line_user_id
    - ถ้าปิด toggle จะยังถือว่าผูกบัญชีอยู่ แต่ไม่ส่งแจ้งเตือน
    """
    with get_connection() as conn:
        user_exists = conn.execute(
            "SELECT 1 FROM users WHERE id = ? LIMIT 1",
            (user_id,),
        ).fetchone()

        if not user_exists:
            return None

        conn.execute(
            """
            UPDATE users
            SET line_notify_enabled = ?
            WHERE id = ?
            """,
            (1 if enabled else 0, user_id),
        )

    return get_user_line_status(user_id)


def clear_expired_line_link_code(code: str) -> None:
    """
    ล้างรหัสที่หมดอายุแล้วตาม code

    ใช้กรณี user ส่งรหัสเข้ามาใน LINE แต่รหัสหมดอายุแล้ว
    เพื่อไม่ให้รหัสค้างในฐานข้อมูล
    """
    normalized_code = _normalize_line_code(code)

    if not normalized_code:
        return

    with get_connection() as conn:
        conn.execute(
            """
            UPDATE users
            SET line_link_code = NULL,
                line_link_code_expires_at = NULL
            WHERE UPPER(line_link_code) = ?
              AND line_link_code_expires_at <= CURRENT_TIMESTAMP
            """,
            (normalized_code,),
        )


def clear_all_expired_line_link_codes() -> int:
    """
    ล้างรหัสผูก LINE ทั้งหมดที่หมดอายุแล้ว

    ไม่แตะ line_user_id เดิม
    ไม่ปิด line_notify_enabled ของ user ที่ผูกสำเร็จแล้ว
    """
    with get_connection() as conn:
        cur = conn.execute(
            """
            UPDATE users
            SET line_link_code = NULL,
                line_link_code_expires_at = NULL
            WHERE line_link_code IS NOT NULL
              AND line_link_code_expires_at IS NOT NULL
              AND line_link_code_expires_at <= CURRENT_TIMESTAMP
            """
        )

        return cur.rowcount


def bind_line_user_by_code(code: str, line_user_id: str) -> Optional[dict]:
    """
    ผูก LINE userId จาก webhook เข้ากับ user ในเว็บ

    เงื่อนไข:
    - code ต้องตรงกับ users.line_link_code
    - code ต้องยังไม่หมดอายุ
    - เมื่อผูกสำเร็จจะเปิด line_notify_enabled = 1
    - ล้าง line_link_code และ line_link_code_expires_at ทันที
    """
    normalized_code = _normalize_line_code(code)
    clean_line_user_id = str(line_user_id or "").strip()

    if not normalized_code or not clean_line_user_id:
        return None

    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT id
            FROM users
            WHERE UPPER(line_link_code) = ?
              AND line_link_code_expires_at > CURRENT_TIMESTAMP
            LIMIT 1
            """,
            (normalized_code,),
        ).fetchone()

        if not row:
            return None

        user_id = int(row["id"])

        conn.execute(
            """
            UPDATE users
            SET line_user_id = ?,
                line_notify_enabled = 1,
                line_link_code = NULL,
                line_link_code_expires_at = NULL
            WHERE id = ?
            """,
            (clean_line_user_id, user_id),
        )

    return get_user_line_status(user_id)


# ========================
# Session
# ========================

def create_session(user_id: int, planned_duration_min: int) -> int:
    with get_connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO sessions (user_id, planned_duration_min)
            VALUES (?, ?)
            """,
            (user_id, planned_duration_min),
        )
        return cur.lastrowid


def close_session(
    session_id: int,
    good_seconds: float,
    bad_seconds: float,
    forward_head_seconds: float,
    rounded_shoulder_seconds: float,
    alert_count: int,
    risk_level: str,
    forward_head_alert_count: int = 0,
    rounded_shoulder_alert_count: int = 0,
    effective_seated_seconds: float = 0.0,
) -> None:
    """
    ปิด session และบันทึกสรุปผล

    ระบบใหม่ใช้:
    - good_seconds = เวลาที่นับเป็นท่าทางเหมาะสม
    - bad_seconds = เวลาหลังมี alert active แล้ว
    - effective_seated_seconds = เวลาที่ตรวจเจอผู้ใช้งานจริงในกล้อง
    - forward_head_seconds = เวลาคอยื่นหลังแจ้งเตือนแล้ว
    - rounded_shoulder_seconds = เวลาไหล่ห่อหลังแจ้งเตือนแล้ว
    - alert_count = จำนวนแจ้งเตือนรวม
    - forward_head_alert_count = จำนวนแจ้งเตือนคอยื่น
    - rounded_shoulder_alert_count = จำนวนแจ้งเตือนไหล่ห่อ
    """
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE sessions
            SET end_time = CURRENT_TIMESTAMP,
                good_seconds = ?,
                bad_seconds = ?,
                effective_seated_seconds = ?,
                forward_head_seconds = ?,
                rounded_shoulder_seconds = ?,
                alert_count = ?,
                forward_head_alert_count = ?,
                rounded_shoulder_alert_count = ?,
                risk_level = ?
            WHERE id = ?
            """,
            (
                good_seconds,
                bad_seconds,
                effective_seated_seconds,
                forward_head_seconds,
                rounded_shoulder_seconds,
                alert_count,
                forward_head_alert_count,
                rounded_shoulder_alert_count,
                risk_level,
                session_id,
            ),
        )


def get_user_sessions(user_id: int, limit: int = 50) -> list[dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM sessions
            WHERE user_id = ?
            ORDER BY start_time DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()

        return [dict(row) for row in rows]


# ========================
# Logs
# ========================

def log_posture_issue(
    session_id: int,
    issue_type: str,
    cva_angle: Optional[float],
    fsa_angle: Optional[float],
    duration: float,
) -> None:
    """
    บันทึกเหตุการณ์ท่าทางไม่เหมาะสม

    issue_type ที่แนะนำ:
    - forward_head
    - rounded_shoulder
    """
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO posture_logs
            (session_id, issue_type, cva_angle, fsa_angle, duration)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                session_id,
                issue_type,
                cva_angle,
                fsa_angle,
                duration,
            ),
        )


def get_session_logs(session_id: int) -> list[dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM posture_logs
            WHERE session_id = ?
            ORDER BY timestamp ASC
            """,
            (session_id,),
        ).fetchall()

        return [dict(row) for row in rows]


# ========================
# Alerts
# ========================

def log_alert(session_id: int, alert_type: str, message: str) -> None:
    """
    บันทึกการแจ้งเตือน

    alert_type ที่แนะนำ:
    - forward_head
    - rounded_shoulder
    """
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO alerts (session_id, alert_type, message)
            VALUES (?, ?, ?)
            """,
            (session_id, alert_type, message),
        )


def get_session_alerts(session_id: int) -> list[dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM alerts
            WHERE session_id = ?
            ORDER BY timestamp ASC
            """,
            (session_id,),
        ).fetchall()

        return [dict(row) for row in rows]