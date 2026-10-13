'use strict';

/**
 * Проверка совместимости API Electron: при обновлении Electron main.js на старте
 * убеждается, что все используемые функции на месте, и сообщает, чего не хватает.
 */

const REQUIRED_APIS = Object.freeze({
  app: ['whenReady', 'quit', 'on', 'setLoginItemSettings', 'getPath'],
  BrowserWindow: [],
  Tray: [],
  Menu: ['buildFromTemplate'],
  ipcMain: ['handle'],
  screen: ['getPrimaryDisplay', 'getAllDisplays', 'getDisplayMatching'],
  nativeImage: ['createFromPath', 'createEmpty'],
  desktopCapturer: ['getSources'],
  clipboard: ['readText', 'writeText', 'readBuffer'],
  Notification: ['isSupported'],
  dialog: ['showOpenDialog', 'showMessageBox', 'showErrorBox'],
  shell: ['openPath', 'openExternal'],
  globalShortcut: ['register', 'unregister', 'unregisterAll'],
  powerSaveBlocker: ['start', 'stop'],
  safeStorage: ['isEncryptionAvailable', 'encryptString', 'decryptString'],
  session: []
});

function checkElectronApis(electron, required = REQUIRED_APIS) {
  const missing = [];
  for (const [name, members] of Object.entries(required)) {
    const obj = electron ? electron[name] : undefined;
    if (obj === undefined || obj === null) {
      missing.push(name);
      continue;
    }
    for (const m of members) {
      if (typeof obj[m] !== 'function') missing.push(`${name}.${m}`);
    }
  }
  return missing;
}

module.exports = { REQUIRED_APIS, checkElectronApis };
