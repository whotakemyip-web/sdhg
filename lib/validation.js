'use strict';

/**
 * Валидация всего, что приходит из рендерера по IPC.
 * Рендерер считается недоверенным: любое значение проверяется по allowlist,
 * типам и лимитам. Модуль не зависит от Electron — его можно тестировать отдельно.
 */

const path = require('node:path');
const { fileURLToPath } = require('node:url');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const THEMES = Object.freeze([
  'purple', 'blue', 'green', 'orange', 'teal', 'red',
  'sakura', 'lavender', 'peach', 'mint',   // пастельные «цветочные» палитры
  'monet'
]);
const MODES = Object.freeze(['dark', 'light', 'system']);
const UI_STYLES = Object.freeze(['flower', 'classic']);
const TOOLS = Object.freeze(['taskmgr', 'calc', 'explorer', 'settings', 'snip']);
const AUDIO_OPS = Object.freeze(['get', 'volume', 'mute']);
const BRIGHTNESS_OPS = Object.freeze(['get', 'set']);
const LAUNCHER_EXTS = Object.freeze(['.exe', '.lnk', '.bat', '.cmd']);
const CLIPBOARD_TTL_OPTIONS_MIN = Object.freeze([5, 60, 1440, 10080]);

const LIMITS = Object.freeze({
  notes: 50000,
  todos: 200,
  todoText: 500,
  launcherApps: 30,
  appName: 100,
  pathLen: 1024,
  notifTitle: 100,
  notifBody: 300,
  ifname: 64,
  idLen: 64,
  dragDelta: 20000
});

// Имя сетевого адаптера: буквы/цифры (любой язык), пробел, _ . ( ) -
// Никаких кавычек, $, `, ;, |, *, ?, [ ] — их нет и в реальных именах Wi-Fi адаптеров.
const IFNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.()\-]{0,63}$/u;

/* ---------- примитивы ---------- */

function bool(name) {
  return (v) => {
    if (typeof v !== 'boolean') throw new ValidationError(`${name}: ожидается true/false`);
    return v;
  };
}

function oneOf(name, list) {
  return (v) => {
    if (typeof v !== 'string' || !list.includes(v)) {
      throw new ValidationError(`${name}: недопустимое значение`);
    }
    return v;
  };
}

function numberIn(name, min, max) {
  return (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new ValidationError(`${name}: число вне диапазона ${min}…${max}`);
    }
    return v;
  };
}

function integerIn(name, min, max) {
  return (v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new ValidationError(`${name}: целое число ${min}…${max}`);
    }
    return v;
  };
}

function stringMax(name, max, { allowEmpty = true } = {}) {
  return (v) => {
    if (typeof v !== 'string') throw new ValidationError(`${name}: ожидается строка`);
    if (v.length > max) throw new ValidationError(`${name}: длиннее ${max} символов`);
    if (!allowEmpty && v.length === 0) throw new ValidationError(`${name}: пусто`);
    return v;
  };
}

function validateIfname(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!IFNAME_RE.test(s)) {
    throw new ValidationError(
      'Имя адаптера: допустимы буквы, цифры, пробел и символы _ . ( ) - (до 64 символов)'
    );
  }
  return s;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function todosValidator(v) {
  if (!Array.isArray(v) || v.length > LIMITS.todos) {
    throw new ValidationError(`todos: ожидается массив до ${LIMITS.todos} элементов`);
  }
  return v.map((t) => {
    if (!isPlainObject(t)) throw new ValidationError('todos: элемент должен быть объектом');
    return {
      text: stringMax('todos.text', LIMITS.todoText, { allowEmpty: false })(t.text),
      done: bool('todos.done')(t.done)
    };
  });
}

function launcherAppsValidator(v) {
  if (!Array.isArray(v) || v.length > LIMITS.launcherApps) {
    throw new ValidationError(`launcherApps: ожидается массив до ${LIMITS.launcherApps} элементов`);
  }
  return v.map((a) => {
    if (!isPlainObject(a)) throw new ValidationError('launcherApps: элемент должен быть объектом');
    return {
      path: stringMax('launcherApps.path', LIMITS.pathLen, { allowEmpty: false })(a.path),
      name: stringMax('launcherApps.name', LIMITS.appName, { allowEmpty: false })(a.name)
    };
  });
}

/* ---------- схема настроек ----------
 * rendererRead  — рендерер может читать ключ через store:get
 * rendererWrite — рендерер может писать ключ через store:set
 * Остальные ключи (позиция окна, закрепление и т.п.) меняет только main-процесс
 * через собственные проверенные каналы.
 */
const SETTINGS = Object.freeze({
  theme:        { validate: oneOf('theme', THEMES),       rendererRead: true,  rendererWrite: true },
  mode:         { validate: oneOf('mode', MODES),         rendererRead: true,  rendererWrite: true },
  opacity:      { validate: numberIn('opacity', 0.3, 1),  rendererRead: true,  rendererWrite: true },
  autoLaunch:   { validate: bool('autoLaunch'),           rendererRead: true,  rendererWrite: true },
  syncWinTheme: { validate: bool('syncWinTheme'),         rendererRead: true,  rendererWrite: true },
  notes:        { validate: stringMax('notes', LIMITS.notes), rendererRead: true, rendererWrite: true },
  wifiIfname:   { validate: validateIfname,               rendererRead: true,  rendererWrite: true },
  todos:        { validate: todosValidator,               rendererRead: true,  rendererWrite: true },
  launcherApps: { validate: launcherAppsValidator,        rendererRead: true,  rendererWrite: true },
  uiStyle:      { validate: oneOf('uiStyle', UI_STYLES),  rendererRead: true,  rendererWrite: true },
  collapseOnBlur: { validate: bool('collapseOnBlur'),     rendererRead: true,  rendererWrite: true },
  hotkeyEnabled:  { validate: bool('hotkeyEnabled'),      rendererRead: true,  rendererWrite: true },
  nowPlaying:     { validate: bool('nowPlaying'),         rendererRead: true,  rendererWrite: true },
  pillLive:       { validate: bool('pillLive'),           rendererRead: true,  rendererWrite: true },
  focusMinutes:   { validate: integerIn('focusMinutes', 1, 180), rendererRead: true, rendererWrite: true },

  // Только чтение из рендерера; запись — через выделенные каналы main-процесса
  pinned:       { validate: bool('pinned'),               rendererRead: true,  rendererWrite: false },
  monetAutoWatch: { validate: bool('monetAutoWatch'),     rendererRead: true,  rendererWrite: false },

  // Полностью внутренние ключи
  posX:         { validate: numberIn('posX', -100000, 100000), rendererRead: false, rendererWrite: false },
  posY:         { validate: numberIn('posY', -100000, 100000), rendererRead: false, rendererWrite: false }
});

function hasKey(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

function canRendererRead(key) {
  return hasKey(key) && SETTINGS[key].rendererRead;
}

/** Возвращает очищенное значение либо бросает ValidationError. */
function sanitizeRendererWrite(key, value) {
  if (!hasKey(key) || !SETTINGS[key].rendererWrite) {
    throw new ValidationError('Этот ключ настроек недоступен для записи');
  }
  return SETTINGS[key].validate(value);
}

/* ---------- IPC-аргументы ---------- */

function requireBoolean(v, name = 'значение') {
  return bool(name)(v);
}

function requirePlainObject(v, name = 'аргумент') {
  if (!isPlainObject(v)) throw new ValidationError(`${name}: ожидается объект`);
  return v;
}

function requireKnownKeys(obj, allowed, name = 'аргумент') {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ValidationError(`${name}: неизвестное поле «${k}»`);
  }
}

function validateNotification(payload) {
  const p = requirePlainObject(payload, 'уведомление');
  requireKnownKeys(p, ['title', 'body'], 'уведомление');
  const title = p.title === undefined ? '' : stringMax('title', LIMITS.notifTitle)(p.title);
  const body = p.body === undefined ? '' : stringMax('body', LIMITS.notifBody)(p.body);
  return { title, body };
}

function validateWifiPayload(payload, defaultIfname = 'Wi-Fi') {
  const p = requirePlainObject(payload, 'wifi');
  requireKnownKeys(p, ['enable', 'ifname'], 'wifi');
  return {
    enable: bool('enable')(p.enable),
    ifname: validateIfname(p.ifname === undefined || p.ifname === '' ? defaultIfname : p.ifname)
  };
}

function validateBluetoothPayload(payload) {
  const p = requirePlainObject(payload, 'bluetooth');
  requireKnownKeys(p, ['enable'], 'bluetooth');
  return { enable: bool('enable')(p.enable) };
}

function validateAudioPayload(payload) {
  const p = requirePlainObject(payload, 'audio');
  requireKnownKeys(p, ['op', 'level', 'muted'], 'audio');
  const op = oneOf('op', AUDIO_OPS)(p.op);
  const out = { op };
  if (op === 'volume') out.level = integerIn('level', 0, 100)(p.level);
  if (op === 'mute') out.muted = bool('muted')(p.muted);
  return out;
}

function validateBrightnessPayload(payload) {
  const p = requirePlainObject(payload, 'brightness');
  requireKnownKeys(p, ['op', 'level'], 'brightness');
  const op = oneOf('op', BRIGHTNESS_OPS)(p.op);
  const out = { op };
  if (op === 'set') out.level = integerIn('level', 0, 100)(p.level);
  return out;
}

function validateToggleOnly(payload, name) {
  const p = requirePlainObject(payload, name);
  requireKnownKeys(p, ['enable'], name);
  return { enable: bool('enable')(p.enable) };
}

function validateToolId(id) {
  return oneOf('tool', TOOLS)(id);
}

function validateDragDelta(payload) {
  const p = requirePlainObject(payload, 'drag');
  requireKnownKeys(p, ['dx', 'dy'], 'drag');
  const range = numberIn('смещение', -LIMITS.dragDelta, LIMITS.dragDelta);
  return { dx: range(p.dx), dy: range(p.dy) };
}

function validateClipboardPatch(patch) {
  const p = requirePlainObject(patch, 'clipboard');
  requireKnownKeys(p, ['enabled', 'paused', 'persist', 'ttlMin'], 'clipboard');
  const out = {};
  if (p.enabled !== undefined) out.enabled = bool('enabled')(p.enabled);
  if (p.paused !== undefined) out.paused = bool('paused')(p.paused);
  if (p.persist !== undefined) out.persist = bool('persist')(p.persist);
  if (p.ttlMin !== undefined) {
    if (!CLIPBOARD_TTL_OPTIONS_MIN.includes(p.ttlMin)) {
      throw new ValidationError('ttlMin: недопустимый срок хранения');
    }
    out.ttlMin = p.ttlMin;
  }
  return out;
}

function validateClipboardId(id) {
  return stringMax('id', LIMITS.idLen, { allowEmpty: false })(id);
}

/* ---------- лаунчер ---------- */

function normalizePathForCompare(p, platform = process.platform) {
  const n = path.normalize(p);
  return platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * Проверка пути для запуска: строка, абсолютный путь, разрешённое расширение.
 * Дополнительно main проверяет, что путь был выбран пользователем через системный диалог.
 */
function validateLauncherPath(p, platform = process.platform) {
  const s = stringMax('path', LIMITS.pathLen, { allowEmpty: false })(p);
  if (s.includes('\0')) throw new ValidationError('path: недопустимые символы');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(s)) throw new ValidationError('path: нужен абсолютный путь');
  const ext = pathApi.extname(s).toLowerCase();
  if (!LAUNCHER_EXTS.includes(ext)) throw new ValidationError('path: недопустимый тип файла');
  return s;
}

/* ---------- доверенный отправитель ---------- */

function isTrustedSenderUrl(url, trustedFilePath, platform = process.platform) {
  if (typeof url !== 'string') return false;
  let senderPath;
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    senderPath = fileURLToPath(u); // hash и query отбрасываются
  } catch (_) {
    return false;
  }
  return normalizePathForCompare(senderPath, platform) ===
    normalizePathForCompare(trustedFilePath, platform);
}

module.exports = {
  ValidationError,
  THEMES, MODES, UI_STYLES, TOOLS, AUDIO_OPS, BRIGHTNESS_OPS, LAUNCHER_EXTS, CLIPBOARD_TTL_OPTIONS_MIN, LIMITS, IFNAME_RE,
  SETTINGS, hasKey, canRendererRead, sanitizeRendererWrite,
  validateIfname, validateNotification, validateWifiPayload, validateBluetoothPayload,
  validateAudioPayload, validateBrightnessPayload, validateToggleOnly, validateToolId,
  validateDragDelta, validateClipboardPatch, validateClipboardId,
  validateLauncherPath, normalizePathForCompare, isTrustedSenderUrl,
  requireBoolean, isPlainObject
};
