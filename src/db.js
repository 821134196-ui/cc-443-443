'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS floors (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open | closed
  closed_reason TEXT,
  closed_by INTEGER,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  type TEXT NOT NULL,                            -- door_lock | diaper_table | nursing_booth | water_heater | power_outlet
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',             -- ok | fault
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  floors TEXT,                                   -- JSON 数组；NULL/空 = 全部楼层
  pin TEXT
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',         -- active | closed
  handover_note TEXT,
  handover_to INTEGER
);

-- 班次快照：只增不改（见下方触发器），哈希链防篡改
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER REFERENCES shifts(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL,
  snapshot TEXT NOT NULL,                        -- JSON：逐项结果+耗材+消毒+房间状态
  prev_hash TEXT,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consumables (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  item TEXT NOT NULL,                            -- paper_towel | cleaning_bag
  label TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  safety_level INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  unit TEXT NOT NULL,
  UNIQUE(room_id, item)
);

CREATE TABLE IF NOT EXISTS consumable_txns (
  id INTEGER PRIMARY KEY,
  consumable_id INTEGER NOT NULL REFERENCES consumables(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,                            -- inspect | shelve | reversal | adjust
  ref TEXT,
  actor INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouse_stock (
  item TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  quantity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS replenishment_orders (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  consumable_id INTEGER NOT NULL REFERENCES consumables(id),
  item TEXT NOT NULL,
  qty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | claimed | delivered | shelved | reversal_pending
  created_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  claimed_by INTEGER, claimed_at TEXT,
  delivered_by INTEGER, delivered_at TEXT,
  shelved_by INTEGER, shelved_at TEXT,
  needs_substitution INTEGER NOT NULL DEFAULT 0,
  substituted_item TEXT
);

CREATE TABLE IF NOT EXISTS reversal_requests (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES replenishment_orders(id),
  requested_by INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | approved | rejected
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fault_reports (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  facility_id INTEGER REFERENCES facilities(id), -- NULL = 房间级报障
  category TEXT NOT NULL,
  description TEXT,
  photo_path TEXT,                               -- 本地文件路径（/photos/xxx）
  source TEXT NOT NULL,                          -- customer | staff | inspection | monitor
  status TEXT NOT NULL DEFAULT 'open',           -- open | repairing | resolved
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS repairs (
  id INTEGER PRIMARY KEY,
  fault_id INTEGER NOT NULL REFERENCES fault_reports(id),
  technician_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  retest_result TEXT,                            -- pass | fail
  retest_by INTEGER,
  retest_at TEXT,
  retest_note TEXT
);

CREATE TABLE IF NOT EXISTS disinfection_records (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  staff_id INTEGER NOT NULL,
  done TEXT NOT NULL,                            -- JSON 数组
  required TEXT NOT NULL,                        -- JSON 数组
  missed TEXT NOT NULL,                          -- JSON 数组
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temperature_readings (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  celsius REAL NOT NULL,
  source TEXT NOT NULL,                          -- adapter | inspection
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                            -- substitution | overtemp | disinfection_missed | repeat_fault | room_closure | restock_overdue
  ref TEXT NOT NULL,                             -- 关联对象，如 fault:12 / order:5 / room:3
  room_id INTEGER,
  floor_id INTEGER,
  assignee_role TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',           -- open | resolved
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by INTEGER
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                            -- restock_overdue | retest_due
  ref TEXT NOT NULL,
  message TEXT NOT NULL,
  floor_id INTEGER,
  room_id INTEGER,
  created_at TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_fault_room ON fault_reports(room_id, status);
CREATE INDEX IF NOT EXISTS idx_fault_facility ON fault_reports(facility_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON replenishment_orders(status);
CREATE INDEX IF NOT EXISTS idx_escalations ON escalations(status, assignee_role);
CREATE INDEX IF NOT EXISTS idx_inspections_room ON inspections(room_id);
CREATE INDEX IF NOT EXISTS idx_readings_facility ON temperature_readings(facility_id, id);

-- 班次快照不可覆盖 / 不可删除
CREATE TRIGGER IF NOT EXISTS trg_inspections_no_update
BEFORE UPDATE ON inspections
BEGIN SELECT RAISE(ABORT, 'inspections are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_inspections_no_delete
BEFORE DELETE ON inspections
BEGIN SELECT RAISE(ABORT, 'inspections are immutable'); END;
`;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'photos'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'mall.db'));
  db.exec(SCHEMA);
  return db;
}

function isSeeded(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM floors').get();
  return row.n > 0;
}

module.exports = { openDb, isSeeded };
