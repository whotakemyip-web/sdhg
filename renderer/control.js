/* =========================================================
   Центр управления: плитки (Wi-Fi, Bluetooth, «не беспокоить», «не засыпать»,
   тема, скриншот), ползунки яркости и громкости, «сейчас играет», CPU/RAM со
   спарклайном, быстрые действия и «живая» капсула.
   Использует глобальные функции/переменные из app.js (api, flashStatus, applyMode …).
   ========================================================= */

const ccStatus = document.getElementById('ccStatus');
const qaStatus = document.getElementById('qaStatus');
const mediaStatus = document.getElementById('mediaStatus');

/* ---------- Системная статистика + спарклайн ---------- */
const HISTORY_LEN = 30;
const cpuHistory = [];
const memHistory = [];

function pushHistory(arr, v) {
  arr.push(v);
  if (arr.length > HISTORY_LEN) arr.shift();
}

function sparkPoints(arr) {
  if (arr.length < 2) return '';
  const step = 120 / (HISTORY_LEN - 1);
  const offset = (HISTORY_LEN - arr.length) * step;
  return arr.map((v, i) => `${(offset + i * step).toFixed(1)},${(30 - (Math.max(0, Math.min(100, v)) / 100) * 28).toFixed(1)}`).join(' ');
}

function setBar(id, pct) {
  document.getElementById(id).style.setProperty('--w', `${Math.max(0, Math.min(100, pct))}%`);
}

api.onStats((data) => {
  document.getElementById('cpuMini').textContent = `CPU ${data.cpu}%`;
  document.getElementById('cpuVal').textContent = `${data.cpu}%`;
  document.getElementById('memVal').textContent = `${data.mem}%`;
  setBar('barCpu', data.cpu);
  setBar('barMem', data.mem);

  pushHistory(cpuHistory, data.cpu);
  pushHistory(memHistory, data.mem);
  document.getElementById('sparkCpu').setAttribute('points', sparkPoints(cpuHistory));
  document.getElementById('sparkMem').setAttribute('points', sparkPoints(memHistory));

  document.getElementById('memDetail').textContent = `ОЗУ ${data.memUsedGB} / ${data.memTotalGB} ГБ`;
  const h = Math.floor(data.uptimeMin / 60);
  const m = data.uptimeMin % 60;
  document.getElementById('uptimeVal').textContent = `⏳ ${h ? `${h} ч ` : ''}${m} мин`;
  document.getElementById('hostVal').textContent = `💻 ${data.hostname}`;
});

/* ---------- Батарея (если есть) ---------- */
const batteryVal = document.getElementById('batteryVal');
if (navigator.getBattery) {
  navigator.getBattery().then((battery) => {
    const update = () => {
      batteryVal.textContent = `🔋 ${Math.round(battery.level * 100)}%${battery.charging ? ' ⚡' : ''}`;
    };
    update();
    battery.addEventListener('levelchange', update);
    battery.addEventListener('chargingchange', update);
  });
} else {
  batteryVal.textContent = '🔌 без батареи';
}

/* ---------- Плитки ---------- */
const tileWifi = document.getElementById('tileWifi');
const tileBt = document.getElementById('tileBt');
const tileDnd = document.getElementById('tileDnd');
const tileAwake = document.getElementById('tileAwake');
const tileDark = document.getElementById('tileDark');
const wifiIfnameInput = document.getElementById('wifiIfname');
const wifiStatus = document.getElementById('wifiStatus');

function setTile(tile, subId, state, onText, offText) {
  tile.classList.toggle('unknown', state === null);
  tile.setAttribute('aria-pressed', String(state === true));
  document.getElementById(subId).textContent = state === null ? 'нет данных' : (state ? onText : offText);
}
const tileOn = (tile) => tile.getAttribute('aria-pressed') === 'true';

async function toggleTile(tile, subId, onText, offText, action, busyText = 'ожидание…') {
  if (tile.classList.contains('busy')) return;
  const prev = tileOn(tile);
  const next = !prev;
  const sub = document.getElementById(subId);
  tile.classList.add('busy');
  sub.textContent = busyText;
  let res;
  try { res = await action(next); } catch (_) { res = { success: false, message: 'Ошибка' }; }
  tile.classList.remove('busy');
  if (res && res.success) {
    setTile(tile, subId, next, onText, offText);
  } else {
    setTile(tile, subId, prev, onText, offText);
    flashStatus(ccStatus, false, (res && res.message) || 'Не удалось выполнить');
  }
  return res;
}

tileWifi.addEventListener('click', async () => {
  const res = await toggleTile(tileWifi, 'tileWifiSub', 'вкл', 'выкл',
    (enable) => api.toggleWifi({ enable, ifname: wifiIfnameInput.value.trim() || 'Wi-Fi' }), 'запрос прав…');
  if (res && res.success) setTimeout(() => refreshSystemState(), 2500);
});
tileBt.addEventListener('click', async () => {
  const res = await toggleTile(tileBt, 'tileBtSub', 'вкл', 'выкл',
    (enable) => api.toggleBluetooth({ enable }), 'запрос прав…');
  if (res && res.success) setTimeout(() => refreshSystemState(), 2500);
});
tileDnd.addEventListener('click', () => toggleTile(tileDnd, 'tileDndSub', 'вкл', 'выкл', (enable) => api.setDnd(enable)));
tileAwake.addEventListener('click', () => toggleTile(tileAwake, 'tileAwakeSub', 'экран не гаснет', 'выкл', (enable) => api.setKeepAwake(enable)));
tileDark.addEventListener('click', () => applyMode(currentResolvedMode() === 'dark' ? 'light' : 'dark', { syncWindows: true }));
document.getElementById('tileShot').addEventListener('click', async () => {
  const res = await api.captureScreenshot();
  flashStatus(ccStatus, res.success, res.success ? 'Скриншот в буфере обмена и в Изображения/DynamicIslandMD3' : `Ошибка: ${res.message}`);
});

document.addEventListener('island:mode', (e) => {
  const dark = e.detail === 'dark';
  tileDark.setAttribute('aria-pressed', String(dark));
  document.getElementById('tileDarkSub').textContent = modeChoice === 'system' ? 'авто' : (dark ? 'вкл' : 'выкл');
});

/* Имя адаптера Wi-Fi (раздел «Система» настроек) */
api.getSetting('wifiIfname').then((v) => { wifiIfnameInput.value = v || 'Wi-Fi'; });
wifiIfnameInput.addEventListener('change', async () => {
  const res = await api.setSetting('wifiIfname', wifiIfnameInput.value.trim() || 'Wi-Fi');
  if (!res || !res.success) flashStatus(wifiStatus, false, (res && res.message) || 'Не удалось сохранить имя адаптера');
});

/* ---------- Ползунки: громкость и яркость ---------- */
const volumeRange = document.getElementById('volumeRange');
const volumeVal = document.getElementById('volumeVal');
const volMuteBtn = document.getElementById('volMuteBtn');
const brightnessRange = document.getElementById('brightnessRange');
const brightnessVal = document.getElementById('brightnessVal');
const brightnessCard = document.getElementById('brightnessCard');
const volumeCard = document.getElementById('volumeCard');

let volMuted = false;
const dragging = { volume: false, brightness: false };

/* «Последнее значение побеждает»: пока идёт запрос, новые значения копятся в одну ячейку. */
function makeCommitter(send) {
  let inflight = false;
  let pending = null;
  return async function commit(value) {
    pending = value;
    if (inflight) return;
    inflight = true;
    try {
      while (pending !== null) {
        const v = pending;
        pending = null;
        await send(v);
      }
    } finally {
      inflight = false;
    }
  };
}

function volumeIcon(level, muted) {
  if (muted || level === 0) return '🔇';
  return level < 35 ? '🔈' : level < 70 ? '🔉' : '🔊';
}

function setVolumeUi(level, muted) {
  volMuted = muted;
  if (!dragging.volume) {
    volumeRange.value = String(level);
    syncRangeFill(volumeRange);
    volumeVal.textContent = `${level}%`;
  }
  volMuteBtn.textContent = volumeIcon(level, muted);
  volumeCard.classList.remove('unsupported');
  volumeRange.disabled = false;
}

function setVolumeUnavailable(message) {
  volumeVal.textContent = '—';
  volumeCard.classList.add('unsupported');
  volumeRange.disabled = true;
  if (message) flashStatus(ccStatus, false, `Громкость: ${message}`);
}

const commitVolume = makeCommitter(async (level) => {
  const res = await api.audio({ op: 'volume', level });
  if (res.success) setVolumeUi(res.volume, res.muted);
  else flashStatus(ccStatus, false, `Громкость: ${res.message}`);
});

let volTimer = null;
volumeRange.addEventListener('input', () => {
  const v = Number(volumeRange.value);
  volumeVal.textContent = `${v}%`;
  volMuteBtn.textContent = volumeIcon(v, volMuted);
  clearTimeout(volTimer);
  volTimer = setTimeout(() => commitVolume(v), 300);
});
volumeRange.addEventListener('change', () => { clearTimeout(volTimer); commitVolume(Number(volumeRange.value)); });
volumeRange.addEventListener('pointerdown', () => { dragging.volume = true; });
window.addEventListener('pointerup', () => { dragging.volume = false; dragging.brightness = false; });

volMuteBtn.addEventListener('click', async () => {
  const res = await api.audio({ op: 'mute', muted: !volMuted });
  if (res.success) setVolumeUi(res.volume, res.muted);
  else flashStatus(ccStatus, false, `Звук: ${res.message}`);
});

function setBrightnessUi(level) {
  if (!dragging.brightness) {
    brightnessRange.value = String(level);
    syncRangeFill(brightnessRange);
    brightnessVal.textContent = `${level}%`;
  }
  brightnessCard.classList.remove('unsupported');
  brightnessRange.disabled = false;
}

function setBrightnessUnavailable() {
  brightnessVal.textContent = 'нет';
  brightnessCard.classList.add('unsupported');
  brightnessRange.disabled = true;
  brightnessCard.title = 'Яркость доступна только для встроенных экранов (ноутбуки, моноблоки)';
}

const commitBrightness = makeCommitter(async (level) => {
  const res = await api.brightness({ op: 'set', level });
  if (res.success) setBrightnessUi(res.level);
  else if (res.unsupported) setBrightnessUnavailable();
  else flashStatus(ccStatus, false, `Яркость: ${res.message}`);
});

let brTimer = null;
brightnessRange.addEventListener('input', () => {
  const v = Number(brightnessRange.value);
  brightnessVal.textContent = `${v}%`;
  clearTimeout(brTimer);
  brTimer = setTimeout(() => commitBrightness(v), 300);
});
brightnessRange.addEventListener('change', () => { clearTimeout(brTimer); commitBrightness(Number(brightnessRange.value)); });
brightnessRange.addEventListener('pointerdown', () => { dragging.brightness = true; });

/* ---------- Обновление состояния при открытии ---------- */
let lastRefresh = 0;
let refreshing = false;

async function refreshSystemState() {
  const st = await api.getSystemState();
  if (!st || !st.success) return;
  setTile(tileWifi, 'tileWifiSub', st.wifi, 'вкл', 'выкл');
  setTile(tileBt, 'tileBtSub', st.bluetooth, 'вкл', 'выкл');
  setTile(tileDnd, 'tileDndSub', st.dnd, 'вкл', 'выкл');
  setTile(tileAwake, 'tileAwakeSub', st.keepAwake, 'экран не гаснет', 'выкл');
}

async function refreshControlCenter(force) {
  if (refreshing || (!force && Date.now() - lastRefresh < 5000)) return;
  refreshing = true;
  lastRefresh = Date.now();
  try {
    await Promise.all([
      refreshSystemState(),
      api.audio({ op: 'get' }).then((r) => (r.success ? setVolumeUi(r.volume, r.muted) : setVolumeUnavailable(r.message))),
      api.brightness({ op: 'get' }).then((r) => {
        if (r.success) setBrightnessUi(r.level);
        else setBrightnessUnavailable();
      })
    ]);
  } finally {
    refreshing = false;
  }
}

document.addEventListener('island:expanded', (e) => { if (e.detail) refreshControlCenter(false); });
document.addEventListener('island:tab', (e) => { if (e.detail === 'center') refreshControlCenter(false); });

/* ---------- «Сейчас играет» ---------- */
const mediaArt = { img: document.getElementById('mediaImg'), glyph: document.getElementById('mediaGlyph') };
const mediaTitle = document.getElementById('mediaTitle');
const mediaSub = document.getElementById('mediaSub');
const mediaProgFill = document.getElementById('mediaProgFill');
const mediaPosEl = document.getElementById('mediaPos');
const mediaDurEl = document.getElementById('mediaDur');
const mkPlay = document.getElementById('mkPlay');

const ART_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif'];
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const media = { s: null, recvTs: 0 };
let nowPlayingEnabled = true;
let pillLive = true;

function setArt(art, mime) {
  if (typeof art === 'string' && art.length < 600000 && ART_MIMES.includes(mime) && B64_RE.test(art)) {
    mediaArt.img.src = `data:${mime};base64,${art}`;
    mediaArt.img.classList.remove('hidden');
    mediaArt.glyph.classList.add('hidden');
  } else {
    mediaArt.img.removeAttribute('src');
    mediaArt.img.classList.add('hidden');
    mediaArt.glyph.classList.remove('hidden');
  }
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function mediaHasTrack() {
  const s = media.s;
  return !!(s && s.active && (s.title || s.artist));
}

function renderMedia() {
  const s = media.s;
  if (!nowPlayingEnabled) {
    mediaTitle.textContent = '«Сейчас играет» выключено';
    mediaSub.textContent = 'Включи в Настройки → Остров';
  } else if (!mediaHasTrack()) {
    mediaTitle.textContent = 'Ничего не играет';
    mediaSub.textContent = s && s.failed
      ? 'Не удалось подключиться к системному плееру (нужна Windows 10 1809+)'
      : 'Запусти музыку или видео — название появится здесь';
  } else {
    mediaTitle.textContent = s.title || 'Без названия';
    mediaSub.textContent = [s.artist, s.album].filter(Boolean).join(' · ') || s.app || '';
  }
  mkPlay.textContent = media.s && media.s.active && media.s.status === 'Playing' ? '⏸' : '▶';
  updateMediaProgress();
}

function updateMediaProgress() {
  const s = media.s;
  if (!mediaHasTrack() || !s.dur) {
    mediaProgFill.style.setProperty('--w', '0%');
    mediaPosEl.textContent = '0:00';
    mediaDurEl.textContent = s && s.dur ? fmtTime(s.dur) : '0:00';
    return;
  }
  let pos = s.pos;
  if (s.status === 'Playing') pos += (Date.now() - media.recvTs) / 1000;
  pos = Math.min(pos, s.dur);
  mediaProgFill.style.setProperty('--w', `${(pos / s.dur) * 100}%`);
  mediaPosEl.textContent = fmtTime(pos);
  mediaDurEl.textContent = fmtTime(s.dur);
}
setInterval(() => { if (expanded) updateMediaProgress(); }, 500);

function onMedia(s) {
  if (!s || typeof s !== 'object') return;
  if (s.artChanged) setArt(s.art, s.mime);
  media.s = s;
  media.recvTs = Date.now();
  renderMedia();
  renderPill();
}
api.getNowPlaying().then(onMedia);
api.onMediaUpdate(onMedia);

function wireMediaKey(btnId, action, label) {
  document.getElementById(btnId).addEventListener('click', async () => {
    const res = await api.mediaKey(action);
    if (!res.success) flashStatus(mediaStatus, false, `${label}: ошибка`);
  });
}
wireMediaKey('mkPlay', 'playpause', 'Play/Pause');
wireMediaKey('mkNext', 'next', 'Следующий трек');
wireMediaKey('mkPrev', 'prev', 'Предыдущий трек');

/* ---------- Быстрые действия и инструменты ---------- */
document.getElementById('qaLock').addEventListener('click', () => api.lockPc());
document.getElementById('qaSleep').addEventListener('click', () => api.sleepPc());
document.getElementById('qaNotify').addEventListener('click', async () => {
  const res = await api.sendNotification({ title: 'DynamicIsland MD3', body: 'Тестовое нативное уведомление Windows 🌸' });
  flashStatus(qaStatus, res.success, res.success ? 'Уведомление отправлено' : 'Не удалось отправить');
});
document.querySelectorAll('[data-tool]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const res = await api.openTool(btn.dataset.tool);
    if (!res.success) flashStatus(qaStatus, false, res.message || 'Не удалось открыть');
  });
});

/* ---------- Живая капсула: таймер > музыка > часы ---------- */
const pillSlots = {
  default: document.getElementById('pillDefault'),
  media: document.getElementById('pillMedia'),
  timer: document.getElementById('pillTimer')
};

function renderPill() {
  let mode = 'default';
  if (pillLive && focusState.running) mode = 'timer';
  else if (pillLive && nowPlayingEnabled && mediaHasTrack() && media.s.status === 'Playing') mode = 'media';

  Object.entries(pillSlots).forEach(([name, el]) => el.classList.toggle('hidden', name !== mode));

  if (mode === 'timer') {
    document.getElementById('pillTimerText').textContent =
      `${pad(Math.floor(focusState.seconds / 60))}:${pad(focusState.seconds % 60)}`;
  } else if (mode === 'media') {
    const s = media.s;
    document.getElementById('pillMediaText').textContent = s.artist ? `${s.artist} — ${s.title}` : s.title;
  }
}

document.addEventListener('island:focus', renderPill);
document.addEventListener('island:setting', (e) => {
  const { key, value } = e.detail;
  if (key === 'pillLive') { pillLive = value; renderPill(); }
  if (key === 'nowPlaying') {
    nowPlayingEnabled = value;
    if (!value) { media.s = null; setArt(null, null); }
    renderMedia();
    renderPill();
  }
});

renderMedia();
renderPill();
