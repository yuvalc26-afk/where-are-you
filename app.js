/* WhereAreYou web app: controls the WhereAreYou board over BLE (Nordic UART) or USB (Web Serial),
 * shows ImHere and the phone on a map.
 * Board protocol: text commands in, one JSON event per line out (see WhereAreYou.ino). */
'use strict';

const NUS = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
};

const JOB_TEXT = {
  0: 'נמצא מיקום',
  1: 'החיפוש הסתיים בלי מיקום',
  2: 'עוד לא הסתיים חיפוש',
  3: 'מחפש GPS…',
  4: 'מודול ה-GPS לא מגיב',
};
const FLAG = { HAS_FIX: 1, GPS_BUSY: 2, BLE_ON: 4, TIME_VALID: 8, BLE_CONNECTED: 16 };
const NEO6M_CEP_M = 2.5;
const $ = (id) => document.getElementById(id);

// ================================================================ transports
class LineSplitter {
  constructor(onLine) { this.buf = ''; this.onLine = onLine; }
  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BleLink {
  // device: a previously permitted device (reconnect without the chooser)
  constructor(device = null) { this.device = device; this.userClosed = false; }
  get label() { return 'BLE'; }
  async connect(onEvent, onClose, onState) {
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.onState = onState;
    if (!this.device) {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS.service] }, { namePrefix: 'WhereAreYou' }],
        optionalServices: [NUS.service],
      });
    }
    this.device.addEventListener('gattserverdisconnected', () => this.onDrop());
    await this.open();
  }
  async open() {
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(NUS.service);
    this.rx = await svc.getCharacteristic(NUS.rx);
    const tx = await svc.getCharacteristic(NUS.tx);
    const decoder = new TextDecoder();
    const lines = new LineSplitter((l) => { try { this.onEvent(JSON.parse(l)); } catch { /* partial / noise */ } });
    tx.addEventListener('characteristicvaluechanged', (e) => lines.push(decoder.decode(e.target.value, { stream: true })));
    await tx.startNotifications();
    this.chain = Promise.resolve();
  }
  // Link lost (board reset, out of range, PC/phone radio hiccup): keep trying until the user disconnects
  async onDrop() {
    if (this.userClosed) { this.onClose(); return; }
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.onState('reconnecting');
    for (let i = 0; !this.userClosed; i++) {
      await sleep(Math.min(1000 * 2 ** i, 10000));
      if (this.userClosed) break;
      try {
        await this.open();
        this.reconnecting = false;
        this.onState('connected');
        return;
      } catch { /* not back yet */ }
    }
    this.reconnecting = false;
    this.onClose();
  }
  send(cmd) {
    if (!this.device?.gatt?.connected) return Promise.reject(new Error('BLE לא מחובר כרגע'));
    // GATT allows one operation at a time: serialize writes
    const data = new TextEncoder().encode(cmd + '\n');
    this.chain = this.chain.catch(() => {}).then(() => this.rx.writeValueWithResponse
      ? this.rx.writeValueWithResponse(data) : this.rx.writeValue(data));
    return this.chain;
  }
  disconnect() {
    this.userClosed = true;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.onClose();
  }
}

class SerialLink {
  get label() { return 'USB'; }
  async connect(onEvent, onClose) {
    this.port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] });
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.pipeThrough(new TextDecoderStream()).getReader();
    const lines = new LineSplitter((l) => {
      if (!l.startsWith('EV ')) return;  // raw modem lines (RX/TX/INFO) are for the Python app
      try { onEvent(JSON.parse(l.slice(3))); } catch { /* ignore */ }
    });
    (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          lines.push(value);
        }
      } catch { /* port lost */ }
      onClose();
    })();
  }
  send(cmd) { return this.writer.write(new TextEncoder().encode(cmd + '\n')); }
  async disconnect() {
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { this.writer?.releaseLock(); await this.port?.close(); } catch { /* ignore */ }
  }
}

// Fake board for trying the UI without hardware
class DemoLink {
  get label() { return 'דמו'; }
  async connect(onEvent, onClose) {
    this.emit = onEvent;
    this.onClose = onClose;
    this.base = { lat: 32.0997, lon: 34.8122 };  // Yarkon Park, Tel Aviv
    this.state = { adaptive: false, dbm: 14, profile: 0, ble: false, fixAt: Date.now() - 95000 };
  }
  later(ms, fn) { setTimeout(fn, ms); }
  link() {
    this.emit({ ev: 'link', up_rssi: -112, up_snr: -3.5, down_rssi: -110, down_snr: -2.75, margin: 16.5, profile: this.state.profile });
    this.emit({ ev: 'flags', v: FLAG.HAS_FIX | FLAG.TIME_VALID | (this.state.ble ? FLAG.BLE_ON : 0) });
  }
  loc(fresh) {
    const now = Math.floor(Date.now() / 1000);
    const jitter = () => (Math.random() - 0.5) * 0.0004;
    if (fresh) this.state.fixAt = Date.now();
    this.emit({
      ev: 'loc', fresh, has_fix: true, job: 0, lat: this.base.lat + jitter(), lon: this.base.lon + jitter(), alt: 18.4,
      fix_unix: Math.floor(this.state.fixAt / 1000), now_unix: now, age: Math.floor((Date.now() - this.state.fixAt) / 1000),
      hdop: 1.1, pdop: 1.9, vdop: 1.6, speed: 0, course: 0, ttff: 4, search: 9, used: 8, view: 12, tracked: 9,
      cn0max: 42, cn0avg: 38, fix_type: 3, quality: 1, uptime: 3600, flags: 9, rssi: -110, snr: -2.75,
    });
  }
  profile() {
    const P = [['SF12 BW125 CR4/8', 183], ['SF12 BW125 CR4/5', 293], ['SF11 BW125 CR4/5', 537]];
    const [name, bps] = P[this.state.profile];
    this.emit({ ev: 'profile', idx: this.state.profile, name, bps, dbm: this.state.dbm });
  }
  status() {
    this.emit({ ev: 'status', fw: 2, adaptive: this.state.adaptive, dbm: this.state.dbm, profile: this.state.profile, freq: 869.525, last_ok_s: -1 });
    this.profile();
  }
  async send(line) {
    const [cmd, arg] = line.split(' ');
    const busy = (on) => this.emit({ ev: 'busy', on });
    const log = (msg) => this.emit({ ev: 'log', msg });
    if (cmd === 'status') return this.status();
    busy(true);
    log(`→ ${cmd.toUpperCase()} (demo)`);
    if (cmd === 'ping') this.later(1200, () => { this.link(); this.emit({ ev: 'pong', fw: 1, uptime: 3600, now_unix: Math.floor(Date.now() / 1000), ble_left: this.state.ble ? 1200 : 0, gps_left: 0, batt_mv: 3950, flags: 9 }); busy(false); });
    else if (cmd === 'get_last') this.later(1500, () => { this.link(); this.loc(false); busy(false); });
    else if (cmd === 'gps_fix') {
      this.later(1200, () => { this.link(); this.emit({ ev: 'ack', cmd: 'GPS_FIX', status: 0, param: Number(arg) || 120 }); busy(false); });
      this.later(5000, () => { log('← GPS result pushed by node (demo)'); this.loc(true); });
    } else if (cmd === 'ble_on' || cmd === 'ble_off') {
      this.state.ble = cmd === 'ble_on';
      this.later(1200, () => { this.link(); this.emit({ ev: 'ack', cmd: cmd.toUpperCase(), status: 0, param: Number(arg) || 0 }); busy(false); });
    } else if (cmd === 'adaptive') {
      this.state.adaptive = arg === '1';
      this.state.profile = this.state.adaptive ? 2 : 0;
      this.later(800, () => { this.status(); busy(false); });
    } else if (cmd === 'power') {
      this.state.dbm = Number(arg);
      this.later(800, () => { this.status(); busy(false); });
    } else busy(false);
  }
  disconnect() { this.onClose(); }
}

// ================================================================ state
const S = {
  link: null,           // active transport
  node: null,           // last location event (+ receivedAt)
  phone: null,          // { lat, lon, acc }
  heading: null,        // device compass heading, degrees
  following: false,
};

// ================================================================ map
const map = L.map('map', { zoomControl: true }).setView([31.8, 35.0], 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap',
}).addTo(map);

const nodeIcon = L.divIcon({ className: 'pin-node', html: '<span></span>', iconSize: [24, 24] });
const phoneIcon = L.divIcon({ className: 'pin-phone', html: '<span></span>', iconSize: [22, 22] });
const nodeMarker = L.marker([0, 0], { icon: nodeIcon });
const nodeCircle = L.circle([0, 0], { radius: 5, color: '#dc2626', weight: 1, fillOpacity: 0.12 });
const phoneMarker = L.marker([0, 0], { icon: phoneIcon });
const phoneCircle = L.circle([0, 0], { radius: 10, color: '#2563eb', weight: 1, fillOpacity: 0.1 });
const joinLine = L.polyline([], { color: '#64748b', weight: 2, dashArray: '6 6' });
nodeMarker.bindTooltip('אני פה', { permanent: true, direction: 'top', offset: [0, -10], className: 'pin-label' });
phoneMarker.bindTooltip('אני', { permanent: true, direction: 'top', offset: [0, -10], className: 'pin-label' });

function fitBoth() {
  const pts = [];
  if (S.node) pts.push([S.node.lat, S.node.lon]);
  if (S.phone) pts.push([S.phone.lat, S.phone.lon]);
  if (pts.length === 2) map.fitBounds(pts, { padding: [50, 50], maxZoom: 18 });
  else if (pts.length === 1) map.setView(pts[0], 17);
}

function drawMap() {
  if (S.node) {
    const p = [S.node.lat, S.node.lon];
    nodeMarker.setLatLng(p).addTo(map);
    nodeCircle.setLatLng(p).setRadius(Math.max(3, S.node.hdop * NEO6M_CEP_M)).addTo(map);
  }
  if (S.phone) {
    const p = [S.phone.lat, S.phone.lon];
    phoneMarker.setLatLng(p).addTo(map);
    phoneCircle.setLatLng(p).setRadius(S.phone.acc || 10).addTo(map);
  }
  if (S.node && S.phone) joinLine.setLatLngs([[S.phone.lat, S.phone.lon], [S.node.lat, S.node.lon]]).addTo(map);
}

// ================================================================ geometry / formatting
const rad = (d) => d * Math.PI / 180;
function distanceM(a, b) {
  const R = 6371000;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const COMPASS = ['צפון', 'צפון-מזרח', 'מזרח', 'דרום-מזרח', 'דרום', 'דרום-מערב', 'מערב', 'צפון-מערב'];
const compassName = (deg) => COMPASS[Math.round(deg / 45) % 8];
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} מ׳` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} ק״מ`; }
function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} ש׳`;
  if (s < 3600) return `${Math.floor(s / 60)} דק׳ ${s % 60} ש׳`;
  if (s < 86400) return `${Math.floor(s / 3600)} שע׳ ${Math.floor(s % 3600 / 60)} דק׳`;
  return `${Math.floor(s / 86400)} ימים ${Math.floor(s % 86400 / 3600)} שע׳`;
}
const fmtTime = (unix) => unix ? new Date(unix * 1000).toLocaleString('he-IL', { hour12: false }) : '—';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setDetails(el, rows) {
  el.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
}

// ================================================================ UI updates
function chip(id, state, text) {
  const el = $(id);
  el.className = `chip ${state}`;
  el.textContent = text;
}

function log(msg) {
  const el = $('log');
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${new Date().toLocaleTimeString('he-IL', { hour12: false })}</span>  ${esc(msg)}`;
  el.appendChild(line);
  while (el.childElementCount > 400) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

function setConnected(on) {
  document.querySelectorAll('[data-cmd], #power').forEach((b) => { b.disabled = !on; });
  $('btnDisconnect').hidden = !on;
  ['btnBle', 'btnUsb', 'btnDemo'].forEach((id) => { $(id).style.display = on ? 'none' : ''; });
}

function updateNav() {
  const arrow = $('arrow');
  if (!S.node) return;
  const ageS = S.node.age + (Date.now() - S.node.receivedAt) / 1000;
  const accM = S.node.hdop * NEO6M_CEP_M;
  $('fixAge').textContent = `המיקום נמדד לפני ${fmtDur(ageS)} · דיוק ~${accM < 10 ? accM.toFixed(1) : Math.round(accM)} מ׳`;
  $('btnNavigate').hidden = false;
  $('btnNavigate').href = `https://www.google.com/maps/dir/?api=1&destination=${S.node.lat.toFixed(6)},${S.node.lon.toFixed(6)}`;
  if (!S.phone) {
    $('distance').textContent = '—';
    $('bearing').textContent = 'אין מיקום לטלפון (צריך הרשאת מיקום)';
    arrow.classList.add('unknown');
    return;
  }
  const d = distanceM(S.phone, S.node);
  const b = bearingDeg(S.phone, S.node);
  $('distance').textContent = fmtDist(d);
  arrow.classList.remove('unknown');
  if (S.heading != null) {
    arrow.style.transform = `rotate(${b - S.heading}deg)`;
    $('bearing').textContent = `${compassName(b)} (${Math.round(b)}°) · החץ מצביע לכיוון "אני פה"`;
  } else {
    arrow.style.transform = `rotate(${b}deg)`;
    $('bearing').textContent = `${compassName(b)} (${Math.round(b)}°) · צפון למעלה`;
  }
}

function showLocation(e) {
  if (!e.has_fix) {
    setDetails($('fixDetails'), [
      ['סטטוס', esc(JOB_TEXT[e.job] ?? e.job)],
      ['לוויינים', `בטווח ראייה ${e.view}, במעקב ${e.tracked} (אין fix)`],
      ['אות (C/N0)', `${e.cn0max} / ${e.cn0avg} dB-Hz`],
    ]);
    log(`אין מיקום: ${JOB_TEXT[e.job] ?? e.job}`);
    return;
  }
  S.node = { ...e, receivedAt: Date.now() };
  try { localStorage.setItem('lastNode', JSON.stringify(S.node)); } catch { /* storage unavailable */ }
  renderNode(true);
  log(`📍 ${e.lat.toFixed(6)}, ${e.lon.toFixed(6)} · ${e.used} לוויינים · HDOP ${e.hdop}`);
}

function renderNode(fit) {
  const e = S.node;
  const fixType = { 2: '2D', 3: '3D' }[e.fix_type] ?? '?';
  setDetails($('fixDetails'), [
    ['סטטוס', `${esc(JOB_TEXT[e.job] ?? e.job)} <span class="badge ${e.fresh ? 'fresh' : ''}">${e.fresh ? 'חדש' : 'שמור'}</span>`],
    ['קואורדינטות', `${e.lat.toFixed(6)}, ${e.lon.toFixed(6)}`],
    ['דיוק משוער', `~${(e.hdop * NEO6M_CEP_M).toFixed(1)} מ׳`],
    ['גובה', `${e.alt} מ׳`],
    ['זמן המדידה', fmtTime(e.fix_unix)],
    ['לוויינים', `${e.used} בשימוש / ${e.view} בטווח ראייה / ${e.tracked} במעקב`],
    ['אות (C/N0)', `${e.cn0max} / ${e.cn0avg} dB-Hz`],
    ['HDOP / PDOP / VDOP', `${e.hdop} / ${e.pdop} / ${e.vdop}`],
    ['סוג fix', fixType],
    ['מהירות / כיוון', `${e.speed} קמ״ש / ${Math.round(e.course)}°`],
    ['זמן עד fix / חיפוש', `${e.ttff} / ${e.search} ש׳`],
    ['שעון היחידה מול הטלפון', e.now_unix ? `${Math.round(e.now_unix - (e.receivedAt / 1000))} ש׳` : '—'],
    ['זמן פעולה של היחידה', fmtDur(e.uptime)],
  ]);
  drawMap();
  updateNav();
  if (fit) fitBoth();
}

let lastLink = null, lastProfile = null, lastFlags = null;
function renderLink() {
  const rows = [];
  if (lastProfile) rows.push(['קצב', `#${lastProfile.idx} · ${esc(lastProfile.name)} · ${lastProfile.bps} bit/s`]);
  if (lastLink) {
    rows.push(['היחידה שומעת אותנו', `RSSI ${lastLink.up_rssi} dBm · SNR ${lastLink.up_snr} dB`]);
    rows.push(['אנחנו שומעים אותה', `RSSI ${lastLink.down_rssi} dBm · SNR ${lastLink.down_snr} dB`]);
    rows.push(['מרווח SNR', `${lastLink.margin} dB`]);
  }
  if (lastFlags != null) {
    const f = lastFlags;
    rows.push(['מצב היחידה', [
      f & FLAG.BLE_ON ? `BLE דולק${f & FLAG.BLE_CONNECTED ? ' (טלפון מחובר)' : ''}` : 'BLE כבוי',
      f & FLAG.GPS_BUSY ? 'מחפש GPS' : 'GPS במנוחה',
      f & FLAG.HAS_FIX ? 'יש מיקום' : 'אין מיקום',
    ].join(' · ')]);
  }
  if (rows.length) setDetails($('linkDetails'), rows);
}

// ================================================================ command buttons
// Blue idle -> yellow while waiting for ImHere -> green (answered) / red (no answer) for 10 s -> blue
const CMD_OF = { PING: 'ping', GET_LAST: 'get_last', GPS_FIX: 'gps_fix', BLE_ON: 'ble_on', BLE_OFF: 'ble_off' };
const CMD_TIMEOUT_S = 45;  // 3 attempts at the slowest rate take ~30 s
const RESULT_SHOW_MS = 10000;
const cmdState = {};       // cmd -> { pending, timer, reset }

function setBtnState(cmd, state) {
  const b = document.querySelector(`[data-cmd="${cmd}"]`);
  if (!b) return;
  b.classList.remove('pending', 'ok', 'fail');
  if (state) b.classList.add(state);
}

function cmdStart(cmd, timeoutS = CMD_TIMEOUT_S) {
  const st = cmdState[cmd] || (cmdState[cmd] = {});
  clearTimeout(st.timer);
  clearTimeout(st.reset);
  st.pending = true;
  setBtnState(cmd, 'pending');
  st.timer = setTimeout(() => cmdDone(cmd, false, 'אין תשובה בזמן סביר'), timeoutS * 1000);
}

function cmdExtend(cmd, timeoutS) {
  const st = cmdState[cmd];
  if (!st?.pending) return;
  clearTimeout(st.timer);
  st.timer = setTimeout(() => cmdDone(cmd, false, 'אין תשובה בזמן סביר'), timeoutS * 1000);
}

function cmdDone(cmd, ok, why = '') {
  const st = cmdState[cmd];
  if (!st) return;  // never pressed in this session
  clearTimeout(st.timer);
  clearTimeout(st.reset);
  st.pending = false;
  setBtnState(cmd, ok ? 'ok' : 'fail');
  if (!ok && why) log(`✗ ${cmd}: ${why}`);
  st.reset = setTimeout(() => setBtnState(cmd, null), RESULT_SHOW_MS);
}

function failAllPending(why) {
  Object.keys(cmdState).forEach((c) => { if (cmdState[c].pending) cmdDone(c, false, why); });
}

// ================================================================ board events
function onEvent(e) {
  switch (e.ev) {
    case 'log': log(e.msg); break;
    case 'busy': $('chipBusy').hidden = !e.on; break;
    case 'status':
      $('power').value = String(e.dbm);
      break;
    case 'profile': lastProfile = e; renderLink(); break;
    case 'link':
      lastLink = e;
      renderLink();
      chip('chipNode', 'ok', `אני פה: עונה · ${new Date().toLocaleTimeString('he-IL', { hour12: false })}`);
      break;
    case 'flags': lastFlags = e.v; renderLink(); break;
    case 'failed':
      chip('chipNode', 'bad', `אני פה: לא עונה (${e.cmd})`);
      if (CMD_OF[e.cmd]) cmdDone(CMD_OF[e.cmd], false, '"אני פה" לא ענה');
      break;
    case 'ack': {
      const extra = e.cmd === 'GPS_FIX' ? ` · מחפש עד ${e.param} ש׳, התוצאה תגיע לבד`
        : e.cmd === 'BLE_ON' ? (e.param ? ` · BLE דולק ל-${e.param} דק׳` : ' · BLE דולק עד כיבוי') : '';
      log(`✓ ${e.cmd} ${e.status === 0 ? 'אושר' : 'נדחה'}${extra}`);
      // GPS check stays yellow until the search result is pushed
      if (e.cmd === 'GPS_FIX') { if (e.status === 0) cmdExtend('gps_fix', e.param + 60); else cmdDone('gps_fix', false, 'נדחה'); }
      else if (CMD_OF[e.cmd]) cmdDone(CMD_OF[e.cmd], e.status === 0, 'נדחה');
      break;
    }
    case 'pong':
      log(`✓ פינג: זמן פעולה ${fmtDur(e.uptime)}${e.ble_left ? `, BLE עוד ${fmtDur(e.ble_left)}` : ''}${e.batt_mv ? `, סוללה ${(e.batt_mv / 1000).toFixed(2)}V` : ''}`);
      lastFlags = e.flags; renderLink();
      cmdDone('ping', true);
      break;
    case 'loc':
      showLocation(e);
      if (e.fresh) cmdDone('gps_fix', e.has_fix, 'החיפוש הסתיים בלי מיקום');
      else cmdDone('get_last', true);
      break;
  }
}

// ================================================================ connection
async function connect(LinkClass, device = null) {
  const link = new LinkClass(device);
  chip('chipDongle', 'wait', 'איפה אתה: מתחבר…');
  try {
    await link.connect(onEvent, () => onClosed(link), (state) => onLinkState(link, state));
  } catch (err) {
    chip('chipDongle', 'off', 'איפה אתה: לא מחובר');
    const msg = err?.message || String(err);
    log(`החיבור נכשל: ${err?.name || ''} ${msg}`);
    // NotFoundError also covers "Bluetooth adapter not available"; only a closed chooser is silent
    if (!(err?.name === 'NotFoundError' && /cancel/i.test(msg))) showNotice(bleHint(err));
    return false;
  }
  S.link = link;
  hideNotice();
  chip('chipDongle', 'ok', `איפה אתה: מחובר (${link.label})`);
  chip('chipNode', 'off', 'אני פה: לא ידוע — לחץ פינג');
  setConnected(true);
  log(`מחובר ל"איפה אתה" דרך ${link.label}`);
  keepScreenOn();
  send('status');  // board state only, nothing is transmitted over LoRa
  return true;
}

function showNotice(text) { const n = $('notice'); n.textContent = text; n.hidden = false; }
function hideNotice() { $('notice').hidden = true; }

function bleHint(err) {
  const m = `${err?.name || ''} ${err?.message || ''}`;
  if (/adapter not available|bluetooth.*(off|disabled)|no bluetooth/i.test(m)) {
    return 'ה-Bluetooth בטלפון כבוי או לא זמין. הדלק Bluetooth ומיקום (GPS) בטלפון ונסה שוב.';
  }
  if (/globally disabled|not allowed|permission|denied|SecurityError|NotAllowedError/i.test(m)) {
    return 'ל-Chrome אין הרשאה ל-Bluetooth. בהגדרות הטלפון ← אפליקציות ← Chrome ← הרשאות: '
      + 'לאפשר "מכשירים בקרבת מקום" ו"מיקום". ובהגדרות האתר ב-Chrome (סמל המנעול) לאפשר Bluetooth.';
  }
  return `החיבור ל-Bluetooth נכשל: ${err?.message || err}. ודא ש-Bluetooth ומיקום דולקים בטלפון.`;
}

function onLinkState(link, state) {
  if (S.link !== link) return;
  if (state === 'reconnecting') {
    chip('chipDongle', 'wait', 'איפה אתה: החיבור נפל, מתחבר מחדש…');
    log('חיבור ה-BLE נפל — מנסה להתחבר מחדש');
  } else if (state === 'connected') {
    chip('chipDongle', 'ok', `איפה אתה: מחובר (${link.label})`);
    log('חיבור ה-BLE חזר');
    send('status');
  }
}

// After a page reload: reconnect to a WhereAreYou this browser was already allowed to use
async function autoConnect() {
  if (!navigator.bluetooth?.getDevices) return;
  let devices = [];
  try { devices = await navigator.bluetooth.getDevices(); } catch { return; }
  const dev = devices.find((d) => d.name?.startsWith('WhereAreYou'));
  if (!dev) return;
  log('מתחבר אוטומטית ל"איפה אתה" שחובר קודם…');
  for (let i = 0; i < 3 && !S.link; i++) {
    if (await connect(BleLink, dev)) return;
    await sleep(2000);
  }
}

function onClosed(link) {
  if (S.link !== link) return;
  S.link = null;
  setConnected(false);
  chip('chipDongle', 'bad', 'איפה אתה: נותק');
  $('chipBusy').hidden = true;
  log('החיבור ל"איפה אתה" נותק');
  failAllPending('החיבור ל"איפה אתה" נותק');
}

async function send(cmd) {
  if (!S.link) return false;
  try {
    await S.link.send(cmd);
    return true;
  } catch (err) {
    log(`שליחה נכשלה: ${err?.message || err}`);
    return false;
  }
}

let wakeLock = null;
async function keepScreenOn() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.link && !wakeLock) keepScreenOn();
});

// ================================================================ phone location + compass
function startGeolocation() {
  if (!navigator.geolocation) return;
  let first = true;
  navigator.geolocation.watchPosition((pos) => {
    S.phone = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
    drawMap();
    updateNav();
    if (S.following) map.panTo([S.phone.lat, S.phone.lon]);
    if (first) { first = false; if (!S.node) map.setView([S.phone.lat, S.phone.lon], 16); else fitBoth(); }
  }, (err) => log(`אין מיקום לטלפון: ${err.message}`), { enableHighAccuracy: true, maximumAge: 2000 });
}

function startCompass() {
  const handler = (e) => {
    if (e.absolute && e.alpha != null) { S.heading = (360 - e.alpha) % 360; updateNav(); }
  };
  window.addEventListener('deviceorientationabsolute', handler);
}

// ================================================================ wiring
function init() {
  if (navigator.serial) $('btnUsb').hidden = false;
  $('btnBle').onclick = async () => {
    hideNotice();
    if (!window.isSecureContext) return showNotice('הדף חייב להיפתח בכתובת https:// כדי להשתמש ב-Bluetooth.');
    if (!navigator.bluetooth) {
      return showNotice('הדפדפן הזה לא תומך ב-Bluetooth מדף אינטרנט. פתח את הקישור ב-Chrome '
        + '(לא מתוך WhatsApp / Gmail / Facebook, ולא ב-Samsung Internet או Firefox).');
    }
    try {
      if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
        return showNotice('ה-Bluetooth בטלפון כבוי או לא זמין. הדלק Bluetooth (וגם מיקום) ונסה שוב.');
      }
    } catch { /* not supported: just try */ }
    connect(BleLink);
  };
  $('btnUsb').onclick = () => connect(SerialLink);
  $('btnDemo').onclick = () => connect(DemoLink);
  $('btnDisconnect').onclick = () => S.link?.disconnect();
  $('btnFit').onclick = fitBoth;
  $('btnMe').onclick = () => {
    S.following = !S.following;
    $('btnMe').style.outline = S.following ? '2px solid var(--accent)' : '';
    if (S.phone) map.panTo([S.phone.lat, S.phone.lon]);
  };

  document.querySelectorAll('[data-cmd]').forEach((b) => {
    b.onclick = async () => {
      const c = b.dataset.cmd;
      cmdStart(c, c === 'gps_fix' ? Number($('gpsTimeout').value) + 60 : CMD_TIMEOUT_S);
      const line = c === 'gps_fix' ? `gps_fix ${$('gpsTimeout').value}`
        : c === 'ble_on' ? `ble_on ${$('bleMinutes').value}` : c;
      if (!(await send(line))) cmdDone(c, false, 'לא נשלח ל"איפה אתה"');
    };
  });
  $('power').onchange = (e) => send(`power ${e.target.value}`);

  setConnected(false);
  try {
    const saved = JSON.parse(localStorage.getItem('lastNode') || 'null');
    if (saved) { S.node = { ...saved, fresh: false }; renderNode(true); log('מוצג המיקום האחרון שנשמר בדפדפן'); }
  } catch { /* storage unavailable */ }
  startGeolocation();
  startCompass();
  setInterval(updateNav, 1000);
  if (new URLSearchParams(location.search).has('demo')) connect(DemoLink);
  else autoConnect();
}

init();
