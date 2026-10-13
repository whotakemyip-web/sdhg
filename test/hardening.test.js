'use strict';
/** Статические проверки настроек безопасности: чтобы их нельзя было случайно убрать. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const main = read('main.js');
const html = read('renderer', 'index.html');
const css = read('renderer', 'styles.css');
const app = read('renderer', 'app.js');
const preload = read('preload.js');
const pkg = JSON.parse(read('package.json'));
const workflow = read('.github', 'workflows', 'build.yml');

test('окно: sandbox, изоляция, запрет webview и навигации', () => {
  for (const re of [/sandbox:\s*true/, /contextIsolation:\s*true/, /nodeIntegration:\s*false/, /webSecurity:\s*true/,
    /webviewTag:\s*false/, /allowRunningInsecureContent:\s*false/, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/,
    /'will-navigate'/, /'will-attach-webview'/, /setPermissionRequestHandler/, /onBeforeRequest/]) {
    assert.match(main, re, String(re));
  }
});

test('CSP: строгая политика в index.html', () => {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(m, 'CSP meta не найдена');
  const csp = m[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /style-src 'self'(;|$)/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), 'нет unsafe-* и wildcard');
});

test('страница совместима с CSP: нет inline-стилей, inline-скриптов и обработчиков', () => {
  assert.ok(!/\sstyle\s*=/.test(html), 'style="..." в HTML');
  assert.ok(!/<style[\s>]/i.test(html), '<style> в HTML');
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline-обработчики событий');
  assert.ok(!/javascript:/i.test(html));
  assert.ok(!/<(img|link|script)[^>]+(https?:)?\/\//i.test(html), 'нет внешних ресурсов');
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(css));
  assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(app), 'небезопасные DOM-API в app.js');
  assert.ok(!/setAttribute\(\s*['"]style/.test(app));
});

test('PowerShell: main.js не строит скрипты и не использует shell-exec', () => {
  assert.ok(!/(^|[^A-Za-z])exec\(/.test(main), 'exec( со строкой команды');
  assert.ok(!/require\('(node:)?child_process'\)\)?\.exec\b/.test(main));
  assert.ok(!/Start-Process|Set-Content|\.ps1|Add-Type|Set-ItemProperty/.test(main), 'PowerShell-код должен быть в lib/powershell.js');
  assert.ok(!/writeFileSync\([^)]*(tmpdir|\.ps1)/.test(main), 'временные скрипты не пишутся');
});

test('preload: не отдаёт ipcRenderer и не принимает произвольные каналы', () => {
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preload));
  assert.ok(!/invoke:\s*\(/.test(preload) && !/send:\s*\(/.test(preload), 'нет универсального invoke/send');
});

test('рендерер не использует удалённые каналы и сам хранит только нужное', () => {
  assert.ok(!/islandAPI\.drag\(/.test(app));
  assert.ok(!/-webkit-app-region:\s*drag/.test(css), 'клик по капсуле не должен перехватываться app-region');
});

test('CI: npm ci, тесты перед сборкой, ограниченные права', () => {
  assert.match(workflow, /npm ci/);
  assert.ok(!/npm install/.test(workflow));
  assert.match(workflow, /npm test/);
  assert.ok(workflow.indexOf('npm test') < workflow.indexOf('npm run dist'));
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
});

test('package.json: тесты, актуальный Electron, лок-файл не в .gitignore', () => {
  assert.equal(pkg.scripts.test, 'node --test');
  const major = Number(String(pkg.devDependencies.electron).replace(/[^0-9.]/g, '').split('.')[0]);
  assert.ok(major >= 41, `Electron ${major} — EOL или близок к нему`);
  assert.ok(!/package-lock/.test(read('.gitignore')));
});
