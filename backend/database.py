# database.py
# จัดการฐานข้อมูล SQLite ของระบบ PostureGuard Backend
#
# เวอร์ชันใหม่:
# - ใช้ CVA สำหรับภาวะคอยื่น
# - ใช้ FSA สำหรับภาวะไหล่ห่อ
# - ลบ warning_seconds ออกจาก schema และ logic หลัก
# - ลบการใช้งาน hunched_back / หลังคร่อม ออกจาก logic หลัก
# - เพิ่มเวลาที่ตรวจเจอผู้ใช้งานจริง:
#   effective_seated_seconds
# - เพิ่มจำนวนแจ้งเตือนแยกตามสาเหตุ:
#   forward_head_alert_count
#   rounded_shoulder_alert_count
# - เพิ่ม migration รองรับฐานข้อมูลเก่าที่อาจยังไม่มี column ใหม่

import sqlite3
import hashlib
from contextlib import contextmanager
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


def init_database() -> None:
    """
    สร้างฐานข้อมูลและ migration เบื้องต้น

    หมายเหตุ:
    - ถ้าเป็น database ใหม่ จะสร้าง schema ใหม่ตาม SCHEMA_SQL
    - ถ้าเป็น database เก่า จะเพิ่ม column ใหม่ที่จำเป็น
    - warning_seconds เดิมอาจยังค้างอยู่ในไฟล์ .db เก่า
      แต่ระบบใหม่จะไม่อ่าน/ไม่เขียนค่านี้แล้ว
    """
    with get_connection() as conn:
        conn.executescript(SCHEMA_SQL)

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