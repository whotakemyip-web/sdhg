'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../lib/powershell');
const { ValidationError } = require('../lib/validation');

const decodeUtf16 = (b64) => Buffer.from(b64, 'base64').toString('utf16le');
const innerFromLauncher = (launcher) => {
  const m = launcher.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/);
  assert.ok(m, 'внутренний EncodedCommand не найден');
  return decodeUtf16(m[1]);
};

const INJECTIONS = [
  'Wi-Fi"; Start-Process calc; "', "Wi-Fi'; calc; '", '$(calc)', '`n', 'a;b', 'a|b', 'a\nb', '$env:USERNAME', "'; exit; '"
];

test('Wi-Fi: инъекции в имени адаптера отклоняются до построения скрипта', () => {
  for (const name of INJECTIONS) {
    assert.throws(() => ps.buildWifiScript({ name, enable: true }), (e) => e instanceof ValidationError, name);
  }
});

test('Wi-Fi: имя попадает в скрипт только как Base64-данные', () => {
  const name = 'Беспроводная сеть 2';
  const script = ps.buildWifiScript({ name, enable: false });
  assert.ok(!script.includes(name), 'сырое имя не должно присутствовать в тексте скрипта');
  const b64 = script.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.match(b64, /^[A-Za-z0-9+/]*={0,2}$/);
  assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), { name, enable: false });
  assert.ok(script.includes('Enable-NetAdapter') && script.includes('Disable-NetAdapter'));
  assert.ok(!script.includes('__PARAMS_B64__'));
});

test('Wi-Fi: шаблон неизменен при разных входных данных (кроме Base64)', () => {
  const strip = (s) => s.replace(/FromBase64String\('[^']+'\)/, 'X');
  assert.equal(strip(ps.buildWifiScript({ name: 'A', enable: true })), strip(ps.buildWifiScript({ name: 'Другое имя (3)', enable: false })));
});

test('Wi-Fi/Bluetooth: enable должен быть boolean', () => {
  for (const bad of ['true', 1, null, undefined, {}]) {
    assert.throws(() => ps.buildWifiScript({ name: 'Wi-Fi', enable: bad }), ValidationError);
    assert.throws(() => ps.buildBluetoothScript({ enable: bad }), ValidationError);
  }
});

test('Bluetooth: скрипт фиксирован, параметр — только Base64', () => {
  const s = ps.buildBluetoothScript({ enable: true });
  const b64 = s.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), { enable: true });
  assert.ok(s.includes('Get-PnpDevice'));
});

test('Повышение прав: внутренний скрипт передаётся Base64 и запускается с RunAs, без файлов', () => {
  const inner = ps.buildBluetoothScript({ enable: false });
  const launcher = ps.buildElevationLauncher(inner);
  assert.ok(launcher.includes('-Verb RunAs'));
  assert.ok(launcher.includes('-PassThru') && launcher.includes('exit $p.ExitCode'));
  assert.ok(!/\.ps1|Set-Content|tmp|temp/i.test(launcher), 'не должно быть временных файлов');
  assert.equal(innerFromLauncher(launcher), inner);
});

test('Ключи: допустимый диапазон и защита от прототипных имён', () => {
  assert.equal(ps.getVirtualKey('playpause'), 0xb3);
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', null, undefined, 5, 'PLAYPAUSE']) {
    assert.equal(ps.getVirtualKey(bad), null, String(bad));
  }
  assert.match(ps.buildKeyScript(0xb3), /keybd_event\(179, 0, 0/);
  for (const bad of [-1, 256, 1.5, NaN, '179', '1); calc #', null]) assert.throws(() => ps.buildKeyScript(bad), ValidationError);
});

test('Тема Windows: только boolean, значение 0/1', () => {
  assert.match(ps.buildThemeScript(true), /AppsUseLightTheme -Value 0/);
  assert.match(ps.buildThemeScript(false), /SystemUsesLightTheme -Value 1/);
  for (const bad of ['dark', 1, null, undefined]) assert.throws(() => ps.buildThemeScript(bad), ValidationError);
});

/* ---------- запуск и обработка ошибок ---------- */
const fakeExec = (err) => {
  const calls = [];
  const fn = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(err); };
  fn.calls = calls;
  return fn;
};

test('runPowerShell: успех, аргументы без shell-строки', async () => {
  const execFile = fakeExec(null);
  const res = await ps.runPowerShell('Write-Output 1', { execFile });
  assert.deepEqual(res, { success: true, code: 0, message: 'Готово' });
  const { file, args, opts } = execFile.calls[0];
  assert.equal(file, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(decodeUtf16(args[3]), 'Write-Output 1');
  assert.equal(opts.windowsHide, true);
  assert.ok(opts.timeout > 0);
});

test('runElevated: коды выхода превращаются в понятные сообщения', async () => {
  const cases = [
    [Object.assign(new Error('x'), { code: 2 }), /не найдено/i, 2],
    [Object.assign(new Error('x'), { code: 3 }), /Не удалось выполнить/, 3],
    [Object.assign(new Error('x'), { code: 10 }), /отклонён/, 10],
    [Object.assign(new Error('x'), { code: 77 }), /код 77/, 77]
  ];
  for (const [err, re, code] of cases) {
    const res = await ps.runElevated('x', { execFile: fakeExec(err) });
    assert.equal(res.success, false);
    assert.equal(res.code, code);
    assert.match(res.message, re);
  }
});

test('runElevated: ENOENT, таймаут и исключение execFile не роняют приложение', async () => {
  let res = await ps.runElevated('x', { execFile: fakeExec(Object.assign(new Error('spawn'), { code: 'ENOENT' })) });
  assert.equal(res.success, false);
  assert.match(res.message, /не найден/);

  res = await ps.runElevated('x', { execFile: fakeExec(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' })) });
  assert.equal(res.success, false);
  assert.match(res.message, /время ожидания/);

  res = await ps.runElevated('x', { execFile: () => { throw new Error('boom'); } });
  assert.equal(res.success, false);

  res = await ps.runElevated('x', { execFile: fakeExec(new Error('strange')) });
  assert.equal(res.success, false);
  assert.ok(!res.message.includes('strange'), 'внутренний текст ошибки не раскрывается');
});

test('mapExecResult: сообщение об ошибке не содержит пути/стека', () => {
  const r = ps.mapExecResult(new Error('C:\\Users\\secret\\file failed'));
  assert.ok(!r.message.includes('secret'));
});
