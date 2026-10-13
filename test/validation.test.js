'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../lib/validation');

const throwsValidation = (fn) => assert.throws(fn, (e) => e instanceof v.ValidationError);

test('имя адаптера: допускает реальные имена', () => {
  for (const ok of ['Wi-Fi', 'Wi-Fi 2', 'Беспроводная сеть', 'Ethernet (2)', 'WLAN_1.0']) {
    assert.equal(v.validateIfname(ok), ok);
  }
  assert.equal(v.validateIfname('  Wi-Fi  '), 'Wi-Fi'); // trim
});

test('имя адаптера: отклоняет инъекции и мусор', () => {
  const bad = [
    'Wi-Fi"; calc; "', "Wi-Fi'; calc; '", '$(calc)', '`calc`', 'a;b', 'a|b', 'a&b', 'a*', 'a?',
    '[a]', 'a\nb', 'a\0b', '-Wi-Fi', '', '   ', 'x'.repeat(65), null, undefined, 42, {}, [], 'a{b}', 'a<b>', 'a,b'
  ];
  for (const b of bad) throwsValidation(() => v.validateIfname(b));
});

test('настройки: запись — allowlist ключей, прототипные и служебные ключи не проходят', () => {
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'unknown', '', 'a.b', 'posX',
    'pinned', 'monetAutoWatch', 'monetTheme', 'launcherApproved', 'clipboardEnabled', 'clipboardHistoryEnc', 42, null]) {
    throwsValidation(() => v.sanitizeRendererWrite(k, true));
  }
});

test('настройки: чтение — только разрешённые ключи', () => {
  for (const k of ['theme', 'mode', 'opacity', 'autoLaunch', 'notes', 'todos', 'launcherApps', 'pinned', 'monetAutoWatch', 'wifiIfname', 'syncWinTheme']) {
    assert.equal(v.canRendererRead(k), true, k);
  }
  for (const k of ['posX', 'posY', 'monetTheme', 'launcherApproved', 'clipboardHistoryEnc', '__proto__', 'constructor']) {
    assert.equal(v.canRendererRead(k), false, k);
  }
});

test('настройки: типы и диапазоны', () => {
  assert.equal(v.sanitizeRendererWrite('theme', 'monet'), 'monet');
  throwsValidation(() => v.sanitizeRendererWrite('theme', 'evil'));
  throwsValidation(() => v.sanitizeRendererWrite('theme', 5));
  assert.equal(v.sanitizeRendererWrite('mode', 'light'), 'light');
  throwsValidation(() => v.sanitizeRendererWrite('mode', 'auto'));
  assert.equal(v.sanitizeRendererWrite('opacity', 0.8), 0.8);
  for (const bad of [0, 1.5, NaN, Infinity, '0.8', null]) throwsValidation(() => v.sanitizeRendererWrite('opacity', bad));
  throwsValidation(() => v.sanitizeRendererWrite('autoLaunch', 'true'));
  throwsValidation(() => v.sanitizeRendererWrite('autoLaunch', 1));
  assert.equal(v.sanitizeRendererWrite('autoLaunch', false), false);
});

test('настройки: лимит размера заметок', () => {
  assert.equal(v.sanitizeRendererWrite('notes', 'x'.repeat(v.LIMITS.notes)).length, v.LIMITS.notes);
  throwsValidation(() => v.sanitizeRendererWrite('notes', 'x'.repeat(v.LIMITS.notes + 1)));
  throwsValidation(() => v.sanitizeRendererWrite('notes', { a: 1 }));
});

test('todos: форма, лимиты и очистка лишних полей', () => {
  const clean = v.sanitizeRendererWrite('todos', [{ text: 'a', done: false, extra: '<script>' }]);
  assert.deepEqual(clean, [{ text: 'a', done: false }]);
  throwsValidation(() => v.sanitizeRendererWrite('todos', 'nope'));
  throwsValidation(() => v.sanitizeRendererWrite('todos', [{ text: '', done: false }]));
  throwsValidation(() => v.sanitizeRendererWrite('todos', [{ text: 'a', done: 'no' }]));
  throwsValidation(() => v.sanitizeRendererWrite('todos', [null]));
  throwsValidation(() => v.sanitizeRendererWrite('todos', new Array(v.LIMITS.todos + 1).fill({ text: 'a', done: false })));
  throwsValidation(() => v.sanitizeRendererWrite('todos', [{ text: 'x'.repeat(v.LIMITS.todoText + 1), done: false }]));
});

test('launcherApps: форма и лимиты', () => {
  const clean = v.sanitizeRendererWrite('launcherApps', [{ path: 'C:\\a.exe', name: 'A', evil: 1 }]);
  assert.deepEqual(clean, [{ path: 'C:\\a.exe', name: 'A' }]);
  throwsValidation(() => v.sanitizeRendererWrite('launcherApps', [{ path: 5, name: 'A' }]));
  throwsValidation(() => v.sanitizeRendererWrite('launcherApps', new Array(v.LIMITS.launcherApps + 1).fill({ path: 'a', name: 'b' })));
});

test('путь лаунчера: абсолютный, разрешённое расширение', () => {
  assert.equal(v.validateLauncherPath('C:\\Program Files\\App\\app.exe', 'win32'), 'C:\\Program Files\\App\\app.exe');
  assert.equal(v.validateLauncherPath('C:\\x\\y.LNK', 'win32'), 'C:\\x\\y.LNK');
  for (const bad of ['app.exe', '..\\app.exe', 'C:\\x\\y.ps1', 'C:\\x\\y.js', 'C:\\x\\y', 'C:\\x\\y.exe\0', '', 5, null, 'x'.repeat(2000) + '.exe']) {
    throwsValidation(() => v.validateLauncherPath(bad, 'win32'));
  }
});

test('IPC-аргументы: уведомления', () => {
  assert.deepEqual(v.validateNotification({ title: 'a', body: 'b' }), { title: 'a', body: 'b' });
  assert.deepEqual(v.validateNotification({}), { title: '', body: '' });
  throwsValidation(() => v.validateNotification({ title: 'x'.repeat(101) }));
  throwsValidation(() => v.validateNotification({ body: 'x'.repeat(301) }));
  throwsValidation(() => v.validateNotification({ title: 1 }));
  throwsValidation(() => v.validateNotification({ title: 'a', icon: 'file:///etc/passwd' }));
  throwsValidation(() => v.validateNotification('str'));
  throwsValidation(() => v.validateNotification(null));
});

test('IPC-аргументы: wifi / bluetooth / drag', () => {
  assert.deepEqual(v.validateWifiPayload({ enable: true, ifname: 'Wi-Fi' }), { enable: true, ifname: 'Wi-Fi' });
  assert.deepEqual(v.validateWifiPayload({ enable: false }, 'Моя сеть'), { enable: false, ifname: 'Моя сеть' });
  throwsValidation(() => v.validateWifiPayload({ enable: 'yes', ifname: 'Wi-Fi' }));
  throwsValidation(() => v.validateWifiPayload({ enable: true, ifname: '$(calc)' }));
  throwsValidation(() => v.validateWifiPayload({ enable: true, ifname: 'Wi-Fi', cmd: 'x' }));
  throwsValidation(() => v.validateWifiPayload(null));
  assert.deepEqual(v.validateBluetoothPayload({ enable: false }), { enable: false });
  throwsValidation(() => v.validateBluetoothPayload({ enable: 1 }));
  assert.deepEqual(v.validateDragDelta({ dx: -5, dy: 12.5 }), { dx: -5, dy: 12.5 });
  for (const bad of [{ dx: NaN, dy: 0 }, { dx: 0, dy: Infinity }, { dx: '1', dy: 0 }, { dx: 1e9, dy: 0 }, { dx: 1 }, { dx: 1, dy: 1, z: 1 }]) {
    throwsValidation(() => v.validateDragDelta(bad));
  }
});

test('IPC-аргументы: настройки буфера обмена', () => {
  assert.deepEqual(v.validateClipboardPatch({ enabled: true, paused: false, persist: false, ttlMin: 60 }),
    { enabled: true, paused: false, persist: false, ttlMin: 60 });
  assert.deepEqual(v.validateClipboardPatch({}), {});
  for (const bad of [{ enabled: 'yes' }, { ttlMin: 7 }, { ttlMin: '60' }, { foo: 1 }, { __proto__x: 1, enabled: true }, 'x', null]) {
    throwsValidation(() => v.validateClipboardPatch(bad));
  }
  assert.equal(v.validateClipboardId('abc'), 'abc');
  for (const bad of ['', 5, null, 'x'.repeat(65)]) throwsValidation(() => v.validateClipboardId(bad));
});

test('доверенный отправитель: только наш index.html', () => {
  const trusted = '/app/renderer/index.html';
  assert.equal(v.isTrustedSenderUrl('file:///app/renderer/index.html', trusted, 'linux'), true);
  assert.equal(v.isTrustedSenderUrl('file:///app/renderer/index.html#x', trusted, 'linux'), true);
  assert.equal(v.isTrustedSenderUrl('file:///app/renderer/index.html?q=1', trusted, 'linux'), true);
  for (const bad of ['file:///app/renderer/other.html', 'https://evil.example/', 'http://localhost/', 'about:blank',
    'file:///app/renderer/../main.js', '', undefined, null, 5]) {
    assert.equal(v.isTrustedSenderUrl(bad, trusted, 'linux'), false, String(bad));
  }
});

test('доверенный отправитель: Windows — регистр и слэши', () => {
  assert.equal(v.normalizePathForCompare('C:\\App\\Renderer\\index.html', 'win32'),
    v.normalizePathForCompare('c:\\app\\renderer\\INDEX.html', 'win32'));
});
