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
    this.state = { adaptive: false, dbm: 22, profile: 0, ble: false, fixAt: Date.now() - 95000 };
  }
  later(ms, fn) { setTimeout(fn, ms); }
  link() {
    const j = () => Math.round((Math.random() - 0.5) * 16);
    this.emit({ ev: 'link', up_rssi: -112 + j(), up_snr: -3.5 + j() / 4, down_rssi: -110 + j(), down_snr: -2.75 + j() / 4, margin: 16.5, profile: this.state.profile });
    this.emit({ ev: 'flags', v: FLAG.HAS_FIX | FLAG.TIME_VALID | (this.state.ble ? FLAG.BLE_ON : 0) });
  }
  loc(fresh, avg = 1) {
    const now = Math.floor(Date.now() / 1000);
    const jitter = () => (Math.random() - 0.5) * 0.0004;
    if (fresh) this.state.fixAt = Date.now();
    this.emit({
      ev: 'loc', fresh, has_fix: true, job: 0, lat: this.base.lat + jitter(), lon: this.base.lon + jitter(), alt: 18.4,
      fix_unix: Math.floor(this.state.fixAt / 1000), now_unix: now, age: Math.floor((Date.now() - this.state.fixAt) / 1000),
      hdop: 1.1, pdop: 1.9, vdop: 1.6, speed: 0, course: 0, ttff: 4, search: 9, used: 8, view: 12, tracked: 9,
      cn0max: 42, cn0avg: 38, fix_type: 3, quality: 1, uptime: 3600, flags: 9, rssi: -110, snr: -2.75, avg,
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
      const settle = Number(line.split(' ')[2]) || 0;
      this.later(Math.min(3000 + settle * 100, 9000), () => { log('← GPS result pushed by node (demo)'); this.loc(true, settle + 1); });
    } else if (cmd === 'ble_on' || cmd === 'ble_off' || cmd === 'buzz') {
      if (cmd !== 'buzz') this.state.ble = cmd === 'ble_on';
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
nodeMarker.bindTooltip('I_M_Here', { permanent: true, direction: 'top', offset: [0, -10], className: 'pin-label' });
phoneMarker.bindTooltip('הפלאפון שלי', { permanent: true, direction: 'top', offset: [0, -10], className: 'pin-label' });

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
  const avg = S.node.avg > 1 ? ` · עודכן ${S.node.avg} פעמים` : '';
  $('fixAge').textContent = `המיקום נמדד לפני ${fmtDur(ageS)} · דיוק ~${accM < 10 ? accM.toFixed(1) : Math.round(accM)} מ׳${avg}`;
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
    $('bearing').textContent = `${compassName(b)} (${Math.round(b)}°) · החץ מצביע לכיוון ⁨I_M_Here⁩`;
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
    ['עדכונים בחיפוש', e.avg ? `${e.avg} (נשלח האחרון)` : '—'],
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
    rows.push(['קליטה ב-⁨Where R U?⁩', `RSSI ${lastLink.down_rssi} dBm · SNR ${lastLink.down_snr} dB`]);
    rows.push(['קליטה ב-⁨I_M_Here⁩', `RSSI ${lastLink.up_rssi} dBm · SNR ${lastLink.up_snr} dB`]);
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
const CMD_OF = { PING: 'ping', GET_LAST: 'get_last', GPS_FIX: 'gps_fix', BLE_ON: 'ble_on', BLE_OFF: 'ble_off', BUZZ: 'buzz' };
// Until Where R U? transmits (it may still be busy with a previous command); after that its own
// "sent" event gives the exact wait: worst-case answer time + ~2.8 s, then it reports failed.
const CMD_TIMEOUT_S = 30;
const BLE_SLACK_S = 2;      // event delivery over BLE
const RESULT_SHOW_MS = 10000;
const cmdState = {};       // cmd -> { pending, timer, reset }

function setBtnState(cmd, state) {
  const b = document.querySelector(`[data-cmd="${cmd}"]`);
  if (!b) return;
  b.classList.remove('pending', 'ok', 'fail', 'running');
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

// ================================================================ link quality
// Score 1-10 from the dB left above SF12/BW125 sensitivity (~-137 dBm). Below 0 dB SNR the packet
// RSSI is mostly noise, so the signal is RSSI + SNR there. 0 dB left -> 1, 36 dB or more -> 10.
const SENSITIVITY_DBM = -137;
function linkScore(rssi, snr) {
  const signal = snr < 0 ? rssi + snr : rssi;
  const margin = signal - SENSITIVITY_DBM;
  return Math.max(1, Math.min(10, Math.round(1 + margin / 4)));
}
const scoreColor = (s) => `hsl(${Math.round((s - 1) * 120 / 9)} 75% 42%)`;  // 1 red .. 10 green

function paintScore(el, s) {
  el.textContent = s ? `${s}/10` : '–';
  el.style.background = s ? scoreColor(s) : '';
  el.style.color = s ? '#fff' : '';
}

// no answer: neither side has a reading for this exchange
function clearQuality() {
  ['qUp', 'qDown'].forEach((id) => { $(id).textContent = '— אין תשובה'; });
  paintScore($('qUpScore'), null);
  paintScore($('qDownScore'), null);
}

function renderQuality(e) {
  $('qUp').innerHTML = `<b>${Math.round(e.up_rssi)} dBm</b><small>SNR ${e.up_snr.toFixed(1)} dB</small>`;
  $('qDown').innerHTML = `<b>${Math.round(e.down_rssi)} dBm</b><small>SNR ${e.down_snr.toFixed(1)} dB</small>`;
  paintScore($('qUpScore'), linkScore(e.up_rssi, e.up_snr));
  paintScore($('qDownScore'), linkScore(e.down_rssi, e.down_snr));
}

// ================================================================ continuous ping
// One ping at a time: the next one goes out as soon as the previous answered or timed out
// (Where R U? waits the worst-case answer time + ~2.8 s). Counters restart on every start.
const pingLoop = {
  running: false, sent: 0, got: 0, failed: 0, up: [], down: [], link: null, timer: null, done: null,
  start() {
    if (!S.link) { log('אין חיבור ל-⁨Where R U?⁩'); return; }
    Object.assign(this, { running: true, sent: 0, got: 0, failed: 0, up: [], down: [], link: null });
    $('btnPingLoop').classList.add('on');
    $('btnPingLoop').textContent = 'עצור ■';
    $('pingStats').hidden = false;
    $('rfTools').hidden = false;
    rf.recent = [];
    rf.raw = [];
    log('▶ פינג רצוף התחיל');
    this.render();
    this.loop();
  },
  stop(why = '') {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    this.result(false, true);
    $('btnPingLoop').classList.remove('on');
    $('btnPingLoop').textContent = 'פינג רצוף ▶';
    log(`■ פינג רצוף נעצר${why ? ` (${why})` : ''}: התקבלו ${this.got} מתוך ${this.sent}, נכשלו ${this.failed}`);
    this.render();
  },
  async loop() {
    while (this.running) {
      this.link = null;
      const answered = new Promise((res) => { this.done = res; });
      this.armWait(CMD_TIMEOUT_S * 1000 - BLE_SLACK_S * 1000);
      if (!this.running) break;
      if (!(await send('ping'))) { this.stop('השליחה ל-⁨Where R U?⁩ נכשלה'); break; }
      this.sent++;
      this.render();
      await answered;
      if (this.running) await new Promise((r) => { this.timer = setTimeout(r, 300); });
    }
  },
  armWait(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.result(false), ms + BLE_SLACK_S * 1000);
  },
  result(ok, quiet = false) {
    if (!this.done) return;
    clearTimeout(this.timer);
    if (!ok && !quiet) this.failed++;  // stopped mid-wait is not a failure
    if (ok) {
      this.got++;
      if (this.link) {
        this.up.push(linkScore(this.link.up_rssi, this.link.up_snr));
        this.down.push(linkScore(this.link.down_rssi, this.link.down_snr));
        rf.add(this.link);
      }
    }
    const d = this.done;
    this.done = null;
    if (!quiet) this.render();
    d(ok);
  },
  render() {
    // only failures lower it; the ping still waiting for its answer isn't counted yet (100% until a failure)
    const finished = this.sent - (this.done ? 1 : 0);
    const pct = `${finished ? Math.round((100 * (finished - this.failed)) / finished) : 100}%`;
    const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '–');
    const l = this.link;
    $('pingStats').innerHTML =
      `<div><b>נשלחו ${this.sent} · התקבלו ${this.got} · נכשלו ${this.failed}</b> (${pct})${this.done ? ' · ממתין לתשובה' : this.running ? ' · פועל' : ' · עצור'}</div>`
      + `<div>קליטה ב-⁨Where R U?⁩: ציון ממוצע ${avg(this.down)}${l ? ` · אחרון ${Math.round(l.down_rssi)} dBm` : ''}</div>`
      + `<div>קליטה ב-⁨I_M_Here⁩: ציון ממוצע ${avg(this.up)}${l ? ` · אחרון ${Math.round(l.up_rssi)} dBm` : ''}</div>`
      + rf.html();
  },
};

// ================================================================ distance from signal strength
// I_M_Here stays put and Where R U? moves with the phone, so every answered continuous ping is a
// sample "at this spot the signal was X". Log-distance model: rssi = P1m - 10 n log10(d).
// RSSI swings 5-10 dB on its own, so this gives a band and a trend, not metres.
const RF_N = 2.7;              // path-loss exponent, open ground with obstacles
const RF_P1M_DEFAULT = -40;    // dBm at ~1 m, until calibrated
const RF_SMOOTH = 3;           // average the last pings
const RF_TREND_WIN = 4;        // trend: mean of the last pings vs the ones before
const RF_TREND_DB = 4;         // change that counts as closer / farther
const RF_MAX_PHONE_ACC = 30;   // m, phone GPS samples worse than this are not used for the estimate
const RF_MIN_SPREAD = 30;      // m the samples must cover before estimating a location
const RF_SIGMA_DB = 6;         // RSSI noise, sizes the uncertainty circle
const RF_MIN_D = 15;           // m, the model can't resolve closer than this
const RF_MIN_SAMPLES = 8;
const RF_BANDS = [[20, 'פחות מ-20 מ׳'], [50, '20–50 מ׳'], [150, '50–150 מ׳'], [500, '150–500 מ׳'], [Infinity, 'מעל 500 מ׳']];

// signal power of a packet: below 0 dB SNR the packet RSSI is mostly noise
const rfSignal = (rssi, snr) => (snr < 0 ? rssi + snr : rssi);

// Where is a fixed transmitter, given RSSI samples at known points? Grid search; P1m is solved for
// each cell (least squares), so calibration doesn't matter here. Returns null until the samples
// pin it down (the likely area must not touch the search edge).
function estimateSource(samples, n = RF_N) {
  if (samples.length < RF_MIN_SAMPLES) return { spread: 0, few: true };
  const lat0 = samples[0].lat, lon0 = samples[0].lon;
  const kx = 111320 * Math.cos(rad(lat0)), ky = 110540;
  const pts = samples.map((s) => ({ x: (s.lon - lon0) * kx, y: (s.lat - lat0) * ky, r: s.rssi }));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pts.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
  const spread = Math.hypot(maxX - minX, maxY - minY);
  if (spread < RF_MIN_SPREAD) return { spread };
  const pad = Math.max(200, 2 * spread), N = 70;
  const x0 = (minX + maxX) / 2 - pad - (maxX - minX) / 2, y0 = (minY + maxY) / 2 - pad - (maxY - minY) / 2;
  const step = (2 * pad + Math.max(maxX - minX, maxY - minY)) / N;
  const cost = new Float64Array(N * N);
  let best = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const cx = x0 + i * step, cy = y0 + j * step;
      const L = pts.map((p) => -10 * n * Math.log10(Math.max(RF_MIN_D, Math.hypot(p.x - cx, p.y - cy))));
      const p1m = pts.reduce((a, p, k) => a + p.r - L[k], 0) / pts.length;
      // a single fluke reading must not pull the answer onto itself: cap each residual at 2 sigma
      const c = pts.reduce((a, p, k) => a + Math.min((p.r - p1m - L[k]) ** 2, (2 * RF_SIGMA_DB) ** 2), 0);
      cost[i * N + j] = c;
      if (c < cost[best]) best = i * N + j;
    }
  }
  // likely area: cells within ~1 sigma (2 parameters) of the best fit
  const lim = cost[best] + 2.3 * RF_SIGMA_DB ** 2;
  const bi = Math.floor(best / N), bj = best % N;
  let radius = 0, open = false;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (cost[i * N + j] > lim) continue;
      if (i === 0 || j === 0 || i === N - 1 || j === N - 1) open = true;
      radius = Math.max(radius, Math.hypot(i - bi, j - bj) * step);
    }
  }
  return {
    spread, open,
    lat: lat0 + (y0 + bj * step) / ky, lon: lon0 + (x0 + bi * step) / kx,
    radius: Math.max(10, radius + step / 2),
  };
}

const rf = {
  p1m: (() => { try { return Number(localStorage.getItem('rfP1m')) || RF_P1M_DEFAULT; } catch { return RF_P1M_DEFAULT; } })(),
  recent: [], raw: [], samples: [], est: null,
  layer: L.layerGroup().addTo(map),
  estCircle: L.circle([0, 0], { radius: 10, color: '#f97316', weight: 2, dashArray: '6 6', fillOpacity: 0.08 }),
  smooth() { return this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : null; },
  add(link) {
    const r = (rfSignal(link.up_rssi, link.up_snr) + rfSignal(link.down_rssi, link.down_snr)) / 2;
    this.recent.push(r);
    if (this.recent.length > RF_SMOOTH) this.recent.shift();
    this.raw.push(r);
    if (this.raw.length > 2 * RF_TREND_WIN) this.raw.shift();
    if (S.phone && S.phone.acc <= RF_MAX_PHONE_ACC) {
      const s = { lat: S.phone.lat, lon: S.phone.lon, rssi: r };
      this.samples.push(s);
      if (this.samples.length > 200) this.layer.removeLayer(this.samples.shift().dot);
      s.dot = L.circleMarker([s.lat, s.lon], { radius: 6, weight: 1, color: '#fff', fillOpacity: 0.9 })
        .bindTooltip(`${Math.round(r)} dBm`).addTo(this.layer);
      this.recolor();
      this.est = estimateSource(this.samples);
      this.drawEst();
    }
  },
  // dots colored relative to each other: weakest sample red, strongest green
  recolor() {
    const r = this.samples.map((s) => s.rssi);
    const lo = Math.min(...r), span = Math.max(6, Math.max(...r) - lo);
    this.samples.forEach((s) => s.dot.setStyle({ fillColor: scoreColor(1 + 9 * (s.rssi - lo) / span) }));
  },
  drawEst() {
    const e = this.est;
    if (e?.lat != null && !e.open) this.estCircle.setLatLng([e.lat, e.lon]).setRadius(e.radius).addTo(map);
    else this.estCircle.remove();
  },
  distBand() {
    const s = this.smooth();
    if (s == null) return null;
    const d = 10 ** ((this.p1m - s) / (10 * RF_N));
    return RF_BANDS.find(([max]) => d < max)[1];
  },
  trend() {
    const h = this.raw;
    if (h.length < 2 * RF_TREND_WIN) return null;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const diff = mean(h.slice(-RF_TREND_WIN)) - mean(h.slice(-2 * RF_TREND_WIN, -RF_TREND_WIN));
    return diff >= RF_TREND_DB ? ['up', 'מתקרב ⬆'] : diff <= -RF_TREND_DB ? ['down', 'מתרחק ⬇'] : ['', 'בערך באותו מרחק'];
  },
  html() {
    const band = this.distBand();
    if (!band) return '';
    const t = this.trend();
    let out = `<div>📏 מרחק משוער: <b>${band}</b> <span class="muted">(שערוך גס לפי עוצמת אות)</span></div>`;
    if (t) out += `<div>מגמה: <span class="rf-trend ${t[0]}">${t[1]}</span></div>`;
    const e = this.est;
    if (!S.phone) out += '<div class="muted">📍 אין מיקום לטלפון, אין שערוך מיקום על המפה</div>';
    else if (e?.few) out += `<div class="muted">📍 שערוך מיקום אחרי ${RF_MIN_SAMPLES} דגימות עם מיקום טלפון (יש ${this.samples.length})</div>`;
    else if (!e || e.lat == null) out += `<div class="muted">📍 לשערוך מיקום: להסתובב באזור (עד עכשיו ${Math.round(e?.spread || 0)} מתוך ${RF_MIN_SPREAD} מ׳)</div>`;
    else if (e.open) out += '<div class="muted">📍 עוד לא מספיק: ללכת גם בכיוונים אחרים</div>';
    else {
      const ph = { lat: S.phone.lat, lon: S.phone.lon };
      out += `<div>📍 שערוך מיקום: ${fmtDist(distanceM(ph, e))} ${compassName(bearingDeg(ph, e))}, ±${fmtDist(e.radius)}</div>`;
    }
    return out;
  },
  calibrate() {
    const s = this.smooth();
    if (s == null) { log('לכיול: להפעיל פינג רצוף ולעמוד ליד ⁨I_M_Here⁩'); return; }
    this.p1m = Math.round(s);
    try { localStorage.setItem('rfP1m', String(this.p1m)); } catch { /* storage unavailable */ }
    log(`כויל: ${this.p1m} dBm במרחק ~1 מ׳`);
    pingLoop.render();
  },
  clear() {
    this.samples = [];
    this.est = null;
    this.layer.clearLayers();
    this.estCircle.remove();
    log('דגימות האות נמחקו מהמפה');
    pingLoop.render();
  },
};

// Buzzer countdown: starts at the ACK (ImHere starts buzzing right after sending it)
const buzz = { endAt: 0, tick: null };
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function buzzLabel(text) {
  const b = document.querySelector('[data-cmd="buzz"]');
  if (!b) return;
  b.dataset.label ??= b.textContent;
  b.textContent = text ?? b.dataset.label;
}

function buzzCountdown(seconds) {
  const st = cmdState.buzz || (cmdState.buzz = {});
  clearTimeout(st.timer);
  clearTimeout(st.reset);
  st.pending = false;
  clearInterval(buzz.tick);
  buzz.endAt = Date.now() + seconds * 1000;
  setBtnState('buzz', 'running');
  const update = () => {
    const left = Math.ceil((buzz.endAt - Date.now()) / 1000);
    if (left > 0) { buzzLabel(`מצפצף… ${fmtClock(left)}`); return; }
    buzzStop();
    log('🔔 הצפצוף הסתיים');
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* not supported */ }
    cmdDone('buzz', true);
  };
  update();
  buzz.tick = setInterval(update, 500);
  log(`🔊 ⁨I_M_Here⁩ מצפצף ${seconds >= 60 ? fmtDur(seconds) : `${seconds} ש׳`}`);
}

function buzzStop() {
  clearInterval(buzz.tick);
  buzz.tick = null;
  buzzLabel(null);
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
      renderQuality(e);
      pingLoop.link = e;
      chip('chipNode', 'ok', `⁨I_M_Here⁩: עונה · ${new Date().toLocaleTimeString('he-IL', { hour12: false })}`);
      break;
    case 'flags': lastFlags = e.v; renderLink(); break;
    case 'sent':
      if (e.cmd === 'PING' && pingLoop.running) pingLoop.armWait(e.wait_ms);
      else if (CMD_OF[e.cmd]) cmdExtend(CMD_OF[e.cmd], e.wait_ms / 1000 + BLE_SLACK_S);
      break;
    case 'failed':
      chip('chipNode', 'bad', `⁨I_M_Here⁩: לא עונה (${e.cmd})`);
      clearQuality();
      if (e.cmd === 'PING' && pingLoop.running) pingLoop.result(false);
      else if (CMD_OF[e.cmd]) cmdDone(CMD_OF[e.cmd], false, '⁨I_M_Here⁩ לא ענה');
      break;
    case 'ack': {
      const win = Number($('gpsWindow').value);
      const extra = e.cmd === 'GPS_FIX' ? ` · מחפש עד ${e.param} ש׳${win ? `, אחרי המיקום הראשון מעדכן עוד ${win} ש׳` : ''}, התוצאה תגיע לבד`
        : e.cmd === 'BLE_ON' ? (e.param ? ` · BLE דולק ל-${e.param} דק׳` : ' · BLE דולק עד כיבוי')
        : e.cmd === 'BUZZ' ? (e.status === 0 ? (e.param ? ` · מצפצף ${e.param} ש׳` : ' · הצפצוף הופסק') : ' · אין זמזם מוגדר ב-⁨I_M_Here⁩') : '';
      log(`✓ ${e.cmd} ${e.status === 0 ? 'אושר' : 'נדחה'}${extra}`);
      // GPS check stays yellow until the search result is pushed
      if (e.cmd === 'GPS_FIX') { if (e.status === 0) cmdExtend('gps_fix', e.param + Number($('gpsWindow').value) + 60); else cmdDone('gps_fix', false, 'נדחה'); }
      else if (e.cmd === 'BUZZ' && e.status === 0) {
        if (e.param > 0) buzzCountdown(e.param);
        else { buzzStop(); cmdDone('buzz', true); }
      } else if (CMD_OF[e.cmd]) cmdDone(CMD_OF[e.cmd], e.status === 0, 'נדחה');
      break;
    }
    case 'pong':
      log(`✓ פינג: זמן פעולה ${fmtDur(e.uptime)}${e.ble_left ? `, BLE עוד ${fmtDur(e.ble_left)}` : ''}${e.batt_mv ? `, סוללה ${(e.batt_mv / 1000).toFixed(2)}V` : ''}`);
      lastFlags = e.flags; renderLink();
      if (pingLoop.running) pingLoop.result(true);
      else cmdDone('ping', true);
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
  chip('chipDongle', 'wait', '⁨Where R U?⁩: מתחבר…');
  try {
    await link.connect(onEvent, () => onClosed(link), (state) => onLinkState(link, state));
  } catch (err) {
    chip('chipDongle', 'off', '⁨Where R U?⁩: לא מחובר');
    const msg = err?.message || String(err);
    log(`החיבור נכשל: ${err?.name || ''} ${msg}`);
    // NotFoundError also covers "Bluetooth adapter not available"; only a closed chooser is silent
    if (!(err?.name === 'NotFoundError' && /cancel/i.test(msg))) showNotice(bleHint(err));
    return false;
  }
  S.link = link;
  hideNotice();
  chip('chipDongle', 'ok', `⁨Where R U?⁩: מחובר (${link.label})`);
  chip('chipNode', 'off', '⁨I_M_Here⁩: לא ידוע — לחץ פינג');
  setConnected(true);
  log(`מחובר ל-⁨Where R U?⁩ דרך ${link.label}`);
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
    pingLoop.stop('החיבור נפל');
    chip('chipDongle', 'wait', '⁨Where R U?⁩: החיבור נפל, מתחבר מחדש…');
    log('חיבור ה-BLE נפל — מנסה להתחבר מחדש');
  } else if (state === 'connected') {
    chip('chipDongle', 'ok', `⁨Where R U?⁩: מחובר (${link.label})`);
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
  log('מתחבר אוטומטית ל-⁨Where R U?⁩ שחובר קודם…');
  for (let i = 0; i < 3 && !S.link; i++) {
    if (await connect(BleLink, dev)) return;
    await sleep(2000);
  }
}

function onClosed(link) {
  if (S.link !== link) return;
  S.link = null;
  setConnected(false);
  chip('chipDongle', 'bad', '⁨Where R U?⁩: נותק');
  $('chipBusy').hidden = true;
  log('החיבור ל-⁨Where R U?⁩ נותק');
  failAllPending('החיבור ל-⁨Where R U?⁩ נותק');
  pingLoop.stop('החיבור נותק');
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
  $('btnDisconnect').onclick = () => { pingLoop.stop('נותק ידנית'); S.link?.disconnect(); };
  // leaving or reloading the page ends the loop (a reload always starts with it off)
  window.addEventListener('pagehide', () => pingLoop.stop());
  $('btnFit').onclick = fitBoth;
  $('btnMe').onclick = () => {
    S.following = !S.following;
    $('btnMe').style.outline = S.following ? '2px solid var(--accent)' : '';
    if (S.phone) map.panTo([S.phone.lat, S.phone.lon]);
  };

  document.querySelectorAll('[data-cmd]').forEach((b) => {
    b.onclick = async () => {
      const c = b.dataset.cmd;
      // yellow = still waiting for the answer: don't send the same command again
      if (cmdState[c]?.pending) { log('⏳ עדיין ממתין לתשובה, לא נשלח שוב'); return; }
      if (c === 'ping' && pingLoop.running) { log('פינג רצוף פועל, הפינג הבודד לא נשלח'); return; }
      if (c === 'buzz') buzzStop();  // a new press replaces a running countdown
      const settle = Number($('gpsWindow').value);
      cmdStart(c, c === 'gps_fix' ? Number($('gpsTimeout').value) + settle + 60 : CMD_TIMEOUT_S);
      const line = c === 'gps_fix' ? `gps_fix ${$('gpsTimeout').value} ${settle}`
        : c === 'ble_on' ? `ble_on ${$('bleMinutes').value}`
        : c === 'buzz' ? `buzz ${$('buzzSeconds').value}` : c;
      if (!(await send(line))) cmdDone(c, false, 'לא נשלח ל-⁨Where R U?⁩');
    };
  });
  $('power').onchange = (e) => send(`power ${e.target.value}`);
  $('btnPingLoop').onclick = () => (pingLoop.running ? pingLoop.stop() : pingLoop.start());
  $('btnCalib').onclick = () => rf.calibrate();
  $('btnRfClear').onclick = () => rf.clear();

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
