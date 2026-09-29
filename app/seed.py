"""样例数据导入：三层楼、六间母婴室、员工与授权、库存、在修工单与报障。

幂等：检测到已有楼层数据则跳过。
"""
from __future__ import annotations

import base64
import struct
import zlib
from pathlib import Path

from . import services
from .db import PHOTO_DIR, Tx, connect, init_db, query_one, now_iso

STAFF = [
    # id, 姓名, 角色, 授权楼层(空=全楼), 职责
    (1, "王岚", "staff", [1], []),
    (2, "李航", "staff", [2], []),
    (3, "赵宁", "staff", [3], []),
    (4, "陈晨", "staff", [], ["supply_lead"]),
    (5, "周建国", "staff", [], ["engineer"]),
    (6, "吴敏", "staff", [], ["hygiene_lead"]),
    (7, "孙磊", "staff", [], ["duty_manager"]),
    (8, "钱进", "staff", [], ["floor_manager"]),
    (9, "郑主管", "supervisor", [], ["floor_manager"]),
]


def _solid_png(path: Path, w: int, h: int, rgb: tuple[int, int, int]) -> None:
    """用标准库生成纯色 PNG（样例故障照片占位，非卡通插画）。"""
    raw = b""
    row = b"\x00" + bytes(rgb) * w
    for _ in range(h):
        raw += row

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def seed(force: bool = False) -> bool:
    init_db()
    conn = connect()
    try:
        if query_one(conn, "SELECT COUNT(*) c FROM floors")["c"] and not force:
            return False

        with Tx(conn):
            conn.execute("DELETE FROM escalations")
            for tbl in (
                "snapshot_facilities", "snapshot_inventory", "snapshot_items", "snapshots",
                "reminders", "supply_reversals", "supply_orders", "customer_reports",
                "work_orders", "closures", "temperature_readings", "disinfection_log",
                "inspections", "shifts", "inventory_items", "facilities", "rooms",
                "staff_duties", "staff_floors", "staff", "floors",
            ):
                conn.execute(f"DELETE FROM {tbl}")

            floors = [(1, "B1层 超市区", "B1"), (2, "L3层 童装区", "L3"), (3, "L5层 餐饮区", "L5")]
            conn.executemany("INSERT INTO floors(id,name,level_no) VALUES(?,?,?)", floors)

            for sid, name, role, fl_ids, duties in STAFF:
                conn.execute("INSERT INTO staff(id,name,role) VALUES(?,?,?)", (sid, name, role))
                for fid in fl_ids:
                    conn.execute("INSERT INTO staff_floors(staff_id,floor_id) VALUES(?,?)", (sid, fid))
                for d in duties:
                    conn.execute("INSERT INTO staff_duties(staff_id,duty) VALUES(?,?)", (sid, d))

            # 每层两间房：尿布台x2、哺乳隔间x2、热水设备x1；纸巾/清洁袋
            room_seq = 1
            fac_seq = 1
            inv_seq = 1
            for fid, _, prefix in floors:
                for n in (1, 2):
                    rid = room_seq
                    code = f"{prefix}-{100 + fid*100 + n}"
                    conn.execute(
                        "INSERT INTO rooms(id,floor_id,code,name,status) VALUES(?,?,?,?,'open')",
                        (rid, fid, code, f"{prefix}母婴室 {n}号"),
                    )
                    facs = [
                        ("changing_table", "尿布台 A"), ("changing_table", "尿布台 B"),
                        ("nursing_booth", "哺乳隔间 1"), ("nursing_booth", "哺乳隔间 2"),
                        ("water_heater", "热水设备"),
                    ]
                    for ftype, fname in facs:
                        conn.execute(
                            "INSERT INTO facilities(id,room_id,type,code,name,status) "
                            "VALUES(?,?,?,?,?,'open')",
                            (fac_seq, rid, ftype, f"{code}-{fac_seq}", fname),
                        )
                        fac_seq += 1
                    for kind, unit, cap in (("tissue", "包", 20), ("bags", "卷", 15)):
                        conn.execute(
                            """INSERT INTO inventory_items(id,room_id,kind,name,unit,quantity,
                                   safety_level,capacity) VALUES(?,?,?,?,?,?,?,?)""",
                            (inv_seq, rid, kind,
                             "抽纸" if kind == "tissue" else "清洁垃圾袋",
                             unit, cap // 2, 5, cap),
                        )
                        inv_seq += 1
                    room_seq += 1

            # 白班（每层一个开放班次，演示用）
            for fid, sid in ((1, 1), (2, 2), (3, 3)):
                conn.execute(
                    "INSERT INTO shifts(floor_id,staff_id,label,started_at,status) VALUES(?,?,?,?,'open')",
                    (fid, sid, "白班 09:00-17:00", now_iso()),
                )

        # 低库存：B1 母婴室1号 抽纸 -> 自动入补给队列
        with Tx(conn):
            conn.execute("UPDATE inventory_items SET quantity=1, safety_level=5 WHERE id=1")
            conn.execute(
                "UPDATE inventory_items SET quantity=2 WHERE room_id=4 AND kind='bags'"
            )
            item = query_one(conn, "SELECT * FROM inventory_items WHERE id=1")
        services._ensure_supply_order(conn, item)

        # 在修工单：L3-201 哺乳隔间2 顾客报障（局部闭用）
        with Tx(conn):
            booth = query_one(
                conn, "SELECT * FROM facilities WHERE room_id=3 AND type='nursing_booth' "
                "ORDER BY id DESC LIMIT 1"
            )
            PHOTO_DIR.mkdir(parents=True, exist_ok=True)
            photo = PHOTO_DIR / "sample_booth.png"
            _solid_png(photo, 1200, 800, (235, 224, 214))
            conn.execute(
                """INSERT INTO work_orders(scope,room_id,facility_id,source,item_key,title,
                       description,photo_path,status,reported_by,created_at)
                   VALUES('facility',3,?,'customer_report','door_lock',
                          '隔间门锁损坏','顾客上报：隔间门无法上锁，已暂停使用该隔间',
                          'sample_booth.png','open',2,?)""",
                (booth["id"], now_iso()),
            )
            conn.execute(
                "INSERT INTO customer_reports(room_id,facility_id,description,created_at) VALUES(?,?,?,?)",
                (3, booth["id"], "隔间门锁不上", now_iso()),
            )
            # 24h 内第二次报障 -> 连续报障升级
            conn.execute(
                "INSERT INTO customer_reports(room_id,facility_id,description,created_at) VALUES(?,?,?,?)",
                (3, booth["id"], "门还是锁不上，希望尽快维修", now_iso()),
            )
            services._recompute_room(conn, 3)

        # 维修中工单：L5-302 热水设备水温不稳，待复测
        with Tx(conn):
            heater = query_one(
                conn, "SELECT * FROM facilities WHERE room_id=6 AND type='water_heater'"
            )
            conn.execute(
                """INSERT INTO work_orders(scope,room_id,facility_id,source,item_key,title,
                       description,status,reported_by,created_at,repairing_at,repair_note)
                   VALUES('facility',6,?,'inspection','water_temp','热水温度不稳',
                          '巡检发现水温波动','repairing',3,?,?,
                          '已更换温控元件，等待复测')""",
                (heater["id"], now_iso(), now_iso()),
            )
            services._recompute_room(conn, 6)

        # L3 清洁袋补给单：已领料状态
        with Tx(conn):
            conn.execute(
                """INSERT INTO supply_orders(item_id,room_id,kind,request_qty,status,
                       claimed_by,claimed_at,created_at,due_at,stockout_at)
                   SELECT id,room_id,'bags',15,'claimed',2,?,?,?,NULL
                   FROM inventory_items WHERE room_id=4 AND kind='bags'""",
                (now_iso(), now_iso(), now_iso()),
            )

        # 连续报障升级由服务函数幂等生成：直接补一条顾客报障触发逻辑更自然，
        # 这里调用服务层以确保升级路由真实生效
        services.customer_report(
            conn, room_id=3, facility_id=booth["id"], description="门把手松动（第三次跟进）"
        )

        # 模拟温度场景：B1 热水设备首次读数即超温，便于演示温度异常升级
        from .temperature import adapter
        wh1 = query_one(conn, "SELECT code FROM facilities WHERE room_id=1 AND type='water_heater'")
        adapter.set_scenario(wh1["code"], [46.8, 46.2, 41.0])

        return True
    finally:
        conn.close()


if __name__ == "__main__":
    created = seed()
    print("样例数据已导入" if created else "样例数据已存在，跳过（使用 --force 可重置）")
