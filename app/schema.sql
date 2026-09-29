-- 商场母婴室巡检与耗材补给系统 数据结构
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS floors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  level_no TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','closed')),
  closed_reason TEXT
);

CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  type TEXT NOT NULL CHECK (type IN ('changing_table','nursing_booth','water_heater')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_reason TEXT
);

-- 员工角色: staff 值班员 / supervisor 主管; duty 为升级职责（可兼任）
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff','supervisor'))
);
CREATE TABLE IF NOT EXISTS staff_duties (
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  duty TEXT NOT NULL CHECK (duty IN
    ('supply_lead','engineer','hygiene_lead','duty_manager','floor_manager')),
  PRIMARY KEY (staff_id, duty)
);
-- 楼层授权: 无记录代表可访问全部楼层（主管/经理）
CREATE TABLE IF NOT EXISTS staff_floors (
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  PRIMARY KEY (staff_id, floor_id)
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('tissue','bags')),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  safety_level INTEGER NOT NULL,
  capacity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

-- 逐项巡检记录（门锁/水温/插座/异味/清洁度/耗材余量）
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  item_key TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('ok','fault','na')),
  note TEXT,
  temp_value REAL,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  inspected_at TEXT NOT NULL,
  UNIQUE (shift_id, room_id, item_key)
);

CREATE TABLE IF NOT EXISTS disinfection_log (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  facility_id INTEGER REFERENCES facilities(id),
  shift_id INTEGER REFERENCES shifts(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temperature_readings (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  value_c REAL NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'adapter',
  recorded_at TEXT NOT NULL
);

-- 临时闭用（区别于故障闭用）
CREATE TABLE IF NOT EXISTS closures (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('room','facility')),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  facility_id INTEGER REFERENCES facilities(id),
  reason TEXT NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  started_at TEXT NOT NULL,
  expected_reopen_at TEXT,
  ended_at TEXT
);

-- 工单（故障/报障）。scope=room 影响整间；scope=facility 仅局部
CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('room','facility')),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  facility_id INTEGER REFERENCES facilities(id),
  source TEXT NOT NULL CHECK (source IN ('inspection','staff_report','customer_report')),
  item_key TEXT,
  title TEXT NOT NULL,
  description TEXT,
  photo_path TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','repairing','retest_passed')),
  reported_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL,
  repairing_at TEXT,
  repair_note TEXT,
  last_retest_at TEXT,
  last_retest_passed INTEGER,
  retest_note TEXT
);

-- 顾客报障：仅记录场所与描述，不保存姓名/电话等身份信息
CREATE TABLE IF NOT EXISTS customer_reports (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  facility_id INTEGER REFERENCES facilities(id),
  description TEXT NOT NULL,
  work_order_id INTEGER REFERENCES work_orders(id),
  created_at TEXT NOT NULL
);

-- 补给单：queued 待领取 -> claimed 已领料 -> delivered 已送达 -> shelved 已上架
CREATE TABLE IF NOT EXISTS supply_orders (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL,
  request_qty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','claimed','delivered','shelved')),
  stockout_at TEXT,
  claimed_by INTEGER REFERENCES staff(id),
  claimed_at TEXT,
  delivered_by INTEGER REFERENCES staff(id),
  delivered_at TEXT,
  shelved_by INTEGER REFERENCES staff(id),
  shelved_at TEXT,
  created_at TEXT NOT NULL,
  due_at TEXT NOT NULL
);

-- 撤销上架复核
CREATE TABLE IF NOT EXISTS supply_reversals (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES supply_orders(id),
  requested_by INTEGER NOT NULL REFERENCES staff(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES staff(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);

-- 升级事件，五类来源对应五个负责人
CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN
    ('stockout_substitute','hot_water','missed_disinfection','repeated_reports','room_closure')),
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  ref_kind TEXT,
  ref_id INTEGER,
  title TEXT NOT NULL,
  detail TEXT,
  assignee_role TEXT NOT NULL,
  assignee_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acked','resolved')),
  created_at TEXT NOT NULL,
  acked_at TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('supply_due','retest_due')),
  ref_id INTEGER NOT NULL,
  floor_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  fired_at TEXT
);

-- ===== 班次快照（生成后不可 UPDATE / DELETE / 重复提交） =====
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  room_status TEXT NOT NULL,
  water_temp_c REAL,
  created_at TEXT NOT NULL,
  UNIQUE (shift_id, room_id)
);
CREATE TABLE IF NOT EXISTS snapshot_items (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  item_key TEXT NOT NULL,
  result TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS snapshot_inventory (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  safety_level INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_facilities (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  facility_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  disinfected INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS trg_snap_no_update BEFORE UPDATE ON snapshots
BEGIN SELECT RAISE(ABORT, '班次快照不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_snap_no_delete BEFORE DELETE ON snapshots
BEGIN SELECT RAISE(ABORT, '班次快照不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_snap_item_no_update BEFORE UPDATE ON snapshot_items
BEGIN SELECT RAISE(ABORT, '班次快照不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_snap_item_no_delete BEFORE DELETE ON snapshot_items
BEGIN SELECT RAISE(ABORT, '班次快照不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_snap_inv_no_update BEFORE UPDATE ON snapshot_inventory
BEGIN SELECT RAISE(ABORT, '班次快照不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_snap_inv_no_delete BEFORE DELETE ON snapshot_inventory
BEGIN SELECT RAISE(ABORT, '班次快照不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_snap_fac_no_update BEFORE UPDATE ON snapshot_facilities
BEGIN SELECT RAISE(ABORT, '班次快照不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_snap_fac_no_delete BEFORE DELETE ON snapshot_facilities
BEGIN SELECT RAISE(ABORT, '班次快照不可删除'); END;

CREATE INDEX IF NOT EXISTS idx_wo_fac ON work_orders(facility_id);
CREATE INDEX IF NOT EXISTS idx_wo_room ON work_orders(room_id);
CREATE INDEX IF NOT EXISTS idx_reports_target ON customer_reports(room_id, facility_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON supply_orders(status);
