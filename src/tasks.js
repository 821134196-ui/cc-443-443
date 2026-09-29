'use strict';

const { now } = require('./util');
const { escalate, addReminder } = require('./escalations');
const { handleOvertemp } = require('./domain');

/** 轮询全部热水设备温度；超温 → 关闭设施 + 升级工程负责人。 */
function pollTemperatures(db, cfg, adapter) {
  const heaters = db.prepare("SELECT * FROM facilities WHERE type = 'water_heater'").all();
  const ts = now();
  const events = [];
  for (const h of heaters) {
    const celsius = adapter.read(h.id);
    db.prepare('INSERT INTO temperature_readings (facility_id, celsius, source, created_at) VALUES (?, ?, ?, ?)')
      .run(h.id, celsius, 'adapter', ts);
    if (celsius > cfg.TEMP_LIMIT_C) {
      const faultId = handleOvertemp(db, cfg, h, celsius, 'monitor');
      events.push({ facility_id: h.id, celsius, fault_id: faultId });
    }
  }
  return events;
}

/** 补给时限扫描：超过 deadline 仍未上架 → 提醒 + 升级仓储主管。 */
function scanRestockOverdue(db, cfg, nowIso = now()) {
  const rows = db
    .prepare(
      `SELECT o.*, r.name AS room_name, r.floor_id, c.label
       FROM replenishment_orders o
       JOIN rooms r ON r.id = o.room_id
       JOIN consumables c ON c.id = o.consumable_id
       WHERE o.status IN ('pending','claimed','delivered') AND o.deadline_at < ?`
    )
    .all(nowIso);
  for (const o of rows) {
    addReminder(db, {
      kind: 'restock_overdue',
      ref: `order:${o.id}`,
      message: `补给超时：${o.room_name} · ${o.label}（时限 ${o.deadline_at}）`,
      floorId: o.floor_id,
      roomId: o.room_id,
    });
    escalate(db, cfg, {
      type: 'restock_overdue',
      ref: `order:${o.id}`,
      roomId: o.room_id,
      floorId: o.floor_id,
      title: `补给超时：${o.room_name} · ${o.label}`,
      detail: `单据 #${o.id} 超过时限 ${o.deadline_at} 仍未上架`,
    });
  }
  return rows.length;
}

/** 复检提醒：维修开始超过阈值仍未复测 → 提醒。 */
function scanRetestDue(db, cfg, nowDate = new Date()) {
  const threshold = new Date(nowDate.getTime() - cfg.RETEST_DUE_MIN * 60000).toISOString();
  const rows = db
    .prepare(
      `SELECT f.id, f.category, f.room_id, r.name AS room_name, r.floor_id, rp.started_at
       FROM fault_reports f
       JOIN rooms r ON r.id = f.room_id
       JOIN repairs rp ON rp.fault_id = f.id AND rp.retest_result IS NULL
       WHERE f.status = 'repairing' AND rp.started_at < ?`
    )
    .all(threshold);
  for (const f of rows) {
    addReminder(db, {
      kind: 'retest_due',
      ref: `fault:${f.id}`,
      message: `待复检：${f.room_name} · ${f.category}（维修开始于 ${f.started_at}）`,
      floorId: f.floor_id,
      roomId: f.room_id,
    });
  }
  return rows.length;
}

/** 单节拍（测试可直接调用）。 */
function runTick(db, cfg, adapter) {
  const tempEvents = pollTemperatures(db, cfg, adapter);
  const overdue = scanRestockOverdue(db, cfg);
  const retestDue = scanRetestDue(db, cfg);
  return { tempEvents, overdue, retestDue };
}

/** 启动进程内任务循环，返回停止函数。 */
function startTasks(db, cfg, adapter, tickMs = cfg.TASK_TICK_MS) {
  const timer = setInterval(() => {
    try {
      runTick(db, cfg, adapter);
    } catch (err) {
      console.error('[tasks] tick failed:', err.message);
    }
  }, tickMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { runTick, startTasks, pollTemperatures, scanRestockOverdue, scanRetestDue };
