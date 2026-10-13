'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ps = require('../lib/powershell');
const v = require('../lib/validation');
const { MediaWatcher, sanitizeMediaState } = require('../lib/mediaWatcher');

const decodeB64 = (b) => Buffer.from(b, 'base64').toString('utf8');

/* ---------- валидация ---------- */
test('audio/brightness: только допустимые операции и значения', () => {
  assert.deepEqual(v.validateAudioPayload({ op: 'get' }), { op: 'get' });
  assert.deepEqual(v.validateAudioPayload({ op: 'volume', level: 40 }), { op: 'volume', level: 40 });
  assert.deepEqual(v.validateAudioPayload({ op: 'mute', muted: true }), { op: 'mute', muted: true });
  for (const bad of [null, {}, { op: 'volume' }, { op: 'volume', level: 101 }, { op: 'volume', level: 1.5 },
    { op: 'volume', level: '5' }, { op: 'mute', muted: 1 }, { op: 'x' }, { op: 'get', extra: 1 }]) {
    assert.throws(() => v.validateAudioPayload(bad), v.ValidationError);
  }
  assert.deepEqual(v.validateBrightnessPayload({ op: 'set', level: 0 }), { op: 'set', level: 0 });
  assert.throws(() => v.validateBrightnessPayload({ op: 'set', level: -1 }), v.ValidationError);
  assert.throws(() => v.validateBrightnessPayload({ op: 'set' }), v.ValidationError);
});

test('инструменты: только allowlist', () => {
  for (const t of v.TOOLS) assert.equal(v.validateToolId(t), t);
  for (const bad of ['cmd', 'powershell', '../x', '', 5, null, '__proto__', 'constructor']) {
    assert.throws(() => v.validateToolId(bad), v.ValidationError);
  }
});

test('новые настройки: стиль, режим, палитры, таймер', () => {
  assert.equal(v.sanitizeRendererWrite('uiStyle', 'flower'), 'flower');
  assert.throws(() => v.sanitizeRendererWrite('uiStyle', 'evil'));
  assert.equal(v.sanitizeRendererWrite('mode', 'system'), 'system');
  for (const t of ['sakura', 'lavender', 'peach', 'mint']) assert.equal(v.sanitizeRendererWrite('theme', t), t);
  assert.equal(v.sanitizeRendererWrite('focusMinutes', 45), 45);
  assert.throws(() => v.sanitizeRendererWrite('focusMinutes', 0));
  assert.throws(() => v.sanitizeRendererWrite('focusMinutes', 2.5));
  assert.throws(() => v.sanitizeRendererWrite('collapseOnBlur', 'yes'));
});

/* ---------- PowerShell-шаблоны ---------- */
test('шаблоны громкости/яркости/состояния: параметры только в Base64, плейсхолдеров не остаётся', () => {
  const scripts = [
    ps.buildAudioScript({ op: 'volume', level: 33 }), ps.buildAudioScript({ op: 'mute', muted: false }),
    ps.buildAudioScript({ op: 'get' }), ps.buildBrightnessScript({ op: 'set', level: 70 }),
    ps.buildBrightnessScript({ op: 'get' }), ps.buildDndScript({ enable: true }),
    ps.buildStateScript(), ps.buildMediaWatchScript({ parentPid: 4242 })
  ];
  for (const s of scripts) assert.ok(!s.includes('__PARAMS_B64__'));
  const a = ps.buildAudioScript({ op: 'volume', level: 33 });
  const b64 = a.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1];
  assert.deepEqual(JSON.parse(decodeB64(b64)), { op: 'volume', level: 33 });
  assert.match(a, /IAudioEndpointVolume/);
  assert.throws(() => ps.buildAudioScript({ op: 'volume', level: 500 }));
  assert.throws(() => ps.buildBrightnessScript({ op: 'set', level: 'x' }));
  assert.throws(() => ps.buildMediaWatchScript({ parentPid: '1; calc' }));
  assert.throws(() => ps.buildDndScript({ enable: 'yes' }));
});

test('C#-вставка с here-string: закрывающий \'@ в начале строки', () => {
  const a = ps.buildAudioScript({ op: 'get' });
  assert.ok(/^'@$/m.test(a));
  assert.ok(/\$src = @'$/m.test(a));
});

test('runPowerShellJson: разбор stdout, BOM, мусор, коды выхода', async () => {
  const mk = (err, out) => (f, a, o, cb) => cb(err, out);
  let r = await ps.runPowerShellJson('x', { execFile: mk(null, '\uFEFF{"volume":10,"muted":false}\r\n') });
  assert.equal(r.success, true); assert.equal(r.data.volume, 10);
  r = await ps.runPowerShellJson('x', { execFile: mk(null, 'не json') });
  assert.equal(r.success, false);
  r = await ps.runPowerShellJson('x', { execFile: mk(Object.assign(new Error('x'), { code: 4 }), '') });
  assert.equal(r.code, ps.EXIT.UNSUPPORTED);
  assert.match(r.message, /Не поддерживается/);
});

/* ---------- «Сейчас играет» ---------- */
test('sanitizeMediaState: чистит строки, обложку, статус и числа', () => {
  const s = sanitizeMediaState({
    active: true, status: 'Playing', title: 'A\u0000B\n' + 'x'.repeat(500), artist: 5, album: 'Al',
    app: 'Spotify.exe', pos: -3, dur: 1e12, art: 'QUJD', mime: 'image/png'
  });
  assert.ok(s.title.length <= 200 && !/[\u0000\n]/.test(s.title));
  assert.equal(s.artist, ''); assert.equal(s.app, 'Spotify'); assert.equal(s.pos, 0);
  assert.ok(s.dur <= 86400 * 3); assert.equal(s.art, 'QUJD');
  assert.equal(sanitizeMediaState({ active: true, art: 'QUJD', mime: 'text/html' }).art, undefined);
  assert.equal(sanitizeMediaState({ active: true, art: '<script>', mime: 'image/png' }).art, undefined);
  assert.equal(sanitizeMediaState({ active: true, status: 'Hacked' }).status, 'Closed');
  assert.deepEqual(sanitizeMediaState({ active: false }), { active: false });
  assert.equal(sanitizeMediaState(null), null);
  assert.equal(sanitizeMediaState([]), null);
});

function fakeSpawn() {
  const handlers = {}; const out = {};
  const child = {
    stdout: { setEncoding() {}, on: (e, f) => { out[e] = f; }, removeAllListeners() {} },
    on: (e, f) => { handlers[e] = f; }, removeAllListeners() {}, kill() { child.killed = true; }
  };
  return { child, handlers, out, spawn: () => child };
}
const line = (o) => Buffer.from(JSON.stringify(o)).toString('base64') + '\n';

test('MediaWatcher: обложка уходит только при смене, snapshot хранит её', () => {
  const f = fakeSpawn(); const got = [];
  const w = new MediaWatcher({ spawn: f.spawn, buildCommand: () => ({ file: 'x', args: [] }), onUpdate: (s) => got.push(s) });
  w.start();
  const base = { active: true, status: 'Playing', title: 'T', artist: 'A', album: '', app: 'x.exe', pos: 1, dur: 100 };
  f.out.data(line({ ...base, art: 'QUJD', mime: 'image/jpeg' }));
  f.out.data(line({ ...base, pos: 3 }));
  f.out.data(line({ ...base, title: 'T2', pos: 0 }));
  assert.equal(got[0].artChanged, true); assert.equal(got[0].art, 'QUJD');
  assert.equal(got[1].artChanged, false); assert.equal(got[1].art, undefined);
  assert.equal(got[2].artChanged, true); assert.equal(got[2].art, undefined);
  f.out.data('!!!мусор!!!\n'); f.out.data(Buffer.from('{bad').toString('base64') + '\n');
  assert.equal(got.length, 3);
  assert.equal(w.snapshot().title, 'T2');
  w.stop(); assert.ok(f.child.killed);
});

test('MediaWatcher: перезапуски с лимитом, затем failed', () => {
  const timers = []; let spawns = 0; const got = [];
  const f = fakeSpawn();
  const w = new MediaWatcher({
    spawn: () => { spawns++; return f.child; }, buildCommand: () => ({ file: 'x', args: [] }),
    onUpdate: (s) => got.push(s), setTimer: (fn) => { timers.push(fn); return 1; }, clearTimer() {}, maxRestarts: 2
  });
  w.start();
  for (let i = 0; i < 4; i++) {
    f.handlers.exit && f.handlers.exit();
    const t = timers.shift(); if (t) t();
  }
  assert.ok(spawns >= 2 && spawns <= 3);
  assert.equal(got.at(-1).failed, true);
});

/* ---------- статические проверки интерфейса ---------- */
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('рендерер: нет небезопасных DOM-API во всех скриптах', () => {
  for (const f of ['app.js', 'control.js']) {
    const src = read('renderer', f);
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(src), f);
    assert.ok(!/setAttribute\(\s*['"]style/.test(src), f);
  }
});

test('Flower UI: палитры, стиль и украшения на месте', () => {
  const css = read('renderer', 'styles.css');
  for (const t of ['sakura', 'lavender', 'peach', 'mint']) {
    assert.match(css, new RegExp(`body\\[data-theme="${t}"\\]\\[data-mode="light"\\]`));
    assert.match(css, new RegExp(`body\\[data-theme="${t}"\\]\\[data-mode="dark"\\]`));
  }
  assert.match(css, /body\[data-style="flower"\]/);
  assert.match(css, /\.bloom-layer/);
  const html = read('renderer', 'index.html');
  for (const id of ['tileWifi', 'tileBt', 'brightnessRange', 'volumeRange', 'settingsSeg', 'styleSeg', 'modeSeg']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const t of v.THEMES) assert.ok(html.includes(`data-theme="${t}"`), `нет свотча ${t}`);
});

test('размеры окна в main.js совпадают с CSS-токенами', () => {
  const main = read('main.js'); const css = read('renderer', 'styles.css');
  const c = main.match(/COLLAPSED = \{ w: (\d+), h: (\d+) \}/); const e = main.match(/EXPANDED = \{ w: (\d+), h: (\d+) \}/);
  assert.ok(css.includes(`--pill-w: ${c[1]}px; --pill-h: ${c[2]}px`));
  assert.ok(css.includes(`--exp-w: ${e[1]}px;  --exp-h: ${e[2]}px`));
});
