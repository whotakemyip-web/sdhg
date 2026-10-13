'use strict';

/**
 * «Сейчас играет»: долгоживущий PowerShell-процесс опрашивает системные медиа-сессии Windows
 * (GlobalSystemMediaTransportControls) и печатает по строке Base64(JSON) при изменениях.
 * Этот модуль разбирает строки, ЖЁСТКО очищает данные (название трека и обложка приходят от
 * стороннего приложения — считаем их недоверенными) и перезапускает процесс при сбоях.
 * Электрон не нужен — модуль тестируется отдельно, spawn подставляется снаружи.
 */

const ALLOWED_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif']);
const STATUSES = Object.freeze(['Closed', 'Opened', 'Changing', 'Stopped', 'Playing', 'Paused']);
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_ART_B64 = 560000;      // ~400 КБ бинарных данных
const MAX_LINE = 1400000;        // защита от бесконечной строки без перевода строки

function clip(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max);
}

function num(v, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0;
}

function prettyApp(raw) {
  const s = clip(raw, 120);
  if (!s) return '';
  // «Spotify.exe», «chrome.exe», «Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic»
  const base = s.split('!').pop().split('\\').pop().replace(/\.exe$/i, '');
  return base.slice(0, 60);
}

/** Приводит сырой объект от PowerShell к безопасному виду. Возвращает null для мусора. */
function sanitizeMediaState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.active !== true) return { active: false };

  const status = STATUSES.includes(raw.status) ? raw.status : 'Closed';
  const out = {
    active: true,
    status,
    title: clip(raw.title, 200),
    artist: clip(raw.artist, 150),
    album: clip(raw.album, 150),
    app: prettyApp(raw.app),
    pos: num(raw.pos, 86400 * 3),
    dur: num(raw.dur, 86400 * 3)
  };
  if (typeof raw.art === 'string' && raw.art.length > 0 && raw.art.length <= MAX_ART_B64 &&
      B64_RE.test(raw.art) && ALLOWED_MIME.includes(raw.mime)) {
    out.art = raw.art;
    out.mime = raw.mime;
  }
  return out;
}

class MediaWatcher {
  /**
   * @param {object} o
   * @param {Function} o.spawn         — child_process.spawn (или подмена в тестах)
   * @param {Function} o.buildCommand  — () => { file, args } для запуска наблюдателя
   * @param {Function} o.onUpdate      — (state) => void; state без art, если обложка не менялась
   * @param {Function} [o.setTimer]    — для тестов
   */
  constructor({ spawn, buildCommand, onUpdate, setTimer = setTimeout, clearTimer = clearTimeout, maxRestarts = 5 }) {
    this.spawn = spawn;
    this.buildCommand = buildCommand;
    this.onUpdate = onUpdate;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.maxRestarts = maxRestarts;
    this.child = null;
    this.buffer = '';
    this.running = false;
    this.restarts = 0;
    this.restartTimer = null;
    this.last = { active: false };
    this.lastArt = null;       // { art, mime } для текущего трека
    this.lastTrackKey = '';
    this.failed = false;
  }

  /** Полное состояние (вместе с обложкой) — для рендерера, который загрузился позже. */
  snapshot() {
    const s = { ...this.last, failed: this.failed, artChanged: true };
    if (this.lastArt) { s.art = this.lastArt.art; s.mime = this.lastArt.mime; }
    return s;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.failed = false;
    this.restarts = 0;
    this._spawn();
  }

  stop() {
    this.running = false;
    if (this.restartTimer) { this.clearTimer(this.restartTimer); this.restartTimer = null; }
    this._kill();
    this.last = { active: false };
    this.lastArt = null;
    this.lastTrackKey = '';
    this.buffer = '';
  }

  _kill() {
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.removeAllListeners(); } catch (_) { /* ignore */ }
      try { if (c.stdout) c.stdout.removeAllListeners(); } catch (_) { /* ignore */ }
      try { c.kill(); } catch (_) { /* ignore */ }
    }
  }

  _spawn() {
    let child;
    try {
      const { file, args } = this.buildCommand();
      child = this.spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
      this._scheduleRestart();
      return;
    }
    this.child = child;
    this.buffer = '';
    if (child.stdout) {
      child.stdout.setEncoding && child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._onData(String(chunk)));
    }
    child.on('error', () => { if (this.child === child) { this.child = null; this._scheduleRestart(); } });
    child.on('exit', () => { if (this.child === child) { this.child = null; this._scheduleRestart(); } });
  }

  _scheduleRestart() {
    if (!this.running) return;
    this.restarts += 1;
    if (this.restarts > this.maxRestarts) {
      // Наблюдатель не поднимается (например, старая Windows без WinRT-API) — сдаёмся тихо.
      this.running = false;
      this.failed = true;
      this.last = { active: false };
      this.onUpdate({ ...this.last, failed: true, artChanged: true });
      return;
    }
    this.restartTimer = this.setTimer(() => { this.restartTimer = null; this._spawn(); }, Math.min(30000, 1500 * this.restarts));
    if (this.restartTimer && this.restartTimer.unref) this.restartTimer.unref();
  }

  _onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE && !this.buffer.includes('\n')) { this.buffer = ''; return; }
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this._handleLine(line);
    }
  }

  _handleLine(line) {
    if (line.length > MAX_LINE || !B64_RE.test(line)) return;
    let state;
    try {
      state = sanitizeMediaState(JSON.parse(Buffer.from(line, 'base64').toString('utf8')));
    } catch (_) {
      return;
    }
    if (!state) return;
    this.restarts = 0; // процесс жив и отвечает

    if (!state.active) {
      this.last = state;
      this.lastArt = null;
      this.lastTrackKey = '';
      this.onUpdate({ ...state, artChanged: true });
      return;
    }

    const trackKey = `${state.title}\u0001${state.artist}\u0001${state.album}`;
    let artChanged = false;
    if (trackKey !== this.lastTrackKey) {
      this.lastTrackKey = trackKey;
      this.lastArt = null;
      artChanged = true;
    }
    if (state.art) {
      if (!this.lastArt || this.lastArt.art !== state.art) artChanged = true;
      this.lastArt = { art: state.art, mime: state.mime };
    }

    const { art, mime, ...rest } = state;
    this.last = { ...rest, trackKey };
    const payload = { ...this.last, artChanged };
    if (artChanged && this.lastArt) { payload.art = this.lastArt.art; payload.mime = this.lastArt.mime; }
    this.onUpdate(payload);
  }
}

module.exports = { MediaWatcher, sanitizeMediaState, ALLOWED_MIME, STATUSES, MAX_ART_B64 };
