"""端到端测试：低库存、局部闭用、并发领单、温度异常、跨楼层权限等。

直接启动内存外的真实 HTTP 服务（临时 SQLite + 临时照片目录），零 mock。
运行: python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import base64
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# 每个测试进程使用独立的临时库与照片目录
_TMP = tempfile.mkdtemp(prefix="mb_test_")
os.environ["MB_DB"] = str(Path(_TMP) / "test.db")
os.environ["MB_PHOTOS"] = str(Path(_TMP) / "photos")

from app.db import connect  # noqa: E402
from app.seed import seed  # noqa: E402
from app.server import build_server  # noqa: E402

# 1x1 合法 PNG（程序生成，用于照片上传测试）
def _png_1px() -> str:
    import struct
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    raw = b"\x00\xff\x00\x00"  # 1 行：filter 0 + RGB
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw))
           + chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


PNG_1PX = _png_1px()


class Api:
    def __init__(self, base: str, staff: int = 1):
        self.base = base
        self.staff = staff

    def call(self, method: str, path: str, body=None, staff=None, expect=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json",
                     "X-Staff-Id": str(staff if staff is not None else self.staff)},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                payload = json.loads(resp.read().decode())
                if expect is not None:
                    raise AssertionError(f"{method} {path} 期望 {expect}，实际 200")
                return payload
        except urllib.error.HTTPError as e:
            if expect is not None:
                assert e.code == expect, f"{method} {path} 期望 {expect}，实际 {e.code}: {e.read().decode()}"
                return json.loads(e.read().decode())
            raise

    def get(self, path, **kw): return self.call("GET", path, **kw)
    def post(self, path, body=None, **kw): return self.call("POST", path, body, **kw)


class SystemTest(unittest.TestCase):
    server = None
    api: Api = None

    @classmethod
    def setUpClass(cls):
        seed(force=True)
        cls.server = build_server("127.0.0.1", 0)
        cls.port = cls.server.server_address[1]
        cls.api = Api(f"http://127.0.0.1:{cls.port}")
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.app.stop()

    def setUp(self):
        self.api.staff = 1

    # ---------- 基础 ----------

    def test_01_seed_overview(self):
        data = self.api.get("/api/overview")
        self.assertEqual(len(data), 1)  # 员工1 仅授权 B1 层
        self.assertEqual(data[0]["floor"]["id"], 1)

    def test_02_photo_upload(self):
        r = self.api.post("/api/photos", {"data_base64": "data:image/png;base64," + PNG_1PX})
        self.assertTrue(r["path"].endswith(".png"))
        self.assertTrue((Path(os.environ["MB_PHOTOS"]) / r["path"]).is_file())

    # ---------- 跨楼层权限 ----------

    def test_10_cross_floor_forbidden(self):
        # 员工2 仅 L3 层，访问 B1 层被拒
        self.api.get("/api/overview?floor_id=1", staff=2, expect=403)
        self.api.post("/api/shifts", {"floor_id": 1, "label": "x"}, staff=2, expect=403)
        # 无楼层授权的补给主管可跨楼层
        data = self.api.get("/api/overview", staff=4)
        self.assertEqual(len(data), 3)
        # 主管全部可见
        data = self.api.get("/api/overview", staff=9)
        self.assertEqual(len(data), 3)

    # ---------- 低库存自动入队 ----------

    def test_20_low_stock_creates_supply_order(self):
        # 种子数据：B1-201 抽纸 1 < 安全 5，队列中已有该单
        queue = self.api.get("/api/supply-queue")
        self.assertTrue(any(o["kind"] == "tissue" and o["room_id"] == 1 and o["status"] == "queued"
                            for o in queue))
        # 巡检中把 B1-202 清洁袋点到 1（< 5），自动产生新补给单
        room2 = self.api.get("/api/rooms/2")
        bags = next(i for i in room2["inventory"] if i["kind"] == "bags")
        self.api.post("/api/inspections", {
            "shift_id": 1, "room_id": 2,
            "items": [{"item_key": "supply_level", "result": "ok"}],
            "quantities": {str(bags["id"]): 1},
        })
        queue = self.api.get("/api/supply-queue")
        self.assertTrue(any(o["kind"] == "bags" and o["room_id"] == 2 and o["status"] == "queued"
                            for o in queue))
        # 幂等：再次保存同样低库存不会重复建单
        self.api.post("/api/inspections", {
            "shift_id": 1, "room_id": 2,
            "items": [{"item_key": "supply_level", "result": "ok"}],
            "quantities": {str(bags["id"]): 1},
        })
        queue = [o for o in self.api.get("/api/supply-queue")
                 if o["kind"] == "bags" and o["room_id"] == 2]
        self.assertEqual(len(queue), 1)

    # ---------- 并发领单：只保留首个领取者 ----------

    def test_30_concurrent_claim_first_wins(self):
        room2 = self.api.get("/api/rooms/2")
        tissue = next(i for i in room2["inventory"] if i["kind"] == "tissue")
        self.api.post("/api/inspections", {
            "shift_id": 1, "room_id": 2,
            "items": [{"item_key": "supply_level", "result": "ok"}],
            "quantities": {str(tissue["id"]): 0},
        })
        order = next(o for o in self.api.get("/api/supply-queue")
                     if o["kind"] == "tissue" and o["room_id"] == 2 and o["status"] == "queued")
        # 库存为 0 同时触发缺货替代升级
        esc = self.api.get("/api/escalations?status=open")
        self.assertTrue(any(e["type"] == "stockout_substitute" and e["assignee_role"] == "supply_lead"
                            for e in esc))

        results = []

        def claim(staff_id):
            try:
                self.api.post(f"/api/supply-orders/{order['id']}/claim", {}, staff=staff_id)
                return 200
            except urllib.error.HTTPError as e:
                return e.code

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim, [4, 9]))
        self.assertEqual(sorted(results), [200, 409])

        got = self.api.get("/api/supply-queue")
        fresh = next(o for o in got if o["id"] == order["id"])
        self.assertEqual(fresh["status"], "claimed")
        self.assertIn(fresh["claimed_by"], (4, 9))
        # 第三个人再来领取必然失败
        self.api.post(f"/api/supply-orders/{order['id']}/claim", {}, staff=1, expect=409)

    # ---------- 温度异常 → 关热水设备 + 升级工程师，其他设施照常用 ----------

    def test_40_hot_water_partial_closure_and_retest(self):
        room1 = self.api.get("/api/rooms/1")
        heater = next(f for f in room1["facilities"] if f["type"] == "water_heater")
        # 模拟适配器：强制下一次读数 48.6°C
        self.api.post(f"/api/facilities/{heater['id']}/temperature/override", {"value_c": 48.6})
        reading = self.api.get(f"/api/facilities/{heater['id']}/temperature")
        self.assertEqual(reading["status"], "high")
        self.assertGreater(reading["value_c"], 45.0)

        items = [
            {"item_key": "door_lock", "result": "ok"},
            {"item_key": "water_temp", "result": "fault", "note": "水烫"},
            {"item_key": "power_outlet", "result": "ok"},
            {"item_key": "odor", "result": "ok"},
            {"item_key": "cleanliness", "result": "ok"},
            {"item_key": "supply_level", "result": "ok"},
        ]
        self.api.post("/api/inspections", {
            "shift_id": 1, "room_id": 1, "items": items, "temp_value": 48.6,
        })
        # 清除模拟覆盖
        self.api.post(f"/api/facilities/{heater['id']}/temperature/override", {"value_c": None})

        room1 = self.api.get("/api/rooms/1")
        h = next(f for f in room1["facilities"] if f["type"] == "water_heater")
        self.assertEqual(h["status"], "closed")
        # 局部闭用：房间 partial，其余 4 个设施仍开放
        self.assertEqual(room1["status"], "partial")
        self.assertEqual(room1["facility_total"] if "facility_total" in room1 else
                         sum(f["status"] == "open" for f in room1["facilities"]), 4)
        # 升级到设备工程师
        esc = self.api.get("/api/escalations?status=open")
        hw = [e for e in esc if e["type"] == "hot_water"]
        self.assertTrue(hw)
        self.assertEqual(hw[0]["assignee_role"], "engineer")

        # 未复测不能重开；复测通过后热水设备恢复、房间开放
        wo = next(w for w in self.api.get("/api/work-orders")
                  if w["facility_id"] == heater["id"] and w["status"] in ("open", "repairing"))
        self.api.post(f"/api/work-orders/{wo['id']}/retest", {"passed": False, "note": "仍超温"})
        room1 = self.api.get("/api/rooms/1")
        self.assertEqual(next(f for f in room1["facilities"] if f["id"] == heater["id"])["status"], "closed")
        self.api.post(f"/api/work-orders/{wo['id']}/retest", {"passed": True, "note": "温度正常"})
        room1 = self.api.get("/api/rooms/1")
        self.assertEqual(room1["status"], "open")
        self.assertTrue(all(f["status"] == "open" for f in room1["facilities"]))

    # ---------- 门锁故障 → 整间闭用并升级楼层管理员 ----------

    def test_41_room_wide_closure_on_door_fault(self):
        # 员工3 负责 L5 层房间 6
        self.api.staff = 3
        items = [
            {"item_key": "door_lock", "result": "fault", "note": "门锁失效"},
            {"item_key": "water_temp", "result": "ok"},
            {"item_key": "power_outlet", "result": "ok"},
            {"item_key": "odor", "result": "ok"},
            {"item_key": "cleanliness", "result": "ok"},
            {"item_key": "supply_level", "result": "ok"},
        ]
        self.api.post("/api/inspections", {
            "shift_id": 3, "room_id": 6, "items": items,
        })
        room = self.api.get("/api/rooms/6")
        self.assertEqual(room["status"], "closed")
        self.assertTrue(all(f["status"] == "closed" for f in room["facilities"]))
        esc = self.api.get("/api/escalations?status=open")
        rc = [e for e in esc if e["type"] == "room_closure" and e["ref_id"] == 6]
        self.assertTrue(rc)
        self.assertEqual(rc[0]["assignee_role"], "floor_manager")

    # ---------- 快照不可覆盖 + 消毒漏项升级 ----------

    def test_50_snapshot_immutable_and_disinfection_escalation(self):
        items = [
            {"item_key": k, "result": "ok"}
            for k in ("door_lock", "water_temp", "power_outlet", "odor", "cleanliness", "supply_level")
        ]
        self.api.post("/api/inspections", {
            "shift_id": 1, "room_id": 2, "items": items,
        })
        r = self.api.post("/api/snapshots", {"shift_id": 1, "room_id": 2})
        sid = r["snapshot_id"]
        # 已有快照后再次保存检查 -> 拒绝
        self.api.post("/api/inspections", {
            "shift_id": 1, "room_id": 2, "items": items,
        }, expect=409)
        self.api.post("/api/snapshots", {"shift_id": 1, "room_id": 2}, expect=409)
        # 未做任何消毒登记 -> 消毒漏项升级卫生负责人
        esc = self.api.get("/api/escalations?status=open")
        md = [e for e in esc if e["type"] == "missed_disinfection" and e["ref_id"] == 2]
        self.assertTrue(md)
        self.assertEqual(md[0]["assignee_role"], "hygiene_lead")
        # 数据库层触发器：快照不可改不可删
        conn = connect()
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("UPDATE snapshots SET room_status='closed' WHERE id=?", (sid,))
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("DELETE FROM snapshots WHERE id=?", (sid,))
        conn.close()

    # ---------- 三步确认 + 撤销上架必须主管 ----------

    def test_60_supply_lifecycle_and_supervisor_reversal(self):
        # 种子订单 #2：L3 清洁袋已领料（claimed）
        order = next(o for o in self.api.get("/api/supply-queue", staff=4)
                     if o["room_id"] == 4 and o["kind"] == "bags")
        self.assertEqual(order["status"], "claimed")
        # 状态机不能跳步
        self.api.post(f"/api/supply-orders/{order['id']}/shelve", {}, staff=4, expect=409)
        self.api.post(f"/api/supply-orders/{order['id']}/deliver", {}, staff=4)
        self.api.post(f"/api/supply-orders/{order['id']}/deliver", {}, staff=4, expect=409)
        self.api.post(f"/api/supply-orders/{order['id']}/shelve", {}, staff=4)
        done = next(o for o in self.api.get("/api/supply-queue", staff=4) if o["id"] == order["id"])
        self.assertEqual(done["status"], "shelved")

        # 申请撤销
        rv = self.api.post(f"/api/supply-orders/{order['id']}/reversal",
                           {"reason": "上架数量有误"}, staff=4)
        # 普通值班员不能复核
        self.api.post(f"/api/reversals/{rv['reversal_id']}/review",
                      {"approve": True}, staff=1, expect=409)
        # 主管复核通过 → 单据退回 delivered，库存回冲
        self.api.post(f"/api/reversals/{rv['reversal_id']}/review",
                      {"approve": True}, staff=9)
        done = next(o for o in self.api.get("/api/supply-queue", staff=4) if o["id"] == order["id"])
        self.assertEqual(done["status"], "delivered")
        # 已复核不能重复操作
        self.api.post(f"/api/reversals/{rv['reversal_id']}/review",
                      {"approve": True}, staff=9, expect=409)

    # ---------- 连续报障升级 ----------

    def test_70_repeated_customer_reports_escalation(self):
        esc = self.api.get("/api/escalations?status=open", staff=9)
        rr = [e for e in esc if e["type"] == "repeated_reports"]
        self.assertTrue(rr, "种子中的 24h 内连续顾客报障应升级值班经理")
        self.assertEqual(rr[0]["assignee_role"], "duty_manager")
        # 顾客报障接口不要求身份头
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/reports",
            data=json.dumps({"room_id": 1, "description": "补充一条报障"}).encode(),
            method="POST", headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)

    # ---------- 交接前必须全部快照 ----------

    def test_80_close_shift_requires_all_snapshots(self):
        # 楼层1班次：房间2有快照、房间1没有 → 不能交接
        self.api.post("/api/shifts/1/close", {}, expect=409)

    def test_81_full_handover_after_all_snapshots(self):
        six = [{"item_key": k, "result": "ok"} for k in
               ("door_lock", "water_temp", "power_outlet", "odor", "cleanliness", "supply_level")]
        form = self.api.get("/api/shifts/3/form", staff=3)
        for entry in form["rooms"]:
            rid = entry["room"]["id"]
            self.api.post("/api/inspections", {"shift_id": 3, "room_id": rid, "items": six}, staff=3)
            for f in entry["room"]["facilities"]:
                if f["type"] != "water_heater":
                    self.api.post("/api/disinfection",
                                  {"shift_id": 3, "room_id": rid, "facility_id": f["id"]}, staff=3)
            self.api.post("/api/snapshots", {"shift_id": 3, "room_id": rid}, staff=3)
        self.api.post("/api/shifts/3/close", {}, staff=3)
        hv = self.api.get("/api/shifts/3/handover", staff=3)
        self.assertEqual(hv["shift"]["status"], "closed")
        self.assertEqual(len(hv["snapshots"]), 2)
        for key in ("open_work_orders", "supply_queue", "escalations", "reminders"):
            self.assertIn(key, hv)
        self.api.post("/api/shifts/3/close", {}, staff=3, expect=409)


    # ---------- 进程内任务：补给时限 / 复检提醒到点触发 ----------

    def test_90_due_reminders_fire_once(self):
        from app.services import fire_due_reminders
        conn = connect()
        try:
            # 把未触发提醒的时间改到过去，模拟时限到达（autocommit 即时生效）
            conn.execute("UPDATE reminders SET fire_at='2000-01-01T00:00:00+08:00' WHERE fired_at IS NULL")
            first = fire_due_reminders(conn)
            self.assertTrue(first, "到点的补给/复检提醒应被后台任务触发")
            # 幂等：再次扫描不重复触发
            second = fire_due_reminders(conn)
            self.assertEqual(second, [])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
