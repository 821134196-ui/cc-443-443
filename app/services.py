"""领域服务：巡检/快照、库存补给、维修复测、闭用、报障、升级与提醒。

所有写操作在 db.Tx（BEGIN IMMEDIATE + 进程锁）内完成，
保证 check-then-act（如并发领单）的原子性。
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

from . import config
from .db import Tx, now_iso, query_all, query_one


class ServiceError(Exception):
    """业务规则违反（HTTP 层映射为 409）。"""


# ============ 读取：总览 / 设施 / 表单 ============

def floor_list(conn):
    return query_all(conn, "SELECT * FROM floors ORDER BY id")


def _facility_states(conn, room_id):
    facs = query_all(
        conn, "SELECT * FROM facilities WHERE room_id=? ORDER BY id", (room_id,)
    )
    for f in facs:
        active_wo = query_one(
            conn,
            "SELECT id,status FROM work_orders WHERE facility_id=? "
            "AND status IN ('open','repairing') ORDER BY id DESC LIMIT 1",
            (f["id"],),
        )
        f["open_work_order_id"] = active_wo["id"] if active_wo else None
    return facs


def room_detail(conn, room_id):
    room = query_one(conn, "SELECT * FROM rooms WHERE id=?", (room_id,))
    if not room:
        raise ServiceError("房间不存在")
    room["facilities"] = _facility_states(conn, room_id)
    room["inventory"] = query_all(
        conn, "SELECT * FROM inventory_items WHERE room_id=? ORDER BY kind, id", (room_id,)
    )
    room["active_closure"] = query_one(
        conn,
        "SELECT * FROM closures WHERE room_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
        (room_id,),
    )
    room["active_facility_closures"] = query_all(
        conn,
        """SELECT c.*, f.name facility_name FROM closures c
           JOIN facilities f ON f.id=c.facility_id
           WHERE c.room_id=? AND c.facility_id IS NOT NULL AND c.ended_at IS NULL""",
        (room_id,),
    )
    return room


def overview(conn, staff_id, floor_id=None):
    floors = floor_list(conn)
    result = []
    for fl in floors:
        if floor_id and fl["id"] != floor_id:
            continue
        rooms = query_all(conn, "SELECT * FROM rooms WHERE floor_id=? ORDER BY code", (fl["id"],))
        entries = []
        for r in rooms:
            facs = _facility_states(conn, r["id"])
            closed_facs = [f for f in facs if f["status"] == "closed"]
            open_facs = [f for f in facs if f["status"] == "open"]
            wo_cnt = conn.execute(
                "SELECT COUNT(*) c FROM work_orders WHERE room_id=? AND status IN ('open','repairing')",
                (r["id"],),
            ).fetchone()["c"]
            low_cnt = conn.execute(
                "SELECT COUNT(*) c FROM inventory_items WHERE room_id=? AND quantity < safety_level",
                (r["id"],),
            ).fetchone()["c"]
            entries.append({
                **r,
                "facility_total": len(facs),
                "facility_open": len(open_facs),
                "closed_facilities": [
                    {"id": f["id"], "name": f["name"], "type": f["type"],
                     "reason": f["closed_reason"]} for f in closed_facs
                ],
                "open_work_orders": wo_cnt,
                "low_stock_count": low_cnt,
            })
        result.append({"floor": fl, "rooms": entries})
    return result


# ============ 班次 ============

def open_shift(conn, staff_id, floor_id, label):
    with Tx(conn):
        existing = query_one(
            conn,
            "SELECT id FROM shifts WHERE floor_id=? AND staff_id=? AND status='open'",
            (floor_id, staff_id),
        )
        if existing:
            return query_one(conn, "SELECT * FROM shifts WHERE id=?", (existing["id"],))
        cur = conn.execute(
            "INSERT INTO shifts(floor_id,staff_id,label,started_at,status) VALUES(?,?,?,?, 'open')",
            (floor_id, staff_id, label, now_iso()),
        )
        return query_one(conn, "SELECT * FROM shifts WHERE id=?", (cur.lastrowid))


def shift_form(conn, shift_id):
    shift = query_one(conn, "SELECT * FROM shifts WHERE id=?", (shift_id,))
    if not shift:
        raise ServiceError("班次不存在")
    rooms = query_all(
        conn, "SELECT * FROM rooms WHERE floor_id=? ORDER BY code", (shift["floor_id"],)
    )
    out = []
    for r in rooms:
        insp = {
            row["item_key"]: dict(row)
            for row in conn.execute(
                "SELECT * FROM inspections WHERE shift_id=? AND room_id=?",
                (shift_id, r["id"]),
            ).fetchall()
        }
        snap = query_one(
            conn, "SELECT id FROM snapshots WHERE shift_id=? AND room_id=?", (shift_id, r["id"])
        )
        disinfected = [
            row["facility_id"]
            for row in conn.execute(
                "SELECT DISTINCT facility_id FROM disinfection_log WHERE shift_id=? AND room_id=?",
                (shift_id, r["id"]),
            ).fetchall()
        ]
        out.append({
            "room": room_detail(conn, r["id"]),
            "inspections": insp,
            "snapshot_id": snap["id"] if snap else None,
            "disinfected_facility_ids": disinfected,
        })
    return {"shift": shift, "rooms": out, "check_items": config.CHECK_ITEMS}


# ============ 闭用状态维护 ============

def _active_closure(conn, room_id, facility_id=None):
    sql = "SELECT * FROM closures WHERE ended_at IS NULL AND room_id=?"
    params = [room_id]
    if facility_id is None:
        sql += " AND facility_id IS NULL"
    else:
        sql += " AND facility_id=?"
        params.append(facility_id)
    return query_one(conn, sql + " ORDER BY id DESC LIMIT 1", tuple(params))


def _recompute_room(conn, room_id):
    """按故障工单 + 临时闭用重算房间与设施开闭状态。"""
    room = query_one(conn, "SELECT * FROM rooms WHERE id=?", (room_id,))
    # 设施
    facs = query_all(conn, "SELECT * FROM facilities WHERE room_id=?", (room_id,))
    any_fac_closed = False
    for f in facs:
        wo = query_one(
            conn,
            "SELECT * FROM work_orders WHERE facility_id=? AND status IN ('open','repairing') "
            "ORDER BY id DESC LIMIT 1",
            (f["id"],),
        )
        fac_closure = _active_closure(conn, room_id, f["id"])
        if wo or fac_closure:
            reason = (wo["title"] if wo else None) or (fac_closure["reason"] if fac_closure else None)
            if f["status"] != "closed":
                conn.execute(
                    "UPDATE facilities SET status='closed', closed_reason=? WHERE id=?",
                    (reason, f["id"]),
                )
            any_fac_closed = True
        elif f["status"] == "closed":
            conn.execute(
                "UPDATE facilities SET status='open', closed_reason=NULL WHERE id=?", (f["id"],)
            )
    # 房间
    room_wo = query_one(
        conn,
        """SELECT * FROM work_orders WHERE scope='room' AND room_id=?
           AND item_key IN ('door_lock','power_outlet')
           AND status IN ('open','repairing') ORDER BY id DESC LIMIT 1""",
        (room_id,),
    )
    room_closure = _active_closure(conn, room_id)
    room_closed = bool(room_wo or room_closure)
    if room_closed:
        reason = (room_wo["title"] if room_wo else None) or (
            room_closure["reason"] if room_closure else None
        )
        conn.execute("UPDATE rooms SET status='closed', closed_reason=? WHERE id=?", (reason, room_id))
        # 整间闭用时所有设施不可用（复测解除后随重算恢复开放）
        conn.execute(
            "UPDATE facilities SET status='closed', closed_reason=? WHERE room_id=? AND status='open'",
            (reason, room_id),
        )
        status = "closed"
    elif any_fac_closed:
        conn.execute("UPDATE rooms SET status='partial', closed_reason=NULL WHERE id=?", (room_id,))
        status = "partial"
    else:
        conn.execute("UPDATE rooms SET status='open', closed_reason=NULL WHERE id=?", (room_id,))
        status = "open"
    return status


# ============ 升级 ============

def _assignee_for(conn, duty, floor_id):
    row = query_one(
        conn,
        """SELECT s.id FROM staff s
           JOIN staff_duties d ON d.staff_id=s.id
           WHERE d.duty=?
             AND (s.role='supervisor'
                  OR NOT EXISTS (SELECT 1 FROM staff_floors WHERE staff_id=s.id)
                  OR EXISTS (SELECT 1 FROM staff_floors WHERE staff_id=s.id AND floor_id=?))
           ORDER BY (s.role='supervisor') DESC, s.id LIMIT 1""",
        (duty, floor_id),
    )
    return row["id"] if row else None


def _escalate(conn, etype, floor_id, ref_kind, ref_id, title, detail):
    """同一对象同类未解决升级去重。"""
    dup = query_one(
        conn,
        "SELECT id FROM escalations WHERE type=? AND ref_kind=? AND ref_id=? AND status='open'",
        (etype, ref_kind, ref_id),
    )
    if dup:
        return dup["id"]
    duty, _ = config.ESCALATION[etype]
    assignee = _assignee_for(conn, duty, floor_id)
    cur = conn.execute(
        """INSERT INTO escalations(type,floor_id,ref_kind,ref_id,title,detail,
               assignee_role,assignee_id,created_at,status)
           VALUES(?,?,?,?,?,?,?,?,?, 'open')""",
        (etype, floor_id, ref_kind, ref_id, title, detail, duty, assignee, now_iso()),
    )
    return cur.lastrowid


# ============ 库存 / 补给队列 ============

def _ensure_supply_order(conn, item):
    """低于安全量 -> 自动进入补给队列（幂等：已有未完结单则不重复）。"""
    existing = query_one(
        conn,
        "SELECT * FROM supply_orders WHERE item_id=? AND status IN ('queued','claimed','delivered')",
        (item["id"],),
    )
    if existing:
        return existing["id"], False
    request_qty = max(item["capacity"] - item["quantity"], item["safety_level"])
    due = (datetime.now() + timedelta(hours=config.SUPPLY_DEADLINE_HOURS[item["kind"]])).isoformat(
        timespec="seconds"
    )
    cur = conn.execute(
        """INSERT INTO supply_orders(item_id,room_id,kind,request_qty,status,created_at,due_at)
           VALUES(?,?,?,?,'queued',?,?)""",
        (item["id"], item["room_id"], item["kind"], request_qty, now_iso(), due),
    )
    conn.execute(
        "INSERT INTO reminders(kind,ref_id,floor_id,message,fire_at) "
        "SELECT ?,?,r.floor_id,?,? FROM rooms r WHERE r.id=?",
        (
            "supply_due", cur.lastrowid,
            f"{config.INVENTORY_KINDS[item['kind']]}补给即将超时（{item['name']}）", due,
            item["room_id"],
        ),
    )
    return cur.lastrowid, True


def _refresh_inventory_supplies(conn, room_id, quantities):
    """quantities: {item_id: qty}。返回新建补给单与缺货升级列表。"""
    new_orders, stockouts = [], []
    for item in conn.execute("SELECT * FROM inventory_items WHERE room_id=?", (room_id,)):
        iid = item["id"]
        if iid not in quantities:
            continue
        qty = max(0, int(quantities[iid]))
        conn.execute("UPDATE inventory_items SET quantity=? WHERE id=?", (qty, iid))
        item = dict(item)
        item["quantity"] = qty
        if qty < item["safety_level"]:
            oid, created = _ensure_supply_order(conn, item)
            if created:
                new_orders.append(oid)
        if qty <= config.STOCKOUT_QTY:
            # 缺货替代升级（幂等）
            conn.execute(
                "UPDATE supply_orders SET stockout_at=? WHERE item_id=? AND stockout_at IS NULL "
                "AND status IN ('queued','claimed','delivered')",
                (now_iso(), iid),
            )
            eid = _escalate(
                conn, "stockout_substitute",
                query_one(conn, "SELECT floor_id FROM rooms WHERE id=?", (room_id,))["floor_id"],
                "inventory_item", iid,
                f"{item['name']} 缺货，需要替代方案",
                f"房间 {room_id} 的{config.INVENTORY_KINDS[item['kind']]}库存为 0",
            )
            stockouts.append(eid)
    return new_orders, stockouts


# ============ 巡检提交 + 快照 ============

ROOM_SCOPE_ITEMS = {"door_lock", "power_outlet"}  # 安全项故障 -> 整间闭用


def _heater_of(conn, room_id):
    return query_one(
        conn, "SELECT * FROM facilities WHERE room_id=? AND type='water_heater' LIMIT 1",
        (room_id,),
    )


def _record_fault(conn, *, room, item_key, note, photo_path, staff_id):
    """故障 -> 建单并关闭对应设施/房间。已有未结同工单则不重复建单。"""
    room_id = room["id"]
    scope, fac_id = "room", None
    if item_key == "water_temp":
        h = _heater_of(conn, room_id)
        scope, fac_id = "facility", h["id"] if h else None
    elif item_key in config.CHECK_ITEM_MAP and item_key not in ROOM_SCOPE_ITEMS and item_key != "water_temp":
        # 异味/清洁度：开卫生工单但不自动闭用
        scope = "room"
    existing = query_one(
        conn,
        "SELECT id FROM work_orders WHERE room_id=? AND item_key=? "
        "AND COALESCE(facility_id,-1)=COALESCE(?,-1) AND status IN ('open','repairing')",
        (room_id, item_key, fac_id),
    )
    if existing:
        return existing["id"]
    item_name = config.CHECK_ITEM_MAP[item_key]["name"]
    title = f"{item_name}异常"
    cur = conn.execute(
        """INSERT INTO work_orders(scope,room_id,facility_id,source,item_key,title,description,
               photo_path,status,reported_by,created_at)
           VALUES(?,?,?, 'inspection', ?,?,?,?, 'open',?,?)""",
        (scope, room_id, fac_id, item_key, title, note, photo_path, staff_id, now_iso()),
    )
    wo_id = cur.lastrowid
    # 安全项与热水设备立即闭用；异味/清洁度不自动闭用
    if item_key in ROOM_SCOPE_ITEMS or item_key == "water_temp":
        _recompute_room(conn, room_id)
        if item_key in ROOM_SCOPE_ITEMS:
            _escalate(
                conn, "room_closure", room["floor_id"], "room", room_id,
                f"{room['name']} 因{item_name}故障整间闭用", note or title,
            )
    return wo_id


def submit_inspection(conn, *, shift_id, room_id, staff_id, items, quantities, temp_value=None):
    """保存一个房间的逐项检查；故障即建单闭用并按需升级。"""
    shift = query_one(conn, "SELECT * FROM shifts WHERE id=?", (shift_id,))
    if not shift:
        raise ServiceError("班次不存在")
    if shift["status"] != "open":
        raise ServiceError("班次已结束，不能再录入检查")
    room = query_one(conn, "SELECT * FROM rooms WHERE id=?", (room_id,))
    if not room or room["floor_id"] != shift["floor_id"]:
        raise ServiceError("房间不属于该班次楼层")
    if query_one(conn, "SELECT id FROM snapshots WHERE shift_id=? AND room_id=?", (shift_id, room_id)):
        raise ServiceError("该房间已生成班次快照，检查结果不可覆盖")

    valid = {c["key"] for c in config.CHECK_ITEMS}
    norm = {}
    for it in items:
        key = it.get("item_key")
        if key not in valid:
            raise ServiceError(f"未知巡检项: {key}")
        if it.get("result") not in ("ok", "fault", "na"):
            raise ServiceError("检查结果只能是 ok/fault/na")
        norm[key] = it

    with Tx(conn):
        recorded_temp = None
        for key, it in norm.items():
            tv = None
            if key == "water_temp":
                tv = float(temp_value) if temp_value is not None else None
                recorded_temp = tv
            conn.execute(
                """INSERT INTO inspections(shift_id,room_id,item_key,result,note,temp_value,staff_id,inspected_at)
                   VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(shift_id,room_id,item_key) DO UPDATE SET
                     result=excluded.result, note=excluded.note,
                     temp_value=excluded.temp_value, staff_id=excluded.staff_id,
                     inspected_at=excluded.inspected_at""",
                (shift_id, room_id, key, it["result"], it.get("note"), tv, staff_id, now_iso()),
            )

        # 水温：适配器读数超温即视为设备故障——自动建单、关闭热水设备并升级工程师，
        # 与值班员手标结果无关（手标仅用于记录个人判断）。
        temp_marked_fault = norm.get("water_temp", {}).get("result") == "fault"
        if recorded_temp is not None and recorded_temp > config.WATER_MAX_C:
            wo_id = _record_fault(
                conn, room=room, item_key="water_temp",
                note=norm.get("water_temp", {}).get("note") or f"适配器读数 {recorded_temp}°C 超温",
                photo_path=norm.get("water_temp", {}).get("photo_path"), staff_id=staff_id,
            )
            h = _heater_of(conn, room_id)
            _escalate(
                conn, "hot_water", room["floor_id"], "facility", h["id"] if h else wo_id,
                f"热水超温 {recorded_temp}°C（限值 {config.WATER_MAX_C}°C）",
                norm.get("water_temp", {}).get("note") or "",
            )
        elif temp_marked_fault:
            _record_fault(
                conn, room=room, item_key="water_temp",
                note=norm.get("water_temp", {}).get("note"),
                photo_path=norm.get("water_temp", {}).get("photo_path"), staff_id=staff_id,
            )

        for key, it in norm.items():
            if key == "water_temp":
                continue  # 水温故障已按读数处理
            if it["result"] == "fault":
                _record_fault(
                    conn, room=room, item_key=key,
                    note=it.get("note"), photo_path=it.get("photo_path"), staff_id=staff_id,
                )
        _refresh_inventory_supplies(conn, room_id, {int(k): v for k, v in (quantities or {}).items()})
    return {"ok": True, "recorded": len(norm)}


def record_disinfection(conn, *, shift_id, room_id, facility_id, staff_id, note=""):
    shift = query_one(conn, "SELECT * FROM shifts WHERE id=?", (shift_id,))
    if not shift or shift["status"] != "open":
        raise ServiceError("班次不存在或已结束")
    with Tx(conn):
        conn.execute(
            """INSERT INTO disinfection_log(room_id,facility_id,shift_id,staff_id,note,created_at)
               VALUES(?,?,?,?,?,?)""",
            (room_id, facility_id, shift_id, staff_id, note, now_iso()),
        )
    return {"ok": True}


def generate_snapshot(conn, *, shift_id, room_id, staff_id):
    """六检齐全后生成不可变班次快照；消毒漏项在此升级。"""
    shift = query_one(conn, "SELECT * FROM shifts WHERE id=?", (shift_id,))
    if not shift or shift["status"] != "open":
        raise ServiceError("班次不存在或已结束")
    room = query_one(conn, "SELECT * FROM rooms WHERE id=?", (room_id,))
    if not room or room["floor_id"] != shift["floor_id"]:
        raise ServiceError("房间不属于该班次楼层")
    with Tx(conn):
        if query_one(conn, "SELECT id FROM snapshots WHERE shift_id=? AND room_id=?", (shift_id, room_id)):
            raise ServiceError("快照已存在，不可覆盖")
        insp = {
            r["item_key"]: r
            for r in conn.execute(
                "SELECT * FROM inspections WHERE shift_id=? AND room_id=?", (shift_id, room_id)
            ).fetchall()
        }
        missing = [c["name"] for c in config.CHECK_ITEMS if c["key"] not in insp]
        if missing:
            raise ServiceError("尚有巡检项未完成：" + "、".join(missing))

        water = insp.get("water_temp")
        cur = conn.execute(
            """INSERT INTO snapshots(shift_id,room_id,floor_id,staff_id,room_status,water_temp_c,created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (shift_id, room_id, shift["floor_id"], staff_id, room["status"],
             water["temp_value"] if water else None, now_iso()),
        )
        sid = cur.lastrowid
        for key, row in insp.items():
            conn.execute(
                "INSERT INTO snapshot_items(snapshot_id,item_key,result,note) VALUES(?,?,?,?)",
                (sid, key, row["result"], row["note"]),
            )
        for inv in conn.execute("SELECT * FROM inventory_items WHERE room_id=?", (room_id,)):
            conn.execute(
                """INSERT INTO snapshot_inventory(snapshot_id,item_id,kind,quantity,safety_level)
                   VALUES(?,?,?,?,?)""",
                (sid, inv["id"], inv["kind"], inv["quantity"], inv["safety_level"]),
            )
        missing_disinfection = []
        for f in conn.execute(
            "SELECT * FROM facilities WHERE room_id=? AND type IN ('changing_table','nursing_booth')",
            (room_id,),
        ):
            done = query_one(
                conn,
                "SELECT 1 FROM disinfection_log WHERE shift_id=? AND facility_id=? LIMIT 1",
                (shift_id, f["id"]),
            )
            conn.execute(
                "INSERT INTO snapshot_facilities(snapshot_id,facility_id,type,status,disinfected) VALUES(?,?,?,?,?)",
                (sid, f["id"], f["type"], f["status"], 1 if done else 0),
            )
            if not done:
                missing_disinfection.append(dict(f))
        if missing_disinfection:
            _escalate(
                conn, "missed_disinfection", shift["floor_id"], "room", room_id,
                f"{room['name']} 消毒漏项 {len(missing_disinfection)} 处",
                "未消毒：" + "、".join(f["name"] for f in missing_disinfection),
            )
    return {"ok": True, "snapshot_id": sid}


# ============ 临时闭用 ============

def create_closure(conn, *, scope, room_id, facility_id, reason, staff_id, hours=None):
    room = query_one(conn, "SELECT * FROM rooms WHERE id=?", (room_id,))
    if not room:
        raise ServiceError("房间不存在")
    if scope == "facility":
        if not facility_id:
            raise ServiceError("设施闭用必须指定 facility_id")
        if not query_one(conn, "SELECT 1 FROM facilities WHERE id=? AND room_id=?", (facility_id, room_id)):
            raise ServiceError("设施不属于该房间")
    with Tx(conn):
        reopen = None
        if hours:
            reopen = (datetime.now() + timedelta(hours=float(hours))).isoformat(timespec="seconds")
        cur = conn.execute(
            """INSERT INTO closures(scope,room_id,facility_id,reason,staff_id,started_at,expected_reopen_at)
               VALUES(?,?,?,?,?,?,?)""",
            (scope, room_id, facility_id if scope == "facility" else None,
             reason, staff_id, now_iso(), reopen),
        )
        _recompute_room(conn, room_id)
        if scope == "room":
            _escalate(
                conn, "room_closure", room["floor_id"], "room", room_id,
                f"{room['name']} 临时整间闭用", reason,
            )
        return {"ok": True, "closure_id": cur.lastrowid}


def end_closure(conn, closure_id, staff_id):
    cl = query_one(conn, "SELECT * FROM closures WHERE id=?", (closure_id,))
    if not cl:
        raise ServiceError("闭用记录不存在")
    if cl["ended_at"]:
        return {"ok": True}
    with Tx(conn):
        conn.execute("UPDATE closures SET ended_at=? WHERE id=?", (now_iso(), closure_id))
        _recompute_room(conn, cl["room_id"])
    return {"ok": True}


# ============ 顾客报障（不采集身份）============

def customer_report(conn, *, room_id, facility_id, description):
    if not description or not description.strip():
        raise ServiceError("请描述故障情况")
    room = query_one(conn, "SELECT * FROM rooms WHERE id=?", (room_id,))
    if not room:
        raise ServiceError("房间不存在")
    if facility_id and not query_one(
        conn, "SELECT 1 FROM facilities WHERE id=? AND room_id=?", (facility_id, room_id)
    ):
        raise ServiceError("设施不属于该房间")
    with Tx(conn):
        cur = conn.execute(
            "INSERT INTO customer_reports(room_id,facility_id,description,created_at) VALUES(?,?,?,?)",
            (room_id, facility_id, description.strip(), now_iso()),
        )
        report_id = cur.lastrowid
        # 连续报障：同对象 24h 内第 2 次起升级（去重）
        since = (datetime.now() - timedelta(hours=config.REPEATED_REPORT_WINDOW_HOURS)).isoformat(
            timespec="seconds"
        )
        cnt = conn.execute(
            "SELECT COUNT(*) c FROM customer_reports WHERE room_id=? "
            "AND COALESCE(facility_id,-1)=COALESCE(?,-1) AND created_at>=?",
            (room_id, facility_id, since),
        ).fetchone()["c"]
        esc_id = None
        if cnt >= config.REPEATED_REPORT_COUNT:
            tgt_kind, tgt_id = ("facility", facility_id) if facility_id else ("room", room_id)
            esc_id = _escalate(
                conn, "repeated_reports", room["floor_id"], tgt_kind, tgt_id,
                f"{'设施' if facility_id else '房间'} 24小时内第 {cnt} 次顾客报障",
                description.strip(),
            )
    return {"ok": True, "report_id": report_id, "escalation_id": esc_id}


# ============ 工单 / 维修 / 复测 ============

def work_orders(conn, status=None, floor_id=None):
    sql = """SELECT w.*, r.name room_name, r.floor_id, f.name facility_name,
                    s.name reporter_name
             FROM work_orders w
             JOIN rooms r ON r.id=w.room_id
             LEFT JOIN facilities f ON f.id=w.facility_id
             LEFT JOIN staff s ON s.id=w.reported_by"""
    where, params = [], []
    if status:
        where.append("w.status=?")
        params.append(status)
    if floor_id:
        where.append("r.floor_id=?")
        params.append(floor_id)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY w.id DESC"
    return query_all(conn, sql, tuple(params))


def start_repair(conn, wo_id, staff_id, note=""):
    with Tx(conn):
        wo = query_one(conn, "SELECT * FROM work_orders WHERE id=?", (wo_id,))
        if not wo:
            raise ServiceError("工单不存在")
        if wo["status"] not in ("open", "repairing"):
            raise ServiceError("该工单已复测通过，无需维修")
        conn.execute(
            "UPDATE work_orders SET status='repairing', repairing_at=COALESCE(repairing_at,?), "
            "repair_note=? WHERE id=?",
            (now_iso(), note or wo["repair_note"], wo_id),
        )
        # 复检提醒
        exists = query_one(
            conn,
            "SELECT id FROM reminders WHERE kind='retest_due' AND ref_id=? AND fired_at IS NULL",
            (wo_id,),
        )
        if not exists:
            fire = (datetime.now() + timedelta(hours=config.RETEST_REMINDER_HOURS)).isoformat(
                timespec="seconds"
            )
            room = query_one(conn, "SELECT floor_id FROM rooms WHERE id=?", (wo["room_id"],))
            conn.execute(
                "INSERT INTO reminders(kind,ref_id,floor_id,message,fire_at) VALUES(?,?,?,?,?)",
                ("retest_due", wo_id, room["floor_id"], f"工单 #{wo_id} 维修已超 24h，请安排复测", fire),
            )
    return {"ok": True}


def submit_retest(conn, wo_id, staff_id, passed, note=""):
    with Tx(conn):
        wo = query_one(conn, "SELECT * FROM work_orders WHERE id=?", (wo_id,))
        if not wo:
            raise ServiceError("工单不存在")
        if wo["status"] not in ("open", "repairing"):
            raise ServiceError("该工单已复测通过")
        conn.execute(
            "UPDATE work_orders SET last_retest_at=?, last_retest_passed=?, retest_note=? WHERE id=?",
            (now_iso(), 1 if passed else 0, note, wo_id),
        )
        if passed:
            conn.execute("UPDATE work_orders SET status='retest_passed' WHERE id=?", (wo_id,))
            _recompute_room(conn, wo["room_id"])
    return {"ok": True, "retest_passed": bool(passed)}


# ============ 补给：领取/送达/上架/撤销 ============

def supply_queue(conn, floor_id=None):
    sql = """SELECT o.*, i.name item_name, i.kind, i.quantity current_qty,
                    i.safety_level, i.capacity, i.unit, r.name room_name, r.floor_id,
                    sc.name claimed_name, sd.name delivered_name, ss.name shelved_name
             FROM supply_orders o
             JOIN inventory_items i ON i.id=o.item_id
             JOIN rooms r ON r.id=o.room_id
             LEFT JOIN staff sc ON sc.id=o.claimed_by
             LEFT JOIN staff sd ON sd.id=o.delivered_by
             LEFT JOIN staff ss ON ss.id=o.shelved_by"""
    params = []
    if floor_id:
        sql += " WHERE r.floor_id=?"
        params.append(floor_id)
    sql += " ORDER BY CASE o.status WHEN 'queued' THEN 0 WHEN 'claimed' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END, o.id"
    rows = query_all(conn, sql, tuple(params))
    now = now_iso()
    for o in rows:
        o["overdue"] = o["status"] in ("queued", "claimed") and o["due_at"] < now
    return rows


def claim_order(conn, order_id, staff_id):
    """并发安全：只有首个领取者成功（条件 UPDATE + changes 校验）。"""
    with Tx(conn):
        order = query_one(conn, "SELECT * FROM supply_orders WHERE id=?", (order_id,))
        if not order:
            raise ServiceError("补给单不存在")
        cur = conn.execute(
            "UPDATE supply_orders SET status='claimed', claimed_by=?, claimed_at=? "
            "WHERE id=? AND status='queued' AND claimed_by IS NULL",
            (staff_id, now_iso(), order_id),
        )
        if cur.rowcount == 0:
            winner = query_one(
                conn, "SELECT s.name FROM staff s JOIN supply_orders o ON o.claimed_by=s.id WHERE o.id=?",
                (order_id,),
            )
            raise ServiceError(
                f"该补给单已被 {winner['name'] if winner else '他人'} 领取，仅保留首个领取者"
            )
    return {"ok": True}


def deliver_order(conn, order_id, staff_id):
    with Tx(conn):
        order = query_one(conn, "SELECT * FROM supply_orders WHERE id=?", (order_id,))
        if not order:
            raise ServiceError("补给单不存在")
        if order["status"] != "claimed":
            raise ServiceError("仅已领料（claimed）的单据可确认送达")
        conn.execute(
            "UPDATE supply_orders SET status='delivered', delivered_by=?, delivered_at=? WHERE id=?",
            (staff_id, now_iso(), order_id),
        )
    return {"ok": True}


def shelve_order(conn, order_id, staff_id):
    with Tx(conn):
        order = query_one(conn, "SELECT * FROM supply_orders WHERE id=?", (order_id,))
        if not order:
            raise ServiceError("补给单不存在")
        if order["status"] != "delivered":
            raise ServiceError("仅已送达（delivered）的单据可确认上架")
        conn.execute(
            "UPDATE supply_orders SET status='shelved', shelved_by=?, shelved_at=? WHERE id=?",
            (staff_id, now_iso(), order_id),
        )
        conn.execute(
            "UPDATE inventory_items SET quantity = MIN(capacity, quantity + ?) WHERE id=?",
            (order["request_qty"], order["item_id"]),
        )
    return {"ok": True}


def request_reversal(conn, order_id, staff_id, reason):
    with Tx(conn):
        order = query_one(conn, "SELECT * FROM supply_orders WHERE id=?", (order_id,))
        if not order:
            raise ServiceError("补给单不存在")
        if order["status"] != "shelved":
            raise ServiceError("仅已上架单据可申请撤销上架")
        pending = query_one(
            conn, "SELECT id FROM supply_reversals WHERE order_id=? AND status='pending'", (order_id,)
        )
        if pending:
            raise ServiceError("已存在待主管复核的撤销申请")
        cur = conn.execute(
            """INSERT INTO supply_reversals(order_id,requested_by,reason,status,created_at)
               VALUES(?,?,?, 'pending',?)""",
            (order_id, staff_id, reason or "撤销上架", now_iso()),
        )
        return {"ok": True, "reversal_id": cur.lastrowid}


def review_reversal(conn, reversal_id, supervisor_id, approve):
    """撤销上架必须主管复核。"""
    supervisor = query_one(conn, "SELECT * FROM staff WHERE id=?", (supervisor_id,))
    if not supervisor or supervisor["role"] != "supervisor":
        raise ServiceError("只有主管可以复核撤销上架")
    with Tx(conn):
        rv = query_one(conn, "SELECT * FROM supply_reversals WHERE id=?", (reversal_id,))
        if not rv:
            raise ServiceError("复核记录不存在")
        if rv["status"] != "pending":
            raise ServiceError("该申请已复核")
        if approve:
            order = query_one(conn, "SELECT * FROM supply_orders WHERE id=?", (rv["order_id"],))
            conn.execute(
                "UPDATE inventory_items SET quantity=MAX(0, quantity - ?) WHERE id=?",
                (order["request_qty"], order["item_id"]),
            )
            conn.execute(
                "UPDATE supply_orders SET status='delivered' WHERE id=?", (order["id"],)
            )
            conn.execute(
                "UPDATE supply_reversals SET status='approved', reviewed_by=?, reviewed_at=? WHERE id=?",
                (supervisor_id, now_iso(), reversal_id),
            )
        else:
            conn.execute(
                "UPDATE supply_reversals SET status='rejected', reviewed_by=?, reviewed_at=? WHERE id=?",
                (supervisor_id, now_iso(), reversal_id),
            )
    return {"ok": True, "approved": bool(approve)}


# ============ 升级 / 提醒 ============

def escalations(conn, status=None, floor_id=None):
    sql = """SELECT e.*, s.name assignee_name, fl.name floor_name
             FROM escalations e
             JOIN floors fl ON fl.id=e.floor_id
             LEFT JOIN staff s ON s.id=e.assignee_id"""
    where, params = [], []
    if status:
        where.append("e.status=?")
        params.append(status)
    if floor_id:
        where.append("e.floor_id=?")
        params.append(floor_id)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY e.id DESC"
    rows = query_all(conn, sql, tuple(params))
    for r in rows:
        r["type_name"] = config.ESCALATION_NAMES[r["type"]]
        r["assignee_role_name"] = config.ESCALATION[r["type"]][1]
    return rows


def ack_escalation(conn, esc_id, staff_id):
    with Tx(conn):
        e = query_one(conn, "SELECT * FROM escalations WHERE id=?", (esc_id,))
        if not e:
            raise ServiceError("升级事件不存在")
        conn.execute(
            "UPDATE escalations SET status=CASE WHEN status='open' THEN 'acked' ELSE status END, "
            "acked_at=COALESCE(acked_at,?) WHERE id=?",
            (now_iso(), esc_id),
        )
    return {"ok": True}


def resolve_escalation(conn, esc_id, staff_id):
    with Tx(conn):
        conn.execute(
            "UPDATE escalations SET status='resolved', resolved_at=? WHERE id=?", (now_iso(), esc_id)
        )
    return {"ok": True}


def fire_due_reminders(conn):
    """后台周期调用：到点提醒置为 fired（幂等）。"""
    fired = []
    with Tx(conn):
        rows = conn.execute(
            "SELECT * FROM reminders WHERE fired_at IS NULL AND fire_at<=?", (now_iso(),)
        ).fetchall()
        for r in rows:
            conn.execute("UPDATE reminders SET fired_at=? WHERE id=?", (now_iso(), r["id"]))
            fired.append(dict(r))
    return fired


def reminders(conn, staff_id=None):
    return query_all(
        conn,
        """SELECT rm.*, fl.name floor_name FROM reminders rm
           JOIN floors fl ON fl.id=rm.floor_id
           ORDER BY (rm.fired_at IS NULL), rm.fire_at""",
    )


# ============ 班次交接 ============

def close_shift(conn, shift_id):
    with Tx(conn):
        shift = query_one(conn, "SELECT * FROM shifts WHERE id=?", (shift_id,))
        if not shift:
            raise ServiceError("班次不存在")
        if shift["status"] == "closed":
            raise ServiceError("班次已结束")
        rooms = query_all(conn, "SELECT id FROM rooms WHERE floor_id=?", (shift["floor_id"],))
        unsnap = [
            r["id"] for r in rooms
            if not query_one(
                conn, "SELECT 1 FROM snapshots WHERE shift_id=? AND room_id=?", (shift_id, r["id"])
            )
        ]
        if unsnap:
            raise ServiceError("仍有房间未生成班次快照，不能交接")
        conn.execute(
            "UPDATE shifts SET status='closed', ended_at=? WHERE id=?", (now_iso(), shift_id)
        )
    return {"ok": True}


def handover(conn, shift_id):
    shift = query_one(
        conn,
        """SELECT sh.*, fl.name floor_name, s.name staff_name FROM shifts sh
           JOIN floors fl ON fl.id=sh.floor_id JOIN staff s ON s.id=sh.staff_id WHERE sh.id=?""",
        (shift_id,),
    )
    if not shift:
        raise ServiceError("班次不存在")
    snaps = query_all(
        conn,
        """SELECT sp.*, r.name room_name, r.code room_code FROM snapshots sp
           JOIN rooms r ON r.id=sp.room_id WHERE sp.shift_id=? ORDER BY r.code""",
        (shift_id,),
    )
    for sp in snaps:
        sp["items"] = query_all(conn, "SELECT * FROM snapshot_items WHERE snapshot_id=?", (sp["id"],))
        sp["inventory"] = query_all(
            conn, "SELECT * FROM snapshot_inventory WHERE snapshot_id=?", (sp["id"],)
        )
        sp["facilities"] = query_all(
            conn, "SELECT * FROM snapshot_facilities WHERE snapshot_id=?", (sp["id"],)
        )
    return {
        "shift": shift,
        "snapshots": snaps,
        "open_work_orders": work_orders(conn, floor_id=shift["floor_id"]),
        "supply_queue": supply_queue(conn, floor_id=shift["floor_id"]),
        "escalations": escalations(conn, floor_id=shift["floor_id"]),
        "reminders": [r for r in reminders(conn) if r["floor_id"] == shift["floor_id"]],
    }
