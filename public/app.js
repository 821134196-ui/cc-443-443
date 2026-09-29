'use strict';

/* ================= 状态与工具 ================= */

const S = {
  cfg: null,
  staffList: [],
  floors: [],
  me: null,
  floorFilter: Number(localStorage.getItem('floorFilter') || 0),
  view: 'overview',
  inspect: null, // 巡检表单状态
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const can = (...roles) => S.me && roles.includes(S.me.role);

const ORDER_STATUS = { pending: '待领料', claimed: '已领料', delivered: '已送达', shelved: '已上架', reversal_pending: '撤销复核中' };
const FAULT_STATUS = { open: '待认领', repairing: '维修中', resolved: '已解决' };

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtCountdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000), m = Math.round((abs % 3600000) / 60000);
  const txt = h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
  return ms >= 0 ? { text: `剩余 ${txt}`, overdue: false } : { text: `已超时 ${txt}`, overdue: true };
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.me ? { 'X-Staff-Id': String(S.me.id) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `请求失败（${res.status}）`);
    err.code = data.error;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isErr ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function openModal(html) {
  $('#modal-card').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

function openPhoto(src) {
  $('#photo-overlay-img').src = src;
  $('#photo-overlay').classList.remove('hidden');
}

/* ================= 组件 ================= */

/** 实心刻度条（非圆环）：10 段实心刻度 */
function ticks(qty, cap, safety, lg = false) {
  const n = 10;
  const filled = Math.round((Math.min(qty, cap) / cap) * n);
  const low = qty < safety;
  let out = `<span class="ticks${low ? ' low' : ''}${lg ? ' lg' : ''}" title="${qty}/${cap}">`;
  for (let i = 0; i < n; i++) out += `<i class="${i < filled ? 'on' : ''}"></i>`;
  return out + '</span>';
}

function opennessBar(ok, total, closed) {
  const pct = total ? Math.round((ok / total) * 100) : 0;
  const low = pct < 60;
  return `<div class="openness">
    <div class="openness-track"><div class="openness-fill${low ? ' low' : ''}" style="width:${pct}%"></div></div>
    <span class="openness-text">${closed ? '闭用中' : `${ok}/${total} 开放`}</span>
  </div>`;
}

function statusPill(status) {
  if (status === 'open') return '<span class="pill sage">开放</span>';
  return '<span class="pill coral">闭用</span>';
}

function facStatusPill(status) {
  return status === 'ok' ? '<span class="pill sage">正常</span>' : '<span class="pill coral">故障关闭</span>';
}

function photoThumb(path) {
  return path ? `<img class="photo-thumb" src="${esc(path)}" data-action="photo" data-src="${esc(path)}" alt="故障照片">` : '';
}

/* ================= 头部与导航 ================= */

function renderHeader() {
  const floorSel = $('#floor-select');
  floorSel.innerHTML = '<option value="0">全部楼层</option>' +
    S.floors.map((f) => `<option value="${f.id}" ${S.floorFilter === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const staffSel = $('#staff-select');
  staffSel.innerHTML = '<option value="">选择身份…</option>' +
    S.staffList.map((s) => {
      const role = S.cfg.role_labels[s.role] || s.role;
      const scope = s.floors ? `（限${s.floors.map((id) => S.floors.find((f) => f.id === id)?.name || id).join('')}）` : '';
      return `<option value="${s.id}" ${S.me && S.me.id === s.id ? 'selected' : ''}>${esc(s.name)} · ${role}${scope}</option>`;
    }).join('');
}

async function refreshBadges() {
  try {
    const q = S.floorFilter ? `?floor_id=${S.floorFilter}` : '';
    const [rep, faults, escOpen] = await Promise.all([
      api(`/api/replenishments${q}${q ? '&' : '?'}active=1`),
      api(`/api/faults?status=open${S.floorFilter ? `&floor_id=${S.floorFilter}` : ''}`),
      api(`/api/escalations?status=open${S.floorFilter ? `&floor_id=${S.floorFilter}` : ''}`),
    ]);
    const activeOrders = rep.orders.filter((o) => o.status !== 'shelved').length;
    const repairing = faults.filter((f) => f.status === 'repairing').length;
    const bo = $('#badge-orders');
    bo.textContent = activeOrders; bo.classList.toggle('hidden', !activeOrders);
    const br = $('#badge-retest');
    br.textContent = repairing; br.classList.toggle('hidden', !repairing);
    const banner = $('#escalation-banner');
    if (escOpen.length) {
      const types = [...new Set(escOpen.map((e) => S.cfg.escalation_routes[e.type] || e.type))].join('、');
      banner.innerHTML = `<b>${escOpen.length} 条待处理升级</b>：${esc(types)}　<span data-action="goto" data-view="handover" style="text-decoration:underline;cursor:pointer">前往处理</span>`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch { /* 静默 */ }
}

/* ================= 视图：楼层总览 ================= */

async function renderOverview() {
  const q = S.floorFilter ? `?floor_id=${S.floorFilter}` : '';
  const rooms = await api(`/api/overview${q}`);
  $('#view').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin:8px 2px 4px">
      <div class="section-title" style="margin:0">房间开放情况</div>
      <button class="btn coral sm" data-action="open-report">顾客报障</button>
    </div>
    ${rooms.map((r) => `
      <div class="card tappable" data-action="room-detail" data-id="${r.id}">
        <div class="room-row">
          <div class="room-head">
            <span class="status-dot ${r.status}"></span>
            <span class="room-name">${esc(r.name)}</span>
            <span class="room-code">${esc(r.code)}</span>
            ${statusPill(r.status)}
          </div>
          ${opennessBar(r.facilities_ok, r.facilities_total, r.status === 'closed')}
          <div class="room-meta">
            <div class="mini-consumables">
              ${r.consumables.map((c) => `<span class="mini-cons">${esc(c.label)} ${ticks(c.quantity, c.capacity, c.safety_level)} ${c.quantity}${esc(c.unit)}</span>`).join('')}
            </div>
            ${r.open_faults ? `<span class="pill coral">故障 ${r.open_faults}</span>` : ''}
            ${r.active_orders ? `<span class="pill amber">补给 ${r.active_orders}</span>` : ''}
            ${r.open_escalations ? `<span class="pill coral">升级 ${r.open_escalations}</span>` : ''}
          </div>
          ${r.status === 'closed' ? `<div class="list-sub">闭用原因：${esc(r.closed_reason || '—')}</div>` : ''}
        </div>
      </div>`).join('') || '<div class="empty">该楼层暂无房间</div>'}`;
}

async function openRoomModal(roomId) {
  const d = await api(`/api/rooms/${roomId}`);
  const { room, facilities, consumables, faults, orders } = d;
  openModal(`
    <div class="modal-head">
      <h3>${esc(room.name)} ${statusPill(room.status)}</h3>
      <button class="modal-close" data-action="close-modal">×</button>
    </div>
    ${room.status === 'closed' ? `<div class="card" style="background:var(--coral-soft)">闭用原因：${esc(room.closed_reason || '—')}<br><span class="list-sub">${fmtTime(room.closed_at)}</span></div>` : ''}
    <div class="section-title">设施（${facilities.filter((f) => f.status === 'ok').length}/${facilities.length} 可用）</div>
    <div class="card">
      ${facilities.map((f) => `<div class="list-row">
        <div class="list-main"><div class="list-title">${esc(f.label)}</div>
        <div class="list-sub">${esc(S.cfg.facility_types[f.type] || f.type)}${f.open_faults ? ` · ${f.open_faults} 条未解决故障` : ''}</div></div>
        ${facStatusPill(f.status)}
      </div>`).join('')}
    </div>
    <div class="section-title">耗材余量</div>
    <div class="card">
      ${consumables.map((c) => `<div class="list-row">
        <div class="list-main"><div class="list-title">${esc(c.label)}</div>
        <div class="list-sub">安全量 ${c.safety_level}${esc(c.unit)} · 当前 ${c.quantity}${esc(c.unit)}${c.quantity < c.safety_level ? ' · <b style="color:var(--coral-deep)">低于安全量</b>' : ''}</div></div>
        ${ticks(c.quantity, c.capacity, c.safety_level, true)}
      </div>`).join('')}
    </div>
    ${faults.length ? `<div class="section-title">未解决故障</div><div class="card">
      ${faults.map((f) => `<div class="list-row">
        ${photoThumb(f.photo_path)}
        <div class="list-main"><div class="list-title">${esc(f.category)}</div>
        <div class="list-sub">${esc(f.facility_label || '房间级')} · ${FAULT_STATUS[f.status]} · ${fmtTime(f.created_at)}</div>
        ${f.description ? `<div class="list-sub">${esc(f.description)}</div>` : ''}</div>
      </div>`).join('')}</div>` : ''}
    ${orders.length ? `<div class="section-title">进行中的补给</div><div class="card">
      ${orders.map((o) => `<div class="list-row"><div class="list-main">
        <div class="list-title">${esc(o.label)} × ${o.qty}${esc(o.unit)}</div>
        <div class="list-sub">${ORDER_STATUS[o.status]}</div></div></div>`).join('')}</div>` : ''}
    <div class="grid2" style="margin-top:10px">
      ${room.status === 'open' && can('inspector', 'supervisor')
        ? `<button class="btn coral" data-action="close-room" data-id="${room.id}">整间闭用</button>` : ''}
      ${room.status === 'closed' && can('inspector', 'supervisor')
        ? `<button class="btn sage" data-action="reopen-room" data-id="${room.id}">重新开放</button>` : ''}
    </div>`);
}

/* ================= 视图：移动巡检 ================= */

function blankInspect() {
  return {
    roomId: null,
    items: Object.fromEntries(S.cfg.check_items.map((c) => [c.key, { result: null, note: '', photo_path: null }])),
    consumables: {},
    disinfection: new Set(),
    closeRoom: false,
    closeReason: '',
    tempValue: null,
    heaterId: null,
  };
}

async function renderInspect() {
  if (!S.inspect) S.inspect = blankInspect();
  const q = S.floorFilter ? `?floor_id=${S.floorFilter}` : '';
  const rooms = await api(`/api/overview${q}`);
  const insp = S.inspect;
  const room = rooms.find((r) => r.id === insp.roomId);

  let body = `
    <div class="section-title">选择房间（单手点选）</div>
    <div class="room-chips">
      ${rooms.map((r) => `<button class="chip ${r.id === insp.roomId ? 'active' : ''} ${r.status === 'closed' ? 'closed' : ''}"
        data-action="inspect-room" data-id="${r.id}" ${r.status === 'closed' ? 'disabled' : ''}>${esc(r.name)}${r.status === 'closed' ? '·闭用' : ''}</button>`).join('')}
    </div>`;

  if (!room) {
    body += '<div class="empty">请选择要巡检的房间</div>';
    $('#view').innerHTML = body;
    return;
  }

  if (!insp.loadedFor || insp.loadedFor !== room.id) {
    const detail = await api(`/api/rooms/${room.id}`);
    insp.loadedFor = room.id;
    insp.consumables = Object.fromEntries(detail.consumables.map((c) => [c.item, c.quantity]));
    insp.heaterId = (detail.facilities.find((f) => f.type === 'water_heater') || {}).id || null;
    insp.consMeta = detail.consumables;
  }

  body += `
    <div class="section-title">逐项检查</div>
    ${S.cfg.check_items.map((item) => {
      const st = insp.items[item.key];
      const tempRow = item.key === 'water_temp' ? `<div class="temp-row">
        <span class="temp-value ${insp.tempValue != null && insp.tempValue > S.cfg.temp_limit_c ? 'over' : ''}">${insp.tempValue != null ? insp.tempValue.toFixed(1) : '--.-'}</span>
        <span class="temp-unit">℃（上限 ${S.cfg.temp_limit_c}℃）</span>
        <button class="btn ghost sm" data-action="read-temp" ${insp.heaterId ? '' : 'disabled'}>读取水温</button>
      </div>` : '';
      const failExtra = st.result === 'fail' ? `<div class="fail-extra">
        <input type="text" placeholder="异常情况说明（选填）" value="${esc(st.note)}" data-bind="fail-note" data-key="${item.key}">
        <div>${st.photo_path ? `<img class="photo-thumb" src="${esc(st.photo_path)}" data-action="photo" data-src="${esc(st.photo_path)}">` : ''}
          <label class="btn ghost sm">上传照片<input type="file" accept="image/*" hidden data-photo-input="inspect:${item.key}"></label>
        </div>
      </div>` : '';
      return `<div class="card check-row">
        <div class="check-label"><b>${esc(item.label)}</b>${st.result === 'fail' ? '<span class="pill coral">异常</span>' : st.result === 'pass' ? '<span class="pill sage">正常</span>' : '<span class="check-hint">待检查</span>'}</div>
        ${tempRow}
        <div class="seg">
          <button class="${st.result === 'pass' ? 'on-pass' : ''}" data-action="check" data-key="${item.key}" data-result="pass">正常</button>
          <button class="${st.result === 'fail' ? 'on-fail' : ''}" data-action="check" data-key="${item.key}" data-result="fail">异常</button>
        </div>
        ${failExtra}
      </div>`;
    }).join('')}

    <div class="section-title">耗材余量</div>
    <div class="card">
      ${(insp.consMeta || []).map((c) => {
        const qty = insp.consumables[c.item] ?? 0;
        return `<div class="list-row">
          <div class="list-main">
            <div class="list-title">${esc(c.label)}</div>
            <div class="list-sub">安全量 ${c.safety_level}${esc(c.unit)}${qty < c.safety_level ? ' · <b style="color:var(--coral-deep)">低于安全量，将自动生成补给单</b>' : ''}</div>
            <div style="margin-top:5px">${ticks(qty, c.capacity, c.safety_level, true)}</div>
          </div>
          <div class="stepper">
            <button data-action="step" data-item="${c.item}" data-delta="-1">−</button>
            <span class="qty">${qty}</span><span class="unit">${esc(c.unit)}</span>
            <button data-action="step" data-item="${c.item}" data-delta="1">＋</button>
          </div>
        </div>`;
      }).join('')}
    </div>

    <div class="section-title">消毒确认（点选已完成项）</div>
    <div class="card"><div class="disinfect-chips">
      ${S.cfg.required_disinfection.map((x) => `<button class="chip ${insp.disinfection.has(x) ? 'done' : ''}" data-action="disinfect" data-item="${esc(x)}">${insp.disinfection.has(x) ? '✓ ' : ''}${esc(x)}</button>`).join('')}
    </div></div>

    <div class="card">
      <div class="toggle-row">
        <div><b>整间闭用</b><div class="list-sub">严重问题时关闭整间母婴室</div></div>
        <button class="switch ${insp.closeRoom ? 'on' : ''}" data-action="toggle-close-room" aria-label="整间闭用"></button>
      </div>
      ${insp.closeRoom ? `<div class="field" style="margin-top:8px"><input type="text" placeholder="闭用原因" value="${esc(insp.closeReason)}" data-bind="close-reason"></div>` : ''}
    </div>

    <div class="sticky-submit">
      <button class="btn sage block" data-action="submit-inspection">完成巡检并生成班次快照</button>
    </div>`;
  $('#view').innerHTML = body;
}

async function submitInspection() {
  const insp = S.inspect;
  if (!insp.roomId) return toast('请先选择房间', true);
  for (const c of S.cfg.check_items) {
    if (!insp.items[c.key].result) return toast(`请完成「${c.label}」检查`, true);
  }
  if (insp.closeRoom && !insp.closeReason.trim()) return toast('请填写闭用原因', true);
  const payload = {
    room_id: insp.roomId,
    items: Object.fromEntries(Object.entries(insp.items).map(([k, v]) => [k, {
      result: v.result,
      ...(v.note ? { note: v.note } : {}),
      ...(v.photo_path ? { photo_path: v.photo_path } : {}),
      ...(k === 'water_temp' && insp.tempValue != null ? { value: insp.tempValue } : {}),
    }])),
    consumables: insp.consumables,
    disinfection_done: [...insp.disinfection],
    close_room: insp.closeRoom,
    close_reason: insp.closeReason,
  };
  const r = await api('/api/inspections', { method: 'POST', body: payload });
  S.inspect = blankInspect();
  const effects = [];
  if (r.faults.length) effects.push(`新建故障 ${r.faults.length} 条`);
  if (r.orders.length) effects.push(`自动生成补给单 ${r.orders.length} 张`);
  if (r.escalations.length) effects.push(`触发升级：${[...new Set(r.escalations)].map((t) => S.cfg.escalation_routes[t] || t).join('、')}`);
  if (r.room_closed) effects.push('房间已整间闭用');
  openModal(`
    <div class="modal-head"><h3>班次快照已生成</h3><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="card">
      <div class="kv"><span>快照编号</span><b>#${r.inspection_id}</b></div>
      <div class="kv"><span>班次</span><b>#${r.shift_id}</b></div>
      ${r.water_temp != null ? `<div class="kv"><span>水温读数</span><b>${r.water_temp}℃</b></div>` : ''}
      <div style="margin-top:8px"><span class="list-sub">防篡改哈希（不可覆盖）</span><div class="mono">${esc(r.hash)}</div></div>
    </div>
    ${effects.length ? `<div class="card" style="background:var(--sage-soft)">${effects.map((e) => `<div>· ${esc(e)}</div>`).join('')}</div>` : '<div class="card">全部正常，无待办事项。</div>'}
    <button class="btn sage block" data-action="close-modal">完成</button>`);
  refreshBadges();
}

/* ================= 视图：设施状态 ================= */

async function renderFacilities() {
  const q = S.floorFilter ? `?floor_id=${S.floorFilter}` : '';
  const [facilities, faults, temps] = await Promise.all([
    api(`/api/facilities${q}`),
    api(`/api/faults?status=open${S.floorFilter ? `&floor_id=${S.floorFilter}` : ''}`),
    api(`/api/temperature${q}`),
  ]);
  const byRoom = {};
  for (const f of facilities) (byRoom[f.room_code] ||= { name: f.room_name, room_status: f.room_status, list: [] }).list.push(f);
  $('#view').innerHTML = `
    <div class="section-title">热水设备实时温度</div>
    <div class="card">
      ${temps.map((t) => `<div class="list-row">
        <div class="list-main"><div class="list-title">${esc(t.room_name)} · ${esc(t.label)}</div>
        <div class="list-sub">${t.measured_at ? fmtTime(t.measured_at) : '暂无读数'}</div></div>
        <span class="temp-value ${t.celsius != null && t.celsius > S.cfg.temp_limit_c ? 'over' : ''}" style="font-size:1.25rem">${t.celsius != null ? t.celsius.toFixed(1) + '℃' : '--'}</span>
        ${facStatusPill(t.status)}
      </div>`).join('') || '<div class="empty">无热水设备</div>'}
    </div>
    <div class="section-title">设施状态</div>
    ${Object.entries(byRoom).map(([code, g]) => `
      <div class="card">
        <div class="list-title" style="margin-bottom:6px">${esc(g.name)} ${g.room_status === 'closed' ? '<span class="pill coral">闭用</span>' : ''}</div>
        ${g.list.map((f) => `<div class="list-row">
          <div class="list-main"><div class="list-title">${esc(f.label)}</div>
          <div class="list-sub">${esc(S.cfg.facility_types[f.type] || f.type)}${f.open_faults ? ` · ${f.open_faults} 条故障` : ''}</div></div>
          ${facStatusPill(f.status)}
        </div>`).join('')}
      </div>`).join('')}
    <div class="section-title">未解决故障（${faults.length}）</div>
    ${faults.map((f) => `<div class="card">
      <div class="list-row" style="border:none;padding-top:0">
        ${photoThumb(f.photo_path)}
        <div class="list-main">
          <div class="list-title">${esc(f.category)} <span class="pill ${f.status === 'open' ? 'amber' : 'gray'}">${FAULT_STATUS[f.status]}</span></div>
          <div class="list-sub">${esc(f.room_name)}${f.facility_label ? ' · ' + esc(f.facility_label) : ' · 房间级'} · ${fmtTime(f.created_at)} · 来源：${{ customer: '顾客报障', staff: '员工', inspection: '巡检', monitor: '温度监测' }[f.source] || f.source}</div>
          ${f.description ? `<div class="list-sub">${esc(f.description)}</div>` : ''}
          ${f.repair ? `<div class="list-sub">维修：${esc(f.repair.technician || '—')}（${fmtTime(f.repair.started_at)} 开始）</div>` : ''}
        </div>
        ${f.status === 'open' && can('maintenance', 'supervisor') ? `<button class="btn sage sm" data-action="claim-fault" data-id="${f.id}">认领</button>` : ''}
      </div>
    </div>`).join('') || '<div class="empty">暂无未解决故障</div>'}`;
}

/* ================= 视图：补给队列 ================= */

async function renderReplenish() {
  const q = S.floorFilter ? `?floor_id=${S.floorFilter}` : '';
  const [data, reversals] = await Promise.all([
    api(`/api/replenishments${q}`),
    can('supervisor') ? api('/api/reversal-requests?status=pending') : Promise.resolve([]),
  ]);
  const { orders, warehouse } = data;
  const stepsOf = (o) => {
    const seq = ['pending', 'claimed', 'delivered', 'shelved'];
    const labels = ['领料', '送达', '上架', '完成'];
    const actors = [o.claimed_by_name, o.delivered_by_name, o.shelved_by_name, o.shelved_by_name];
    const cur = o.status === 'reversal_pending' ? 3 : seq.indexOf(o.status);
    return `<div class="steps">${seq.map((s, i) => {
      const cls = (i < cur || o.status === 'shelved') ? 'done' : i === cur ? 'now' : '';
      const who = actors[i] && (i < cur || (i === cur && o.status === 'shelved')) ? `<br>${esc(actors[i])}` : '';
      return `<div class="step ${cls}">${labels[i]}${who}</div>`;
    }).join('')}</div>`;
  };
  $('#view').innerHTML = `
    <div class="section-title">仓库库存</div>
    <div class="card"><div class="mini-consumables">
      ${warehouse.map((w) => `<span class="mini-cons">${esc(w.label)} <b>${w.quantity}</b>${w.quantity === 0 ? ' <span class="pill coral">缺货</span>' : ''}</span>`).join('')}
    </div></div>
    ${can('supervisor') && reversals.length ? `<div class="section-title">撤销上架复核（${reversals.length}）</div>
      ${reversals.map((rr) => `<div class="card">
        <div class="list-title">${esc(rr.room_name)} · ${esc(rr.label)} × ${rr.qty}${esc(rr.unit)}</div>
        <div class="list-sub">申请人：${esc(rr.requested_by_name)} · ${fmtTime(rr.created_at)}</div>
        <div class="list-sub">原因：${esc(rr.reason)}</div>
        <div class="grid2" style="margin-top:8px">
          <button class="btn sage sm" data-action="review-reversal" data-id="${rr.id}" data-approve="1">批准撤销</button>
          <button class="btn ghost sm" data-action="review-reversal" data-id="${rr.id}" data-approve="0">驳回</button>
        </div>
      </div>`).join('')}` : ''}
    <div class="section-title">补给队列（${orders.filter((o) => o.status !== 'shelved').length} 进行中）</div>
    ${orders.map((o) => {
      const cd = fmtCountdown(o.deadline_at);
      return `<div class="card">
        <div class="list-row" style="border:none;padding-top:0">
          <div class="list-main">
            <div class="list-title">${esc(o.room_name)} · ${esc(o.label)} × ${o.qty}${esc(o.unit)}
              <span class="pill ${o.status === 'shelved' ? 'sage' : o.status === 'reversal_pending' ? 'amber' : 'gray'}">${ORDER_STATUS[o.status]}</span></div>
            <div class="list-sub">当前余量 ${o.stock_now}${esc(o.unit)} · 安全量 ${o.safety_level}${esc(o.unit)}</div>
            ${o.status !== 'shelved' ? `<div class="deadline ${cd.overdue ? 'overdue' : ''}">补给时限：${cd.text}</div>` : `<div class="list-sub">上架于 ${fmtTime(o.shelved_at)}</div>`}
            ${o.needs_substitution ? '<div class="pill coral" style="margin-top:4px">仓库缺货，需登记替代</div>' : ''}
            ${o.substituted_item ? `<div class="list-sub">替代品：${esc(o.substituted_item)}</div>` : ''}
          </div>
          ${ticks(o.stock_now, o.capacity, o.safety_level)}
        </div>
        ${stepsOf(o)}
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          ${o.status === 'pending' && can('stocker', 'supervisor') ? `<button class="btn sage sm" data-action="claim-order" data-id="${o.id}">领料</button>` : ''}
          ${o.status === 'claimed' && o.needs_substitution && can('stocker', 'supervisor') ? `
            <input type="text" placeholder="替代品名称" data-bind="substitute" data-id="${o.id}" style="flex:1;min-height:40px;border:1px solid var(--line);border-radius:10px;padding:6px 10px">
            <button class="btn coral sm" data-action="substitute-order" data-id="${o.id}">登记替代</button>` : ''}
          ${o.status === 'claimed' && !o.needs_substitution && can('stocker', 'supervisor') ? `<button class="btn sage sm" data-action="deliver-order" data-id="${o.id}">确认送达</button>` : ''}
          ${o.status === 'delivered' && can('stocker', 'supervisor') ? `<button class="btn sage sm" data-action="shelve-order" data-id="${o.id}">确认上架</button>` : ''}
          ${o.status === 'shelved' && can('stocker', 'supervisor') && !o.pending_reversal ? `<button class="btn ghost sm" data-action="request-reversal" data-id="${o.id}">申请撤销上架</button>` : ''}
          ${o.status === 'reversal_pending' ? '<span class="pill amber">等待主管复核</span>' : ''}
        </div>
      </div>`;
    }).join('') || '<div class="empty">补给队列为空</div>'}`;
}

/* ================= 视图：维修复检 ================= */

async function renderRetest() {
  const faults = await api(`/api/faults?status=open${S.floorFilter ? `&floor_id=${S.floorFilter}` : ''}`);
  const repairing = faults.filter((f) => f.status === 'repairing');
  const open = faults.filter((f) => f.status === 'open');
  const card = (f, withRetest) => `
    <div class="card">
      <div class="list-row" style="border:none;padding-top:0">
        ${photoThumb(f.photo_path)}
        <div class="list-main">
          <div class="list-title">${esc(f.category)}</div>
          <div class="list-sub">${esc(f.room_name)}${f.facility_label ? ' · ' + esc(f.facility_label) : ' · 房间级'}</div>
          ${f.description ? `<div class="list-sub">${esc(f.description)}</div>` : ''}
          ${f.repair ? `<div class="list-sub">维修员：${esc(f.repair.technician || '—')} · ${fmtTime(f.repair.started_at)} 开始</div>` : ''}
        </div>
      </div>
      ${withRetest && can('maintenance', 'supervisor', 'inspector') ? `
        <div class="grid2" style="margin-top:6px">
          <button class="btn sage" data-action="retest" data-id="${f.id}" data-result="pass">复测通过 · 重新开放</button>
          <button class="btn coral" data-action="retest" data-id="${f.id}" data-result="fail">复测不通过</button>
        </div>` : ''}
      ${!withRetest && can('maintenance', 'supervisor') ? `<button class="btn sage sm" data-action="claim-fault" data-id="${f.id}" style="margin-top:6px">认领维修</button>` : ''}
    </div>`;
  $('#view').innerHTML = `
    <div class="section-title">待复检（维修中 · ${repairing.length}）</div>
    ${repairing.map((f) => card(f, true)).join('') || '<div class="empty">暂无待复检故障</div>'}
    <div class="section-title">待认领（${open.length}）</div>
    ${open.map((f) => card(f, false)).join('') || '<div class="empty">暂无待认领故障</div>'}
    <div class="card" style="background:var(--paper-2)"><span class="list-sub">复测通过后设施自动重新开放；不通过则保持关闭并继续维修。整间闭用的房间须全部故障复测通过后才能重新开放。</span></div>`;
}

/* ================= 视图：班次交接 ================= */

async function renderHandover() {
  const d = await api(`/api/handover${S.floorFilter ? `?floor_id=${S.floorFilter}` : ''}`);
  const escLabel = (t) => S.cfg.escalation_routes[t] || t;
  $('#view').innerHTML = `
    <div class="section-title">当前班次</div>
    ${d.shift ? `<div class="card">
      <div class="kv"><span>班次</span><b>#${d.shift.id} · ${esc(d.shift.floor_name)}</b></div>
      <div class="kv"><span>值班人</span><b>${esc(d.shift.staff_name)}</b></div>
      <div class="kv"><span>开始时间</span><b>${fmtTime(d.shift.started_at)}</b></div>
      <div class="kv"><span>已巡检</span><b>${d.inspections.length} 间次</b></div>
      <div class="field" style="margin-top:10px"><label>交接备注</label><textarea data-bind="handover-note" placeholder="留给接班人的说明…"></textarea></div>
      <button class="btn coral block" data-action="close-shift" data-id="${d.shift.id}">交班并结束班次</button>
    </div>` : `<div class="card">
      <div class="empty">当前没有进行中的班次</div>
      ${can('inspector', 'supervisor') ? `<button class="btn sage block" data-action="start-shift">开始新班次（${esc(S.floors.find((f) => f.id === S.floorFilter)?.name || '全部楼层')}）</button>` : '<div class="list-sub" style="text-align:center">请以巡检员或主管身份登录</div>'}
    </div>`}
    ${d.inspections.length ? `<div class="section-title">本班巡检快照（不可覆盖）</div><div class="card">
      ${d.inspections.map((i) => `<div class="list-row"><div class="list-main">
        <div class="list-title">${esc(i.room_name)}</div><div class="list-sub">${fmtTime(i.created_at)}</div></div>
        <button class="btn ghost sm" data-action="view-snapshot" data-id="${i.id}">快照</button>
      </div>`).join('')}</div>` : ''}
    <div class="section-title">待处理升级（${d.escalations.length}）</div>
    ${d.escalations.map((e) => `<div class="card">
      <div class="list-row" style="border:none;padding:0">
        <div class="list-main">
          <div class="list-title">${esc(e.title)}</div>
          <div class="list-sub">${escLabel(e.type)} → ${esc(S.cfg.role_labels[e.assignee_role] || e.assignee_role)} · ${fmtTime(e.created_at)}</div>
          ${e.detail ? `<div class="list-sub">${esc(e.detail)}</div>` : ''}
        </div>
        ${can('supervisor') || (S.me && S.me.role === e.assignee_role) ? `<button class="btn sage sm" data-action="resolve-escalation" data-id="${e.id}">办结</button>` : ''}
      </div>
    </div>`).join('') || '<div class="empty">暂无待处理升级</div>'}
    <div class="section-title">提醒（${d.reminders.length}）</div>
    ${d.reminders.map((r) => `<div class="card"><div class="list-row" style="border:none;padding:0">
      <div class="list-main"><div class="list-title">${esc(r.message)}</div><div class="list-sub">${fmtTime(r.created_at)}</div></div>
      <button class="btn ghost sm" data-action="dismiss-reminder" data-id="${r.id}">知道了</button>
    </div></div>`).join('') || '<div class="empty">暂无提醒</div>'}
    <div class="section-title">未解决故障（${d.open_faults.length}） · 进行中补给（${d.active_orders.length}）</div>
    <div class="card">
      ${d.open_faults.map((f) => `<div class="list-row"><div class="list-main"><div class="list-title">${esc(f.category)}</div><div class="list-sub">${esc(f.room_name)} · ${FAULT_STATUS[f.status]}</div></div></div>`).join('') || '<div class="list-sub">无未解决故障</div>'}
      ${d.active_orders.map((o) => `<div class="list-row"><div class="list-main"><div class="list-title">${esc(o.label)} × ${o.qty}${esc(o.unit)}</div><div class="list-sub">${esc(o.room_name)} · ${ORDER_STATUS[o.status]}</div></div></div>`).join('')}
    </div>
    <div class="section-title">最近班次</div>
    ${d.recent_shifts.map((s) => `<div class="card">
      <div class="kv"><span>${esc(s.floor_name)} · ${esc(s.staff_name)}</span><b>${fmtTime(s.started_at)} — ${fmtTime(s.ended_at)}</b></div>
      <div class="list-sub">巡检 ${s.inspection_count} 间次${s.handover_note ? ` · 备注：${esc(s.handover_note)}` : ''}</div>
    </div>`).join('') || '<div class="empty">暂无历史班次</div>'}`;
}

async function viewSnapshot(id) {
  const d = await api(`/api/inspections/${id}`);
  const s = d.snapshot;
  openModal(`
    <div class="modal-head"><h3>班次快照 #${d.id}</h3><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="card">
      <div class="kv"><span>房间</span><b>${esc(d.room_name)}</b></div>
      <div class="kv"><span>巡检人</span><b>${esc(d.staff_name)}</b></div>
      <div class="kv"><span>时间</span><b>${fmtTime(d.created_at)}</b></div>
    </div>
    <div class="section-title">逐项结果</div>
    <div class="card">
      ${S.cfg.check_items.map((c) => {
        const it = s.items[c.key] || {};
        return `<div class="kv"><span>${esc(c.label)}</span><b>${it.result === 'pass' ? '正常' : '异常'}${it.value != null ? `（${it.value}℃）` : ''}</b></div>`;
      }).join('')}
    </div>
    <div class="section-title">耗材 / 消毒</div>
    <div class="card">
      ${Object.entries(s.consumables || {}).map(([k, v]) => `<div class="kv"><span>${esc(S.cfg.consumables[k]?.label || k)}</span><b>${v.before} → ${v.after}</b></div>`).join('') || '<div class="list-sub">无耗材记录</div>'}
      <div class="kv"><span>消毒漏项</span><b>${(s.disinfection?.missed || []).join('、') || '无'}</b></div>
    </div>
    <div class="card"><span class="list-sub">防篡改哈希</span><div class="mono">${esc(d.hash)}</div>
    <span class="list-sub">前序哈希</span><div class="mono">${esc(d.prev_hash || '（首条）')}</div></div>`);
}

/* ================= 顾客报障（不采集身份） ================= */

async function openReportModal() {
  const rooms = await api('/api/overview');
  openModal(`
    <div class="modal-head"><h3>顾客报障</h3><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="list-sub" style="margin-bottom:10px">无需提供任何个人信息，描述问题即可。</div>
    <div class="field"><label>房间</label><select data-bind="report-room">
      <option value="">请选择…</option>
      ${rooms.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}
    </select></div>
    <div class="field"><label>设施（可选）</label><select data-bind="report-facility"><option value="">整个房间 / 不确定</option></select></div>
    <div class="field"><label>问题类别</label><select data-bind="report-category">
      ${['门锁故障', '尿布台问题', '哺乳隔间问题', '热水问题', '插座问题', '异味', '清洁问题', '耗材缺失', '其他'].map((c) => `<option>${c}</option>`).join('')}
    </select></div>
    <div class="field"><label>问题描述</label><textarea data-bind="report-desc" placeholder="简单描述遇到的问题…"></textarea></div>
    <div class="field"><label>照片（可选）</label>
      <div id="report-photo-slot"><label class="btn ghost sm">拍照 / 上传<input type="file" accept="image/*" capture="environment" hidden data-photo-input="report"></label></div>
    </div>
    <button class="btn coral block" data-action="submit-report">提交报障</button>`);
}

/* ================= 渲染调度 ================= */

const VIEWS = {
  overview: renderOverview,
  inspect: renderInspect,
  facilities: renderFacilities,
  replenish: renderReplenish,
  retest: renderRetest,
  handover: renderHandover,
};

async function render() {
  renderHeader();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === S.view));
  try {
    await VIEWS[S.view]();
  } catch (err) {
    $('#view').innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
  }
}

/* ================= 事件 ================= */

async function guard(fn) {
  try { await fn(); } catch (err) { toast(err.message, true); }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  // 照片大图预览（不依赖身份）
  const photoEl = e.target.closest('[data-action="photo"]');
  if (photoEl) { openPhoto(photoEl.dataset.src); return; }
  if (!el) return;
  const action = el.dataset.action;
  const id = Number(el.dataset.id);

  const actions = {
    'goto': () => { S.view = el.dataset.view; render(); },
    'close-modal': () => closeModal(),
    'room-detail': () => guard(async () => { await openRoomModal(id); }),
    'inspect-room': () => { S.inspect.roomId = id; S.inspect.loadedFor = null; S.inspect.tempValue = null; renderInspect(); },
    'check': () => {
      const st = S.inspect.items[el.dataset.key];
      st.result = st.result === el.dataset.result ? null : el.dataset.result;
      renderInspect();
    },
    'read-temp': () => guard(async () => {
      if (!S.inspect.heaterId) return toast('该房间无热水设备', true);
      const r = await api(`/api/facilities/${S.inspect.heaterId}/temperature`, { method: 'POST' });
      S.inspect.tempValue = r.celsius;
      S.inspect.items.water_temp.result = r.overtemp ? 'fail' : 'pass';
      if (r.overtemp) toast(`水温 ${r.celsius}℃ 超温！设备已自动关闭并升级`, true);
      renderInspect();
    }),
    'step': () => {
      const item = el.dataset.item;
      const meta = (S.inspect.consMeta || []).find((c) => c.item === item);
      const cur = S.inspect.consumables[item] ?? 0;
      S.inspect.consumables[item] = Math.max(0, Math.min(meta ? meta.capacity : 99, cur + Number(el.dataset.delta)));
      renderInspect();
    },
    'disinfect': () => {
      const item = el.dataset.item;
      S.inspect.disinfection.has(item) ? S.inspect.disinfection.delete(item) : S.inspect.disinfection.add(item);
      renderInspect();
    },
    'toggle-close-room': () => { S.inspect.closeRoom = !S.inspect.closeRoom; renderInspect(); },
    'submit-inspection': () => guard(submitInspection),
    'claim-fault': () => guard(async () => { await api(`/api/faults/${id}/claim`, { method: 'POST' }); toast('已认领，开始维修'); render(); refreshBadges(); }),
    'retest': () => guard(async () => {
      const r = await api(`/api/faults/${id}/retest`, { method: 'POST', body: { result: el.dataset.result } });
      toast(el.dataset.result === 'pass' ? (r.facility_reopened ? '复测通过，设施已重新开放' : '复测通过') : '复测不通过，保持关闭');
      render(); refreshBadges();
    }),
    'claim-order': () => guard(async () => {
      const r = await api(`/api/replenishments/${id}/claim`, { method: 'POST' });
      toast(r.needs_substitution ? '已领料；仓库缺货，请登记缺货替代' : '已领料');
      render(); refreshBadges();
    }),
    'deliver-order': () => guard(async () => { await api(`/api/replenishments/${id}/deliver`, { method: 'POST' }); toast('已确认送达'); render(); }),
    'shelve-order': () => guard(async () => { await api(`/api/replenishments/${id}/shelve`, { method: 'POST' }); toast('已确认上架，库存已入账'); render(); refreshBadges(); }),
    'substitute-order': () => guard(async () => {
      const input = document.querySelector(`[data-bind="substitute"][data-id="${id}"]`);
      await api(`/api/replenishments/${id}/substitute`, { method: 'POST', body: { substituted_item: input.value.trim() } });
      toast('已登记缺货替代并升级采购负责人'); render();
    }),
    'request-reversal': () => guard(async () => {
      const reason = prompt('撤销上架原因（须主管复核）：');
      if (!reason) return;
      await api(`/api/replenishments/${id}/reversal-requests`, { method: 'POST', body: { reason } });
      toast('已提交，等待主管复核'); render();
    }),
    'review-reversal': () => guard(async () => {
      await api(`/api/reversal-requests/${id}/review`, { method: 'POST', body: { approve: el.dataset.approve === '1' } });
      toast(el.dataset.approve === '1' ? '已批准撤销，库存已扣回' : '已驳回'); render();
    }),
    'close-room': () => guard(async () => {
      const reason = prompt('整间闭用原因：');
      if (!reason) return;
      await api(`/api/rooms/${id}/close`, { method: 'POST', body: { reason } });
      toast('房间已闭用，已升级运营经理'); closeModal(); render(); refreshBadges();
    }),
    'reopen-room': () => guard(async () => {
      await api(`/api/rooms/${id}/reopen`, { method: 'POST' });
      toast('房间已重新开放'); closeModal(); render(); refreshBadges();
    }),
    'resolve-escalation': () => guard(async () => { await api(`/api/escalations/${id}/resolve`, { method: 'POST' }); toast('升级已办结'); render(); refreshBadges(); }),
    'dismiss-reminder': () => guard(async () => { await api(`/api/reminders/${id}/dismiss`, { method: 'POST' }); render(); }),
    'start-shift': () => guard(async () => {
      const floorId = S.floorFilter || (S.floors[0] && S.floors[0].id);
      await api('/api/shifts', { method: 'POST', body: { floor_id: floorId } });
      toast('班次已开始'); render();
    }),
    'close-shift': () => guard(async () => {
      const note = (document.querySelector('[data-bind="handover-note"]') || {}).value || '';
      await api(`/api/shifts/${id}/close`, { method: 'POST', body: { note } });
      toast('已交班'); render();
    }),
    'view-snapshot': () => guard(() => viewSnapshot(id)),
    'open-report': () => guard(openReportModal),
    'submit-report': () => guard(async () => {
      const roomId = Number((document.querySelector('[data-bind="report-room"]') || {}).value);
      if (!roomId) return toast('请选择房间', true);
      await api('/api/reports', {
        method: 'POST',
        body: {
          room_id: roomId,
          facility_id: Number((document.querySelector('[data-bind="report-facility"]') || {}).value) || null,
          category: document.querySelector('[data-bind="report-category"]').value,
          description: document.querySelector('[data-bind="report-desc"]').value,
          photo_path: window.__reportPhoto || null,
        },
      });
      window.__reportPhoto = null;
      toast('报障已提交，感谢反馈'); closeModal(); render(); refreshBadges();
    }),
  };
  if (actions[action]) actions[action]();
});

// 文本输入绑定（不触发重渲染，避免丢失焦点）
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-bind]');
  if (!el) return;
  const bind = el.dataset.bind;
  if (bind === 'fail-note' && S.inspect) S.inspect.items[el.dataset.key].note = el.value;
  if (bind === 'close-reason' && S.inspect) S.inspect.closeReason = el.value;
});

// 报障房间联动设施下拉
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('[data-bind="report-room"]')) {
    guard(async () => {
      const d = await api(`/api/rooms/${el.value}`);
      document.querySelector('[data-bind="report-facility"]').innerHTML =
        '<option value="">整个房间 / 不确定</option>' +
        d.facilities.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join('');
    });
  }
  if (el.matches('[data-photo-input]')) {
    const file = el.files && el.files[0];
    if (!file) return;
    const target = el.dataset.photoInput;
    const reader = new FileReader();
    reader.onload = () => guard(async () => {
      const r = await api('/api/photos', { method: 'POST', body: { data: reader.result } });
      if (target.startsWith('inspect:')) {
        S.inspect.items[target.split(':')[1]].photo_path = r.path;
        renderInspect();
      } else {
        window.__reportPhoto = r.path;
        $('#report-photo-slot').innerHTML = `<img class="photo-thumb" src="${esc(r.path)}" data-action="photo" data-src="${esc(r.path)}">`;
      }
      toast('照片已上传');
    });
    reader.readAsDataURL(file);
  }
});

$('#tabbar').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  S.view = tab.dataset.view;
  render();
});
$('#floor-select').addEventListener('change', (e) => {
  S.floorFilter = Number(e.target.value);
  localStorage.setItem('floorFilter', String(S.floorFilter));
  S.inspect = null;
  render(); refreshBadges();
});
$('#staff-select').addEventListener('change', (e) => {
  const id = Number(e.target.value);
  S.me = S.staffList.find((s) => s.id === id) || null;
  localStorage.setItem('staffId', String(id || ''));
  render(); refreshBadges();
});
$('#photo-overlay').addEventListener('click', () => $('#photo-overlay').classList.add('hidden'));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ================= 启动 ================= */

(async function init() {
  try {
    const [cfg, staffList, floors] = await Promise.all([
      api('/api/config'), api('/api/staff'), api('/api/floors'),
    ]);
    S.cfg = cfg; S.staffList = staffList; S.floors = floors;
    const savedId = Number(localStorage.getItem('staffId'));
    S.me = staffList.find((s) => s.id === savedId) || null;
    await render();
    refreshBadges();
    setInterval(refreshBadges, 30000);
  } catch (err) {
    $('#view').innerHTML = `<div class="empty">初始化失败：${esc(err.message)}<br>请确认服务已启动。</div>`;
  }
})();
