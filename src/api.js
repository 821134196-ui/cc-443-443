'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Router, readJson } = require('./http');
const { HttpError, now } = require('./util');
const domain = require('./domain');

const PHOTO_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

function requireStaff(req, db) {
  const id = Number(req.headers['x-staff-id']);
  if (!id) throw new HttpError(401, 'unauthorized', '缺少身份（X-Staff-Id）');
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!staff) throw new HttpError(401, 'unauthorized', '身份不存在');
  return staff;
}

function parseStaff(staff) {
  return { ...staff, floors: staff.floors ? JSON.parse(staff.floors) : null };
}

function buildApi({ db, cfg, adapter, photosDir }) {
  const r = new Router();
  const staffOf = (req) => requireStaff(req, db);

  /* ---------- 基础数据 ---------- */

  r.get('/api/config', () => ({
    check_items: cfg.CHECK_ITEMS,
    consumables: cfg.CONSUMABLES,
    facility_types: cfg.FACILITY_TYPES,
    required_disinfection: cfg.REQUIRED_DISINFECTION,
    escalation_routes: Object.fromEntries(Object.entries(cfg.ESCALATION_ROUTES).map(([k, v]) => [k, v.label])),
    role_labels: cfg.ROLE_LABELS,
    temp_limit_c: cfg.TEMP_LIMIT_C,
    restock_sla_min: cfg.RESTOCK_SLA_MIN,
  }));

  r.get('/api/staff', () =>
    db.prepare('SELECT id, name, role, floors FROM staff ORDER BY id').all().map(parseStaff)
  );

  r.get('/api/floors', () => db.prepare('SELECT * FROM floors ORDER BY id').all());

  /* ---------- 楼层总览 ---------- */

  r.get('/api/overview', (req) => {
    const floorId = Number(req.query.floor_id);
    const where = floorId ? 'WHERE r.floor_id = ?' : '';
    const args = floorId ? [floorId] : [];
    const rooms = db.prepare(`SELECT r.*, f.name AS floor_name, f.code AS floor_code FROM rooms r JOIN floors f ON f.id = r.floor_id ${where} ORDER BY r.floor_id, r.code`).all(...args);
    return rooms.map((room) => {
      const fac = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok FROM facilities WHERE room_id = ?").get(room.id);
      const consumables = db.prepare('SELECT item, label, quantity, safety_level, capacity, unit FROM consumables WHERE room_id = ? ORDER BY item').all(room.id);
      const faults = db.prepare("SELECT COUNT(*) AS n FROM fault_reports WHERE room_id = ? AND status != 'resolved'").get(room.id).n;
      const orders = db.prepare("SELECT COUNT(*) AS n FROM replenishment_orders WHERE room_id = ? AND status IN ('pending','claimed','delivered','reversal_pending')").get(room.id).n;
      const escalations = db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE room_id = ? AND status = 'open'").get(room.id).n;
      return {
        ...room,
        facilities_total: fac.total,
        facilities_ok: room.status === 'closed' ? 0 : fac.ok,
        consumables,
        open_faults: faults,
        active_orders: orders,
        open_escalations: escalations,
      };
    });
  });

  r.get('/api/rooms/:id', (req) => {
    const room = domain.mustGet(db,
      'SELECT r.*, f.name AS floor_name FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = ?',
      [Number(req.params.id)], 'room_not_found', '房间不存在');
    const facilities = db.prepare(`
      SELECT fa.*, (SELECT COUNT(*) FROM fault_reports fr WHERE fr.facility_id = fa.id AND fr.status != 'resolved') AS open_faults
      FROM facilities fa WHERE fa.room_id = ? ORDER BY fa.id`).all(room.id);
    const consumables = db.prepare('SELECT * FROM consumables WHERE room_id = ? ORDER BY item').all(room.id);
    const faults = db.prepare(`
      SELECT fr.*, fa.label AS facility_label FROM fault_reports fr
      LEFT JOIN facilities fa ON fa.id = fr.facility_id
      WHERE fr.room_id = ? AND fr.status != 'resolved' ORDER BY fr.id DESC`).all(room.id);
    const orders = db.prepare(`
      SELECT o.*, c.label, c.unit FROM replenishment_orders o JOIN consumables c ON c.id = o.consumable_id
      WHERE o.room_id = ? AND o.status IN ('pending','claimed','delivered','reversal_pending') ORDER BY o.id DESC`).all(room.id);
    const lastInspection = db.prepare('SELECT id, created_at, hash FROM inspections WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(room.id);
    const lastDisinfection = db.prepare('SELECT * FROM disinfection_records WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(room.id);
    return { room, facilities, consumables, faults, orders, last_inspection: lastInspection, last_disinfection: lastDisinfection };
  });

  /* ---------- 设施状态 ---------- */

  r.get('/api/facilities', (req) => {
    const floorId = Number(req.query.floor_id);
    const where = floorId ? 'WHERE r.floor_id = ?' : '';
    const args = floorId ? [floorId] : [];
    return db.prepare(`
      SELECT fa.*, r.name AS room_name, r.code AS room_code, r.status AS room_status, r.floor_id,
        (SELECT COUNT(*) FROM fault_reports fr WHERE fr.facility_id = fa.id AND fr.status != 'resolved') AS open_faults
      FROM facilities fa JOIN rooms r ON r.id = fa.room_id ${where}
      ORDER BY r.floor_id, r.code, fa.id`).all(...args);
  });

  r.get('/api/faults', (req) => {
    const floorId = Number(req.query.floor_id);
    const status = req.query.status;
    const conds = [];
    const args = [];
    if (floorId) { conds.push('r.floor_id = ?'); args.push(floorId); }
    if (status === 'open') { conds.push("fr.status != 'resolved'"); }
    else if (status) { conds.push('fr.status = ?'); args.push(status); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return db.prepare(`
      SELECT fr.*, r.name AS room_name, r.code AS room_code, r.floor_id, fa.label AS facility_label, fa.type AS facility_type,
        (SELECT json_object('technician', (SELECT name FROM staff WHERE id = rp.technician_id), 'started_at', rp.started_at, 'retest_result', rp.retest_result)
         FROM repairs rp WHERE rp.fault_id = fr.id ORDER BY rp.id DESC LIMIT 1) AS repair
      FROM fault_reports fr
      JOIN rooms r ON r.id = fr.room_id
      LEFT JOIN facilities fa ON fa.id = fr.facility_id
      ${where} ORDER BY CASE fr.status WHEN 'open' THEN 0 WHEN 'repairing' THEN 1 ELSE 2 END, fr.id DESC`).all(...args)
      .map((f) => ({ ...f, repair: f.repair ? JSON.parse(f.repair) : null }));
  });

  /** 顾客报障：公开接口，不采集任何报障人身份信息。 */
  r.post('/api/reports', async (req) => {
    const body = await readJson(req);
    return domain.reportFault(db, cfg, {
      roomId: Number(body.room_id),
      facilityId: body.facility_id ? Number(body.facility_id) : null,
      category: body.category,
      description: body.description,
      photoPath: body.photo_path || null,
      source: body.source === 'staff' ? 'staff' : 'customer',
    });
  });

  r.post('/api/faults/:id/claim', (req) => domain.claimFault(db, staffOf(req), Number(req.params.id)));

  r.post('/api/faults/:id/retest', async (req) => {
    const body = await readJson(req);
    return domain.retestFault(db, staffOf(req), Number(req.params.id), { result: body.result, note: body.note });
  });

  r.post('/api/rooms/:id/close', async (req) => {
    const body = await readJson(req);
    return domain.closeRoom(db, cfg, staffOf(req), Number(req.params.id), body.reason);
  });

  r.post('/api/rooms/:id/reopen', (req) => domain.reopenRoom(db, staffOf(req), Number(req.params.id)));

  /* ---------- 巡检与快照 ---------- */

  r.post('/api/inspections', async (req) => {
    const body = await readJson(req);
    return domain.submitInspection(db, cfg, adapter, staffOf(req), body);
  });

  r.get('/api/inspections', (req) => {
    const conds = [];
    const args = [];
    if (req.query.room_id) { conds.push('i.room_id = ?'); args.push(Number(req.query.room_id)); }
    if (req.query.shift_id) { conds.push('i.shift_id = ?'); args.push(Number(req.query.shift_id)); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return db.prepare(`
      SELECT i.id, i.shift_id, i.room_id, i.created_at, i.hash, i.prev_hash, r.name AS room_name, s.name AS staff_name
      FROM inspections i JOIN rooms r ON r.id = i.room_id JOIN staff s ON s.id = i.staff_id
      ${where} ORDER BY i.id DESC LIMIT 100`).all(...args);
  });

  r.get('/api/inspections/:id', (req) => {
    const row = domain.mustGet(db, `
      SELECT i.*, r.name AS room_name, s.name AS staff_name FROM inspections i
      JOIN rooms r ON r.id = i.room_id JOIN staff s ON s.id = i.staff_id WHERE i.id = ?`,
      [Number(req.params.id)], 'inspection_not_found', '巡检快照不存在');
    return { ...row, snapshot: JSON.parse(row.snapshot) };
  });

  /* ---------- 补给队列 ---------- */

  r.get('/api/replenishments', (req) => {
    const floorId = Number(req.query.floor_id);
    const conds = [];
    const args = [];
    if (floorId) { conds.push('r.floor_id = ?'); args.push(floorId); }
    if (req.query.active === '1') { conds.push("o.status IN ('pending','claimed','delivered','reversal_pending')"); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const orders = db.prepare(`
      SELECT o.*, r.name AS room_name, r.code AS room_code, r.floor_id, c.label, c.unit, c.quantity AS stock_now, c.safety_level, c.capacity,
        cs.name AS claimed_by_name, ds.name AS delivered_by_name, ss.name AS shelved_by_name,
        (SELECT COUNT(*) FROM reversal_requests rr WHERE rr.order_id = o.id AND rr.status = 'pending') AS pending_reversal
      FROM replenishment_orders o
      JOIN rooms r ON r.id = o.room_id
      JOIN consumables c ON c.id = o.consumable_id
      LEFT JOIN staff cs ON cs.id = o.claimed_by
      LEFT JOIN staff ds ON ds.id = o.delivered_by
      LEFT JOIN staff ss ON ss.id = o.shelved_by
      ${where}
      ORDER BY CASE o.status WHEN 'pending' THEN 0 WHEN 'claimed' THEN 1 WHEN 'delivered' THEN 2 WHEN 'reversal_pending' THEN 3 ELSE 4 END, o.id DESC
      LIMIT 200`).all(...args);
    const warehouse = db.prepare('SELECT * FROM warehouse_stock ORDER BY item').all();
    return { orders, warehouse };
  });

  r.post('/api/replenishments/:id/claim', (req) => domain.claimOrder(db, staffOf(req), Number(req.params.id)));
  r.post('/api/replenishments/:id/deliver', (req) => domain.deliverOrder(db, staffOf(req), Number(req.params.id)));
  r.post('/api/replenishments/:id/shelve', (req) => domain.shelveOrder(db, staffOf(req), Number(req.params.id)));

  r.post('/api/replenishments/:id/substitute', async (req) => {
    const body = await readJson(req);
    return domain.substituteOrder(db, cfg, staffOf(req), Number(req.params.id), body.substituted_item);
  });

  r.post('/api/replenishments/:id/reversal-requests', async (req) => {
    const body = await readJson(req);
    return domain.requestReversal(db, staffOf(req), Number(req.params.id), body.reason);
  });

  r.get('/api/reversal-requests', (req) => {
    const status = req.query.status || 'pending';
    return db.prepare(`
      SELECT rr.*, o.item, o.qty, o.room_id, r.name AS room_name, r.floor_id, c.label, c.unit,
        rq.name AS requested_by_name, rv.name AS reviewed_by_name
      FROM reversal_requests rr
      JOIN replenishment_orders o ON o.id = rr.order_id
      JOIN rooms r ON r.id = o.room_id
      JOIN consumables c ON c.id = o.consumable_id
      JOIN staff rq ON rq.id = rr.requested_by
      LEFT JOIN staff rv ON rv.id = rr.reviewed_by
      WHERE rr.status = ? ORDER BY rr.id DESC`).all(status);
  });

  r.post('/api/reversal-requests/:id/review', async (req) => {
    const body = await readJson(req);
    return domain.reviewReversal(db, staffOf(req), Number(req.params.id), !!body.approve);
  });

  /* ---------- 升级与提醒 ---------- */

  r.get('/api/escalations', (req) => {
    const conds = [];
    const args = [];
    if (req.query.status) { conds.push('e.status = ?'); args.push(req.query.status); }
    if (req.query.floor_id) { conds.push('e.floor_id = ?'); args.push(Number(req.query.floor_id)); }
    if (req.query.mine === '1') {
      const staff = staffOf(req);
      if (staff.role !== 'supervisor') { conds.push('e.assignee_role = ?'); args.push(staff.role); }
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return db.prepare(`
      SELECT e.*, r.name AS room_name, rs.name AS resolved_by_name
      FROM escalations e LEFT JOIN rooms r ON r.id = e.room_id LEFT JOIN staff rs ON rs.id = e.resolved_by
      ${where} ORDER BY CASE e.status WHEN 'open' THEN 0 ELSE 1 END, e.id DESC LIMIT 200`).all(...args);
  });

  r.post('/api/escalations/:id/resolve', (req) => {
    const staff = staffOf(req);
    const esc = domain.mustGet(db, 'SELECT * FROM escalations WHERE id = ?', [Number(req.params.id)], 'escalation_not_found', '升级单不存在');
    if (esc.status !== 'open') throw new HttpError(409, 'bad_state', '该升级已处理');
    if (staff.role !== 'supervisor' && staff.role !== esc.assignee_role) {
      throw new HttpError(403, 'forbidden_role', `该升级由「${cfg.ROLE_LABELS[esc.assignee_role] || esc.assignee_role}」负责处理`);
    }
    db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?")
      .run(now(), staff.id, esc.id);
    return { escalation_id: esc.id, status: 'resolved' };
  });

  r.get('/api/reminders', (req) => {
    const conds = ['dismissed = 0'];
    const args = [];
    if (req.query.floor_id) { conds.push('floor_id = ?'); args.push(Number(req.query.floor_id)); }
    return db.prepare(`SELECT * FROM reminders WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT 100`).all(...args);
  });

  r.post('/api/reminders/:id/dismiss', (req) => {
    staffOf(req);
    db.prepare('UPDATE reminders SET dismissed = 1 WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  /* ---------- 温度 / 消毒 ---------- */

  /** 巡检现场读取水温（模拟适配器），超温立即触发闭设施+升级。 */
  r.post('/api/facilities/:id/temperature', (req) => {
    staffOf(req);
    const fac = domain.mustGet(db, "SELECT * FROM facilities WHERE id = ? AND type = 'water_heater'", [Number(req.params.id)], 'facility_not_found', '热水设备不存在');
    const celsius = adapter.read(fac.id);
    db.prepare('INSERT INTO temperature_readings (facility_id, celsius, source, created_at) VALUES (?, ?, ?, ?)')
      .run(fac.id, celsius, 'inspection', now());
    let overtemp = false;
    if (celsius > cfg.TEMP_LIMIT_C) {
      domain.handleOvertemp(db, cfg, fac, celsius, 'inspection');
      overtemp = true;
    }
    return { facility_id: fac.id, celsius, limit: cfg.TEMP_LIMIT_C, overtemp };
  });

  r.get('/api/temperature', (req) => {
    const floorId = Number(req.query.floor_id);
    const where = floorId ? 'WHERE r.floor_id = ?' : '';
    const args = floorId ? [floorId] : [];
    return db.prepare(`
      SELECT fa.id AS facility_id, fa.label, fa.status, r.name AS room_name, r.floor_id,
        (SELECT celsius FROM temperature_readings t WHERE t.facility_id = fa.id ORDER BY t.id DESC LIMIT 1) AS celsius,
        (SELECT created_at FROM temperature_readings t WHERE t.facility_id = fa.id ORDER BY t.id DESC LIMIT 1) AS measured_at
      FROM facilities fa JOIN rooms r ON r.id = fa.room_id
      ${where ? where + " AND fa.type = 'water_heater'" : "WHERE fa.type = 'water_heater'"}
      ORDER BY r.floor_id, r.code`).all(...args);
  });

  r.get('/api/disinfection', (req) => {
    const conds = [];
    const args = [];
    if (req.query.room_id) { conds.push('d.room_id = ?'); args.push(Number(req.query.room_id)); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return db.prepare(`
      SELECT d.*, r.name AS room_name, s.name AS staff_name
      FROM disinfection_records d JOIN rooms r ON r.id = d.room_id JOIN staff s ON s.id = d.staff_id
      ${where} ORDER BY d.id DESC LIMIT 50`).all(...args)
      .map((d) => ({ ...d, done: JSON.parse(d.done), required: JSON.parse(d.required), missed: JSON.parse(d.missed) }));
  });

  /* ---------- 班次与交接 ---------- */

  r.post('/api/shifts', async (req) => {
    const body = await readJson(req);
    return domain.startShift(db, staffOf(req), Number(body.floor_id));
  });

  r.post('/api/shifts/:id/close', async (req) => {
    const body = await readJson(req);
    return domain.closeShift(db, staffOf(req), Number(req.params.id), { note: body.note, handoverTo: body.handover_to });
  });

  r.get('/api/handover', (req) => {
    const floorId = Number(req.query.floor_id) || null;
    const staffId = Number(req.headers['x-staff-id']) || null;
    const floorArgs = floorId ? [floorId] : [];
    const floorWhere = floorId ? 'AND r.floor_id = ?' : '';
    const shift = staffId
      ? db.prepare(`SELECT sh.*, s.name AS staff_name, f.name AS floor_name FROM shifts sh JOIN staff s ON s.id = sh.staff_id JOIN floors f ON f.id = sh.floor_id
                    WHERE sh.staff_id = ? AND sh.status = 'active' ${floorId ? 'AND sh.floor_id = ?' : ''} ORDER BY sh.id DESC LIMIT 1`)
          .get(...(floorId ? [staffId, floorId] : [staffId]))
      : null;
    const inspections = shift
      ? db.prepare(`SELECT i.id, i.created_at, i.hash, r.name AS room_name FROM inspections i JOIN rooms r ON r.id = i.room_id WHERE i.shift_id = ? ORDER BY i.id DESC`).all(shift.id)
      : [];
    const openFaults = db.prepare(`SELECT fr.id, fr.category, fr.status, fr.created_at, r.name AS room_name FROM fault_reports fr JOIN rooms r ON r.id = fr.room_id WHERE fr.status != 'resolved' ${floorWhere} ORDER BY fr.id DESC LIMIT 50`).all(...floorArgs);
    const activeOrders = db.prepare(`SELECT o.id, o.status, o.deadline_at, r.name AS room_name, c.label, o.qty, c.unit FROM replenishment_orders o JOIN rooms r ON r.id = o.room_id JOIN consumables c ON c.id = o.consumable_id WHERE o.status IN ('pending','claimed','delivered','reversal_pending') ${floorWhere} ORDER BY o.id DESC LIMIT 50`).all(...floorArgs);
    const escalations = db.prepare(`SELECT e.*, r.name AS room_name FROM escalations e LEFT JOIN rooms r ON r.id = e.room_id WHERE e.status = 'open' ${floorId ? 'AND e.floor_id = ?' : ''} ORDER BY e.id DESC LIMIT 50`).all(...floorArgs);
    const reminders = db.prepare(`SELECT * FROM reminders WHERE dismissed = 0 ${floorId ? 'AND floor_id = ?' : ''} ORDER BY id DESC LIMIT 50`).all(...floorArgs);
    const recentShifts = db.prepare(`
      SELECT sh.*, s.name AS staff_name, f.name AS floor_name,
        (SELECT COUNT(*) FROM inspections i WHERE i.shift_id = sh.id) AS inspection_count
      FROM shifts sh JOIN staff s ON s.id = sh.staff_id JOIN floors f ON f.id = sh.floor_id
      WHERE sh.status = 'closed' ${floorId ? 'AND sh.floor_id = ?' : ''} ORDER BY sh.id DESC LIMIT 5`).all(...floorArgs);
    return { shift, inspections, open_faults: openFaults, active_orders: activeOrders, escalations, reminders, recent_shifts: recentShifts };
  });

  /* ---------- 照片（本地文件存储） ---------- */

  r.post('/api/photos', async (req) => {
    const body = await readJson(req);
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw new HttpError(400, 'bad_photo', '照片须为 dataURL（png/jpeg/webp/gif）');
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${PHOTO_MIME[m[1]]}`;
    fs.writeFileSync(path.join(photosDir, name), Buffer.from(m[2], 'base64'));
    return { path: `/photos/${name}` };
  });

  return r;
}

module.exports = { buildApi };
