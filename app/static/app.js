/* 母婴室巡检 SPA（原生 JS，无框架/无构建） */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATUS_TEXT = { open: '开放', partial: '局部闭用', closed: '整间闭用' };
const FAC_TYPE = { changing_table: '尿布台', nursing_booth: '哺乳隔间', water_heater: '热水设备' };
const WO_STATUS = { open: '待维修', repairing: '维修中', retest_passed: '复测通过' };
const ORDER_STATUS = { queued: '待领取', claimed: '已领料', delivered: '已送达', shelved: '已上架' };
const KIND_NAME = { tissue: '纸巾', bags: '清洁袋' };
const ESC_TYPE = {
  stockout_substitute: '缺货替代', hot_water: '热水超温', missed_disinfection: '消毒漏项',
  repeated_reports: '连续报障', room_closure: '整间闭用',
};

const state = {
  view: 'overview',
  staff: [],
  me: Number(localStorage.getItem('mb_staff') || 1),
  form: null,          // 巡检表单
  inspect: {},         // roomId -> {checks:{}, quantities:{}, photos:{}, temp, note:{}}
  temps: {},           // roomId -> 本次读到的水温
  timers: {},
};

// ---------- API ----------

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Staff-Id': String(state.me) };
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = 'toast'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function dueText(iso) {
  const diff = new Date(iso) - new Date();
  if (diff <= 0) return '已超时';
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `剩余 ${h}小时${m}分` : `剩余 ${m}分钟`;
}

// ---------- 通用组件 ----------

function stockBarHTML(item) {
  const ratio = Math.max(0, Math.min(1, item.quantity / item.capacity));
  const segs = 10;
  const filled = Math.round(ratio * segs);
  const low = item.quantity < item.safety_level;
  let cls = 'sage';
  if (low) cls = 'low';
  else if (ratio < 0.5) cls = 'mid';
  const bars = Array.from({ length: segs }, (_, i) =>
    `<i class="${i < filled ? 'on ' + cls : ''}"></i>`).join('');
  return `<div class="stock ${low ? 'low' : ''}">
    <div class="stock-head"><b>${esc(item.name)}</b>
      <span class="stock-num">${item.quantity}${esc(item.unit)} / 安全 ${item.safety_level}${esc(item.unit)}</span></div>
    <div class="bar">${bars}</div>
  </div>`;
}

function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modalMask').classList.add('show');
}
function closeModal() { $('#modalMask').classList.remove('show'); }
$('#modalMask').addEventListener('click', e => { if (e.target.id === 'modalMask') closeModal(); });

function openPhoto(path) {
  $('#lightboxImg').src = '/photos/' + encodeURIComponent(path);
  $('#lightbox').classList.add('show');
}
function closePhoto() { $('#lightbox').classList.remove('show'); }
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closePhoto(); });

// ============ 视图：楼层总览 ============

async function renderOverview() {
  const data = await api('/api/overview');
  const escs = await api('/api/escalations?status=open').catch(() => []);
  let totalRooms = 0, openRooms = 0, partialRooms = 0, lowStock = 0;
  data.forEach(g => g.rooms.forEach(r => {
    totalRooms++;
    if (r.status === 'open') openRooms++;
    if (r.status === 'partial') partialRooms++;
    lowStock += r.low_stock_count;
  }));

  let html = `<div class="summary-row">
    <div class="stat ok"><div class="n">${openRooms}/${totalRooms}</div><div class="l">正常开放房间</div></div>
    <div class="stat ${partialRooms ? 'warn' : ''}"><div class="n">${partialRooms}</div><div class="l">局部闭用</div></div>
    <div class="stat ${lowStock ? 'warn' : ''}"><div class="n">${lowStock}</div><div class="l">低库存房间</div></div>
    <div class="stat ${escs.length ? 'warn' : ''}"><div class="n">${escs.length}</div><div class="l">待处理升级</div></div>
  </div>`;

  if (escs.length) {
    html += `<div class="section-title">升级事件（按负责人分派）</div>` + escs.map(escalationCard).join('');
  }

  for (const g of data) {
    html += `<div class="floor-head"><h2>${esc(g.floor.name)}</h2>
      <span class="floor-stat">${g.rooms.length} 间母婴室</span></div>`;
    for (const r of g.rooms) {
      const subs = [`<span class="dot ${r.status}"></span>设施开放 ${r.facility_open}/${r.facility_total}`];
      if (r.low_stock_count) subs.push(`<span style="color:var(--coral-deep)">低库存 ${r.low_stock_count} 项</span>`);
      if (r.open_work_orders) subs.push(`<span style="color:var(--coral-deep)">工单 ${r.open_work_orders}</span>`);
      const closed = r.closed_facilities.map(f => esc(f.name)).join('、');
      html += `<div class="room-entry st-${r.status}" onclick="app.showRoom(${r.id})">
        <div class="r-main">
          <div class="r-title"><b>${esc(r.name)}</b><span class="r-code">${esc(r.code)}</span>
            <span class="pill ${r.status}">${STATUS_TEXT[r.status]}</span></div>
          <div class="r-sub">${subs.join('')}${closed ? ` · 闭用：${closed}` : ''}</div>
        </div>
        <span style="color:#b4bdb6;font-size:20px">›</span>
      </div>`;
    }
  }
  html += `<div style="margin-top:14px"><button class="btn ghost sm" onclick="app.refresh()">刷新</button></div>`;
  $('#view').innerHTML = html;
}

function escalationCard(e) {
  const letter = { stockout_substitute: '缺', hot_water: '温', missed_disinfection: '消',
    repeated_reports: '报', room_closure: '闭' }[e.type];
  return `<div class="card esc-card t-${e.type}">
    <div class="esc-icon">${letter}</div>
    <div class="esc-body">
      <div class="esc-title">${esc(e.title)}</div>
      <div class="esc-detail">${esc(e.detail || '')}</div>
      <div class="esc-assign">→ ${esc(e.assignee_role_name)} ${esc(e.assignee_name || '（待分派）')} · ${esc(e.floor_name)} · ${fmtTime(e.created_at)}</div>
    </div>
    <div class="btn-row" style="flex:0 0 auto;flex-direction:column;gap:6px">
      <button class="btn sm" onclick="app.ackEsc(${e.id})">已知悉</button>
      <button class="btn sm primary" onclick="app.resolveEsc(${e.id})">已处理</button>
    </div>
  </div>`;
}

async function showRoom(roomId) {
  const r = await api(`/api/rooms/${roomId}`);
  const facs = r.facilities.map(f => `
    <div class="fac-card ${f.status === 'closed' ? 'closed' : ''}">
      <div class="fc-type">${FAC_TYPE[f.type]}</div>
      <div class="fc-name">${esc(f.name)}</div>
      <span class="pill ${f.status}">${f.status === 'open' ? '开放' : '闭用'}</span>
      ${f.closed_reason ? `<div class="fc-reason">${esc(f.closed_reason)}</div>` : ''}
      ${f.status === 'open' ? `
        <div style="margin-top:8px"><button class="btn sm" onclick="app.tempClosure('facility',${r.id},${f.id})">临时关闭此设施</button></div>` : ''}
      ${r.active_facility_closures.filter(c => c.facility_id === f.id).map(c =>
        `<div class="fc-reason">临时闭用：${esc(c.reason)} · 预计 ${fmtTime(c.expected_reopen_at)}
          <button class="btn sm" style="margin-top:6px" onclick="app.endClosure(${c.id})">解除闭用</button></div>`).join('')}
    </div>`).join('');
  openModal(`
    <h3>${esc(r.name)} <span class="pill ${r.status}" style="vertical-align:middle">${STATUS_TEXT[r.status]}</span></h3>
    <div class="fac-grid">${facs}</div>
    <div style="margin:12px 0 4px">${r.inventory.map(stockBarHTML).join('')}</div>
    ${r.active_closure ? `<div class="pill closed">临时闭用中：${esc(r.active_closure.reason)} 预计 ${fmtTime(r.active_closure.expected_reopen_at)} 重开</div>` : ''}
    <div class="section-title">后勤操作</div>
    <div class="btn-row">
      ${r.active_closure
        ? `<button class="btn primary" onclick="app.endClosure(${r.active_closure.id})">解除临时闭用</button>`
        : `<button class="btn coral" onclick="app.tempClosure('room',${r.id})">整间临时闭用</button>`}
      <button class="btn" onclick="app.customerReportDialog(${r.id})">顾客报障</button>
    </div>
    <div style="margin-top:14px"><button class="btn ghost block" onclick="app.closeModal()">关闭</button></div>
  `);
}

async function tempClosure(scope, roomId, facilityId) {
  const hours = prompt(scope === 'room' ? '整间闭用时长（小时，可留空表示不定）' : '设施闭用时长（小时，可留空）', '2');
  if (hours === null) return;
  const reason = prompt('闭用原因', scope === 'room' ? '例行维护' : '设施维护');
  if (reason === null) return;
  try {
    await api('/api/closures', { method: 'POST', body: {
      scope, room_id: roomId, facility_id: facilityId || null,
      reason, hours: hours ? Number(hours) : null,
    }});
    toast(scope === 'room' ? '已整间闭用并升级楼层管理员' : '该设施已临时关闭');
    closeModal();
    app.refresh();
  } catch (e) { toast(e.message, true); }
}

async function endClosure(id) {
  await api(`/api/closures/${id}/end`, { method: 'POST' });
  toast('已解除闭用'); closeModal(); app.refresh();
}

function customerReportDialog(roomId) {
  openModal(`
    <h3>顾客报障</h3>
    <p style="color:var(--ink-2);font-size:13px;margin-top:0">仅记录故障情况，无需填写姓名与联系方式。</p>
    <div class="field"><label>相关设施（可不选，表示整间问题）</label>
      <select id="crFacility"><option value="">— 整间 / 不指定 —</option></select></div>
    <div class="field"><label>故障描述</label><textarea id="crDesc" placeholder="例如：3号隔间门板松动"></textarea></div>
    <div class="btn-row">
      <button class="btn ghost" onclick="app.closeModal()">取消</button>
      <button class="btn coral" onclick="app.submitCustomerReport(${roomId})">提交报障</button>
    </div>`);
  api(`/api/rooms/${roomId}`).then(r => {
    $('#crFacility').innerHTML = '<option value="">— 整间 / 不指定 —</option>' +
      r.facilities.map(f => `<option value="${f.id}">${FAC_TYPE[f.type]} · ${esc(f.name)}</option>`).join('');
  });
}
async function submitCustomerReport(roomId) {
  const description = $('#crDesc').value.trim();
  if (!description) return toast('请描述故障情况', true);
  const fid = Number($('#crFacility').value) || null;
  try {
    const r = await api('/api/reports', { method: 'POST', body: { room_id: roomId, facility_id: fid, description }});
    toast(r.escalation_id ? '已提交，该对象近期连续报障，已升级值班经理' : '报障已提交');
    closeModal();
  } catch (e) { toast(e.message, true); }
}

// ============ 视图：移动巡检 ============

async function renderInspect() {
  const shifts = await api('/api/shifts?status=open');
  const my = shifts.filter(s => s.staff_id === state.me);
  const opts = (my.length ? my : shifts).map(s =>
    `<option value="${s.id}">${esc(s.floor_name)} · ${esc(s.label)} · ${esc(s.staff_name)}</option>`).join('');
  $('#view').innerHTML = `
    <div class="card">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <label style="font-size:13px;color:var(--ink-2)">当前班次</label>
        <select id="shiftSelect" style="flex:1;min-width:200px">${opts}</select>
        <button class="btn sm" onclick="app.newShiftDialog()">开班</button>
        <button class="btn sm primary" onclick="app.loadForm()">载入巡检表</button>
      </div>
      ${(my.length ? my : shifts).length === 0 ? '<div class="empty" style="padding:18px">暂无开放班次，请先开班</div>' : ''}
    </div>
    <div id="inspectBody"></div>`;
  if ((my.length ? my : shifts).length) {
    $('#shiftSelect').value = (my[0] || shifts[0]).id;
    loadForm();
  }
}

function newShiftDialog() {
  openModal(`
    <h3>开设班次</h3>
    <div class="field"><label>楼层</label><select id="nsFloor"></select></div>
    <div class="field"><label>班次</label>
      <select id="nsLabel"><option>白班 09:00-17:00</option><option>晚班 17:00-22:00</option></select></div>
    <div class="btn-row"><button class="btn ghost" onclick="app.closeModal()">取消</button>
      <button class="btn primary" onclick="app.createShift()">开班</button></div>`);
  api('/api/floors').then(floors => {
    $('#nsFloor').innerHTML = floors.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  });
}
async function createShift() {
  try {
    const s = await api('/api/shifts', { method: 'POST', body: {
      floor_id: Number($('#nsFloor').value), label: $('#nsLabel').value }});
    closeModal(); toast('班次已开启'); renderInspect();
  } catch (e) { toast(e.message, true); }
}

async function loadForm() {
  const shiftId = Number($('#shiftSelect').value);
  if (!shiftId) return;
  state.form = await api(`/api/shifts/${shiftId}/form`);
  initInspectState();
  renderInspectRooms();
}

function initInspectState() {
  for (const entry of state.form.rooms) {
    const rid = entry.room.id;
    if (state.inspect[rid]) continue;
    const checks = {}, photos = {}, note = {};
    for (const it of state.form.check_items) {
      const row = entry.inspections[it.key];
      checks[it.key] = row?.result || null;
      if (row?.note) note[it.key] = row.note;
      if (it.key === 'water_temp' && row?.temp_value != null) state.temps[rid] = row.temp_value;
    }
    const quantities = {};
    for (const inv of entry.room.inventory) quantities[inv.id] = inv.quantity;
    state.inspect[rid] = { checks, quantities, photos, temp: state.temps[rid] ?? null, note };
  }
}

function renderInspectRooms() {
  const { shift, rooms, check_items } = state.form;
  let html = `<div class="card" style="background:var(--sage-soft);border-color:#cfe0d4">
    <b>${esc(shift.floor_name)} · ${esc(shift.label)}</b>
    <div style="font-size:13px;color:var(--sage-ink);margin-top:2px">逐项检查门锁、水温、插座、异味、清洁度、耗材余量，完成后生成班次快照</div>
  </div>`;
  for (const entry of rooms) {
    const r = entry.room;
    const st = state.inspect[r.id];
    const done = check_items.filter(c => st.checks[c.key]).length;
    if (entry.snapshot_id) {
      html += `<div class="card">
        <div class="r-title"><b>${esc(r.name)}</b><span class="r-code">${esc(r.code)}</span></div>
        <div class="snap-banner" style="margin-top:8px">✓ 班次快照 #${entry.snapshot_id} 已生成，检查结果不可覆盖</div>
        ${snapshotSummaryHTML(entry, st)}
      </div>`;
      continue;
    }
    html += `<div class="card" id="roomCard${r.id}">
      <div class="r-title"><b>${esc(r.name)}</b><span class="r-code">${esc(r.code)}</span>
        <span class="pill ${done === check_items.length ? 'open' : 'quiet'}">${done}/${check_items.length} 项</span></div>
      <div id="items${r.id}">${check_items.map(c => inspectItemHTML(r, c, st)).join('')}</div>
      <div class="section-title">耗材余量清点</div>
      ${r.inventory.map(inv => stepperHTML(r.id, inv)).join('')}
      <div class="section-title">消毒登记（尿布台 / 哺乳隔间）</div>
      ${r.facilities.filter(f => f.type !== 'water_heater').map(f => `
        <label class="chk-disinfect">
          <input type="checkbox" data-room="${r.id}" data-fac="${f.id}" ${isDisinfected(r.id, f.id) ? 'checked' : ''}
            onchange="app.toggleDisinfect(${r.id},${f.id},this.checked)" />
          ${FAC_TYPE[f.type]} · ${esc(f.name)}
          <span class="done-tag"></span>
        </label>`).join('')}
      <div class="btn-row" style="margin-top:14px">
        <button class="btn" onclick="app.saveInspection(${r.id})">保存检查</button>
        <button class="btn primary" onclick="app.makeSnapshot(${r.id})" ${done === check_items.length ? '' : 'disabled'}>
          生成班次快照${done === check_items.length ? '' : '（六项齐全后）'}</button>
      </div>
    </div>`;
  }
  $('#inspectBody').innerHTML = html;
}

function isDisinfected(rid, fid) {
  const entry = state.form.rooms.find(e => e.room.id === rid);
  return (entry?.disinfected_facility_ids || []).includes(fid);
}

function inspectItemHTML(r, c, st) {
  const val = st.checks[c.key];
  const isTemp = c.key === 'water_temp';
  const heater = r.facilities.find(f => f.type === 'water_heater');
  const photoPath = st.photos[c.key];
    const savedTemp = state.temps[rid];
    return `<div class="inspect-item ${val === 'fault' ? 'fault' : ''}" id="item${r.id}-${c.key}">
    <div class="ii-head"><span class="ii-name">${esc(c.name)}</span>
      <span class="ii-state">${val === 'ok' ? '正常' : val === 'fault' ? '异常' : val === 'na' ? '不适用' : '待检查'}</span></div>
    ${isTemp ? `<div class="temp-box">
        <button class="btn sm" onclick="app.readTemp(${r.id},${heater.id})">读取水温</button>
        <span class="temp-value ${savedTemp > 45 ? 'high' : savedTemp != null && savedTemp < 37 ? 'low' : savedTemp != null ? 'ok' : ''}" id="tempVal${r.id}">${savedTemp != null ? savedTemp + '°C' : '--.-°'}</span>
        <span class="temp-range">适宜 37–45°C，超温自动升级设备工程师</span>
      </div>` : ''}
    <div class="seg">
      <button class="${val === 'ok' ? 'sel-ok' : ''}" onclick="app.setCheck(${r.id},'${c.key}','ok')">正常</button>
      <button class="${val === 'fault' ? 'sel-fault' : ''}" onclick="app.setCheck(${r.id},'${c.key}','fault')">异常</button>
      <button class="${val === 'na' ? 'sel-na' : ''}" onclick="app.setCheck(${r.id},'${c.key}','na')">不适用</button>
    </div>
    ${val === 'fault' ? `
      <div class="field" style="margin-top:10px"><label>异常说明${c.key === 'door_lock' || c.key === 'water_temp' ? '（将自动关闭对应设施）' : ''}</label>
        <textarea id="note${r.id}-${c.key}" placeholder="描述异常情况">${esc(st.note[c.key] || '')}</textarea></div>
      <div class="field"><label>故障照片（清晰大图）</label>
        <input type="file" accept="image/png,image/jpeg" id="photo${r.id}-${c.key}" onchange="app.uploadPhoto(${r.id},'${c.key}',this)"
          style="font-size:13px;padding:6px;min-height:auto" />
        ${photoPath ? `<img class="photo-thumb" style="margin-top:8px" src="/photos/${encodeURIComponent(photoPath)}" onclick="app.openPhoto('${esc(photoPath)}')" />` : ''}
      </div>` : ''}
  </div>`;
}

function stepperHTML(rid, inv) {
  const qty = state.inspect[rid].quantities[inv.id];
  const view = { ...inv, quantity: qty };
  return `<div data-inv="${inv.id}">
    ${stockBarHTML(view)}
    <div class="qty-input">
      <button onclick="app.stepQty(${rid},${inv.id},-1)">−</button>
      <input value="${qty}" inputmode="numeric" onchange="app.setQty(${rid},${inv.id},this.value)" />
      <button onclick="app.stepQty(${rid},${inv.id},1)">＋</button>
      <span style="color:var(--ink-2);font-size:13px">当前清点数量（低于安全量自动入补给队列）</span>
    </div>
  </div>`;
}

async function toggleDisinfect(rid, fid, checked) {
  if (!checked) { toast('消毒登记由服务端记录，取消勾选不会删除记录'); loadForm(); return; }
  try {
    await api('/api/disinfection', { method: 'POST', body: {
      shift_id: state.form.shift.id, room_id: rid, facility_id: fid }});
    toast('消毒已登记');
    await loadForm();
  } catch (e) { toast(e.message, true); }
}

function setCheck(rid, key, val) {
  const st = state.inspect[rid];
  st.checks[key] = val;
  if (val !== 'fault') { st.photos[key] = null; st.note[key] = ''; }
  $('#items' + rid).innerHTML = state.form.check_items.map(c =>
    inspectItemHTML(state.form.rooms.find(e => e.room.id === rid).room, c, st)).join('');
}

function stepQty(rid, iid, delta) {
  const st = state.inspect[rid];
  const inv = state.form.rooms.find(e => e.room.id === rid).room.inventory.find(i => i.id === iid);
  st.quantities[iid] = Math.max(0, Math.min(inv.capacity, (st.quantities[iid] || 0) + delta));
  $(`[data-inv="${iid}"]`).outerHTML = stepperHTML(rid, inv);
}
function setQty(rid, iid, v) {
  state.inspect[rid].quantities[iid] = Math.max(0, parseInt(v, 10) || 0);
}

async function readTemp(rid, fid) {
  try {
    const r = await api(`/api/facilities/${fid}/temperature`);
    state.inspect[rid].temp = r.value_c;
    const el = $('#tempVal' + rid);
    el.textContent = `${r.value_c}°C`;
    el.className = 'temp-value ' + r.status;
    if (r.status === 'high') toast(`热水超温 ${r.value_c}°C，保存后将升级设备工程师`, true);
    else if (r.status === 'low') toast(`水温偏低 ${r.value_c}°C`);
  } catch (e) { toast(e.message, true); }
}

async function uploadPhoto(rid, key, input) {
  const file = input.files[0];
  if (!file) return;
  const dataBase64 = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  try {
    const r = await api('/api/photos', { method: 'POST', body: { data_base64: dataBase64 }});
    state.inspect[rid].photos[key] = r.path;
    state.inspect[rid].note[key] = $(`#note${rid}-${key}`)?.value || '';
    toast('照片已上传');
    $('#items' + rid).innerHTML = state.form.check_items.map(c =>
      inspectItemHTML(state.form.rooms.find(e => e.room.id === rid).room, c, state.inspect[rid])).join('');
  } catch (e) { toast(e.message, true); }
}

async function saveInspection(rid) {
  const st = state.inspect[rid];
  // 同步备注
  for (const c of state.form.check_items) {
    const n = $(`#note${rid}-${c.key}`);
    if (n) st.note[c.key] = n.value;
  }
  const items = state.form.check_items
    .filter(c => st.checks[c.key])
    .map(c => ({
      item_key: c.key, result: st.checks[c.key],
      note: st.note[c.key] || '', photo_path: st.photos[c.key] || null,
    }));
  if (!items.length) return toast('请至少完成一项检查再保存', true);
  try {
    await api('/api/inspections', { method: 'POST', body: {
      shift_id: state.form.shift.id, room_id: rid, items,
      quantities: st.quantities, temp_value: st.temp,
    }});
    toast('检查已保存：低库存已入队列，故障设施已关闭');
    await loadForm();
  } catch (e) { toast(e.message, true); }
}

async function makeSnapshot(rid) {
  try {
    const r = await api('/api/snapshots', { method: 'POST', body: {
      shift_id: state.form.shift.id, room_id: rid }});
    toast(`不可覆盖的班次快照 #${r.snapshot_id} 已生成`);
    await loadForm();
  } catch (e) { toast(e.message, true); }
}

function snapshotSummaryHTML(entry, st) {
  const insp = entry.inspections;
  const rows = state.form.check_items.map(c => {
    const row = insp[c.key];
    const txt = row.result === 'ok' ? '正常' : row.result === 'fault' ? '异常' : '不适用';
    const tv = c.key === 'water_temp' && row.temp_value != null ? ` ${row.temp_value}°C` : '';
    return `<tr><td>${esc(c.name)}</td><td>${txt}${tv}</td><td>${esc(row.note || '')}</td></tr>`;
  }).join('');
  return `<table class="snap-table"><tr><th>巡检项</th><th>结果</th><th>备注</th></tr>${rows}</table>`;
}

// ============ 视图：设施状态（沿用总览 + 房间详情） ============

async function renderFacilities() {
  const data = await api('/api/overview');
  let html = '';
  for (const g of data) {
    html += `<div class="floor-head"><h2>${esc(g.floor.name)}</h2></div>`;
    for (const r of g.rooms) {
      const detail = await api(`/api/rooms/${r.id}`);
      html += `<div class="card">
        <div class="r-title"><b>${esc(r.name)}</b><span class="r-code">${esc(r.code)}</span>
          <span class="pill ${r.status}">${STATUS_TEXT[r.status]}</span>
          <button class="btn sm" style="margin-left:auto" onclick="app.showRoom(${r.id})">操作</button></div>
        <div class="fac-grid" style="margin-top:10px">
          ${detail.facilities.map(f => `<div class="fac-card ${f.status === 'closed' ? 'closed' : ''}">
            <div class="fc-type">${FAC_TYPE[f.type]}</div><div class="fc-name">${esc(f.name)}</div>
            <span class="pill ${f.status}">${f.status === 'open' ? '开放' : '闭用'}</span>
            ${f.closed_reason ? `<div class="fc-reason">${esc(f.closed_reason)}</div>` : ''}
          </div>`).join('')}
        </div>
        <div style="margin-top:10px">${detail.inventory.map(stockBarHTML).join('')}</div>
      </div>`;
    }
  }
  $('#view').innerHTML = html;
}

// ============ 视图：补给队列 ============

async function renderSupply() {
  const orders = await api('/api/supply-queue');
  const reversals = await api('/api/reversals');
  const me = state.staff.find(s => s.id === state.me);
  $('#supplyBadge').hidden = !orders.filter(o => o.status !== 'shelved').length;
  $('#supplyBadge').textContent = orders.filter(o => o.status !== 'shelved').length;

  let html = `<div class="card" style="background:var(--surface-2)">
    <b>三步确认</b>：领料 → 送达 → 上架，分别由责任人确认。同一补给单被两人同时领取时，只保留首个领取者。
  </div>`;
  if (!orders.length) html += '<div class="empty">补给队列是空的</div>';
  for (const o of orders) {
    const step = ['queued', 'claimed', 'delivered', 'shelved'].indexOf(o.status);
    const names = ['待领取', '已领料', '已送达', '已上架'];
    html += `<div class="card supply-card">
      <div class="sc-head">
        <b>#${o.id} ${esc(o.item_name)}</b>
        <span class="pill ${o.status}">${ORDER_STATUS[o.status]}</span>
        ${o.overdue ? '<span class="pill overdue">超时未完成</span>' : ''}
        ${o.stockout_at ? '<span class="pill overdue">缺货·替代升级</span>' : ''}
      </div>
      <div class="meta"><span>${esc(o.room_name)}</span><span>申领 ${o.request_qty}${esc(o.unit)}</span>
        <span>现库存 ${o.current_qty}${esc(o.unit)}</span><span class="due ${o.overdue ? 'overdue' : ''}">时限 ${fmtTime(o.due_at)}（${dueText(o.due_at)}）</span></div>
      <div class="sc-flow">${names.map((n, i) =>
        `<span class="step ${i <= step ? 'done' : ''}">${n}${i === 1 && o.claimed_name ? '·' + esc(o.claimed_name) : ''}${i === 2 && o.delivered_name ? '·' + esc(o.delivered_name) : ''}${i === 3 && o.shelved_name ? '·' + esc(o.shelved_name) : ''}</span>${i < 3 ? '<span class="arrow">→</span>' : ''}`).join('')}
      </div>
      <div class="btn-row" style="margin-top:10px">
        ${o.status === 'queued' ? `<button class="btn coral" onclick="app.claim(${o.id})">确认领料</button>` : ''}
        ${o.status === 'claimed' ? `<button class="btn primary" onclick="app.deliver(${o.id})">确认送达</button>` : ''}
        ${o.status === 'delivered' ? `<button class="btn primary" onclick="app.shelve(${o.id})">确认上架</button>` : ''}
        ${o.status === 'shelved' ? `<button class="btn sm" onclick="app.reversal(${o.id})">申请撤销上架</button>` : ''}
      </div>
    </div>`;
  }
  const pending = reversals.filter(r => r.status === 'pending');
  if (pending.length || (me && me.role === 'supervisor')) {
    html += `<div class="section-title">撤销上架复核（仅主管）</div>`;
    if (!pending.length) html += '<div class="empty" style="padding:18px">没有待复核的撤销申请</div>';
    for (const r of pending) {
      html += `<div class="card">
        <div><b>撤销申请 #${r.id}</b> <span class="pill claimed">待主管复核</span></div>
        <div class="meta" style="margin-top:6px"><span>补给单 #${r.order_id}</span><span>申请人 ${esc(r.requester_name)}</span><span>${fmtTime(r.created_at)}</span></div>
        <div style="margin:6px 0 10px">${esc(r.reason)}</div>
        <div class="btn-row">
          <button class="btn coral" onclick="app.reviewReversal(${r.id},false)">驳回</button>
          <button class="btn primary" onclick="app.reviewReversal(${r.id},true)" ${me.role === 'supervisor' ? '' : 'disabled'}>
            ${me.role === 'supervisor' ? '主管批准撤销' : '仅主管可批准'}</button>
        </div>
      </div>`;
    }
  }
  $('#view').innerHTML = html;
}

async function claim(id) {
  try { await api(`/api/supply-orders/${id}/claim`, { method: 'POST' }); toast('领料成功：你是首个领取者'); app.refresh(); }
  catch (e) { toast(e.message, true); app.refresh(); }
}
async function deliver(id) {
  try {
    await api(`/api/supply-orders/${id}/deliver`, { method: 'POST' });
    toast('送达已确认'); app.refresh();
  } catch (e) { toast(e.message, true); }
}
async function shelve(id) {
  try { await api(`/api/supply-orders/${id}/shelve`, { method: 'POST' }); toast('上架已确认，库存已补足'); app.refresh(); }
  catch (e) { toast(e.message, true); }
}
function reversal(id) {
  const reason = prompt('撤销上架原因（将提交主管复核）');
  if (!reason) return;
  api(`/api/supply-orders/${id}/reversal`, { method: 'POST', body: { reason }})
    .then(() => { toast('已提交，等待主管复核'); app.refresh(); })
    .catch(e => toast(e.message, true));
}
async function reviewReversal(id, approve) {
  try {
    await api(`/api/reversals/${id}/review`, { method: 'POST', body: { approve }});
    toast(approve ? '主管已批准，单据退回已送达' : '已驳回'); app.refresh();
  } catch (e) { toast(e.message, true); }
}

// ============ 视图：维修复测 ============

async function renderRepair() {
  const wos = await api('/api/work-orders');
  const open = wos.filter(w => w.status !== 'retest_passed');
  $('#repairBadge').hidden = !open.length;
  $('#repairBadge').textContent = open.length;
  let html = `<div class="card" style="background:var(--surface-2)">
    设施故障自动关闭对应设施并转维修；<b>复测通过</b>后才重新开放，不影响的隔间可继续使用。
  </div>`;
  if (!wos.length) html += '<div class="empty">暂无工单</div>';
  for (const w of wos) {
    html += `<div class="card wo-card ${w.status}">
      <div class="wo-head"><b>#${w.id} ${esc(w.title)}</b>
        <span class="pill ${w.status}">${WO_STATUS[w.status]}</span>
        <span class="pill quiet">${w.scope === 'room' ? '整间' : '局部设施'}</span></div>
      <div class="meta"><span>${esc(w.room_name)}${w.facility_name ? ' · ' + esc(w.facility_name) : ''}</span>
        <span>来源：${w.source === 'inspection' ? '巡检' : w.source === 'customer_report' ? '顾客报障' : '员工上报'}</span>
        <span>${fmtTime(w.created_at)}</span></div>
      ${w.description ? `<div class="wo-desc">${esc(w.description)}</div>` : ''}
      ${w.photo_path ? `<img class="photo-thumb" src="/photos/${encodeURIComponent(w.photo_path)}" onclick="app.openPhoto('${esc(w.photo_path)}')" alt="故障照片" />` : ''}
      ${w.repair_note ? `<div class="wo-desc" style="color:var(--ink-2)">维修记录：${esc(w.repair_note)}（${fmtTime(w.repairing_at)}）</div>` : ''}
      ${w.retest_note ? `<div class="wo-desc" style="color:var(--ink-2)">上次复测：${esc(w.retest_note)} · ${w.last_retest_passed ? '通过' : '未通过'}</div>` : ''}
      <div class="btn-row" style="margin-top:10px">
        ${w.status === 'open' ? `<button class="btn" onclick="app.startRepair(${w.id})">开始维修</button>` : ''}
        ${w.status === 'repairing' ? `
          <button class="btn coral" onclick="app.retest(${w.id},false)">复测未通过</button>
          <button class="btn primary" onclick="app.retest(${w.id},true)">复测通过并重开</button>` : ''}
        ${w.status === 'retest_passed' ? `<span class="pill retest_passed">✓ 已复测通过并开放</span>` : ''}
      </div>
    </div>`;
  }
  $('#view').innerHTML = html;
}

async function startRepair(id) {
  const note = prompt('维修安排说明（可留空）', '') || '';
  await api(`/api/work-orders/${id}/repair`, { method: 'POST', body: { note }})
    .then(() => { toast('已转维修，24 小时后将提醒复检'); app.refresh(); })
    .catch(e => toast(e.message, true));
}
async function retest(id, passed) {
  const note = prompt(passed ? '复测结果说明（可留空）' : '未通过原因', '') || '';
  try {
    const r = await api(`/api/work-orders/${id}/retest`, { method: 'POST', body: { passed, note }});
    toast(passed ? '复测通过，设施已重新开放' : '复测未通过，保持关闭');
    app.refresh();
  } catch (e) { toast(e.message, true); }
}

// ============ 视图：班次交接 ============

async function renderHandover() {
  const shifts = await api('/api/shifts');
  const opts = shifts.map(s =>
    `<option value="${s.id}">${esc(s.floor_name)} · ${esc(s.label)} · ${esc(s.staff_name)} · ${s.status === 'closed' ? '已交接' : '进行中'}</option>`).join('');
  $('#view').innerHTML = `<div class="card"><label style="font-size:13px;color:var(--ink-2)">选择班次</label>
    <select id="hvShift" style="width:100%;margin-top:6px" onchange="app.loadHandover()">${opts}</select></div>
    <div id="hvBody"></div>`;
  if (shifts.length) { $('#hvShift').value = shifts[0].id; loadHandover(); }
}

async function loadHandover() {
  const id = Number($('#hvShift').value);
  const d = await api(`/api/shifts/${id}/handover`);
  const faults = d.snapshots.reduce((n, s) => n + s.items.filter(i => i.result === 'fault').length, 0);
  let html = `<div class="summary-row">
    <div class="stat"><div class="n">${d.snapshots.length}</div><div class="l">房间快照</div></div>
    <div class="stat ${faults ? 'warn' : ''}"><div class="n">${faults}</div><div class="l">快照内异常项</div></div>
    <div class="stat ${d.open_work_orders.length ? 'warn' : ''}"><div class="n">${d.open_work_orders.length}</div><div class="l">未结工单</div></div>
    <div class="stat ${d.escalations.filter(e => e.status !== 'resolved').length ? 'warn' : ''}"><div class="n">${d.escalations.filter(e => e.status !== 'resolved').length}</div><div class="l">未结升级</div></div>
  </div>
  <div class="card">
    <div class="r-title"><b>${esc(d.shift.floor_name)} · ${esc(d.shift.label)}</b>
      <span class="pill ${d.shift.status === 'closed' ? 'open' : 'claimed'}">${d.shift.status === 'closed' ? '已交接' : '进行中'}</span></div>
    <div class="meta" style="margin-top:6px">
      <span>值班 ${esc(d.shift.staff_name)}</span><span>起 ${fmtTime(d.shift.started_at)}</span>
      ${d.shift.ended_at ? `<span>止 ${fmtTime(d.shift.ended_at)}</span>` : ''}
    </div>
    ${d.shift.status === 'open'
      ? `<button class="btn coral block" style="margin-top:12px" onclick="app.closeShift(${d.shift.id})">结束班次并交接（需全部房间已生成快照）</button>`
      : '<div class="snap-banner" style="margin-top:12px">该班次已交接，快照永久留存</div>'}
  </div>`;

  html += `<div class="section-title">不可覆盖班次快照</div>`;
  for (const s of d.snapshots) {
    html += `<div class="card">
      <div class="r-title"><b>${esc(s.room_name)}</b><span class="r-code">${esc(s.room_code)}</span>
        <span class="pill ${s.room_status}">${STATUS_TEXT[s.room_status]}</span>
        ${s.water_temp_c != null ? `<span class="pill quiet">水温 ${s.water_temp_c}°C</span>` : ''}</div>
      <table class="snap-table">
        <tr><th>巡检项</th><th>结果</th><th>备注</th></tr>
        ${s.items.map(i => `<tr><td>${esc({ door_lock: '门锁', water_temp: '水温', power_outlet: '插座', odor: '异味', cleanliness: '清洁度', supply_level: '耗材余量' }[i.item_key])}</td>
          <td>${i.result === 'ok' ? '正常' : i.result === 'fault' ? '异常' : '不适用'}</td><td>${esc(i.note || '')}</td></tr>`).join('')}
      </table>
      <div style="margin-top:6px">${s.inventory.map(inv => {
        const name = { tissue: '抽纸', bags: '清洁垃圾袋' }[inv.kind];
        const cap = Math.max(inv.safety_level * 3, inv.quantity);
        return stockBarHTML({ name, quantity: inv.quantity, safety_level: inv.safety_level, capacity: cap, unit: '' });
      }).join('')}</div>
      <div class="meta" style="margin-top:6px">${s.facilities.map(f =>
        `<span>${FAC_TYPE[f.type]} ${f.status === 'open' ? '开放' : '闭用'}${f.disinfected ? '·已消毒' : '·<b style="color:var(--coral-deep)">未消毒</b>'}</span>`).join('')}</div>
    </div>`;
  }

  if (d.open_work_orders.length) {
    html += `<div class="section-title">未结工单（移交下一班跟进复测）</div>`;
    for (const w of d.open_work_orders) {
      html += `<div class="card wo-card ${w.status}">
        <div class="wo-head"><b>#${w.id} ${esc(w.title)}</b><span class="pill ${w.status}">${WO_STATUS[w.status]}</span></div>
        <div class="meta"><span>${esc(w.room_name)}${w.facility_name ? ' · ' + esc(w.facility_name) : ''}</span><span>${esc(w.description || '')}</span></div>
      </div>`;
    }
  }
  if (d.supply_queue.length) {
    html += `<div class="section-title">补给队列</div>`;
    for (const o of d.supply_queue) {
      html += `<div class="card supply-card"><div class="sc-head"><b>#${o.id} ${esc(o.item_name)}</b>
        <span class="pill ${o.status}">${ORDER_STATUS[o.status]}</span>
        ${o.overdue ? '<span class="pill overdue">超时</span>' : ''}</div>
        <div class="meta"><span>${esc(o.room_name)}</span><span class="due ${o.overdue ? 'overdue' : ''}">时限 ${fmtTime(o.due_at)}</span></div></div>`;
    }
  }
  if (d.escalations.length) {
    html += `<div class="section-title">升级事件</div>` + d.escalations.map(e => {
      const ee = { ...e };
      return `<div class="card esc-card t-${e.type}">
        <div class="esc-icon">${({ stockout_substitute: '缺', hot_water: '温', missed_disinfection: '消', repeated_reports: '报', room_closure: '闭' })[e.type]}</div>
        <div class="esc-body"><div class="esc-title">${esc(e.title)}</div>
        <div class="esc-assign">→ ${esc(e.assignee_role_name)} ${esc(e.assignee_name || '')} · ${e.status === 'open' ? '待处理' : e.status === 'acked' ? '已知悉' : '已解决'}</div></div></div>`;
    }).join('');
  }
  if (d.reminders.length) {
    html += `<div class="section-title">进程任务提醒（补给时限 / 复检提醒）</div>`;
    for (const r of d.reminders) {
      html += `<div class="card" style="padding:10px 14px;display:flex;gap:10px;align-items:center">
        <span class="pill ${r.fired_at ? 'overdue' : 'quiet'}">${r.fired_at ? '已到点' : '待触发'}</span>
        <span style="font-size:14px">${esc(r.message)}</span><span class="meta" style="margin-left:auto">${fmtTime(r.fire_at)}</span></div>`;
    }
  }
  $('#hvBody').innerHTML = html;
}

async function closeShift(id) {
  try {
    await api(`/api/shifts/${id}/close`, { method: 'POST' });
    toast('班次已结束并完成交接'); loadHandover();
  } catch (e) { toast(e.message, true); }
}

async function ackEsc(id) {
  await api(`/api/escalations/${id}/ack`, { method: 'POST' }); app.refresh();
}
async function resolveEsc(id) {
  await api(`/api/escalations/${id}/resolve`, { method: 'POST' }); toast('已标记处理'); app.refresh();
}

// ============ 启动 / 导航 ============

async function init() {
  state.staff = await api('/api/staff');
  if (!state.staff.find(s => s.id === state.me)) state.me = state.staff[0]?.id || 1;
  const roleTag = s => (s.role === 'supervisor' ? '主管' : '值班员') +
    (s.duties.length ? ' · ' + s.duties.map(d => ({ supply_lead: '补给主管', engineer: '设备工程师',
      hygiene_lead: '卫生负责人', duty_manager: '值班经理', floor_manager: '楼层管理员' })[d]).join('/') : '');
  $('#staffSelect').innerHTML = state.staff.map(s =>
    `<option value="${s.id}" ${s.id === state.me ? 'selected' : ''}>${esc(s.name)}（${roleTag(s)}）</option>`).join('');
  $('#staffSelect').addEventListener('change', e => {
    state.me = Number(e.target.value);
    localStorage.setItem('mb_staff', state.me);
    state.inspect = {};
    app.refresh();
  });
  $$('#nav button').forEach(b => b.addEventListener('click', () => {
    $$('#nav button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.view = b.dataset.view;
    state.inspect = {};
    app.refresh();
  }));
  app.refresh();
}

function refresh() {
  ({
    overview: renderOverview, inspect: renderInspect, facilities: renderFacilities,
    supply: renderSupply, repair: renderRepair, handover: renderHandover,
  }[state.view] || renderOverview)().catch(e => $('#view').innerHTML =
    `<div class="empty">加载失败：${esc(e.message)}</div>`);
}

// 总览/队列类页面 20 秒轻刷新（巡检页不打断录入）
setInterval(() => { if (['overview', 'supply', 'repair'].includes(state.view)) refresh(); }, 20000);

window.app = {
  refresh, closeModal, openPhoto, closePhoto, showRoom, tempClosure, endClosure,
  customerReportDialog, submitCustomerReport, newShiftDialog, createShift, loadForm,
  toggleDisinfect, setCheck, stepQty, setQty, readTemp, uploadPhoto, saveInspection,
  makeSnapshot, claim, deliver, shelve, reversal, reviewReversal, startRepair, retest,
  loadHandover, closeShift, ackEsc, resolveEsc,
};

init();
