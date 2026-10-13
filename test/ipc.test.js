'use strict';
/**
 * Интеграционный тест: загружаем настоящий main.js с подменённым electron / electron-store /
 * child_process и вызываем зарегистрированные IPC-обработчики с вредоносными аргументами.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const INDEX_URL = pathToFileURL(path.join(ROOT, 'renderer', 'index.html')).href;
const decodeUtf16 = (b64) => Buffer.from(b64, 'base64').toString('utf16le');

function loadMain({ dialogResponse = 0, openDialogPaths = null } = {}) {
  const handlers = new Map();
  const data = new Map();
  const calls = { execFile: [], dialog: [], clipWrites: [], opened: [], notified: 0, login: [], external: [], shortcuts: [], blocker: [], spawn: [] };
  const state = {
    dialogResponse,
    execError: null,
    execHang: false,
    clipboardText: '',
    clipboardBuffers: {}
  };

  const electron = {
    app: {
      whenReady: () => new Promise(() => {}),
      quit() {}, on() {}, getPath: () => os.tmpdir(), isPackaged: true,
      setLoginItemSettings: (o) => calls.login.push(o)
    },
    BrowserWindow: class {}, Tray: class {},
    Menu: { buildFromTemplate: () => ({}) },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, size: { width: 1920, height: 1080 } }),
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    desktopCapturer: { getSources: async () => [] },
    clipboard: {
      readText: () => state.clipboardText,
      writeText: (t) => calls.clipWrites.push(t),
      writeImage() {},
      readBuffer: (fmt) => state.clipboardBuffers[fmt] || Buffer.alloc(0)
    },
    Notification: Object.assign(class { show() { calls.notified++; } }, { isSupported: () => true }),
    dialog: {
      showOpenDialog: async () => (openDialogPaths
        ? { canceled: false, filePaths: openDialogPaths } : { canceled: true, filePaths: [] }),
      showMessageBox: async (...a) => { calls.dialog.push(a); return { response: state.dialogResponse }; },
      showErrorBox() {}
    },
    shell: {
      openPath: async (p) => { calls.opened.push(p); return ''; },
      openExternal: async (u) => { calls.external.push(u); }
    },
    globalShortcut: {
      register: (k, fn) => { calls.shortcuts.push(['register', k]); state.hotkeyFn = fn; return true; },
      unregister: (k) => calls.shortcuts.push(['unregister', k]),
      unregisterAll() {}
    },
    powerSaveBlocker: {
      start: (t) => { calls.blocker.push(['start', t]); return 7; },
      stop: (id) => calls.blocker.push(['stop', id])
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => b.toString('utf8')
    },
    session: { defaultSession: {} }
  };

  class FakeStore {
    constructor({ defaults }) { for (const [k, v] of Object.entries(defaults)) data.set(k, v); }
    get(k) { return data.get(k); }
    set(k, v) { data.set(k, v); }
    delete(k) { data.delete(k); }
  }

  const childProcess = {
    execFile: (file, args, opts, cb) => {
      calls.execFile.push({ file, args });
      if (state.execHang) return;
      cb(state.execError, state.execStdout || '');
    },
    spawn: (file, args) => {
      calls.spawn.push({ file, args });
      const child = {
        stdout: { on() {}, setEncoding() {}, removeAllListeners() {} },
        on() {}, removeAllListeners() {}, kill() { calls.spawn.push('killed'); }
      };
      return child;
    }
  };

  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electron;
    if (request === 'electron-store') return FakeStore;
    if (request === 'node:child_process' || request === 'child_process') return childProcess;
    return origLoad.call(this, request, ...rest);
  };
  const mainPath = require.resolve('../main.js');
  delete require.cache[mainPath];
  try { require(mainPath); } finally { Module._load = origLoad; }

  const goodEvent = { senderFrame: { url: INDEX_URL }, sender: {} };
  return {
    handlers, data, calls, state,
    invoke: (ch, ...args) => handlers.get(ch)(goodEvent, ...args),
    invokeAs: (event, ch, ...args) => handlers.get(ch)(event, ...args)
  };
}

test('все ожидаемые каналы зарегистрированы, лишних нет', () => {
  const { handlers } = loadMain();
  const expected = [
    'media:key', 'system:setWindowsTheme', 'power:lock', 'power:sleep', 'screenshot:capture', 'notify:send',
    'wifi:toggle', 'bluetooth:toggle', 'monet:extract', 'monet:getCached', 'monet:setAutoWatch',
    'window:expand', 'window:dragStart', 'window:dragMove', 'window:dragEnd', 'window:setPinned', 'window:close',
    'launcher:pickFile', 'launcher:open', 'clipboard:getState', 'clipboard:setConfig', 'clipboard:restore',
    'clipboard:clear', 'store:get', 'store:set',
    'system:getState', 'audio:control', 'brightness:control', 'dnd:set', 'power:keepAwake',
    'tools:open', 'media:getNowPlaying'
  ];
  assert.deepEqual([...handlers.keys()].sort(), expected.sort());
});

test('IPC от недоверенного отправителя отклоняется во всех каналах', async () => {
  const m = loadMain();
  const evil = [
    { senderFrame: { url: 'https://evil.example/' }, sender: {} },
    { senderFrame: { url: 'file:///tmp/evil.html' }, sender: {} },
    { senderFrame: null, sender: {} },
    {}
  ];
  for (const ch of m.handlers.keys()) {
    for (const ev of evil) {
      await assert.rejects(() => m.invokeAs(ev, ch, 'x'), /Untrusted/, `${ch}`);
    }
  }
  assert.equal(m.calls.execFile.length, 0);
});

test('store:set: allowlist, типы, служебные ключи', async () => {
  const m = loadMain();
  assert.deepEqual(await m.invoke('store:set', 'theme', 'blue'), { success: true });
  assert.equal(m.data.get('theme'), 'blue');

  const before = new Map(m.data);
  for (const [k, val] of [
    ['theme', 'evil'], ['opacity', 'x'], ['opacity', 7], ['autoLaunch', 'yes'], ['__proto__', {}], ['constructor', 1],
    ['posX', 5], ['pinned', false], ['monetTheme', {}], ['launcherApproved', ['C:\\evil.exe']],
    ['clipboardEnabled', true], ['clipboardHistoryEnc', 'x'], ['unknown', 1], ['a.b', 1], ['notes', 'x'.repeat(50001)],
    ['todos', 'nope'], ['launcherApps', [{ path: 1, name: 2 }]]
  ]) {
    const res = await m.invoke('store:set', k, val);
    assert.equal(res.success, false, `${k} должен быть отклонён`);
  }
  assert.deepEqual([...m.data.entries()], [...before.entries()], 'хранилище не изменилось');
  assert.equal(Object.prototype.polluted, undefined);
});

test('store:set autoLaunch применяет настройку входа в систему только для boolean', async () => {
  const m = loadMain();
  await m.invoke('store:set', 'autoLaunch', true);
  assert.deepEqual(m.calls.login, [{ openAtLogin: true }]);
  await m.invoke('store:set', 'autoLaunch', 'true');
  assert.equal(m.calls.login.length, 1);
});

test('store:get: служебные ключи недоступны рендереру', async () => {
  const m = loadMain();
  m.data.set('clipboardHistoryEnc', 'secret');
  m.data.set('launcherApproved', ['x']);
  m.data.set('monetTheme', { a: 1 });
  for (const k of ['clipboardHistoryEnc', 'launcherApproved', 'monetTheme', 'posX', '__proto__', 'constructor', 5, null]) {
    assert.equal(await m.invoke('store:get', k), null, String(k));
  }
  assert.equal(await m.invoke('store:get', 'theme'), 'sakura');
});

test('Wi-Fi: инъекции отклоняются, PowerShell не запускается', async () => {
  const m = loadMain();
  for (const ifname of ['Wi-Fi"; calc; "', '$(calc)', '`calc`', 'a;b', "a'b", 'a|b', 'a\nb']) {
    const res = await m.invoke('wifi:toggle', { enable: true, ifname });
    assert.equal(res.success, false, ifname);
  }
  for (const payload of [null, 'x', { enable: 'true', ifname: 'Wi-Fi' }, { enable: true, ifname: 'Wi-Fi', extra: 1 }, []]) {
    assert.equal((await m.invoke('wifi:toggle', payload)).success, false);
  }
  assert.equal(m.calls.execFile.length, 0);
});

test('Wi-Fi: корректный запрос — внутренний скрипт без сырого имени, результат из кода выхода', async () => {
  const m = loadMain();
  const name = 'Беспроводная сеть 2';
  const res = await m.invoke('wifi:toggle', { enable: false, ifname: name });
  assert.equal(res.success, true);
  assert.equal(m.calls.execFile.length, 1);
  const { file, args } = m.calls.execFile[0];
  assert.equal(file, 'powershell.exe');
  const outer = decodeUtf16(args[args.indexOf('-EncodedCommand') + 1]);
  assert.ok(outer.includes('-Verb RunAs'));
  const inner = decodeUtf16(outer.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1]);
  assert.ok(!inner.includes(name) && !outer.includes(name));
  assert.ok(inner.includes('Disable-NetAdapter'));

  m.state.execError = Object.assign(new Error('x'), { code: 2 });
  const notFound = await m.invoke('wifi:toggle', { enable: true, ifname: 'Wi-Fi' });
  assert.equal(notFound.success, false);
  assert.match(notFound.message, /не найдено/i);

  m.state.execError = Object.assign(new Error('x'), { code: 10 });
  assert.match((await m.invoke('bluetooth:toggle', { enable: true })).message, /отклонён/);
});

test('Wi-Fi: повторный запрос прав, пока предыдущий не завершён, блокируется', async () => {
  const m = loadMain();
  m.state.execHang = true;
  m.invoke('wifi:toggle', { enable: true, ifname: 'Wi-Fi' }); // «висит» на UAC
  await new Promise((r) => setImmediate(r));
  const second = await m.invoke('bluetooth:toggle', { enable: true });
  assert.equal(second.success, false);
  assert.match(second.message, /ещё выполняется/);
  assert.equal(m.calls.execFile.length, 1);
});

test('Bluetooth: только boolean', async () => {
  const m = loadMain();
  for (const p of [{ enable: 1 }, { enable: 'on' }, {}, null, { enable: true, x: 1 }]) {
    assert.equal((await m.invoke('bluetooth:toggle', p)).success, false);
  }
  assert.equal(m.calls.execFile.length, 0);
});

test('media:key: только известные действия, прототипные имена отклоняются', async () => {
  const m = loadMain();
  for (const a of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', null, 5, {}]) {
    const res = await m.invoke('media:key', a);
    assert.equal(res.success, false, String(a));
  }
  assert.equal(m.calls.execFile.length, 0);
  assert.equal((await m.invoke('media:key', 'playpause')).success, true);
  assert.equal(m.calls.execFile.length, 1);
});

test('тема Windows: только boolean', async () => {
  const m = loadMain();
  assert.equal((await m.invoke('system:setWindowsTheme', 'dark')).success, false);
  assert.equal(m.calls.execFile.length, 0);
  assert.equal((await m.invoke('system:setWindowsTheme', true)).success, true);
});

test('блокировка/сон запускаются без shell (execFile)', async () => {
  const m = loadMain();
  assert.equal((await m.invoke('power:lock')).success, true);
  assert.equal(m.calls.execFile[0].file, 'rundll32.exe');
  m.state.execError = new Error('fail');
  const res = await m.invoke('power:sleep');
  assert.equal(res.success, false);
});

test('уведомления: лимиты и лишние поля', async () => {
  const m = loadMain();
  assert.equal((await m.invoke('notify:send', { title: 'a', body: 'b' })).success, true);
  assert.equal(m.calls.notified, 1);
  for (const p of [{ title: 'x'.repeat(101) }, { body: 'x'.repeat(301) }, { title: 1 }, { icon: 'x' }, null, 'str']) {
    assert.equal((await m.invoke('notify:send', p)).success, false);
  }
  assert.equal(m.calls.notified, 1);
});

test('окно: аргументы проверяются даже когда окна нет', async () => {
  const m = loadMain();
  assert.equal((await m.invoke('window:setPinned', 'yes')).success, false);
  assert.equal(m.data.get('pinned'), true);
  assert.equal((await m.invoke('window:setPinned', false)).success, true);
  assert.equal(m.data.get('pinned'), false);
  assert.equal((await m.invoke('window:expand', 'yes')).success, false);
  assert.equal((await m.invoke('window:dragMove', { dx: 'a', dy: 0 })).success, false);
  assert.equal((await m.invoke('window:dragMove', { dx: 1e9, dy: 0 })).success, false);
  assert.equal((await m.invoke('monet:setAutoWatch', 'on')).success, false);
});

test('лаунчер: запускается только выбранное через диалог', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-test-'));
  const approved = path.join(dir, 'app.exe');
  const other = path.join(dir, 'other.exe');
  fs.writeFileSync(approved, ''); fs.writeFileSync(other, '');
  try {
    const m = loadMain({ openDialogPaths: [approved] });

    let res = await m.invoke('launcher:open', approved);
    assert.equal(res.success, false);
    assert.match(res.message, /не был выбран/);

    const picked = await m.invoke('launcher:pickFile');
    assert.equal(picked.path, approved);
    assert.equal(picked.name, 'app');

    res = await m.invoke('launcher:open', approved);
    assert.equal(res.success, true);
    assert.deepEqual(m.calls.opened, [approved]);

    for (const bad of [other, 'app.exe', '../app.exe', path.join(dir, 'x.ps1'), '', null, 5, {}]) {
      const r = await m.invoke('launcher:open', bad);
      assert.equal(r.success, false, String(bad));
    }
    assert.deepEqual(m.calls.opened, [approved], 'больше ничего не запускалось');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('буфер обмена: по умолчанию выключен, состояние пустое', async () => {
  const m = loadMain();
  const st = await m.invoke('clipboard:getState');
  assert.equal(st.enabled, false);
  assert.equal(st.paused, false);
  assert.equal(st.persist, false);
  assert.deepEqual(st.items, []);
});

test('буфер обмена: без согласия в диалоге не включается', async () => {
  const m = loadMain({ dialogResponse: 1 }); // «Отмена»
  const res = await m.invoke('clipboard:setConfig', { enabled: true });
  assert.equal(res.success, false);
  assert.equal(res.state.enabled, false);
  assert.equal(m.calls.dialog.length, 1);
  assert.equal(m.data.get('clipboardEnabled'), false);
});

test('буфер обмена: рендерер не может включить историю в обход диалога', async () => {
  const m = loadMain({ dialogResponse: 1 });
  assert.equal((await m.invoke('store:set', 'clipboardEnabled', true)).success, false);
  assert.equal(m.data.get('clipboardEnabled'), false);
});

test('буфер обмена: аргументы setConfig проверяются', async () => {
  const m = loadMain();
  for (const p of [{ enabled: 'yes' }, { ttlMin: 3 }, { foo: 1 }, null, 'x']) {
    assert.equal((await m.invoke('clipboard:setConfig', p)).success, false);
  }
  assert.equal(m.calls.dialog.length, 0);
  assert.equal((await m.invoke('clipboard:setConfig', { persist: true })).success, false); // без включения
  assert.equal((await m.invoke('clipboard:restore', 5)).success, false);
  assert.equal((await m.invoke('clipboard:restore', 'nope')).success, false);
});

test('буфер обмена: запись, пауза, пропуск «приватного», возврат по id, очистка, отключение', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const m = loadMain({ dialogResponse: 0 });

  let res = await m.invoke('clipboard:setConfig', { enabled: true });
  assert.equal(res.success, true);
  assert.equal(res.state.enabled, true);
  assert.equal(m.calls.dialog.length, 1, 'нативный диалог согласия показан');

  // копирование → попадает в историю
  m.state.clipboardText = 'hello';
  t.mock.timers.tick(1500);
  let st = await m.invoke('clipboard:getState');
  assert.deepEqual(st.items.map((i) => i.preview), ['hello']);

  // менеджер паролей пометил запись → не сохраняется
  m.state.clipboardBuffers.ExcludeClipboardContentFromMonitorProcessing = Buffer.from([1]);
  m.state.clipboardText = 'p@ssw0rd';
  t.mock.timers.tick(1500);
  st = await m.invoke('clipboard:getState');
  assert.deepEqual(st.items.map((i) => i.preview), ['hello']);
  delete m.state.clipboardBuffers.ExcludeClipboardContentFromMonitorProcessing;

  // пауза: новое не записывается и то, что скопировано во время паузы, не попадает после неё
  await m.invoke('clipboard:setConfig', { paused: true });
  m.state.clipboardText = 'during pause';
  t.mock.timers.tick(3000);
  await m.invoke('clipboard:setConfig', { paused: false });
  t.mock.timers.tick(3000);
  st = await m.invoke('clipboard:getState');
  assert.deepEqual(st.items.map((i) => i.preview), ['hello']);

  m.state.clipboardText = 'after pause';
  t.mock.timers.tick(1500);
  st = await m.invoke('clipboard:getState');
  assert.deepEqual(st.items.map((i) => i.preview), ['after pause', 'hello']);

  // возврат по id
  const hello = st.items.find((i) => i.preview === 'hello');
  assert.equal((await m.invoke('clipboard:restore', hello.id)).success, true);
  assert.deepEqual(m.calls.clipWrites, ['hello']);

  // рендерер получает только превью, не полный текст
  m.state.clipboardText = 'x'.repeat(1000);
  t.mock.timers.tick(1500);
  st = await m.invoke('clipboard:getState');
  const big = st.items.find((i) => i.length === 1000);
  assert.equal(big.preview.length, 120);

  // слишком длинное (> 5000) не записывается
  m.state.clipboardText = 'y'.repeat(5001);
  t.mock.timers.tick(1500);
  st = await m.invoke('clipboard:getState');
  assert.ok(!st.items.some((i) => i.length === 5001));

  // очистка
  res = await m.invoke('clipboard:clear');
  assert.deepEqual(res.state.items, []);

  // отключение сбрасывает связанные настройки и удаляет сохранённое
  m.data.set('clipboardHistoryEnc', 'leftover');
  res = await m.invoke('clipboard:setConfig', { enabled: false });
  assert.equal(res.state.enabled, false);
  assert.equal(m.data.get('clipboardHistoryEnc'), undefined);
  m.state.clipboardText = 'after disable';
  t.mock.timers.tick(3000);
  assert.deepEqual((await m.invoke('clipboard:getState')).items, []);
});

test('буфер обмена: срок хранения', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const m = loadMain({ dialogResponse: 0 });
  await m.invoke('clipboard:setConfig', { enabled: true, ttlMin: 5 });
  m.state.clipboardText = 'short-lived';
  t.mock.timers.tick(1500);
  assert.equal((await m.invoke('clipboard:getState')).items.length, 1);
  t.mock.timers.tick(5 * 60 * 1000 + 2000);
  assert.equal((await m.invoke('clipboard:getState')).items.length, 0);
});

test('буфер обмена: сохранение на диск — только по отдельному согласию и в зашифрованном виде', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const declined = loadMain({ dialogResponse: 0 });
  await declined.invoke('clipboard:setConfig', { enabled: true });
  declined.state.dialogResponse = 1;
  const r = await declined.invoke('clipboard:setConfig', { persist: true });
  assert.equal(r.success, false);
  assert.equal(declined.data.get('clipboardPersist'), false);

  const m = loadMain({ dialogResponse: 0 });
  await m.invoke('clipboard:setConfig', { enabled: true });
  assert.equal(m.data.get('clipboardHistoryEnc'), undefined, 'по умолчанию на диск не пишется');
  assert.equal((await m.invoke('clipboard:setConfig', { persist: true })).success, true);
  m.state.clipboardText = 'persist me';
  t.mock.timers.tick(1500);
  assert.equal(typeof m.data.get('clipboardHistoryEnc'), 'string');
  assert.equal(m.data.get('clipboardHistory'), undefined, 'открытый текст не хранится');
  await m.invoke('clipboard:setConfig', { persist: false });
  assert.equal(m.data.get('clipboardHistoryEnc'), undefined);
});

test('старая открытая история из прошлых версий удаляется при запуске', () => {
  // FakeStore заполняется только defaults, поэтому проверяем исходник: delete вызывается до использования
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(src, /store\.delete\('clipboardHistory'\)/);
});
