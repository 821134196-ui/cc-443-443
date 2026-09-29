"""HTTP 服务：标准库 http.server，零第三方依赖。

- JSON API 前缀 /api/
- 静态前端位于 app/static
- 故障照片保存到本地 data/photos（base64 上传，防止路径穿越）
- 后台线程：到点触发补给时限 / 复检提醒
"""
from __future__ import annotations

import base64
import json
import mimetypes
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import services
from .config import WATER_MAX_C, WATER_MIN_C
from .db import (
    PHOTO_DIR, PermissionError_, connect, init_db, now_iso,
    query_one, assert_floor_access,
)
from .temperature import adapter

STATIC_DIR = Path(__file__).resolve().parent / "static"

# (method, regex, handler-name)
ROUTES: list[tuple[str, re.Pattern, str]] = []


def route(method: str, pattern: str):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn.__name__))
        return fn

    return deco


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class App:
    """无状态应用对象；每个请求新建 SQLite 连接。"""

    def __init__(self) -> None:
        init_db()
        PHOTO_DIR.mkdir(parents=True, exist_ok=True)
        self._stop = threading.Event()
        self._bg = threading.Thread(target=self._background_loop, name="reminders", daemon=True)
        self._bg.start()

    def _background_loop(self) -> None:
        while not self._stop.wait(20):
            try:
                conn = connect()
                try:
                    services.fire_due_reminders(conn)
                finally:
                    conn.close()
            except Exception as exc:  # 后台任务不应导致进程退出
                print(f"[reminder] {exc}", flush=True)

    def stop(self) -> None:
        self._stop.set()

    # ---------- 辅助 ----------

    def staff(self, conn, h: "Handler", floor_id=None):
        raw = h.headers.get("X-Staff-Id")
        if not raw:
            raise ApiError(401, "缺少值班人员身份（X-Staff-Id）")
        try:
            staff_id = int(raw)
        except ValueError:
            raise ApiError(401, "身份无效")
        staff = query_one(conn, "SELECT * FROM staff WHERE id=?", (staff_id,))
        if not staff:
            raise ApiError(401, "员工不存在")
        if floor_id is not None:
            try:
                assert_floor_access(conn, staff_id, floor_id)
            except PermissionError_ as exc:
                raise ApiError(403, str(exc))
        return staff

    def floor_of_room(self, conn, room_id: int) -> int:
        r = query_one(conn, "SELECT floor_id FROM rooms WHERE id=?", (room_id,))
        if not r:
            raise ApiError(404, "房间不存在")
        return r["floor_id"]

    def floor_of_facility(self, conn, facility_id: int) -> int:
        r = query_one(
            conn, "SELECT r.floor_id FROM rooms r JOIN facilities f ON f.room_id=r.id WHERE f.id=?",
            (facility_id,),
        )
        if not r:
            raise ApiError(404, "设施不存在")
        return r["floor_id"]

    def floor_of_order(self, conn, order_id: int) -> int:
        r = query_one(
            conn, "SELECT r.floor_id FROM rooms r JOIN supply_orders o ON o.room_id=r.id WHERE o.id=?",
            (order_id,),
        )
        if not r:
            raise ApiError(404, "补给单不存在")
        return r["floor_id"]

    # ---------- 基础数据 ----------

    @route("GET", r"/api/staff")
    def staff_list(self, conn, h, body, q):
        return [
            {**dict(r),
             "duties": [d["duty"] for d in conn.execute(
                 "SELECT duty FROM staff_duties WHERE staff_id=?", (r["id"],)).fetchall()],
             "floors": [d["floor_id"] for d in conn.execute(
                 "SELECT floor_id FROM staff_floors WHERE staff_id=?", (r["id"],)).fetchall()]}
            for r in conn.execute("SELECT * FROM staff ORDER BY id").fetchall()
        ]

    @route("GET", r"/api/floors")
    def floors(self, conn, h, body, q):
        return services.floor_list(conn)

    @route("GET", r"/api/overview")
    def overview(self, conn, h, body, q):
        staff = self.staff(conn, h)
        floor_id = int(q["floor_id"][0]) if q.get("floor_id") else None
        if floor_id is not None:
            assert_floor_access(conn, staff["id"], floor_id)
        data = services.overview(conn, staff["id"], floor_id)
        # 普通值班员只看到自己的楼层
        from .db import staff_duties
        allowed_floors = {d["floor_id"] for d in conn.execute(
            "SELECT floor_id FROM staff_floors WHERE staff_id=?", (staff["id"],)).fetchall()}
        if staff["role"] != "supervisor" and allowed_floors:
            data = [g for g in data if g["floor"]["id"] in allowed_floors]
        return data

    @route("GET", r"/api/rooms/(?P<rid>\d+)")
    def room(self, conn, h, body, q, rid):
        room = services.room_detail(conn, int(rid))
        self.staff(conn, h, room["floor_id"])
        return room

    # ---------- 班次 / 巡检 ----------

    @route("GET", r"/api/shifts")
    def shifts(self, conn, h, body, q):
        staff = self.staff(conn, h)
        sql = """SELECT sh.*, fl.name floor_name, s.name staff_name FROM shifts sh
                 JOIN floors fl ON fl.id=sh.floor_id JOIN staff s ON s.id=sh.staff_id"""
        where, params = [], []
        if q.get("floor_id"):
            where.append("sh.floor_id=?")
            params.append(int(q["floor_id"][0]))
        if q.get("status"):
            where.append("sh.status=?")
            params.append(q["status"][0])
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY sh.id DESC"
        rows = [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]
        allowed = {d["floor_id"] for d in conn.execute(
            "SELECT floor_id FROM staff_floors WHERE staff_id=?", (staff["id"],)).fetchall()}
        if staff["role"] != "supervisor" and allowed:
            rows = [r for r in rows if r["floor_id"] in allowed]
        return rows

    @route("POST", r"/api/shifts")
    def create_shift(self, conn, h, body, q):
        floor_id = int(body["floor_id"])
        staff = self.staff(conn, h, floor_id)
        return services.open_shift(conn, staff["id"], floor_id, body.get("label") or "当班")

    @route("GET", r"/api/shifts/(?P<sid>\d+)/form")
    def shift_form(self, conn, h, body, q, sid):
        form = services.shift_form(conn, int(sid))
        self.staff(conn, h, form["shift"]["floor_id"])
        return form

    @route("POST", r"/api/inspections")
    def submit_inspection(self, conn, h, body, q):
        shift = query_one(conn, "SELECT * FROM shifts WHERE id=?", (int(body["shift_id"]),))
        if not shift:
            raise ApiError(404, "班次不存在")
        self.staff(conn, h, shift["floor_id"])
        return services.submit_inspection(
            conn,
            shift_id=int(body["shift_id"]),
            room_id=int(body["room_id"]),
            staff_id=int(h.headers["X-Staff-Id"]),
            items=body.get("items", []),
            quantities=body.get("quantities", {}),
            temp_value=body.get("temp_value"),
        )

    @route("POST", r"/api/disinfection")
    def disinfection(self, conn, h, body, q):
        floor = self.floor_of_room(conn, int(body["room_id"]))
        self.staff(conn, h, floor)
        return services.record_disinfection(
            conn, shift_id=int(body["shift_id"]), room_id=int(body["room_id"]),
            facility_id=int(body["facility_id"]),
            staff_id=int(h.headers["X-Staff-Id"]), note=body.get("note", ""),
        )

    @route("POST", r"/api/snapshots")
    def snapshot(self, conn, h, body, q):
        shift = query_one(conn, "SELECT * FROM shifts WHERE id=?", (int(body["shift_id"]),))
        if not shift:
            raise ApiError(404, "班次不存在")
        self.staff(conn, h, shift["floor_id"])
        return services.generate_snapshot(
            conn, shift_id=shift["id"], room_id=int(body["room_id"]),
            staff_id=int(h.headers["X-Staff-Id"]),
        )

    # ---------- 温度 ----------

    @route("GET", r"/api/facilities/(?P<fid>\d+)/temperature")
    def temperature(self, conn, h, body, q, fid):
        fid = int(fid)
        floor = self.floor_of_facility(conn, fid)
        self.staff(conn, h, floor)
        fac = query_one(conn, "SELECT * FROM facilities WHERE id=?", (fid,))
        if fac["type"] != "water_heater":
            raise ApiError(400, "仅热水设备有温度读数")
        reading = adapter.read(fac["code"])
        conn.execute(
            "INSERT INTO temperature_readings(facility_id,value_c,status,source,recorded_at) "
            "VALUES(?,?,?, 'adapter',?)",
            (fid, reading.value_c, reading.status, now_iso()),
        )
        return {
            "value_c": reading.value_c,
            "status": reading.status,
            "min_c": WATER_MIN_C,
            "max_c": WATER_MAX_C,
        }

    @route("POST", r"/api/facilities/(?P<fid>\d+)/temperature/override")
    def temperature_override(self, conn, h, body, q, fid):
        """模拟器控制：固定下一次读数（演示/测试温度异常用）。value=null 清除。"""
        fid = int(fid)
        floor = self.floor_of_facility(conn, fid)
        self.staff(conn, h, floor)
        fac = query_one(conn, "SELECT * FROM facilities WHERE id=?", (fid,))
        if fac["type"] != "water_heater":
            raise ApiError(400, "仅热水设备有温度读数")
        if body.get("value_c") is None:
            adapter._overrides.pop(fac["code"], None)
        else:
            adapter._overrides[fac["code"]] = float(body["value_c"])
        return {"ok": True, "value_c": adapter._overrides.get(fac["code"])}

    # ---------- 闭用 / 报障 ----------

    @route("POST", r"/api/closures")
    def create_closure(self, conn, h, body, q):
        room_id = int(body["room_id"])
        self.staff(conn, h, self.floor_of_room(conn, room_id))
        return services.create_closure(
            conn, scope=body.get("scope", "room"), room_id=room_id,
            facility_id=body.get("facility_id"), reason=body.get("reason", "临时闭用"),
            staff_id=int(h.headers["X-Staff-Id"]), hours=body.get("hours"),
        )

    @route("POST", r"/api/closures/(?P<cid>\d+)/end")
    def end_closure(self, conn, h, body, q, cid):
        cl = query_one(conn, "SELECT * FROM closures WHERE id=?", (int(cid),))
        if not cl:
            raise ApiError(404, "闭用记录不存在")
        self.staff(conn, h, self.floor_of_room(conn, cl["room_id"]))
        return services.end_closure(conn, int(cid), int(h.headers["X-Staff-Id"]))

    @route("POST", r"/api/reports")
    def customer_report(self, conn, h, body, q):
        # 顾客端：不要求登录，不采集任何身份信息
        return services.customer_report(
            conn, room_id=int(body["room_id"]),
            facility_id=body.get("facility_id"),
            description=body.get("description", ""),
        )

    # ---------- 工单 / 维修复测 ----------

    @route("GET", r"/api/work-orders")
    def work_orders(self, conn, h, body, q):
        staff = self.staff(conn, h)
        floor_id = int(q["floor_id"][0]) if q.get("floor_id") else None
        if floor_id is not None:
            assert_floor_access(conn, staff["id"], floor_id)
        else:
            allowed = {d["floor_id"] for d in conn.execute(
                "SELECT floor_id FROM staff_floors WHERE staff_id=?", (staff["id"],)).fetchall()}
            if staff["role"] != "supervisor" and allowed:
                floor_id = next(iter(allowed)) if len(allowed) == 1 else None
        return services.work_orders(conn, q.get("status", [None])[0], floor_id)

    @route("POST", r"/api/work-orders/(?P<wid>\d+)/repair")
    def start_repair(self, conn, h, body, q, wid):
        wo = query_one(conn, "SELECT * FROM work_orders WHERE id=?", (int(wid),))
        if not wo:
            raise ApiError(404, "工单不存在")
        self.staff(conn, h, self.floor_of_room(conn, wo["room_id"]))
        return services.start_repair(
            conn, int(wid), int(h.headers["X-Staff-Id"]), body.get("note", "")
        )

    @route("POST", r"/api/work-orders/(?P<wid>\d+)/retest")
    def retest(self, conn, h, body, q, wid):
        wo = query_one(conn, "SELECT * FROM work_orders WHERE id=?", (int(wid),))
        if not wo:
            raise ApiError(404, "工单不存在")
        self.staff(conn, h, self.floor_of_room(conn, wo["room_id"]))
        return services.submit_retest(
            conn, int(wid), int(h.headers["X-Staff-Id"]),
            bool(body.get("passed", False)), body.get("note", ""),
        )

    # ---------- 补给 ----------

    @route("GET", r"/api/supply-queue")
    def supply_queue(self, conn, h, body, q):
        staff = self.staff(conn, h)
        floor_id = int(q["floor_id"][0]) if q.get("floor_id") else None
        if floor_id is not None:
            assert_floor_access(conn, staff["id"], floor_id)
        else:
            allowed = {d["floor_id"] for d in conn.execute(
                "SELECT floor_id FROM staff_floors WHERE staff_id=?", (staff["id"],)).fetchall()}
            if staff["role"] != "supervisor" and allowed:
                floor_id = next(iter(allowed)) if len(allowed) == 1 else None
        return services.supply_queue(conn, floor_id)

    def _supply_action(self, conn, h, oid, fn):
        self.staff(conn, h, self.floor_of_order(conn, oid))
        return fn(conn, oid, int(h.headers["X-Staff-Id"]))

    @route("POST", r"/api/supply-orders/(?P<oid>\d+)/claim")
    def claim(self, conn, h, body, q, oid):
        return self._supply_action(conn, h, int(oid), services.claim_order)

    @route("POST", r"/api/supply-orders/(?P<oid>\d+)/deliver")
    def deliver(self, conn, h, body, q, oid):
        return self._supply_action(conn, h, int(oid), services.deliver_order)

    @route("POST", r"/api/supply-orders/(?P<oid>\d+)/shelve")
    def shelve(self, conn, h, body, q, oid):
        return self._supply_action(conn, h, int(oid), services.shelve_order)

    @route("POST", r"/api/supply-orders/(?P<oid>\d+)/reversal")
    def reversal(self, conn, h, body, q, oid):
        oid = int(oid)
        self.staff(conn, h, self.floor_of_order(conn, oid))
        return services.request_reversal(
            conn, oid, int(h.headers["X-Staff-Id"]), body.get("reason", "")
        )

    @route("POST", r"/api/reversals/(?P<rid>\d+)/review")
    def review(self, conn, h, body, q, rid):
        staff = self.staff(conn, h)
        return services.review_reversal(
            conn, int(rid), staff["id"], bool(body.get("approve", False))
        )

    @route("GET", r"/api/reversals")
    def reversals(self, conn, h, body, q):
        self.staff(conn, h)
        return [dict(r) for r in conn.execute(
            """SELECT rv.*, s.name requester_name FROM supply_reversals rv
               JOIN staff s ON s.id=rv.requested_by ORDER BY rv.id DESC""").fetchall()]

    # ---------- 升级 / 提醒 ----------

    @route("GET", r"/api/escalations")
    def escalations(self, conn, h, body, q):
        staff = self.staff(conn, h)
        floor_id = int(q["floor_id"][0]) if q.get("floor_id") else None
        if floor_id is None:
            allowed = {d["floor_id"] for d in conn.execute(
                "SELECT floor_id FROM staff_floors WHERE staff_id=?", (staff["id"],)).fetchall()}
            if staff["role"] != "supervisor" and allowed and len(allowed) == 1:
                floor_id = next(iter(allowed))
        return services.escalations(conn, q.get("status", [None])[0], floor_id)

    @route("POST", r"/api/escalations/(?P<eid>\d+)/ack")
    def ack_esc(self, conn, h, body, q, eid):
        self.staff(conn, h)
        return services.ack_escalation(conn, int(eid), int(h.headers["X-Staff-Id"]))

    @route("POST", r"/api/escalations/(?P<eid>\d+)/resolve")
    def resolve_esc(self, conn, h, body, q, eid):
        self.staff(conn, h)
        return services.resolve_escalation(conn, int(eid), int(h.headers["X-Staff-Id"]))

    @route("GET", r"/api/reminders")
    def reminders(self, conn, h, body, q):
        self.staff(conn, h)
        return services.reminders(conn)

    # ---------- 班次交接 ----------

    @route("POST", r"/api/shifts/(?P<sid>\d+)/close")
    def close_shift(self, conn, h, body, q, sid):
        shift = query_one(conn, "SELECT * FROM shifts WHERE id=?", (int(sid),))
        if not shift:
            raise ApiError(404, "班次不存在")
        self.staff(conn, h, shift["floor_id"])
        return services.close_shift(conn, int(sid))

    @route("GET", r"/api/shifts/(?P<sid>\d+)/handover")
    def handover(self, conn, h, body, q, sid):
        data = services.handover(conn, int(sid))
        self.staff(conn, h, data["shift"]["floor_id"])
        return data

    # ---------- 照片 ----------

    @route("POST", r"/api/photos")
    def upload_photo(self, conn, h, body, q):
        self.staff(conn, h)
        raw = body.get("data_base64", "")
        try:
            data = base64.b64decode(raw.split(",", 1)[-1], validate=True)
        except Exception:
            raise ApiError(400, "照片数据无效")
        if len(data) > 8 * 1024 * 1024:
            raise ApiError(413, "照片不能超过 8MB")
        sig = data[:8]
        if sig.startswith(b"\x89PNG\r\n\x1a\n"):
            ext = "png"
        elif sig[:3] == b"\xff\xd8\xff":
            ext = "jpg"
        else:
            raise ApiError(400, "仅支持 PNG/JPEG 照片")
        PHOTO_DIR.mkdir(parents=True, exist_ok=True)
        name = f"wo-{uuid.uuid4().hex[:12]}.{ext}"
        (PHOTO_DIR / name).write_bytes(data)
        return {"path": name}


class Handler(BaseHTTPRequestHandler):
    server_version = "NursingRoom/1.0"
    app: App = None  # 由 server 注入

    def log_message(self, fmt, *args):  # 简洁日志
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    def _send_json(self, status: int, payload) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_static(self, url_path: str) -> None:
        rel = url_path.lstrip("/") or "index.html"
        if rel.startswith("photos/"):
            base = PHOTO_DIR
            rel = rel[len("photos/"):]
        else:
            base = STATIC_DIR
        target = (base / rel).resolve()
        if not str(target).startswith(str(base.resolve())) or not target.is_file():
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            if method == "GET":
                self._serve_static(path)
            else:
                self.send_error(405)
            return

        body, q = {}, parse_qs(parsed.query)
        if method == "POST":
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            if raw:
                try:
                    body = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError:
                    self._send_json(400, {"error": "请求体不是有效 JSON"})
                    return

        conn = connect()
        try:
            for m, rx, fn_name in ROUTES:
                if m != method:
                    continue
                match = rx.match(path)
                if not match:
                    continue
                fn = getattr(self.app, fn_name)
                result = fn(conn, self, body, q, **match.groupdict())
                self._send_json(200, result if result is not None else {"ok": True})
                return
            self._send_json(404, {"error": "接口不存在"})
        except ApiError as exc:
            self._send_json(exc.status, {"error": str(exc)})
        except services.ServiceError as exc:
            self._send_json(409, {"error": str(exc)})
        except PermissionError_ as exc:
            self._send_json(403, {"error": str(exc)})
        except (KeyError, ValueError, TypeError) as exc:
            self._send_json(400, {"error": f"参数错误：{exc}"})
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._send_json(500, {"error": f"服务器错误：{exc}"})
        finally:
            conn.close()


def build_server(host: str = "127.0.0.1", port: int = 8077) -> ThreadingHTTPServer:
    app = App()
    Handler.app = app
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.app = app
    return httpd


def main() -> None:
    import os
    import sys

    host = os.environ.get("MB_HOST", "127.0.0.1")
    port = int(os.environ.get("MB_PORT", "8077"))
    httpd = build_server(host, port)
    print(f"母婴室巡检系统已启动: http://{host}:{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
