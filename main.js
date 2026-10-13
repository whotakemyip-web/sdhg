'use strict';

const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage,
  desktopCapturer, clipboard, Notification, dialog, shell, safeStorage, session,
  globalShortcut, powerSaveBlocker
} = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile, spawn } = require('node:child_process');
const Store = require('electron-store');

const {
  ValidationError, CLIPBOARD_TTL_OPTIONS_MIN,
  canRendererRead, sanitizeRendererWrite,
  validateNotification, validateWifiPayload, validateBluetoothPayload,
  validateAudioPayload, validateBrightnessPayload, validateToggleOnly, validateToolId,
  validateDragDelta, validateClipboardPatch, validateClipboardId,
  validateLauncherPath, normalizePathForCompare, isTrustedSenderUrl,
  requireBoolean, LIMITS
} = require('./lib/validation');
const ps = require('./lib/powershell');
const { ClipboardHistory } = require('./lib/clipboardHistory');
const { MediaWatcher } = require('./lib/mediaWatcher');
const { resolveStartBounds, resizeAroundCenter, clampBounds, pickWorkArea } = require('./lib/position');
const { checkElectronApis } = require('./lib/compat');

// Официальная библиотека Google для вычисления Material You (HCT/Monet) —
// тот же алгоритм, что используют Android и matugen.
let MaterialColor = null;
try {
  MaterialColor = require('@material/material-color-utilities');
} catch (e) {
  MaterialColor = null;
}

const store = new Store({
  defaults: {
    theme: 'sakura',
    mode: 'system',
    uiStyle: 'flower',
    opacity: 0.96,
    collapseOnBlur: false,
    hotkeyEnabled: true,
    nowPlaying: true,
    pillLive: true,
    focusMinutes: 25,
    autoLaunch: false,
    posX: null,           // X ЦЕНТРА окна
    posY: 8,              // верхний край окна
    pinned: true,         // «поверх всех окон»
    notes: '',
    wifiIfname: 'Wi-Fi',
    syncWinTheme: false,
    monetTheme: null,
    monetAutoWatch: false,
    // История буфера обмена: по умолчанию ВЫКЛЮЧЕНА, включается только с согласия пользователя
    clipboardEnabled: false,
    clipboardPaused: false,
    clipboardPersist: false,   // false = только в памяти, пропадает при выходе
    clipboardTtlMin: 60
  }
});

// Старые версии хранили историю буфера открытым текстом в конфиге — удаляем.
store.delete('clipboardHistory');

// Размеры должны совпадать с --pill-w/--pill-h и --exp-w/--exp-h в renderer/styles.css
const COLLAPSED = { w: 280, h: 38 };
const EXPANDED = { w: 460, h: 660 };
const HOTKEY = 'CommandOrControl+Alt+I';
const APP_INDEX = path.join(__dirname, 'renderer', 'index.html');

let win = null;
let tray = null;
let statsTimer = null;

// Пока открыт системный диалог / UAC, потеря фокуса не должна сворачивать остров.
let modalDepth = 0;
async function withModal(fn) {
  modalDepth += 1;
  try { return await fn(); } finally { modalDepth -= 1; }
}

/* =======================================================
   СОВМЕСТИМОСТЬ API ELECTRON
   ======================================================= */
const missingApis = checkElectronApis(require('electron'));
if (missingApis.length) {
  console.error('[compat] В этой версии Electron отсутствуют API:', missingApis.join(', '));
}

/* =======================================================
   БЕЗОПАСНОСТЬ ОКОН: навигация, новые окна, webview, разрешения
   ======================================================= */
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function hardenSession() {
  const ses = session.defaultSession;
  // Рендереру не нужны никакие разрешения (камера, геолокация, уведомления и т.д.)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Интерфейсу не нужен интернет — блокируем любые сетевые запросы из рендерера.
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
}

/* =======================================================
   IPC: проверка отправителя + единая обработка ошибок
   ======================================================= */
function assertTrusted(e) {
  const url = e && e.senderFrame ? e.senderFrame.url : undefined;
  if (!isTrustedSenderUrl(url, APP_INDEX)) throw new Error('Untrusted IPC sender');
  if (win && !win.isDestroyed() && e.sender !== win.webContents) {
    throw new Error('Untrusted IPC sender');
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    assertTrusted(e);
    try {
      return await fn(e, ...args);
    } catch (err) {
      if (err instanceof ValidationError) return { success: false, message: err.message };
      console.error(`[ipc:${channel}]`, err);
      return { success: false, message: 'Внутренняя ошибка' };
    }
  });
}

/* =======================================================
   ОКНО
   ======================================================= */
function workAreas() {
  return screen.getAllDisplays().map((d) => d.workArea);
}

function applyPinned(pinned) {
  if (!win || win.isDestroyed()) return;
  if (pinned) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
  }
}

function savePosition() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  store.set('posX', Math.round(b.x + b.width / 2));
  store.set('posY', b.y);
}

function resetPosition() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getPrimaryDisplay().workArea;
  win.setBounds({
    x: Math.round(wa.x + (wa.width - b.width) / 2),
    y: wa.y + 8,
    width: b.width,
    height: b.height
  });
  savePosition();
}

function createWindow() {
  const start = resolveStartBounds(
    { posX: store.get('posX'), posY: store.get('posY') },
    COLLAPSED,
    workAreas(),
    screen.getPrimaryDisplay().workArea
  );

  win = new BrowserWindow({
    ...start,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });

  applyPinned(store.get('pinned') !== false);
  win.loadFile(APP_INDEX);

  win.on('blur', () => {
    if (store.get('collapseOnBlur') === true && modalDepth === 0 && win && !win.isDestroyed()) {
      win.webContents.send('island:collapse');
    }
  });

  win.on('closed', () => {
    win = null;
  });

  startStatsLoop();
}

function startStatsLoop() {
  if (statsTimer) clearInterval(statsTimer);
  let prevCpu = os.cpus();

  statsTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;

    const cpus = os.cpus();
    let idleDiff = 0, totalDiff = 0;
    for (let i = 0; i < cpus.length; i++) {
      const prev = prevCpu[i].times;
      const cur = cpus[i].times;
      const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
      const curTotal = cur.user + cur.nice + cur.sys + cur.idle + cur.irq;
      totalDiff += curTotal - prevTotal;
      idleDiff += cur.idle - prev.idle;
    }
    prevCpu = cpus;
    const cpuLoad = totalDiff > 0 ? Math.round(100 * (1 - idleDiff / totalDiff)) : 0;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMemPct = Math.round(100 * (1 - freeMem / totalMem));

    win.webContents.send('stats:update', {
      cpu: cpuLoad,
      mem: usedMemPct,
      memUsedGB: ((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(1),
      memTotalGB: (totalMem / 1024 / 1024 / 1024).toFixed(1),
      uptimeMin: Math.round(os.uptime() / 60),
      hostname: os.hostname()
    });
  }, 2000);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('DynamicIsland MD3');

  const menu = Menu.buildFromTemplate([
    { label: 'Показать / Скрыть', click: () => toggleVisibility() },
    { label: 'Свернуть остров', click: () => win && win.webContents.send('island:collapse') },
    { label: 'Сбросить позицию', click: () => resetPosition() },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggleVisibility());
}

function toggleVisibility() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.show();
}

/* =======================================================
   РЕАЛЬНЫЕ СИСТЕМНЫЕ ФУНКЦИИ (Windows)
   Весь PowerShell строится в lib/powershell.js из фиксированных шаблонов —
   пользовательский ввод в текст скриптов не подставляется.
   ======================================================= */
let elevatedBusy = false;

async function runElevatedExclusive(script) {
  if (elevatedBusy) {
    return { success: false, message: 'Предыдущий запрос прав администратора ещё выполняется' };
  }
  elevatedBusy = true;
  try {
    return await withModal(() => ps.runElevated(script, { execFile }));
  } finally {
    elevatedBusy = false;
  }
}

handle('media:key', async (_e, action) => {
  const vk = ps.getVirtualKey(action);
  if (vk === null) return { success: false, message: 'неизвестное действие' };
  return ps.runPowerShell(ps.buildKeyScript(vk), { execFile });
});

// Реальная смена темы Windows (светлая/тёмная) через реестр HKCU —
// прав администратора не требует, применяется сразу.
handle('system:setWindowsTheme', async (_e, isDark) => {
  const dark = requireBoolean(isDark, 'isDark');
  return ps.runPowerShell(ps.buildThemeScript(dark), { execFile });
});

// Блокировка и сон — не требуют прав администратора.
function runSimple(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (err) => {
      resolve(err ? { success: false, message: 'Не удалось выполнить действие' } : { success: true });
    });
  });
}
handle('power:lock', () => runSimple('rundll32.exe', ['user32.dll,LockWorkStation']));
handle('power:sleep', () => runSimple('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']));

// Скриншот основного экрана: копия в буфер обмена + сохранение в
// Изображения/DynamicIslandMD3 — через встроенный Electron API.
handle('screenshot:capture', async () => {
  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });
    const source = sources[0];
    if (!source) return { success: false, message: 'Экран не найден' };

    const image = source.thumbnail;
    clipboard.writeImage(image);

    const dir = path.join(app.getPath('pictures'), 'DynamicIslandMD3');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(filePath, image.toPNG());

    return { success: true, path: filePath };
  } catch (e) {
    console.error('[screenshot]', e);
    return { success: false, message: 'Не удалось сделать скриншот' };
  }
});

// Реальные нативные уведомления Windows (Action Center).
handle('notify:send', (_e, payload) => {
  const { title, body } = validateNotification(payload);
  if (!Notification.isSupported()) return { success: false, message: 'не поддерживается' };
  new Notification({ title: title || 'DynamicIsland MD3', body }).show();
  return { success: true };
});

// Экспериментально: включение/выключение Wi-Fi адаптера (требует UAC).
handle('wifi:toggle', async (_e, payload) => {
  const { enable, ifname } = validateWifiPayload(payload, store.get('wifiIfname') || 'Wi-Fi');
  return runElevatedExclusive(ps.buildWifiScript({ name: ifname, enable }));
});

// Экспериментально: включение/выключение Bluetooth-радиомодуля (требует UAC).
handle('bluetooth:toggle', async (_e, payload) => {
  const { enable } = validateBluetoothPayload(payload);
  return runElevatedExclusive(ps.buildBluetoothScript({ enable }));
});

/* =======================================================
   ЦЕНТР УПРАВЛЕНИЯ: громкость, яркость, состояния, «не беспокоить»,
   «не засыпать», быстрые инструменты, «сейчас играет», горячая клавиша
   ======================================================= */
function finiteInt(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : null;
}

// Реальные значения переключателей на момент открытия центра управления.
handle('system:getState', async () => {
  const res = await ps.runPowerShellJson(ps.buildStateScript(), { execFile });
  const d = res.success && res.data && typeof res.data === 'object' ? res.data : {};
  return {
    success: true,
    wifi: typeof d.wifi === 'boolean' ? d.wifi : null,
    bluetooth: typeof d.bluetooth === 'boolean' ? d.bluetooth : null,
    dnd: d.dnd === true,
    keepAwake: keepAwakeId !== null
  };
});

// Громкость основного устройства вывода: Core Audio (IAudioEndpointVolume), без админ-прав.
handle('audio:control', async (_e, payload) => {
  const p = validateAudioPayload(payload);
  const res = await ps.runPowerShellJson(ps.buildAudioScript(p), { execFile, timeoutMs: 15000 });
  if (!res.success) return { success: false, message: res.message };
  const volume = finiteInt(res.data && res.data.volume, 0, 100);
  if (volume === null) return { success: false, message: 'Не удалось прочитать громкость' };
  return { success: true, volume, muted: !!(res.data && res.data.muted) };
});

// Яркость: WMI (WmiMonitorBrightness*). Работает на встроенных экранах ноутбуков/моноблоков.
handle('brightness:control', async (_e, payload) => {
  const p = validateBrightnessPayload(payload);
  const res = await ps.runPowerShellJson(ps.buildBrightnessScript(p), { execFile, timeoutMs: 15000 });
  if (!res.success) {
    return { success: false, unsupported: res.code === ps.EXIT.UNSUPPORTED, message: res.message };
  }
  const level = finiteInt(res.data && res.data.level, 0, 100);
  if (level === null) return { success: false, message: 'Не удалось прочитать яркость' };
  return { success: true, level };
});

// «Не беспокоить» — выключает баннеры уведомлений (ключ реестра пользователя). Экспериментально.
handle('dnd:set', async (_e, payload) => {
  const { enable } = validateToggleOnly(payload, 'dnd');
  return ps.runPowerShell(ps.buildDndScript({ enable }), { execFile });
});

// «Не засыпать» — встроенный powerSaveBlocker Electron (экран и ПК не уходят в сон).
let keepAwakeId = null;
handle('power:keepAwake', (_e, payload) => {
  const { enable } = validateToggleOnly(payload, 'keepAwake');
  if (!powerSaveBlocker) return { success: false, message: 'Не поддерживается' };
  if (enable && keepAwakeId === null) keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
  if (!enable && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
  return { success: true, enabled: keepAwakeId !== null };
});

// Быстрый запуск системных инструментов — только фиксированный список, без пользовательских путей.
const TOOL_TARGETS = Object.freeze({
  taskmgr:  { file: ['System32', 'taskmgr.exe'] },
  calc:     { file: ['System32', 'calc.exe'] },
  explorer: { file: ['explorer.exe'] },
  settings: { uri: 'ms-settings:' },
  snip:     { uri: 'ms-screenclip:' }
});

handle('tools:open', async (_e, tool) => {
  const target = TOOL_TARGETS[validateToolId(tool)];
  if (target.uri) {
    await shell.openExternal(target.uri);
    return { success: true };
  }
  const full = path.join(process.env.windir || 'C:\\Windows', ...target.file);
  if (!fs.existsSync(full)) return { success: false, message: 'Файл не найден' };
  const err = await shell.openPath(full); // ShellExecute — сам покажет UAC, если нужен
  return { success: !err, message: err ? 'Не удалось запустить' : 'Запущено' };
});

/* ---- «Сейчас играет» (WinRT через долгоживущий PowerShell) ---- */
const mediaWatcher = new MediaWatcher({
  spawn,
  buildCommand: () => ({
    file: 'powershell.exe',
    args: ps.powershellArgs(ps.buildMediaWatchScript({ parentPid: process.pid }))
  }),
  onUpdate: (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('media:update', state);
  }
});

function syncMediaWatcher() {
  if (store.get('nowPlaying') !== false) mediaWatcher.start();
  else mediaWatcher.stop();
}

handle('media:getNowPlaying', () => mediaWatcher.snapshot());

/* ---- Горячая клавиша: Ctrl+Alt+I раскрывает/сворачивает остров ---- */
function onHotkey() {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  win.focus();
  win.webContents.send('island:toggle');
}

function syncHotkey() {
  if (!globalShortcut) return;
  try { globalShortcut.unregister(HOTKEY); } catch (_) { /* ignore */ }
  if (store.get('hotkeyEnabled') === false) return;
  try { globalShortcut.register(HOTKEY, onHotkey); } catch (_) { /* занято другим приложением */ }
}

/* =======================================================
   MONET — живая MD3-палитра из текущих обоев Windows
   (тот же подход, что matugen/Android: HCT quantization + Score)
   ======================================================= */

// Находит реальный файл текущих обоев Windows.
function getWallpaperPath() {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'],
      { windowsHide: true },
      (err, stdout) => {
        let p = null;
        if (!err && stdout) {
          const m = String(stdout).match(/WallPaper\s+REG_SZ\s+(.+)/i);
          if (m) p = m[1].trim();
        }
        if (p && fs.existsSync(p)) {
          resolve(p);
          return;
        }
        // Запасной путь: Windows всегда кеширует отрисованные обои сюда
        // (в JPEG, независимо от исходного формата) — пригождается для
        // слайд-шоу, Windows Spotlight и т.п., когда реестр пуст/неточен.
        const fallback = path.join(
          process.env.APPDATA || '',
          'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper'
        );
        resolve(fs.existsSync(fallback) ? fallback : null);
      }
    );
  });
}

// Electron nativeImage отдаёт растр в BGRA — пакуем в ARGB int32,
// как ожидает QuantizerCelebi.
function bitmapToArgbPixels(bitmap) {
  const pixels = [];
  for (let i = 0; i < bitmap.length; i += 4) {
    const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2], a = bitmap[i + 3];
    if (a < 200) continue;
    const argb = ((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
    pixels.push(argb >>> 0);
  }
  return pixels;
}

async function extractMonetTheme() {
  if (!MaterialColor) {
    return {
      success: false,
      message: 'Пакет @material/material-color-utilities не установлен — выполните npm install'
    };
  }
  try {
    const wallpaperPath = await getWallpaperPath();
    if (!wallpaperPath) {
      return { success: false, message: 'Не удалось найти файл текущих обоев Windows' };
    }

    let img = nativeImage.createFromPath(wallpaperPath);
    if (img.isEmpty()) {
      return { success: false, message: 'Не удалось прочитать файл обоев' };
    }
    // 112x112 — тот же размер растра, что использует Android для
    // извлечения Monet-цвета из обоев.
    img = img.resize({ width: 112, height: 112 });
    const bitmap = img.toBitmap();
    const pixels = bitmapToArgbPixels(bitmap);

    const { QuantizerCelebi, Score, themeFromSourceColor, hexFromArgb } = MaterialColor;

    const colorToCount = QuantizerCelebi.quantize(pixels, 128);
    const ranked = Score.score(colorToCount);
    if (!ranked || !ranked.length) {
      return { success: false, message: 'Не удалось выделить цвет из изображения' };
    }
    const seedArgb = ranked[0];
    const theme = themeFromSourceColor(seedArgb);

    const roleMap = {
      primary: '--md-primary',
      onPrimary: '--md-on-primary',
      primaryContainer: '--md-primary-container',
      onPrimaryContainer: '--md-on-primary-container',
      secondary: '--md-secondary',
      tertiary: '--md-tertiary',
      surface: '--md-surface',
      onSurface: '--md-on-surface',
      surfaceVariant: '--md-surface-variant',
      outline: '--md-outline'
    };

    function buildVars(scheme) {
      const out = {};
      for (const [role, cssVar] of Object.entries(roleMap)) {
        out[cssVar] = hexFromArgb(scheme[role]);
      }
      return out;
    }

    // В рендерер уходит только палитра — путь к файлу обоев ему не нужен.
    const result = {
      success: true,
      seedHex: hexFromArgb(seedArgb),
      light: buildVars(theme.schemes.light),
      dark: buildVars(theme.schemes.dark)
    };

    store.set('monetTheme', result);
    return result;
  } catch (e) {
    console.error('[monet]', e);
    return { success: false, message: 'Не удалось построить палитру' };
  }
}

handle('monet:extract', () => extractMonetTheme());
handle('monet:getCached', () => store.get('monetTheme') || null);

/* ---- Фоновый наблюдатель за сменой обоев (опрос, не push-событие) ---- */
let wallpaperWatchTimer = null;
let lastWallpaperState = null; // { path, mtimeMs }

async function checkWallpaperChanged() {
  try {
    const wallpaperPath = await getWallpaperPath();
    if (!wallpaperPath) return;
    const mtimeMs = fs.statSync(wallpaperPath).mtimeMs;

    const isFirstCheck = !lastWallpaperState;
    const changed = !isFirstCheck &&
      (lastWallpaperState.path !== wallpaperPath || lastWallpaperState.mtimeMs !== mtimeMs);

    lastWallpaperState = { path: wallpaperPath, mtimeMs };

    if (changed) {
      const result = await extractMonetTheme();
      if (win && !win.isDestroyed()) {
        win.webContents.send('monet:auto-update', result);
      }
    }
  } catch (_) {
    // Файл обоев временно недоступен/меняется — тихо пропускаем, попробуем на следующем цикле.
  }
}

function startWallpaperWatch(enabled) {
  if (wallpaperWatchTimer) {
    clearInterval(wallpaperWatchTimer);
    wallpaperWatchTimer = null;
  }
  if (!enabled) return;
  lastWallpaperState = null; // зафиксировать новую базовую точку отсчёта
  checkWallpaperChanged();
  wallpaperWatchTimer = setInterval(checkWallpaperChanged, 20000); // опрос раз в 20 секунд
}

handle('monet:setAutoWatch', (_e, enabled) => {
  const v = requireBoolean(enabled, 'enabled');
  store.set('monetAutoWatch', v);
  startWallpaperWatch(v);
  return { success: true };
});

/* =======================================================
   ПОЗИЦИЯ, ПЕРЕТАСКИВАНИЕ, РАЗМЕР, ЗАКРЕПЛЕНИЕ
   ======================================================= */

// Плавная анимация изменения размера/позиции самого окна острова
// (а не просто CSS-переход внутри) — несколько кадров setBounds с easing.
function animateBounds(fromBounds, toBounds, duration = 300) {
  return new Promise((resolve) => {
    const start = Date.now();
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 4); // easeOutQuart — мягче к концу

    function step() {
      if (!win || win.isDestroyed()) { resolve(); return; }
      const elapsed = Date.now() - start;
      const t = Math.min(1, elapsed / duration);
      const e = easeOutCubic(t);
      win.setBounds({
        x: Math.round(fromBounds.x + (toBounds.x - fromBounds.x) * e),
        y: Math.round(fromBounds.y + (toBounds.y - fromBounds.y) * e),
        width: Math.round(fromBounds.width + (toBounds.width - fromBounds.width) * e),
        height: Math.round(fromBounds.height + (toBounds.height - fromBounds.height) * e)
      });
      if (t < 1) setTimeout(step, 8);
      else resolve();
    }
    step();
  });
}

let expandAnimating = false;
handle('window:expand', async (_e, expand) => {
  const want = requireBoolean(expand, 'expand');
  if (!win || win.isDestroyed() || expandAnimating) return { success: false };
  expandAnimating = true;
  try {
    const bounds = win.getBounds();
    const target = want ? EXPANDED : COLLAPSED;
    // Центр по X сохраняется — окно раскрывается там, где его оставил пользователь.
    const toBounds = resizeAroundCenter(bounds, target, workAreas(), screen.getPrimaryDisplay().workArea);
    await animateBounds(bounds, toBounds, 300);
  } finally {
    expandAnimating = false;
  }
  return { success: true };
});

// Перетаскивание: рендерер шлёт накопленное смещение от точки нажатия,
// поэтому ошибки округления не копируются от кадра к кадру.
let dragStartBounds = null;
handle('window:dragStart', () => {
  if (!win || win.isDestroyed()) return { success: false };
  dragStartBounds = win.getBounds();
  return { success: true };
});
handle('window:dragMove', (_e, payload) => {
  const { dx, dy } = validateDragDelta(payload);
  if (!win || win.isDestroyed() || !dragStartBounds) return { success: false };
  const wanted = {
    x: dragStartBounds.x + dx,
    y: dragStartBounds.y + dy,
    width: dragStartBounds.width,
    height: dragStartBounds.height
  };
  const wa = pickWorkArea(wanted.x + wanted.width / 2, wanted.y, workAreas(), screen.getPrimaryDisplay().workArea);
  win.setBounds(clampBounds(wanted, wa));
  return { success: true };
});
handle('window:dragEnd', () => {
  dragStartBounds = null;
  savePosition();
  return { success: true };
});

handle('window:setPinned', (_e, pinned) => {
  const v = requireBoolean(pinned, 'pinned');
  store.set('pinned', v);
  applyPinned(v);
  return { success: true, pinned: v };
});

handle('window:close', () => {
  app.quit();
  return { success: true };
});

/* =======================================================
   ЛАУНЧЕР — закреплённые ярлыки приложений
   Запускать можно только то, что пользователь сам выбрал через системный диалог.
   ======================================================= */
function getApprovedLaunchPaths() {
  const list = store.get('launcherApproved');
  return new Set(Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []);
}

function approveLaunchPath(filePath) {
  const set = getApprovedLaunchPaths();
  set.add(normalizePathForCompare(filePath));
  store.set('launcherApproved', Array.from(set).slice(-200));
}

handle('launcher:pickFile', async () => {
  const result = await withModal(() => dialog.showOpenDialog(win, {
    title: 'Выберите программу или ярлык',
    properties: ['openFile'],
    filters: [
      { name: 'Программы и ярлыки', extensions: ['exe', 'lnk', 'bat', 'cmd'] }
    ]
  }));
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = validateLauncherPath(result.filePaths[0]);
  approveLaunchPath(filePath);
  const name = path.basename(filePath).replace(/\.(exe|lnk|bat|cmd)$/i, '').slice(0, LIMITS.appName);
  return { path: filePath, name };
});

handle('launcher:open', async (_e, filePath) => {
  const p = validateLauncherPath(filePath);
  if (!getApprovedLaunchPaths().has(normalizePathForCompare(p))) {
    return { success: false, message: 'Этот файл не был выбран через диалог — добавьте его заново' };
  }
  if (!fs.existsSync(p)) return { success: false, message: 'Файл не найден' };
  const err = await shell.openPath(p);
  return { success: !err, message: err ? 'Не удалось запустить' : 'Запущено' };
});

/* =======================================================
   ИСТОРИЯ БУФЕРА ОБМЕНА
   — выключена по умолчанию, включается только после нативного диалога согласия;
   — есть пауза, очистка и срок хранения (TTL);
   — по умолчанию хранится только в памяти; сохранение на диск — по отдельному
     согласию и только в зашифрованном виде (Windows DPAPI через safeStorage);
   — записи, помеченные менеджерами паролей как «не для истории», пропускаются.
   ======================================================= */
const CLIP_POLL_MS = 1500;
const clipHistory = new ClipboardHistory({
  max: 20,
  maxLen: 5000,
  ttlMs: (store.get('clipboardTtlMin') || 60) * 60 * 1000
});
let clipboardTimer = null;
let clipboardPruneTimer = null;
let lastClipboardText = '';

function safeStorageAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}

function clipConfig() {
  const ttl = store.get('clipboardTtlMin');
  return {
    enabled: store.get('clipboardEnabled') === true,
    paused: store.get('clipboardPaused') === true,
    persist: store.get('clipboardPersist') === true,
    ttlMin: CLIPBOARD_TTL_OPTIONS_MIN.includes(ttl) ? ttl : 60
  };
}

function clipState() {
  return {
    ...clipConfig(),
    persistAvailable: safeStorageAvailable(),
    items: clipHistory.list().map((e) => ({
      id: e.id,
      preview: e.text.slice(0, 120),
      length: e.text.length,
      ts: e.ts
    }))
  };
}

function broadcastClipboard() {
  if (win && !win.isDestroyed()) win.webContents.send('clipboard:update', clipState());
}

function persistClipboard() {
  const cfg = clipConfig();
  if (!(cfg.enabled && cfg.persist && safeStorageAvailable())) {
    store.delete('clipboardHistoryEnc');
    return;
  }
  try {
    const enc = safeStorage.encryptString(JSON.stringify(clipHistory.toJSON()));
    store.set('clipboardHistoryEnc', enc.toString('base64'));
  } catch (e) {
    console.error('[clipboard] не удалось сохранить историю', e);
    store.delete('clipboardHistoryEnc');
  }
}

function loadPersistedClipboard() {
  const cfg = clipConfig();
  const enc = store.get('clipboardHistoryEnc');
  if (!(cfg.enabled && cfg.persist && safeStorageAvailable() && typeof enc === 'string')) {
    store.delete('clipboardHistoryEnc');
    return;
  }
  try {
    clipHistory.load(JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))));
  } catch (_) {
    store.delete('clipboardHistoryEnc'); // повреждено / другой пользователь Windows
  }
}

// Менеджеры паролей помечают такие записи специальными форматами Windows.
// Best-effort: если формат недоступен — просто считаем запись обычной.
function clipboardMarkedPrivate() {
  try {
    const exclude = clipboard.readBuffer('ExcludeClipboardContentFromMonitorProcessing');
    if (exclude && exclude.length > 0) return true;
  } catch (_) {}
  try {
    const can = clipboard.readBuffer('CanIncludeInClipboardHistory');
    if (can && can.length >= 4 && can.readUInt32LE(0) === 0) return true;
  } catch (_) {}
  return false;
}

function readClipboardSafely() {
  try { return clipboard.readText(); } catch (_) { return ''; }
}

function stopClipboardWatch() {
  if (clipboardTimer) clearInterval(clipboardTimer);
  clipboardTimer = null;
}

function syncClipboardWatcher() {
  stopClipboardWatch();
  const cfg = clipConfig();
  if (!cfg.enabled || cfg.paused) return;
  // Всё, что скопировано до включения/во время паузы, в историю не попадает.
  lastClipboardText = readClipboardSafely();
  clipboardTimer = setInterval(() => {
    const text = readClipboardSafely();
    if (!text || text === lastClipboardText) return;
    lastClipboardText = text;
    if (clipboardMarkedPrivate()) return;
    if (clipHistory.add(text)) {
      persistClipboard();
      broadcastClipboard();
    }
  }, CLIP_POLL_MS);
  if (clipboardTimer.unref) clipboardTimer.unref();
}

async function confirmDialog(message, detail, acceptLabel) {
  const parent = win && !win.isDestroyed() ? win : undefined;
  const res = await withModal(() => dialog.showMessageBox(parent, {
    type: 'question',
    title: 'DynamicIsland MD3',
    message,
    detail,
    buttons: [acceptLabel, 'Отмена'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }));
  return res.response === 0;
}

handle('clipboard:getState', () => clipState());

handle('clipboard:setConfig', async (_e, patch) => {
  const p = validateClipboardPatch(patch);
  const cur = clipConfig();

  if (p.enabled === true && !cur.enabled) {
    const ok = await confirmDialog(
      'Включить историю буфера обмена?',
      'Остров будет раз в 1,5 секунды читать текст, который вы копируете, и хранить последние ' +
      '20 записей в памяти. В историю могут попасть пароли и другие личные данные, если вы их ' +
      'копируете. Записи автоматически удаляются через выбранный срок; историю можно ' +
      'поставить на паузу, очистить или отключить в любой момент.',
      'Включить'
    );
    if (!ok) return { success: false, message: 'Отменено', state: clipState() };
  }

  const willBeEnabled = p.enabled !== undefined ? p.enabled : cur.enabled;

  if (p.persist === true && !cur.persist) {
    if (!willBeEnabled) return { success: false, message: 'Сначала включите историю', state: clipState() };
    if (!safeStorageAvailable()) {
      return { success: false, message: 'Шифрование Windows недоступно — сохранение отключено', state: clipState() };
    }
    const ok = await confirmDialog(
      'Хранить историю между запусками?',
      'Записи будут сохраняться на диск в зашифрованном виде (ключ привязан к вашей учётной ' +
      'записи Windows) и удаляться по истечении срока хранения.',
      'Хранить'
    );
    if (!ok) return { success: false, message: 'Отменено', state: clipState() };
  }

  if (p.enabled !== undefined) {
    store.set('clipboardEnabled', p.enabled);
    if (!p.enabled) {
      // Отключение = полная очистка и сброс связанных настроек
      clipHistory.clear();
      store.set('clipboardPaused', false);
      store.set('clipboardPersist', false);
      store.delete('clipboardHistoryEnc');
    }
  }
  if (p.paused !== undefined && willBeEnabled) store.set('clipboardPaused', p.paused);
  if (p.persist !== undefined && willBeEnabled) store.set('clipboardPersist', p.persist);
  if (p.ttlMin !== undefined) {
    store.set('clipboardTtlMin', p.ttlMin);
    clipHistory.setTtlMs(p.ttlMin * 60 * 1000);
  }

  persistClipboard();
  syncClipboardWatcher();
  broadcastClipboard();
  return { success: true, state: clipState() };
});

handle('clipboard:restore', (_e, id) => {
  const entry = clipHistory.get(validateClipboardId(id));
  if (!entry) return { success: false, message: 'Запись не найдена или удалена по сроку хранения' };
  lastClipboardText = entry.text; // не считать возврат новой записью
  clipboard.writeText(entry.text);
  return { success: true };
});

handle('clipboard:clear', () => {
  clipHistory.clear();
  persistClipboard();
  broadcastClipboard();
  return { success: true, state: clipState() };
});

/* =======================================================
   НАСТРОЙКИ — только allowlist ключей, типы и лимиты
   ======================================================= */
handle('store:get', (_e, key) => {
  if (!canRendererRead(key)) return null;
  return store.get(key);
});

handle('store:set', (_e, key, value) => {
  const clean = sanitizeRendererWrite(key, value); // бросает ValidationError
  store.set(key, clean);
  if (key === 'autoLaunch') {
    app.setLoginItemSettings({ openAtLogin: clean });
  }
  if (key === 'nowPlaying') syncMediaWatcher();
  if (key === 'hotkeyEnabled') syncHotkey();
  return { success: true };
});

/* =======================================================
   ЗАПУСК
   ======================================================= */
app.whenReady().then(() => {
  if (missingApis.length) {
    dialog.showErrorBox(
      'Несовместимая версия Electron',
      `Не найдены API: ${missingApis.join(', ')}.\nОбновите приложение.`
    );
    app.quit();
    return;
  }

  hardenSession();
  createWindow();
  createTray();
  app.setLoginItemSettings({ openAtLogin: !!store.get('autoLaunch') });
  startWallpaperWatch(!!store.get('monetAutoWatch'));
  syncMediaWatcher();
  syncHotkey();

  loadPersistedClipboard();
  syncClipboardWatcher();
  clipboardPruneTimer = setInterval(() => {
    if (clipHistory.prune()) {
      persistClipboard();
      broadcastClipboard();
    }
  }, 30000);
});

app.on('before-quit', () => {
  mediaWatcher.stop();
  try { if (globalShortcut) globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
  try { if (powerSaveBlocker && keepAwakeId !== null) powerSaveBlocker.stop(keepAwakeId); } catch (_) { /* ignore */ }
  stopClipboardWatch();
  if (clipboardPruneTimer) clearInterval(clipboardPruneTimer);
});

app.on('window-all-closed', () => {
  // Держим приложение живым в трее на Windows — доступ через трей.
});
