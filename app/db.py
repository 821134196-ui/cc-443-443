"""SQLite 连接、初始化与基础查询封装（标准库，无 ORM）。"""
from __future__ import annotations

import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SCHEMA_PATH = BASE_DIR / "schema.sql"

DB_PATH = Path(os.environ.get("MB_DB", str(BASE_DIR / "data" / "mall_nursing.db")))
PHOTO_DIR = Path(os.environ.get("MB_PHOTOS", str(BASE_DIR / "data" / "photos")))

# 写操作全局串行化：SQLite 单库 + 进程内并发领单竞争
_write_lock = threading.RLock()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 8000")
    return conn


def init_db(conn: sqlite3.Connection | None = None) -> None:
    own = conn is None
    conn = conn or connect()
    with _write_lock:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    if own:
        conn.close()


class Tx:
    """事务上下文；所有写操作经同一把全局锁，保证 check-then-act 原子。"""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def __enter__(self) -> sqlite3.Connection:
        _write_lock.acquire()
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is None:
            self.conn.execute("COMMIT")
        else:
            self.conn.execute("ROLLBACK")
        _write_lock.release()


# ---------- 查询助手 ----------

def query_all(conn, sql: str, params=()):
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def query_one(conn, sql: str, params=()):
    r = conn.execute(sql, params).fetchone()
    return dict(r) if r else None


class PermissionError_(Exception):
    """跨楼层/越权访问。"""


def assert_floor_access(conn, staff_id: int, floor_id: int) -> dict:
    staff = query_one(conn, "SELECT * FROM staff WHERE id=?", (staff_id,))
    if not staff:
        raise PermissionError_("员工不存在")
    rows = conn.execute(
        "SELECT floor_id FROM staff_floors WHERE staff_id=?", (staff_id,)
    ).fetchall()
    allowed = {r["floor_id"] for r in rows}
    # 主管/经理或无授权记录（全楼调度）放行；普通值班员仅允许其授权楼层
    if staff["role"] == "supervisor" or not allowed:
        return staff
    if floor_id not in allowed:
        raise PermissionError_(f"该员工无权访问此楼层")
    return staff


def staff_duties(conn, staff_id: int) -> set[str]:
    return {
        r["duty"]
        for r in conn.execute(
            "SELECT duty FROM staff_duties WHERE staff_id=?", (staff_id,)
        ).fetchall()
    }
