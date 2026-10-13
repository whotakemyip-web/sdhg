'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// В рендерер отдаём только узкие именованные функции — не ipcRenderer целиком.
// Все аргументы повторно проверяются в main-процессе (lib/validation.js).
const on = (channel, callback) => {
  if (typeof callback !== 'function') return;
  ipcRenderer.on(channel, (_e, data) => callback(data));
};

contextBridge.exposeInMainWorld('islandAPI', {
  /* ---- окно ---- */
  expand: (value) => ipcRenderer.invoke('window:expand', value),
  closeApp: () => ipcRenderer.invoke('window:close'),
  dragStart: () => ipcRenderer.invoke('window:dragStart'),
  dragMove: (dx, dy) => ipcRenderer.invoke('window:dragMove', { dx, dy }),
  dragEnd: () => ipcRenderer.invoke('window:dragEnd'),
  setPinned: (value) => ipcRenderer.invoke('window:setPinned', value),

  /* ---- настройки (allowlist ключей проверяется в main) ---- */
  getSetting: (key) => ipcRenderer.invoke('store:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('store:set', key, value),

  onStats: (callback) => on('stats:update', callback),
  onCollapseRequest: (callback) => on('island:collapse', callback),
  onToggleRequest: (callback) => on('island:toggle', callback),

  /* ---- реальные системные функции ---- */
  mediaKey: (action) => ipcRenderer.invoke('media:key', action),
  setWindowsTheme: (isDark) => ipcRenderer.invoke('system:setWindowsTheme', isDark),
  lockPc: () => ipcRenderer.invoke('power:lock'),
  sleepPc: () => ipcRenderer.invoke('power:sleep'),
  captureScreenshot: () => ipcRenderer.invoke('screenshot:capture'),
  sendNotification: (payload) => ipcRenderer.invoke('notify:send', payload),
  toggleWifi: (payload) => ipcRenderer.invoke('wifi:toggle', payload),
  toggleBluetooth: (payload) => ipcRenderer.invoke('bluetooth:toggle', payload),

  /* ---- центр управления ---- */
  getSystemState: () => ipcRenderer.invoke('system:getState'),
  audio: (payload) => ipcRenderer.invoke('audio:control', payload),
  brightness: (payload) => ipcRenderer.invoke('brightness:control', payload),
  setDnd: (enable) => ipcRenderer.invoke('dnd:set', { enable }),
  setKeepAwake: (enable) => ipcRenderer.invoke('power:keepAwake', { enable }),
  openTool: (tool) => ipcRenderer.invoke('tools:open', tool),
  getNowPlaying: () => ipcRenderer.invoke('media:getNowPlaying'),
  onMediaUpdate: (callback) => on('media:update', callback),

  extractMonet: () => ipcRenderer.invoke('monet:extract'),
  getCachedMonet: () => ipcRenderer.invoke('monet:getCached'),
  setMonetAutoWatch: (enabled) => ipcRenderer.invoke('monet:setAutoWatch', enabled),
  onMonetAutoUpdate: (callback) => on('monet:auto-update', callback),

  pickLauncherFile: () => ipcRenderer.invoke('launcher:pickFile'),
  openLauncherApp: (filePath) => ipcRenderer.invoke('launcher:open', filePath),

  /* ---- буфер обмена: состояние, настройки, возврат записи по id ---- */
  getClipboardState: () => ipcRenderer.invoke('clipboard:getState'),
  setClipboardConfig: (patch) => ipcRenderer.invoke('clipboard:setConfig', patch),
  restoreClipboard: (id) => ipcRenderer.invoke('clipboard:restore', id),
  clearClipboardHistory: () => ipcRenderer.invoke('clipboard:clear'),
  onClipboardUpdate: (callback) => on('clipboard:update', callback)
});
