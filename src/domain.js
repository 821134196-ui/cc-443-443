'use strict';

const { HttpError, now, sha256, addMinutes, tx } = require('./util');
const { escalate, addReminder } = require('./escalations');

/* ---------------- 权限 ---------------- */

function staffFloors(staff) {
  if (!staff.floors) return null; // NULL = 全部楼层
  try { return JSON.parse(staff.floors); } catch { return null; }
}

function assertRole(staff, roles) {
  if (!roles.includes(staff.role)) {
    throw new HttpError(403, 'forbidden_role', `当前身份（${staff.role}）无权执行此操作`);
  }
}

function assertFloorScope(staff, floorId) {
  const floors = staffFloors(staff);
  if (floors && floors.length && !floors.includes(Number(floorId))) {
    throw new HttpError(403, 'forbidden_floor', '无权操作其他楼层的资源');
  }
}

function mustGet(db, sql, params, code = 'not_found', message = '资源不存在') {
  const row = db.prepare(sql).get(...params);
  if (!row) throw new HttpError(404, code, message);
  return row;
}

/* ---------------- 故障 ---------------- */

/** 创建故障（内部共用）：关闭对应设施 + 连续报障升级检查。须在事务内调用。 */
function createFaultInternal(db, cfg, { roomId, facilityId = null, category, description = '', photoPath = null, source }) {
  const ts = now();
  const room = mustGet(db, 'SELECT * FROM rooms WHERE id = ?', [roomId], 'room_not_found', '房间不存在');
  if (facilityId) {
    db.prepare("UPDATE facilities SET status = 'fault', updated_at = ? WHERE id = ?").run(ts, facilityId);
  }
  const r = db
    .prepare(
      `INSERT INTO fault_reports (room_id, facility_id, category, description, photo_path, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
    )
    .run(roomId, facilityId, category, description, photoPath, source, ts);
  const faultId = Number(r.lastInsertRowid);

  // 连续报障：窗口内同一设施报障达到阈值 → 升级楼层经理
  if (facilityId) {
    const since = new Date(Date.now() - cfg.REPEAT_FAULT_WINDOW_H * 3600 * 1000).toISOString();
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM fault_reports WHERE facility_id = ? AND created_at >= ?')
      .get(facilityId, since);
    if (n >= cfg.REPEAT_FAULT_THRESHOLD) {
      const fac = db.prepare('SELECT * FROM facilities WHERE id = ?').get(facilityId);
      escalate(db, cfg, {
        type: 'repeat_fault',
        ref: `facility:${facilityId}`,
        roomId,
        floorId: room.floor_id,
        title: `连续报障：${room.name} · ${fac ? fac.label : ''}`,
        detail: `${cfg.REPEAT_FAULT_WINDOW_H} 小时内第 ${n} 次报障（${category}）`,
      });
    }
  }
  return faultId;
}

/** 热水超温：关闭热水设备 + 故障单 + 升级工程负责人。幂等。 */
function handleOvertemp(db, cfg, facility, celsius, source) {
  const ts = now();
  db.prepare("UPDATE facilities SET status = 'fault', updated_at = ? WHERE id = ?").run(ts, facility.id);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(facility.room_id);
  let fault = db
    .prepare(
      "SELECT * FROM fault_reports WHERE facility_id = ? AND category = '热水超温' AND status != 'resolved'"
    )
    .get(facility.id);
  let faultId;
  if (fault) {
    faultId = fault.id;
  } else {
    faultId = createFaultInternal(db, cfg, {
      roomId: facility.room_id,
      facilityId: facility.id,
      category: '热水超温',
      description: `水温 ${celsius}℃ 超过安全上限 ${cfg.TEMP_LIMIT_C}℃`,
      source,
    });
  }
  escalate(db, cfg, {
    type: 'overtemp',
    ref: `facility:${facility.id}`,
    roomId: facility.room_id,
    floorId: room.floor_id,
    title: `热水超温：${room.name} · ${facility.label}`,
    detail: `读数 ${celsius}℃ > 上限 ${cfg.TEMP_LIMIT_C}℃，设备已关闭待检修`,
  });
  return faultId;
}

/** 顾客/员工报障（不采集任何报障人身份信息）。 */
function reportFault(db, cfg, { roomId, facilityId = null, category, description = '', photoPath = null, source = 'customer' }) {
  if (!category || !String(category).trim()) throw new HttpError(400, 'bad_request', '缺少故障类别');
  mustGet(db, 'SELECT id FROM rooms WHERE id = ?', [roomId], 'room_not_found', '房间不存在');
  if (facilityId) {
    const fac = mustGet(db, 'SELECT * FROM facilities WHERE id = ?', [facilityId], 'facility_not_found', '设施不存在');
    if (fac.room_id !== Number(roomId)) throw new HttpError(400, 'bad_request', '设施不属于该房间');
  }
  return tx(db, () => ({
    fault_id: createFaultInternal(db, cfg, {
      roomId: Number(roomId), facilityId: facilityId ? Number(facilityId) : null,
      category: String(category).trim(), description: String(description || ''), photoPath, source,
    }),
  }));
}

/** 维修认领故障。 */
function claimFault(db, staff, faultId) {
  assertRole(staff, ['maintenance', 'supervisor']);
  return tx(db, () => {
    const fault = mustGet(db, 'SELECT * FROM fault_reports WHERE id = ?', [faultId], 'fault_not_found', '故障单不存在');
    const r = db.prepare("UPDATE fault_reports SET status = 'repairing' WHERE id = ? AND status = 'open'").run(faultId);
    if (r.changes === 0) throw new HttpError(409, 'bad_state', `故障单当前状态为 ${fault.status}，无法认领`);
    db.prepare('INSERT INTO repairs (fault_id, technician_id, started_at) VALUES (?, ?, ?)')
      .run(faultId, staff.id, now());
    return { fault_id: faultId, status: 'repairing' };
  });
}

/** 维修复测：通过 → 故障解决且设施重新开放；不通过 → 维持关闭继续维修。 */
function retestFault(db, staff, faultId, { result, note = '' }) {
  assertRole(staff, ['maintenance', 'supervisor', 'inspector']);
  if (!['pass', 'fail'].includes(result)) throw new HttpError(400, 'bad_request', '复测结果须为 pass 或 fail');
  return tx(db, () => {
    const fault = mustGet(db, 'SELECT * FROM fault_reports WHERE id = ?', [faultId], 'fault_not_found', '故障单不存在');
    if (fault.status !== 'repairing') throw new HttpError(409, 'bad_state', '仅维修中的故障可复测');
    const repair = db
      .prepare('SELECT * FROM repairs WHERE fault_id = ? AND retest_result IS NULL ORDER BY id DESC LIMIT 1')
      .get(faultId);
    if (!repair) throw new HttpError(409, 'bad_state', '未找到待复测的维修记录');
    const ts = now();
    db.prepare('UPDATE repairs SET retest_result = ?, retest_by = ?, retest_at = ?, retest_note = ? WHERE id = ?')
      .run(result, staff.id, ts, note, repair.id);

    let facilityReopened = false;
    if (result === 'pass') {
      db.prepare("UPDATE fault_reports SET status = 'resolved', resolved_at = ? WHERE id = ?").run(ts, faultId);
      db.prepare("UPDATE reminders SET dismissed = 1 WHERE ref = ? AND dismissed = 0").run(`fault:${faultId}`);
      if (fault.facility_id) {
        const { n } = db
          .prepare("SELECT COUNT(*) AS n FROM fault_reports WHERE facility_id = ? AND status != 'resolved'")
          .get(fault.facility_id);
        if (n === 0) {
          db.prepare("UPDATE facilities SET status = 'ok', updated_at = ? WHERE id = ?").run(ts, fault.facility_id);
          facilityReopened = true;
        }
      }
    } else {
      // 复测不通过：保持关闭，自动进入下一轮维修（可再次复测）
      db.prepare('INSERT INTO repairs (fault_id, technician_id, started_at) VALUES (?, ?, ?)')
        .run(faultId, repair.technician_id, ts);
    }
    return { fault_id: faultId, result, facility_reopened: facilityReopened };
  });
}

/* ---------------- 房间闭用 / 重开 ---------------- */

function closeRoomInternal(db, cfg, room, reason, staffId) {
  const ts = now();
  db.prepare("UPDATE rooms SET status = 'closed', closed_reason = ?, closed_by = ?, closed_at = ? WHERE id = ?")
    .run(reason, staffId, ts, room.id);
  escalate(db, cfg, {
    type: 'room_closure',
    ref: `room:${room.id}`,
    roomId: room.id,
    floorId: room.floor_id,
    title: `整间闭用：${room.name}`,
    detail: reason || '未填写原因',
  });
}

function closeRoom(db, cfg, staff, roomId, reason) {
  assertRole(staff, ['inspector', 'supervisor']);
  return tx(db, () => {
    const room = mustGet(db, 'SELECT * FROM rooms WHERE id = ?', [roomId], 'room_not_found', '房间不存在');
    assertFloorScope(staff, room.floor_id);
    if (room.status === 'closed') throw new HttpError(409, 'bad_state', '房间已处于闭用状态');
    closeRoomInternal(db, cfg, room, String(reason || ''), staff.id);
    return { room_id: room.id, status: 'closed' };
  });
}

/** 重新开放：须无未解决故障（即相关故障均已复测通过）。 */
function reopenRoom(db, staff, roomId) {
  assertRole(staff, ['inspector', 'supervisor']);
  return tx(db, () => {
    const room = mustGet(db, 'SELECT * FROM rooms WHERE id = ?', [roomId], 'room_not_found', '房间不存在');
    assertFloorScope(staff, room.floor_id);
    if (room.status !== 'closed') throw new HttpError(409, 'bad_state', '房间未处于闭用状态');
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM fault_reports WHERE room_id = ? AND status != 'resolved'")
      .get(roomId);
    if (n > 0) throw new HttpError(409, 'unresolved_faults', `仍有 ${n} 条未解决故障，须维修复测通过后方可重新开放`);
    db.prepare("UPDATE rooms SET status = 'open', closed_reason = NULL, closed_by = NULL, closed_at = NULL WHERE id = ?")
      .run(roomId);
    return { room_id: room.id, status: 'open' };
  });
}

/* ---------------- 补给 ---------------- */

/** 耗材低于安全量 → 自动进入补给队列（同一耗材只保留一张进行中的单）。须在事务内调用。 */
function ensureReplenishmentOrder(db, cfg, consumable, room) {
  const open = db
    .prepare(
      "SELECT id FROM replenishment_orders WHERE consumable_id = ? AND status IN ('pending','claimed','delivered')"
    )
    .get(consumable.id);
  if (open) return null;
  const ts = now();
  const qty = Math.max(1, consumable.capacity - consumable.quantity);
  const r = db
    .prepare(
      `INSERT INTO replenishment_orders (room_id, consumable_id, item, qty, status, created_at, deadline_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(room.id, consumable.id, consumable.item, qty, ts, addMinutes(ts, cfg.RESTOCK_SLA_MIN));
  return Number(r.lastInsertRowid);
}

/** 领料：原子条件更新 —— 两人同时领取时只有首个成功。 */
function claimOrder(db, staff, orderId) {
  assertRole(staff, ['stocker', 'supervisor']);
  return tx(db, () => {
    const ts = now();
    const r = db
      .prepare("UPDATE replenishment_orders SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'pending'")
      .run(staff.id, ts, orderId);
    if (r.changes === 0) {
      const cur = db.prepare('SELECT o.*, s.name AS claimer FROM replenishment_orders o LEFT JOIN staff s ON s.id = o.claimed_by WHERE o.id = ?').get(orderId);
      if (!cur) throw new HttpError(404, 'order_not_found', '补给单不存在');
      throw new HttpError(409, 'already_claimed', cur.claimer ? `该单已被 ${cur.claimer} 领取` : '该单已被领取或状态已变化');
    }
    // 从仓库扣减；库存不足 → 标记需要缺货替代
    const order = db.prepare('SELECT * FROM replenishment_orders WHERE id = ?').get(orderId);
    const wh = db.prepare('SELECT * FROM warehouse_stock WHERE item = ?').get(order.item);
    let needsSubstitution = 0;
    if (wh) {
      const take = Math.min(wh.quantity, order.qty);
      db.prepare('UPDATE warehouse_stock SET quantity = quantity - ? WHERE item = ?').run(take, order.item);
      if (take < order.qty) needsSubstitution = 1;
    } else {
      needsSubstitution = 1;
    }
    if (needsSubstitution) {
      db.prepare('UPDATE replenishment_orders SET needs_substitution = 1 WHERE id = ?').run(orderId);
    }
    return { order_id: orderId, status: 'claimed', needs_substitution: needsSubstitution };
  });
}

/** 送达确认。 */
function deliverOrder(db, staff, orderId) {
  assertRole(staff, ['stocker', 'supervisor']);
  const ts = now();
  const r = db
    .prepare("UPDATE replenishment_orders SET status = 'delivered', delivered_by = ?, delivered_at = ? WHERE id = ? AND status = 'claimed' AND needs_substitution = 0")
    .run(staff.id, ts, orderId);
  if (r.changes === 0) {
    const cur = db.prepare('SELECT * FROM replenishment_orders WHERE id = ?').get(orderId);
    if (!cur) throw new HttpError(404, 'order_not_found', '补给单不存在');
    if (cur.needs_substitution) throw new HttpError(409, 'substitution_required', '仓库缺货，请先登记缺货替代');
    throw new HttpError(409, 'bad_state', `当前状态为 ${cur.status}，无法确认送达`);
  }
  return { order_id: orderId, status: 'delivered' };
}

/** 上架确认：库存入账 + 关闭超时提醒。 */
function shelveOrder(db, staff, orderId) {
  assertRole(staff, ['stocker', 'supervisor']);
  return tx(db, () => {
    const ts = now();
    const r = db
      .prepare("UPDATE replenishment_orders SET status = 'shelved', shelved_by = ?, shelved_at = ? WHERE id = ? AND status = 'delivered'")
      .run(staff.id, ts, orderId);
    if (r.changes === 0) {
      const cur = db.prepare('SELECT * FROM replenishment_orders WHERE id = ?').get(orderId);
      if (!cur) throw new HttpError(404, 'order_not_found', '补给单不存在');
      throw new HttpError(409, 'bad_state', `当前状态为 ${cur.status}，无法确认上架`);
    }
    const order = db.prepare('SELECT * FROM replenishment_orders WHERE id = ?').get(orderId);
    db.prepare('UPDATE consumables SET quantity = MIN(capacity, quantity + ?) WHERE id = ?').run(order.qty, order.consumable_id);
    db.prepare('INSERT INTO consumable_txns (consumable_id, delta, kind, ref, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(order.consumable_id, order.qty, 'shelve', `order:${orderId}`, staff.id, ts);
    db.prepare("UPDATE reminders SET dismissed = 1 WHERE kind = 'restock_overdue' AND ref = ? AND dismissed = 0").run(`order:${orderId}`);
    return { order_id: orderId, status: 'shelved' };
  });
}

/** 缺货替代登记 → 升级采购负责人。 */
function substituteOrder(db, cfg, staff, orderId, substitutedItem) {
  assertRole(staff, ['stocker', 'supervisor']);
  if (!substitutedItem || !String(substitutedItem).trim()) throw new HttpError(400, 'bad_request', '请填写替代品');
  return tx(db, () => {
    const r = db
      .prepare('UPDATE replenishment_orders SET substituted_item = ?, needs_substitution = 0 WHERE id = ? AND needs_substitution = 1')
      .run(String(substitutedItem).trim(), orderId);
    if (r.changes === 0) throw new HttpError(409, 'bad_state', '该单不处于待替代状态');
    const order = db.prepare('SELECT o.*, c.label, rm.name AS room_name, rm.floor_id FROM replenishment_orders o JOIN consumables c ON c.id = o.consumable_id JOIN rooms rm ON rm.id = o.room_id WHERE o.id = ?').get(orderId);
    escalate(db, cfg, {
      type: 'substitution',
      ref: `order:${orderId}`,
      roomId: order.room_id,
      floorId: order.floor_id,
      title: `缺货替代：${order.room_name} · ${order.label}`,
      detail: `仓库 ${order.label} 不足，以「${substitutedItem}」替代补给 ${order.qty} ${''}`.trim(),
    });
    return { order_id: orderId, substituted_item: substitutedItem };
  });
}

/** 申请撤销上架（须主管复核）。 */
function requestReversal(db, staff, orderId, reason) {
  assertRole(staff, ['stocker', 'supervisor']);
  if (!reason || !String(reason).trim()) throw new HttpError(400, 'bad_request', '请填写撤销原因');
  return tx(db, () => {
    const r = db
      .prepare("UPDATE replenishment_orders SET status = 'reversal_pending' WHERE id = ? AND status = 'shelved'")
      .run(orderId);
    if (r.changes === 0) {
      const cur = db.prepare('SELECT * FROM replenishment_orders WHERE id = ?').get(orderId);
      if (!cur) throw new HttpError(404, 'order_not_found', '补给单不存在');
      throw new HttpError(409, 'bad_state', '仅已上架的单据可申请撤销');
    }
    const rr = db
      .prepare('INSERT INTO reversal_requests (order_id, requested_by, reason, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(orderId, staff.id, String(reason).trim(), 'pending', now());
    return { reversal_id: Number(rr.lastInsertRowid), order_id: orderId, status: 'reversal_pending' };
  });
}

/** 主管复核撤销上架：批准 → 扣回房间库存、单据退回「已送达」；驳回 → 恢复「已上架」。 */
function reviewReversal(db, staff, reversalId, approve) {
  assertRole(staff, ['supervisor']);
  return tx(db, () => {
    const req = mustGet(db, 'SELECT * FROM reversal_requests WHERE id = ?', [reversalId], 'reversal_not_found', '复核单不存在');
    if (req.status !== 'pending') throw new HttpError(409, 'bad_state', '该复核单已处理');
    const ts = now();
    const order = db.prepare('SELECT * FROM replenishment_orders WHERE id = ?').get(req.order_id);
    if (approve) {
      db.prepare("UPDATE reversal_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(staff.id, ts, reversalId);
      db.prepare("UPDATE replenishment_orders SET status = 'delivered', shelved_by = NULL, shelved_at = NULL WHERE id = ?").run(order.id);
      db.prepare('UPDATE consumables SET quantity = MAX(0, quantity - ?) WHERE id = ?').run(order.qty, order.consumable_id);
      db.prepare('INSERT INTO consumable_txns (consumable_id, delta, kind, ref, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(order.consumable_id, -order.qty, 'reversal', `reversal:${reversalId}`, staff.id, ts);
    } else {
      db.prepare("UPDATE reversal_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(staff.id, ts, reversalId);
      db.prepare("UPDATE replenishment_orders SET status = 'shelved' WHERE id = ?").run(order.id);
    }
    return { reversal_id: reversalId, approved: !!approve };
  });
}

/* ---------------- 巡检与班次快照 ---------------- */

function getOrCreateShift(db, staff, floorId) {
  const active = db
    .prepare("SELECT * FROM shifts WHERE staff_id = ? AND floor_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
    .get(staff.id, floorId);
  if (active) return active;
  const r = db
    .prepare("INSERT INTO shifts (staff_id, floor_id, started_at, status) VALUES (?, ?, ?, 'active')")
    .run(staff.id, floorId, now());
  return db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(r.lastInsertRowid));
}

/**
 * 提交巡检：生成不可覆盖的班次快照（哈希链），并执行全部副作用：
 * 异常项→故障与局部闭用、水温→超温处理、耗材→低库存补给单、消毒漏项→升级、整间闭用。
 */
function submitInspection(db, cfg, adapter, staff, payload) {
  assertRole(staff, ['inspector', 'supervisor']);
  const roomId = Number(payload.room_id);
  if (!roomId) throw new HttpError(400, 'bad_request', '缺少 room_id');
  const items = payload.items || {};
  for (const { key } of cfg.CHECK_ITEMS) {
    const it = items[key];
    if (!it || !['pass', 'fail'].includes(it.result)) {
      throw new HttpError(400, 'bad_request', `检查项「${key}」缺少 pass/fail 结果`);
    }
  }

  return tx(db, () => {
    const room = mustGet(db, 'SELECT * FROM rooms WHERE id = ?', [roomId], 'room_not_found', '房间不存在');
    assertFloorScope(staff, room.floor_id);
    if (room.status === 'closed') throw new HttpError(409, 'room_closed', '房间处于闭用状态，请通过维修复测流程处理');

    const ts = now();
    const shift = getOrCreateShift(db, staff, room.floor_id);
    const effects = { faults: [], orders: [], escalations: [], room_closed: false };

    // 水温：未手工录入时由模拟适配器读数
    const heater = db.prepare("SELECT * FROM facilities WHERE room_id = ? AND type = 'water_heater' LIMIT 1").get(roomId);
    let tempValue = items.water_temp.value != null ? Number(items.water_temp.value) : null;
    if (tempValue == null && heater) tempValue = adapter.read(heater.id);
    if (tempValue != null && heater) {
      db.prepare('INSERT INTO temperature_readings (facility_id, celsius, source, created_at) VALUES (?, ?, ?, ?)')
        .run(heater.id, tempValue, 'inspection', ts);
    }
    const overLimit = tempValue != null && tempValue > cfg.TEMP_LIMIT_C;
    if (overLimit) items.water_temp.result = 'fail';

    // 逐项异常 → 故障 + 局部闭用（仅关闭对应设施，不影响其他隔间）
    for (const { key, label } of cfg.CHECK_ITEMS) {
      const it = items[key];
      if (it.result !== 'fail') continue;
      const facType = cfg.ITEM_FACILITY_TYPE[key];
      if (key === 'water_temp' && heater) {
        const fid = handleOvertemp(db, cfg, heater, tempValue, 'inspection');
        effects.faults.push(fid);
        effects.escalations.push('overtemp');
        continue;
      }
      if (facType) {
        let fac = it.facility_id
          ? db.prepare('SELECT * FROM facilities WHERE id = ? AND room_id = ?').get(Number(it.facility_id), roomId)
          : db.prepare('SELECT * FROM facilities WHERE room_id = ? AND type = ? ORDER BY id LIMIT 1').get(roomId, facType);
        if (fac) {
          effects.faults.push(createFaultInternal(db, cfg, {
            roomId, facilityId: fac.id, category: `${label}异常`,
            description: it.note || '', photoPath: it.photo_path || null, source: 'inspection',
          }));
        }
      } else {
        // 异味 / 清洁度 → 房间级故障，不关闭具体设施
        effects.faults.push(createFaultInternal(db, cfg, {
          roomId, facilityId: null, category: label,
          description: it.note || '', photoPath: it.photo_path || null, source: 'inspection',
        }));
      }
    }

    // 耗材余量登记 + 低库存自动生成补给单
    const consumableState = {};
    for (const [item, meta] of Object.entries(cfg.CONSUMABLES)) {
      const raw = (payload.consumables || {})[item];
      if (raw == null) continue;
      const qty = Math.max(0, Math.min(meta.capacity, Number(raw) || 0));
      const cons = db.prepare('SELECT * FROM consumables WHERE room_id = ? AND item = ?').get(roomId, item);
      if (!cons) continue;
      const delta = qty - cons.quantity;
      db.prepare('UPDATE consumables SET quantity = ? WHERE id = ?').run(qty, cons.id);
      db.prepare('INSERT INTO consumable_txns (consumable_id, delta, kind, ref, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(cons.id, delta, 'inspect', `shift:${shift.id}`, staff.id, ts);
      consumableState[item] = { before: cons.quantity, after: qty, safety: cons.safety_level };
      if (qty < cons.safety_level) {
        const orderId = ensureReplenishmentOrder(db, cfg, { ...cons, quantity: qty }, room);
        if (orderId) effects.orders.push(orderId);
      }
    }

    // 消毒记录：漏项 → 升级保洁主管
    const done = Array.isArray(payload.disinfection_done) ? payload.disinfection_done.map(String) : [];
    const missed = cfg.REQUIRED_DISINFECTION.filter((x) => !done.includes(x));
    db.prepare('INSERT INTO disinfection_records (room_id, staff_id, done, required, missed, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roomId, staff.id, JSON.stringify(done), JSON.stringify(cfg.REQUIRED_DISINFECTION), JSON.stringify(missed), ts);
    if (missed.length > 0) {
      escalate(db, cfg, {
        type: 'disinfection_missed',
        ref: `room:${roomId}`,
        roomId,
        floorId: room.floor_id,
        title: `消毒漏项：${room.name}`,
        detail: `未完成：${missed.join('、')}`,
      });
      effects.escalations.push('disinfection_missed');
    }

    // 整间闭用
    if (payload.close_room) {
      closeRoomInternal(db, cfg, room, String(payload.close_reason || '巡检整间闭用'), staff.id);
      effects.room_closed = true;
      effects.escalations.push('room_closure');
    }

    // 班次快照（不可覆盖，哈希链）
    const facilities = db.prepare('SELECT id, type, label, status FROM facilities WHERE room_id = ? ORDER BY id').all(roomId);
    const prev = db.prepare('SELECT hash FROM inspections ORDER BY id DESC LIMIT 1').get();
    const snapshot = {
      shift_id: shift.id,
      room: { id: room.id, code: room.code, name: room.name, floor_id: room.floor_id, status: payload.close_room ? 'closed' : room.status },
      staff: { id: staff.id, name: staff.name },
      created_at: ts,
      items: Object.fromEntries(cfg.CHECK_ITEMS.map(({ key }) => [key, {
        result: items[key].result,
        ...(key === 'water_temp' && tempValue != null ? { value: tempValue } : {}),
        ...(items[key].note ? { note: String(items[key].note) } : {}),
      }])),
      consumables: consumableState,
      disinfection: { required: cfg.REQUIRED_DISINFECTION, done, missed },
      facilities,
      effects: { faults: effects.faults, orders: effects.orders, room_closed: effects.room_closed },
    };
    const prevHash = prev ? prev.hash : null;
    const hash = sha256(`${prevHash || ''}|${JSON.stringify(snapshot)}`);
    const ins = db
      .prepare('INSERT INTO inspections (shift_id, room_id, staff_id, created_at, snapshot, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(shift.id, roomId, staff.id, ts, JSON.stringify(snapshot), prevHash, hash);

    return {
      inspection_id: Number(ins.lastInsertRowid),
      shift_id: shift.id,
      hash,
      water_temp: tempValue,
      ...effects,
    };
  });
}

/* ---------------- 班次 ---------------- */

function startShift(db, staff, floorId) {
  assertRole(staff, ['inspector', 'supervisor']);
  assertFloorScope(staff, floorId);
  return tx(db, () => {
    db.prepare("UPDATE shifts SET status = 'closed', ended_at = ? WHERE staff_id = ? AND status = 'active'").run(now(), staff.id);
    const r = db.prepare("INSERT INTO shifts (staff_id, floor_id, started_at, status) VALUES (?, ?, ?, 'active')")
      .run(staff.id, Number(floorId), now());
    return { shift_id: Number(r.lastInsertRowid) };
  });
}

function closeShift(db, staff, shiftId, { note = '', handoverTo = null } = {}) {
  return tx(db, () => {
    const shift = mustGet(db, 'SELECT * FROM shifts WHERE id = ?', [shiftId], 'shift_not_found', '班次不存在');
    if (shift.status !== 'active') throw new HttpError(409, 'bad_state', '班次已结束');
    if (shift.staff_id !== staff.id && staff.role !== 'supervisor') {
      throw new HttpError(403, 'forbidden_role', '仅本人或主管可结束该班次');
    }
    db.prepare("UPDATE shifts SET status = 'closed', ended_at = ?, handover_note = ?, handover_to = ? WHERE id = ?")
      .run(now(), String(note || ''), handoverTo ? Number(handoverTo) : null, shiftId);
    return { shift_id: shiftId, status: 'closed' };
  });
}

module.exports = {
  assertRole, assertFloorScope, mustGet,
  createFaultInternal, handleOvertemp, reportFault, claimFault, retestFault,
  closeRoom, reopenRoom,
  ensureReplenishmentOrder, claimOrder, deliverOrder, shelveOrder, substituteOrder,
  requestReversal, reviewReversal,
  submitInspection, getOrCreateShift, startShift, closeShift,
};
