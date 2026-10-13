'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkElectronApis, REQUIRED_APIS } = require('../lib/compat');

function fullElectron() {
  const e = {};
  for (const [name, members] of Object.entries(REQUIRED_APIS)) {
    e[name] = function () {};
    for (const m of members) e[name][m] = () => {};
  }
  return e;
}

test('все нужные API на месте → пусто', () => {
  assert.deepEqual(checkElectronApis(fullElectron()), []);
});

test('отсутствие метода или целого модуля обнаруживается', () => {
  const e = fullElectron();
  delete e.safeStorage.encryptString;
  delete e.desktopCapturer;
  e.dialog.showMessageBox = 'not a function';
  const missing = checkElectronApis(e);
  assert.ok(missing.includes('safeStorage.encryptString'));
  assert.ok(missing.includes('desktopCapturer'));
  assert.ok(missing.includes('dialog.showMessageBox'));
});

test('не-объект вместо electron не падает', () => {
  assert.ok(checkElectronApis(undefined).length > 0);
  assert.ok(checkElectronApis({}).length > 0);
});

test('список API покрывает всё, что main.js берёт из electron', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  const m = src.match(/const \{([\s\S]*?)\} = require\('electron'\);/);
  const used = m[1].split(',').map((x) => x.trim()).filter(Boolean);
  for (const name of used) assert.ok(name in REQUIRED_APIS, `${name} не проверяется в lib/compat.js`);
});
