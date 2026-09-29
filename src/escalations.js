'use strict';

const { now } = require('./util');

/**
 * 升级路由：不同类型的事项升级给不同负责人（角色）。
 * 同一对象同一类型只保留一条未处理的升级（幂等去重）。
 */
function escalate(db, cfg, { type, ref, roomId = null, floorId = null, title, detail = '' }) {
  const route = cfg.ESCALATION_ROUTES[type];
  if (!route) throw new Error(`unknown escalation type: ${type}`);
  const dup = db
    .prepare("SELECT id FROM escalations WHERE type = ? AND ref = ? AND status = 'open'")
    .get(type, ref);
  if (dup) return { id: dup.id, deduped: true };
  const ts = now();
  const r = db
    .prepare(
      `INSERT INTO escalations (type, ref, room_id, floor_id, assignee_role, title, detail, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    )
    .run(type, ref, roomId, floorId, route.role, title, detail, ts);
  return { id: Number(r.lastInsertRowid), deduped: false };
}

function addReminder(db, { kind, ref, message, floorId = null, roomId = null }) {
  const dup = db
    .prepare('SELECT id FROM reminders WHERE kind = ? AND ref = ? AND dismissed = 0')
    .get(kind, ref);
  if (dup) return { id: dup.id, deduped: true };
  const r = db
    .prepare(
      'INSERT INTO reminders (kind, ref, message, floor_id, room_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(kind, ref, message, floorId, roomId, now());
  return { id: Number(r.lastInsertRowid), deduped: false };
}

module.exports = { escalate, addReminder };
