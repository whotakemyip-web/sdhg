'use strict';

/**
 * Построение и запуск PowerShell-скриптов.
 *
 * Главное правило: пользовательский ввод НИКОГДА не подставляется в текст скрипта.
 * Скрипты — фиксированные шаблоны. Параметры передаются как JSON, закодированный
 * в Base64 (алфавит A-Z a-z 0-9 + / =), который невозможно использовать для выхода
 * из строкового литерала. Внутри скрипта JSON разбирается через ConvertFrom-Json,
 * а значения используются как данные, а не как код.
 *
 * Для повышения прав результат возвращается через код выхода процесса — временные
 * .ps1/.txt файлы не создаются, поэтому подменять в них нечего.
 */

const { validateIfname, ValidationError } = require('./validation');

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const EXIT = Object.freeze({
  OK: 0,
  NOT_FOUND: 2,
  FAILED: 3,
  UNSUPPORTED: 4,
  UAC_DECLINED: 10
});

const VK_CODES = Object.freeze({
  playpause: 0xb3,
  next: 0xb0,
  prev: 0xb1,
  stop: 0xb2,
  volup: 0xaf,
  voldown: 0xae,
  volmute: 0xad
});

function getVirtualKey(action) {
  // hasOwn — чтобы 'constructor', '__proto__' и т.п. не проходили как «действия»
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(VK_CODES, action)) {
    return null;
  }
  return VK_CODES[action];
}

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function assertBase64(s) {
  if (typeof s !== 'string' || !B64_RE.test(s)) {
    throw new Error('Внутренняя ошибка: параметры скрипта не в Base64');
  }
  return s;
}

function paramsToBase64(obj) {
  return assertBase64(Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'));
}

function fillTemplate(template, b64) {
  // Функция-замена — чтобы спецпоследовательности вроде $& не интерпретировались
  return template.replace('__PARAMS_B64__', () => assertBase64(b64));
}

/* ---------- фиксированные шаблоны ---------- */

const WIFI_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PARAMS_B64__'))",
  '  $p = $json | ConvertFrom-Json',
  '  $name = [string]$p.name',
  "  $a = Get-NetAdapter -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.PhysicalMediaType -match '802\\.11' } | Select-Object -First 1",
  `  if (-not $a) { exit ${EXIT.NOT_FOUND} }`,
  '  if ($p.enable -eq $true) { Enable-NetAdapter -Name $a.Name -Confirm:$false } else { Disable-NetAdapter -Name $a.Name -Confirm:$false }',
  `  exit ${EXIT.OK}`,
  `} catch { exit ${EXIT.FAILED} }`
].join('\n');

const BLUETOOTH_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PARAMS_B64__'))",
  '  $p = $json | ConvertFrom-Json',
  "  $dev = Get-PnpDevice -PresentOnly | Where-Object { $_.Class -eq 'Bluetooth' -and ($_.FriendlyName -match 'Radio|Bluetooth') } | Select-Object -First 1",
  `  if (-not $dev) { exit ${EXIT.NOT_FOUND} }`,
  '  if ($p.enable -eq $true) { Enable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false } else { Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false }',
  `  exit ${EXIT.OK}`,
  `} catch { exit ${EXIT.FAILED} }`
].join('\n');

function buildWifiScript({ name, enable }) {
  if (typeof enable !== 'boolean') throw new ValidationError('enable: ожидается true/false');
  const ifname = validateIfname(name);
  return fillTemplate(WIFI_TEMPLATE, paramsToBase64({ name: ifname, enable }));
}

function buildBluetoothScript({ enable }) {
  if (typeof enable !== 'boolean') throw new ValidationError('enable: ожидается true/false');
  return fillTemplate(BLUETOOTH_TEMPLATE, paramsToBase64({ enable }));
}

function buildKeyScript(vk) {
  if (!Number.isInteger(vk) || vk < 0 || vk > 255) {
    throw new ValidationError('Недопустимый код клавиши');
  }
  return [
    "Add-Type -Namespace Island -Name Kbd -MemberDefinition @'",
    '[DllImport("user32.dll")]',
    'public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
    "'@",
    `[Island.Kbd]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)`,
    `[Island.Kbd]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)`
  ].join('\n');
}

function buildThemeScript(isDark) {
  if (typeof isDark !== 'boolean') throw new ValidationError('isDark: ожидается true/false');
  const v = isDark ? 0 : 1;
  return [
    "$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'",
    `Set-ItemProperty -Path $path -Name AppsUseLightTheme -Value ${v}`,
    `Set-ItemProperty -Path $path -Name SystemUsesLightTheme -Value ${v}`
  ].join('\n');
}


/* =======================================================
   ГРОМКОСТЬ, ЯРКОСТЬ, СОСТОЯНИЕ, «НЕ БЕСПОКОИТЬ», «СЕЙЧАС ИГРАЕТ»
   Всё — фиксированные шаблоны; параметры идут только как Base64-JSON.
   Скрипты, которые возвращают данные, пишут ОДНУ строку JSON в stdout.
   ======================================================= */

const AUDIO_CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'namespace IslandAudio {',
  '  [ComImport, Guid("BCDE0395-E52F-49B1-8D2D-4F23CCBB75DB")] class MMDeviceEnumeratorComObject { }',
  '  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  '  interface IMMDeviceEnumerator {',
  '    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);',
  '    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);',
  '  }',
  '  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  '  interface IMMDevice {',
  '    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);',
  '  }',
  '  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  '  interface IAudioEndpointVolume {',
  '    int RegisterControlChangeNotify(IntPtr pNotify);',
  '    int UnregisterControlChangeNotify(IntPtr pNotify);',
  '    int GetChannelCount(out uint pnChannelCount);',
  '    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);',
  '    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);',
  '    int GetMasterVolumeLevel(out float pfLevelDB);',
  '    int GetMasterVolumeLevelScalar(out float pfLevel);',
  '    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);',
  '    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);',
  '    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);',
  '    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);',
  '    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);',
  '    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);',
  '  }',
  '  public static class Audio {',
  '    static IAudioEndpointVolume Endpoint() {',
  '      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());',
  '      IMMDevice dev;',
  '      Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));',
  '      Guid iid = typeof(IAudioEndpointVolume).GUID;',
  '      object o;',
  '      Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));',
  '      return (IAudioEndpointVolume)o;',
  '    }',
  '    public static int GetVolume() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return (int)Math.Round(v * 100); }',
  '    public static void SetVolume(int percent) { Guid g = Guid.Empty; Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(percent / 100f, ref g)); }',
  '    public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }',
  '    public static void SetMute(bool mute) { Guid g = Guid.Empty; Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, ref g)); }',
  '  }',
  '}'
].join('\n');

const AUDIO_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PARAMS_B64__'))",
  '  $p = $json | ConvertFrom-Json',
  "  $src = @'",
  AUDIO_CSHARP,
  "'@",
  '  Add-Type -TypeDefinition $src -Language CSharp',
  "  if ($p.op -eq 'volume') { [IslandAudio.Audio]::SetVolume([int]$p.level) }",
  "  if ($p.op -eq 'mute') { [IslandAudio.Audio]::SetMute([bool]$p.muted) }",
  "  $o = @{ volume = [IslandAudio.Audio]::GetVolume(); muted = [IslandAudio.Audio]::GetMute() }",
  '  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))',
  `  exit ${EXIT.OK}`,
  `} catch { exit ${EXIT.FAILED} }`
].join('\n');

const BRIGHTNESS_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PARAMS_B64__'))",
  '  $p = $json | ConvertFrom-Json',
  "  $cur = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1",
  `  if (-not $cur) { exit ${EXIT.UNSUPPORTED} }`,
  '  $level = [int]$cur.CurrentBrightness',
  "  if ($p.op -eq 'set') {",
  "    $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1",
  "    Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$p.level } | Out-Null",
  '    $level = [int]$p.level',
  '  }',
  '  [Console]::Out.WriteLine((@{ level = $level } | ConvertTo-Json -Compress))',
  `  exit ${EXIT.OK}`,
  `} catch { exit ${EXIT.FAILED} }`
].join('\n');

// Читает реальное состояние переключателей (без прав администратора).
const STATE_TEMPLATE = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$wifi = $null; $bt = $null; $dnd = $false',
  "$a = Get-NetAdapter | Where-Object { $_.PhysicalMediaType -match '802\\.11' } | Select-Object -First 1",
  "if ($a) { $wifi = ($a.Status -ne 'Disabled') }",
  "$d = Get-PnpDevice -PresentOnly | Where-Object { $_.Class -eq 'Bluetooth' -and ($_.FriendlyName -match 'Radio|Bluetooth') } | Select-Object -First 1",
  "if ($d) { $bt = ($d.Status -eq 'OK') }",
  "$t = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications' -Name ToastEnabled).ToastEnabled",
  'if ($t -eq 0) { $dnd = $true }',
  '[Console]::Out.WriteLine((@{ wifi = $wifi; bluetooth = $bt; dnd = $dnd } | ConvertTo-Json -Compress))',
  `exit ${EXIT.OK}`
].join('\n');

// «Не беспокоить» = отключение баннеров уведомлений в реестре пользователя (HKCU, без UAC).
const DND_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PARAMS_B64__'))",
  '  $p = $json | ConvertFrom-Json',
  "  $path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications'",
  '  if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }',
  '  $v = 1; if ($p.enable -eq $true) { $v = 0 }',
  "  Set-ItemProperty -Path $path -Name ToastEnabled -Value $v -Type DWord",
  `  exit ${EXIT.OK}`,
  `} catch { exit ${EXIT.FAILED} }`
].join('\n');

// Долгоживущий наблюдатель за плеером (GlobalSystemMediaTransportControls, WinRT).
// Каждая строка stdout — Base64 от JSON в UTF-8 (так не зависим от кодовой страницы консоли).
const MEDIA_WATCH_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  "$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PARAMS_B64__'))",
  '$p = $json | ConvertFrom-Json',
  '$parentPid = [int]$p.ppid',
  'function Emit($o) {',
  '  $line = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress -Depth 4)))',
  '  [Console]::Out.WriteLine($line)',
  '}',
  'try {',
  '  Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
  '  $null = [Windows.Storage.Streams.IRandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime]',
  "  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  '  function Await($op, $type) {',
  '    $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))',
  "    if (-not $t.Wait(8000)) { throw 'timeout' }",
  '    return $t.Result',
  '  }',
  '  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]',
  '  $mgr = Await ($mgrType::RequestAsync()) $mgrType',
  "  $lastSig = ''; $lastKey = ''; $art = $null; $mime = $null; $artTries = 0",
  '  while ($true) {',
  '    if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { exit 0 }',
  '    try {',
  '      $s = $mgr.GetCurrentSession()',
  '      if (-not $s) {',
  "        if ($lastSig -ne 'none') { Emit @{ active = $false }; $lastSig = 'none'; $lastKey = '' }",
  '      } else {',
  '        $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])',
  '        $status = $s.GetPlaybackInfo().PlaybackStatus.ToString()',
  '        $tl = $s.GetTimelineProperties()',
  "        $key = '' + $props.Title + '|' + $props.Artist + '|' + $props.AlbumTitle",
  '        $keyChanged = ($key -ne $lastKey)',
  '        if ($keyChanged) { $art = $null; $mime = $null; $artTries = 0; $lastKey = $key }',
  '        if (($null -eq $art) -and $props.Thumbnail -and $artTries -lt 3) {',
  '          $artTries++',
  '          try {',
  '            $rs = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])',
  '            $st = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($rs)',
  '            $ms = New-Object System.IO.MemoryStream',
  '            $st.CopyTo($ms)',
  '            if ($ms.Length -gt 0 -and $ms.Length -le 400000) { $art = [Convert]::ToBase64String($ms.ToArray()); $mime = [string]$rs.ContentType }',
  '            $ms.Dispose(); $st.Dispose()',
  '          } catch { }',
  '        }',
  '        $sig = $key + "|" + $status + "|" + [bool]($null -ne $art)',
  "        if ($sig -ne $lastSig -or $status -eq 'Playing') {",
  '          $o = @{ active = $true; status = $status; title = [string]$props.Title; artist = [string]$props.Artist; album = [string]$props.AlbumTitle;',
  '                  app = [string]$s.SourceAppUserModelId; pos = [double]$tl.Position.TotalSeconds; dur = [double]$tl.EndTime.TotalSeconds }',
  '          if ($null -ne $art -and ($keyChanged -or $sig -ne $lastSig)) { $o.art = $art; $o.mime = $mime }',
  '          Emit $o',
  '          $lastSig = $sig',
  '        }',
  '      }',
  '    } catch { }',
  '    Start-Sleep -Milliseconds 1500',
  '  }',
  `} catch { exit ${EXIT.FAILED} }`
].join('\n');

function buildAudioScript(payload) {
  const { op, level, muted } = payload || {};
  if (!['get', 'volume', 'mute'].includes(op)) throw new ValidationError('audio: неизвестная операция');
  const params = { op };
  if (op === 'volume') {
    if (!Number.isInteger(level) || level < 0 || level > 100) throw new ValidationError('level: 0…100');
    params.level = level;
  }
  if (op === 'mute') {
    if (typeof muted !== 'boolean') throw new ValidationError('muted: ожидается true/false');
    params.muted = muted;
  }
  return fillTemplate(AUDIO_TEMPLATE, paramsToBase64(params));
}

function buildBrightnessScript(payload) {
  const { op, level } = payload || {};
  if (!['get', 'set'].includes(op)) throw new ValidationError('brightness: неизвестная операция');
  const params = { op };
  if (op === 'set') {
    if (!Number.isInteger(level) || level < 0 || level > 100) throw new ValidationError('level: 0…100');
    params.level = level;
  }
  return fillTemplate(BRIGHTNESS_TEMPLATE, paramsToBase64(params));
}

function buildStateScript() {
  return STATE_TEMPLATE;
}

function buildDndScript({ enable }) {
  if (typeof enable !== 'boolean') throw new ValidationError('enable: ожидается true/false');
  return fillTemplate(DND_TEMPLATE, paramsToBase64({ enable }));
}

function buildMediaWatchScript({ parentPid }) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new ValidationError('pid: ожидается целое число');
  return fillTemplate(MEDIA_WATCH_TEMPLATE, paramsToBase64({ ppid: parentPid }));
}

/** Запуск с получением JSON из stdout (одна строка). */
function runPowerShellJson(script, { execFile, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', powershellArgs(script),
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => {
          const base = mapExecResult(err);
          if (!base.success) { resolve(base); return; }
          try {
            const line = String(stdout || '').replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).pop();
            resolve({ ...base, data: JSON.parse(line) });
          } catch (_) {
            resolve({ success: false, code: EXIT.FAILED, message: MESSAGES[EXIT.FAILED] });
          }
        });
    } catch (e) {
      resolve(mapExecResult(e));
    }
  });
}

/** Внешний (неповышенный) скрипт: запускает внутренний с RunAs и возвращает его код выхода. */
function buildElevationLauncher(innerScript) {
  const inner = assertBase64(encodeCommand(innerScript));
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${inner}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
    '  exit $p.ExitCode',
    `} catch { exit ${EXIT.UAC_DECLINED} }`
  ].join('\n');
}

/* ---------- запуск ---------- */

const MESSAGES = Object.freeze({
  [EXIT.OK]: 'Готово',
  [EXIT.NOT_FOUND]: 'Устройство не найдено (проверьте имя адаптера / драйвер)',
  [EXIT.FAILED]: 'Не удалось выполнить операцию',
  [EXIT.UNSUPPORTED]: 'Не поддерживается этим устройством',
  [EXIT.UAC_DECLINED]: 'Запрос прав администратора отклонён'
});

function mapExecResult(err) {
  if (!err) return { success: true, code: EXIT.OK, message: MESSAGES[EXIT.OK] };
  if (err.killed || err.signal) {
    return { success: false, code: null, message: 'Превышено время ожидания' };
  }
  if (typeof err.code === 'number') {
    return {
      success: false,
      code: err.code,
      message: MESSAGES[err.code] || `Ошибка PowerShell (код ${err.code})`
    };
  }
  if (err.code === 'ENOENT') {
    return { success: false, code: null, message: 'powershell.exe не найден' };
  }
  return { success: false, code: null, message: 'Не удалось запустить PowerShell' };
}

function powershellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)];
}

function runPowerShell(script, { execFile, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', powershellArgs(script), { timeout: timeoutMs, windowsHide: true },
        (err) => resolve(mapExecResult(err)));
    } catch (e) {
      resolve(mapExecResult(e));
    }
  });
}

function runElevated(innerScript, { execFile, timeoutMs = 120000 } = {}) {
  return runPowerShell(buildElevationLauncher(innerScript), { execFile, timeoutMs });
}

module.exports = {
  EXIT, VK_CODES, getVirtualKey,
  encodeCommand, paramsToBase64, assertBase64,
  buildWifiScript, buildBluetoothScript, buildKeyScript, buildThemeScript, buildElevationLauncher,
  buildAudioScript, buildBrightnessScript, buildStateScript, buildDndScript, buildMediaWatchScript,
  powershellArgs, mapExecResult, runPowerShell, runPowerShellJson, runElevated
};
