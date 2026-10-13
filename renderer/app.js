/* =========================================================
   Ядро интерфейса: раскрытие острова, перетаскивание, вкладки,
   оформление (Flower / Classic, палитры, Monet, режим), настройки,
   задачи, лаунчер, буфер обмена, заметки, фокус-таймер.
   Центр управления, медиа и «живая» капсула — в control.js.
   Скрипт один из двух классических <script>; общие функции доступны control.js.
   ========================================================= */

const islandEl = document.getElementById('island');
const pillView = document.getElementById('pillView');
const body = document.body;
const api = window.islandAPI;

function pad(n) { return String(n).padStart(2, '0'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function flashStatus(el, ok, text) {
  if (!el) return;
  el.textContent = text;
  el.className = 'status-line ' + (ok ? 'ok' : 'err');
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => { el.textContent = ''; el.className = 'status-line'; }, 3200);
}

/* Заполнение ползунков (CSS-переменная --fill, без inline-стилей) */
function syncRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${pct}%`);
}
document.querySelectorAll('.md-range').forEach((r) => {
  syncRangeFill(r);
  r.addEventListener('input', () => syncRangeFill(r));
});

/* ---------- Раскрытие / сворачивание ----------
   Классы переключаются сразу (мгновенный отклик), а окно подтягивается к желаемому
   состоянию: если анимация ещё идёт, main отвечает «занято» — повторяем. */
let expanded = false;
let syncing = false;

async function setExpanded(value) {
  if (value === expanded && !syncing) return;
  expanded = value;
  islandEl.classList.toggle('expanded', value);
  islandEl.classList.toggle('collapsed', !value);
  document.dispatchEvent(new CustomEvent('island:expanded', { detail: value }));
  if (value) requestAnimationFrame(moveTabIndicator);

  if (syncing) return;
  syncing = true;
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const want = expanded;
      const res = await api.expand(want);
      if (res && res.success !== false && want === expanded) break;
      await sleep(120);
    }
  } finally {
    syncing = false;
  }
}

/* ---------- Перетаскивание окна (pointer-события) ----------
   Клик без движения = «тап» (раскрыть); движение дальше порога = перетаскивание.
   Позиция сохраняется в main-процессе по окончании перетаскивания. */
const DRAG_THRESHOLD_PX = 4;

function attachDrag(el, { onTap } = {}) {
  let state = null;
  let rafId = 0;
  let pending = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, textarea, select, a')) return;
    el.setPointerCapture(e.pointerId);
    state = { id: e.pointerId, sx: e.screenX, sy: e.screenY, moved: false };
  });

  el.addEventListener('pointermove', (e) => {
    if (!state || e.pointerId !== state.id) return;
    const dx = e.screenX - state.sx;
    const dy = e.screenY - state.sy;
    if (!state.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      state.moved = true;
      el.classList.add('dragging');
      api.dragStart();
    }
    pending = { dx, dy };
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (pending) api.dragMove(pending.dx, pending.dy);
      });
    }
  });

  function finish(e) {
    if (!state || e.pointerId !== state.id) return;
    const wasMoved = state.moved;
    state = null;
    el.classList.remove('dragging');
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (wasMoved) {
      if (pending) api.dragMove(pending.dx, pending.dy);
      pending = null;
      api.dragEnd();
    } else if (e.type === 'pointerup' && onTap) {
      onTap();
    }
  }
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

attachDrag(pillView, { onTap: () => setExpanded(true) });
pillView.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(true); }
});
document.querySelectorAll('.exp-header').forEach((h) => attachDrag(h));

document.getElementById('collapseBtn').addEventListener('click', () => setExpanded(false));
api.onCollapseRequest(() => setExpanded(false));
api.onToggleRequest(() => setExpanded(!expanded));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && expanded) setExpanded(false); });

document.getElementById('quitBtn').addEventListener('click', () => api.closeApp());

/* ---------- Часы ---------- */
function tickClock() {
  const d = new Date();
  document.getElementById('clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  document.getElementById('bigClock').textContent =
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  document.getElementById('dateLine').textContent =
    `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
}
tickClock();
setInterval(tickClock, 1000);

/* ---------- Вкладки со скользящим индикатором ---------- */
const tabsEl = document.getElementById('tabs');
const tabIndicator = document.getElementById('tabIndicator');

function moveTabIndicator() {
  const active = tabsEl.querySelector('.tab-btn.active');
  if (!active) return;
  tabIndicator.style.setProperty('--ind-x', `${active.offsetLeft}px`);
  tabIndicator.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function selectTab(tab) {
  tabsEl.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  moveTabIndicator();
  document.dispatchEvent(new CustomEvent('island:tab', { detail: tab }));
}
tabsEl.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => selectTab(btn.dataset.tab)));
window.addEventListener('resize', moveTabIndicator);
requestAnimationFrame(moveTabIndicator);

/* ---------- Подвкладки настроек (внутри острова) ---------- */
const settingsSeg = document.getElementById('settingsSeg');
settingsSeg.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    settingsSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.sub-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.sub !== btn.dataset.sub));
  });
});

/* ---------- Универсальный тумблер настройки ---------- */
async function bindSettingToggle(input, key, { defaultValue = false, onChange } = {}) {
  const stored = await api.getSetting(key);
  input.checked = typeof stored === 'boolean' ? stored : defaultValue;
  input.addEventListener('change', async () => {
    const res = await api.setSetting(key, input.checked);
    if (res && res.success === false) input.checked = !input.checked;
    document.dispatchEvent(new CustomEvent('island:setting', { detail: { key, value: input.checked } }));
    if (onChange) onChange(input.checked);
  });
  document.dispatchEvent(new CustomEvent('island:setting', { detail: { key, value: input.checked } }));
}

/* ---------- Задачи ---------- */
const todoInput = document.getElementById('todoInput');
const todoList = document.getElementById('todoList');
let todos = [];

function renderTodos() {
  todoList.replaceChildren();
  if (!todos.length) {
    const empty = document.createElement('li');
    empty.className = 'clip-empty';
    empty.textContent = 'Пока пусто — добавь первую задачу ✿';
    todoList.appendChild(empty);
    return;
  }
  todos.forEach((t, idx) => {
    const li = document.createElement('li');
    li.className = 'todo-item' + (t.done ? ' done' : '');

    const label = document.createElement('label');
    label.className = 'todo-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!t.done;
    cb.dataset.idx = String(idx);
    cb.className = 'todo-checkbox';
    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = t.text;
    label.append(cb, text);

    const rm = document.createElement('button');
    rm.className = 'todo-remove';
    rm.dataset.idx = String(idx);
    rm.title = 'Удалить';
    rm.textContent = '✕';

    li.append(label, rm);
    todoList.appendChild(li);
  });
}

function saveTodos() { api.setSetting('todos', todos); }

todoList.addEventListener('click', (e) => {
  const idx = e.target.dataset.idx;
  if (idx === undefined) return;
  if (e.target.classList.contains('todo-checkbox')) {
    todos[idx].done = e.target.checked;
    saveTodos();
    renderTodos();
  } else if (e.target.classList.contains('todo-remove')) {
    todos.splice(idx, 1);
    saveTodos();
    renderTodos();
  }
});

function addTodo() {
  const text = todoInput.value.trim();
  if (!text) return;
  todos.push({ text, done: false });
  todoInput.value = '';
  saveTodos();
  renderTodos();
}
document.getElementById('todoAddBtn').addEventListener('click', addTodo);
todoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodo(); });
api.getSetting('todos').then((v) => { todos = v || []; renderTodos(); });

/* ---------- Лаунчер приложений ---------- */
const launcherGrid = document.getElementById('launcherGrid');
const launcherStatus = document.getElementById('launcherStatus');
let launcherApps = [];

function renderLauncher() {
  launcherGrid.replaceChildren();
  if (!launcherApps.length) {
    const empty = document.createElement('div');
    empty.className = 'launcher-empty';
    empty.textContent = 'Нет закреплённых приложений — добавь первое кнопкой ниже';
    launcherGrid.appendChild(empty);
    return;
  }
  launcherApps.forEach((appItem, idx) => {
    const tile = document.createElement('div');
    tile.className = 'launcher-tile';

    const open = document.createElement('button');
    open.className = 'launcher-open';
    open.dataset.idx = String(idx);
    open.title = appItem.path;
    const icon = document.createElement('span');
    icon.textContent = '🚀';
    const label = document.createElement('span');
    label.textContent = appItem.name;
    open.append(icon, label);

    const rm = document.createElement('button');
    rm.className = 'launcher-remove';
    rm.dataset.idx = String(idx);
    rm.title = 'Убрать';
    rm.textContent = '✕';

    tile.append(open, rm);
    launcherGrid.appendChild(tile);
  });
}

function saveLauncherApps() { api.setSetting('launcherApps', launcherApps); }

launcherGrid.addEventListener('click', async (e) => {
  const openBtn = e.target.closest('.launcher-open');
  const removeBtn = e.target.closest('.launcher-remove');
  if (openBtn) {
    const idx = openBtn.dataset.idx;
    const res = await api.openLauncherApp(launcherApps[idx].path);
    flashStatus(launcherStatus, res.success, res.success ? `Запущено: ${launcherApps[idx].name}` : res.message);
  } else if (removeBtn) {
    launcherApps.splice(removeBtn.dataset.idx, 1);
    saveLauncherApps();
    renderLauncher();
  }
});

document.getElementById('launcherAddBtn').addEventListener('click', async () => {
  const picked = await api.pickLauncherFile();
  if (!picked) return;
  launcherApps.push(picked);
  saveLauncherApps();
  renderLauncher();
});
api.getSetting('launcherApps').then((v) => { launcherApps = v || []; renderLauncher(); });

/* ---------- История буфера обмена ----------
   Выключена по умолчанию. Включение подтверждается нативным диалогом в main-процессе. */
const clipList = document.getElementById('clipList');
const clipOff = document.getElementById('clipOff');
const clipOn = document.getElementById('clipOn');
const clipStatus = document.getElementById('clipStatus');
const clipPauseToggle = document.getElementById('clipPauseToggle');
const clipPersistToggle = document.getElementById('clipPersistToggle');
const clipTtlSelect = document.getElementById('clipTtlSelect');

function formatAge(ts) {
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (min < 1) return 'сейчас';
  if (min < 60) return `${min} мин`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} ч` : `${Math.round(h / 24)} д`;
}

function renderClipboard(state) {
  if (!state) return;
  clipOff.classList.toggle('hidden', state.enabled);
  clipOn.classList.toggle('hidden', !state.enabled);
  if (!state.enabled) { clipList.replaceChildren(); return; }

  clipPauseToggle.checked = !!state.paused;
  clipTtlSelect.value = String(state.ttlMin);
  clipPersistToggle.checked = !!state.persist;
  clipPersistToggle.disabled = !state.persistAvailable;

  clipList.replaceChildren();
  if (!state.items.length) {
    const empty = document.createElement('li');
    empty.className = 'clip-empty';
    empty.textContent = state.paused ? 'Запись на паузе' : 'Пока пусто — скопируй что-нибудь (Ctrl+C)';
    clipList.appendChild(empty);
    return;
  }
  state.items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'clip-item';
    const span = document.createElement('span');
    span.className = 'clip-text';
    span.textContent = item.length > item.preview.length ? item.preview + '…' : item.preview;
    const meta = document.createElement('span');
    meta.className = 'clip-meta';
    meta.textContent = formatAge(item.ts);
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.textContent = '↩';
    btn.title = 'Вернуть в буфер обмена';
    btn.addEventListener('click', async () => {
      const res = await api.restoreClipboard(item.id);
      flashStatus(clipStatus, res.success, res.success ? 'Возвращено в буфер обмена' : res.message);
    });
    li.append(span, meta, btn);
    clipList.appendChild(li);
  });
}

async function updateClipboardConfig(patch) {
  const res = await api.setClipboardConfig(patch);
  if (res.state) renderClipboard(res.state);
  if (!res.success && res.message && res.message !== 'Отменено') flashStatus(clipStatus, false, res.message);
  return res;
}

document.getElementById('clipEnableBtn').addEventListener('click', () => updateClipboardConfig({ enabled: true }));
document.getElementById('clipDisableBtn').addEventListener('click', () => updateClipboardConfig({ enabled: false }));
clipPauseToggle.addEventListener('change', () => updateClipboardConfig({ paused: clipPauseToggle.checked }));
clipPersistToggle.addEventListener('change', () => updateClipboardConfig({ persist: clipPersistToggle.checked }));
clipTtlSelect.addEventListener('change', () => updateClipboardConfig({ ttlMin: Number(clipTtlSelect.value) }));
document.getElementById('clipClearBtn').addEventListener('click', async () => {
  const res = await api.clearClipboardHistory();
  if (res.state) renderClipboard(res.state);
});
api.getClipboardState().then(renderClipboard);
api.onClipboardUpdate(renderClipboard);

/* ---------- Заметки ---------- */
const notesArea = document.getElementById('notesArea');
api.getSetting('notes').then((v) => { notesArea.value = v || ''; });
document.getElementById('saveNoteBtn').addEventListener('click', () => {
  api.setSetting('notes', notesArea.value);
  const btn = document.getElementById('saveNoteBtn');
  const old = btn.textContent;
  btn.textContent = 'Сохранено ✓';
  setTimeout(() => (btn.textContent = old), 1200);
});

/* ---------- Фокус-таймер ----------
   Состояние отдаётся control.js событием island:focus — для «живой» капсулы. */
const focusState = { minutes: 25, seconds: 25 * 60, running: false };
let focusInterval = null;
const focusTimeEl = document.getElementById('focusTime');
const focusStartBtn = document.getElementById('focusStart');
const focusPresets = document.getElementById('focusPresets');

function renderFocus() {
  focusTimeEl.textContent = `${pad(Math.floor(focusState.seconds / 60))}:${pad(focusState.seconds % 60)}`;
  document.dispatchEvent(new CustomEvent('island:focus', { detail: { ...focusState } }));
}

function markPreset() {
  focusPresets.querySelectorAll('.chip-btn').forEach((b) =>
    b.classList.toggle('selected', Number(b.dataset.min) === focusState.minutes));
}

function stopFocus() {
  clearInterval(focusInterval);
  focusInterval = null;
  focusState.running = false;
  focusStartBtn.textContent = 'Старт';
}

focusStartBtn.addEventListener('click', () => {
  if (focusState.running) { stopFocus(); renderFocus(); return; }
  if (focusState.seconds <= 0) focusState.seconds = focusState.minutes * 60;
  focusState.running = true;
  focusStartBtn.textContent = 'Пауза';
  focusInterval = setInterval(() => {
    if (focusState.seconds > 0) {
      focusState.seconds--;
      renderFocus();
    } else {
      stopFocus();
      renderFocus();
      api.sendNotification({ title: 'Фокус-сессия завершена 🌸', body: 'Время сделать перерыв.' });
    }
  }, 1000);
  renderFocus();
});

document.getElementById('focusReset').addEventListener('click', () => {
  stopFocus();
  focusState.seconds = focusState.minutes * 60;
  renderFocus();
});

focusPresets.addEventListener('click', async (e) => {
  const btn = e.target.closest('.chip-btn');
  if (!btn) return;
  focusState.minutes = Number(btn.dataset.min);
  if (!focusState.running) focusState.seconds = focusState.minutes * 60;
  markPreset();
  renderFocus();
  api.setSetting('focusMinutes', focusState.minutes);
});

api.getSetting('focusMinutes').then((v) => {
  if (Number.isInteger(v) && v >= 1 && v <= 180) {
    focusState.minutes = v;
    focusState.seconds = v * 60;
  }
  markPreset();
  renderFocus();
});

/* =========================================================
   ОФОРМЛЕНИЕ: стиль (Flower / Classic), режим, палитры, Monet
   ========================================================= */
const MONET_VAR_NAMES = [
  '--md-primary', '--md-on-primary', '--md-primary-container', '--md-on-primary-container',
  '--md-secondary', '--md-tertiary', '--md-surface', '--md-on-surface',
  '--md-surface-variant', '--md-outline'
];

let monetTheme = null; // { light: {cssVar: hex}, dark: {cssVar: hex} }
const monetStatus = document.getElementById('monetStatus');
const monetSeedDot = document.getElementById('monetSeedDot');

function clearMonetVars() { MONET_VAR_NAMES.forEach((v) => body.style.removeProperty(v)); }

function applyMonetForMode(mode) {
  if (!monetTheme) return;
  const vars = monetTheme[mode] || monetTheme.dark;
  Object.entries(vars).forEach(([k, v]) => body.style.setProperty(k, v));
}

function currentResolvedMode() { return body.getAttribute('data-mode') === 'light' ? 'light' : 'dark'; }

async function runMonetExtraction(silent) {
  if (!silent) {
    monetStatus.textContent = 'Анализирую текущие обои Windows…';
    monetStatus.className = 'status-line';
  }
  const res = await api.extractMonet();
  if (res.success) {
    monetTheme = { light: res.light, dark: res.dark };
    monetSeedDot.style.background = res.seedHex;
    if (!silent) flashStatus(monetStatus, true, `Готово — основной цвет ${res.seedHex}`);
    if (body.getAttribute('data-theme') === 'monet') applyMonetForMode(currentResolvedMode());
  } else if (!silent) {
    flashStatus(monetStatus, false, res.message || 'Не удалось получить обои');
  }
  return res;
}

document.getElementById('monetRefresh').addEventListener('click', () => runMonetExtraction(false));
document.getElementById('monetSwatch').addEventListener('click', async () => {
  if (!monetTheme) {
    const res = await runMonetExtraction(false);
    if (!res.success) return; // не переключаемся, если не получилось
  }
  applyTheme('monet');
});

const monetAutoWatchToggle = document.getElementById('monetAutoWatchToggle');
api.getSetting('monetAutoWatch').then((v) => { monetAutoWatchToggle.checked = !!v; });
monetAutoWatchToggle.addEventListener('change', () => api.setMonetAutoWatch(monetAutoWatchToggle.checked));

api.onMonetAutoUpdate((res) => {
  if (!res || !res.success) return;
  monetTheme = { light: res.light, dark: res.dark };
  monetSeedDot.style.background = res.seedHex;
  if (body.getAttribute('data-theme') === 'monet') applyMonetForMode(currentResolvedMode());
  flashStatus(monetStatus, true, `Обои изменились — палитра обновлена (${res.seedHex})`);
});

/* ---- палитра ---- */
async function applyTheme(theme) {
  body.setAttribute('data-theme', theme);
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('selected', s.dataset.theme === theme));
  if (theme === 'monet') applyMonetForMode(currentResolvedMode());
  else clearMonetVars();
  await api.setSetting('theme', theme);
}

document.querySelectorAll('.swatch').forEach((btn) => {
  if (btn.dataset.theme === 'monet') return; // у Monet свой обработчик выше
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

/* ---- стиль: Flower / Classic ---- */
const styleSeg = document.getElementById('styleSeg');

async function applyStyle(style, { save = true } = {}) {
  const s = style === 'classic' ? 'classic' : 'flower';
  body.setAttribute('data-style', s);
  styleSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.uiStyle === s));
  requestAnimationFrame(moveTabIndicator);
  if (save) await api.setSetting('uiStyle', s);
}
styleSeg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => applyStyle(b.dataset.uiStyle)));

/* ---- режим: светлая / тёмная / авто ---- */
const modeSeg = document.getElementById('modeSeg');
const syncWinThemeToggle = document.getElementById('syncWinTheme');
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let modeChoice = 'system';

function resolveMode(choice) {
  if (choice === 'system') return systemDarkQuery.matches ? 'dark' : 'light';
  return choice === 'light' ? 'light' : 'dark';
}

async function applyMode(choice, { syncWindows = false, save = true } = {}) {
  modeChoice = ['light', 'dark', 'system'].includes(choice) ? choice : 'system';
  const resolved = resolveMode(modeChoice);
  body.setAttribute('data-mode', resolved);
  modeSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.modeChoice === modeChoice));
  if (body.getAttribute('data-theme') === 'monet') applyMonetForMode(resolved);
  document.dispatchEvent(new CustomEvent('island:mode', { detail: resolved }));

  if (save) await api.setSetting('mode', modeChoice);

  if (syncWindows && modeChoice !== 'system' && syncWinThemeToggle.checked) {
    const statusEl = document.getElementById('themeSyncStatus');
    statusEl.textContent = 'Применяю тему Windows…';
    statusEl.className = 'status-line';
    const res = await api.setWindowsTheme(resolved === 'dark');
    flashStatus(statusEl, res.success, res.success ? 'Тема Windows обновлена' : `Ошибка: ${res.message}`);
  }
}
modeSeg.querySelectorAll('.seg-btn').forEach((b) =>
  b.addEventListener('click', () => applyMode(b.dataset.modeChoice, { syncWindows: true })));
systemDarkQuery.addEventListener('change', () => { if (modeChoice === 'system') applyMode('system', { save: false }); });

api.getSetting('syncWinTheme').then((v) => { syncWinThemeToggle.checked = !!v; });
syncWinThemeToggle.addEventListener('change', () => api.setSetting('syncWinTheme', syncWinThemeToggle.checked));

/* ---- прозрачность ---- */
const opacityRange = document.getElementById('opacityRange');
opacityRange.addEventListener('input', () => {
  islandEl.style.opacity = opacityRange.value;
  api.setSetting('opacity', Number(opacityRange.value));
});

/* ---- автозапуск ---- */
const autoLaunchToggle = document.getElementById('autoLaunchToggle');
autoLaunchToggle.addEventListener('change', () => api.setSetting('autoLaunch', autoLaunchToggle.checked));

/* ---- «поверх всех окон» (кнопка в шапке + тумблер в настройках) ---- */
const pinBtn = document.getElementById('pinBtn');
const pinToggle = document.getElementById('pinToggle');
let pinned = true;

function renderPinned() {
  pinBtn.setAttribute('aria-pressed', String(pinned));
  pinBtn.title = `Поверх всех окон: ${pinned ? 'включено' : 'выключено'}`;
  pinToggle.checked = pinned;
}

async function setPinned(next) {
  const res = await api.setPinned(next);
  if (res && res.success) pinned = next;
  renderPinned();
}
pinBtn.addEventListener('click', () => setPinned(!pinned));
pinToggle.addEventListener('change', () => setPinned(pinToggle.checked));

/* ---- тумблеры раздела «Остров» ---- */
bindSettingToggle(document.getElementById('collapseOnBlurToggle'), 'collapseOnBlur', { defaultValue: false });
bindSettingToggle(document.getElementById('pillLiveToggle'), 'pillLive', { defaultValue: true });
bindSettingToggle(document.getElementById('nowPlayingToggle'), 'nowPlaying', { defaultValue: true });
bindSettingToggle(document.getElementById('hotkeyToggle'), 'hotkeyEnabled', { defaultValue: true });

/* ---------- Загрузка сохранённых настроек при старте ---------- */
(async function init() {
  const cachedMonet = await api.getCachedMonet();
  if (cachedMonet && cachedMonet.light && cachedMonet.dark) {
    monetTheme = { light: cachedMonet.light, dark: cachedMonet.dark };
    monetSeedDot.style.background = cachedMonet.seedHex;
  }

  let theme = (await api.getSetting('theme')) || 'sakura';
  if (theme === 'monet' && !monetTheme) theme = 'sakura'; // не на чем применять — подстрахуемся

  const mode = (await api.getSetting('mode')) || 'system';
  const style = (await api.getSetting('uiStyle')) || 'flower';
  const opacity = (await api.getSetting('opacity')) ?? 0.96;
  const autoLaunch = (await api.getSetting('autoLaunch')) || false;

  pinned = (await api.getSetting('pinned')) !== false;
  renderPinned();

  await applyStyle(style, { save: false });
  await applyMode(mode, { save: false });
  await applyTheme(theme);
  opacityRange.value = opacity;
  syncRangeFill(opacityRange);
  islandEl.style.opacity = opacity;
  autoLaunchToggle.checked = autoLaunch;
  requestAnimationFrame(moveTabIndicator);
})();
