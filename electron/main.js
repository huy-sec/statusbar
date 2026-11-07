const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell } = require('electron');
const { AppBar } = require('./appbar');
const { HardwareCollector } = require('./collectors/hardware');
const { JanasCollector } = require('./collectors/janas');
const { ClaudeCollector } = require('./collectors/claude');
const { HermesCollector } = require('./collectors/hermes');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const DEFAULTS = {
  barHeight: 32,
  janasUrl: 'http://127.0.0.1:8080',
  metricsFile: path.join(process.env.LOCALAPPDATA || '', 'janas', 'metrics.jsonl'),
  claudePollMinutes: 5,
};

function loadConfig() {
  const file = path.join(app.getPath('userData'), 'config.json');
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2)); } catch {}
  }
  return { ...DEFAULTS, ...user, file };
}

let win, tray, appbar, config;
let hw, janas, claude, hermes;
let sendTimer = null;
let demoUntil = process.env.STATUSBAR_DEMO ? Date.now() + 60000 : 0;

function state() {
  return {
    claude: claude.state,
    janas: janas.snapshot(hw.state.janasProc),
    hw: hw.state,
    hermes: hermes.state,
    now: Date.now(),
    demo: Date.now() < demoUntil,
  };
}

function push() {
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('state', state());
  }, 150);
}

function trayIcon() {
  // 16x16 orange dot, drawn in code so no image file is needed.
  const size = 16, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), i = (y * size + x) * 4;
    const a = Math.max(0, Math.min(1, 6.5 - d));
    buf[i] = 0x57; buf[i + 1] = 0x77; buf[i + 2] = 0xd9; buf[i + 3] = Math.round(a * 255); // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function loginItemArgs() {
  return app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
}

function menu() {
  const opensAtLogin = app.getLoginItemSettings(loginItemArgs()).openAtLogin;
  const signedIn = claude.state.status === 'ok' || claude.state.status === 'stale';
  return Menu.buildFromTemplate([
    { label: 'Refresh Claude usage', click: () => claude.refresh() },
    signedIn && claude.state.source === 'claude.ai'
      ? { label: 'Sign out of claude.ai', click: () => claude.signOut() }
      : { label: 'Sign in to claude.ai…', click: () => claude.openSignIn() },
    { label: 'Preview Hermes moods', click: () => { demoUntil = Date.now() + 30000; push(); } },
    { label: 'Open claude.ai usage page', click: () => shell.openExternal('https://claude.ai/settings/usage') },
    { type: 'separator' },
    { label: win && win.isVisible() ? 'Hide bar' : 'Show bar', click: toggleBar },
    { label: 'Start with Windows', type: 'checkbox', checked: opensAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, ...loginItemArgs() }) },
    { label: 'Edit settings file', click: () => shell.openPath(config.file) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function toggleBar() {
  if (win.isVisible()) { appbar.unregister(); win.hide(); }
  else { win.show(); appbar.register(screen.getPrimaryDisplay()); }
}

function createBar() {
  const display = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: config.barHeight,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, thickFrame: false,
    show: false, backgroundColor: '#0e0f12', title: 'Status bar',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    appbar = new AppBar(win, {
      height: config.barHeight,
      // Step aside while a game or video is fullscreen.
      onFullscreen: (on) => { win.setAlwaysOnTop(!on, 'pop-up-menu'); if (on) win.hide(); else win.showInactive(); },
    });
    try { appbar.register(screen.getPrimaryDisplay()); }
    catch (e) { console.error('appbar registration failed, bar will float instead:', e); }
    push();
  });
  win.webContents.on('did-finish-load', push);
}

app.whenReady().then(() => {
  config = loadConfig();
  hw = new HardwareCollector();
  janas = new JanasCollector(config);
  claude = new ClaudeCollector(config);
  hermes = new HermesCollector();
  for (const c of [hw, janas, claude, hermes]) { c.on('update', push); c.start(); }

  createBar();

  tray = new Tray(trayIcon());
  tray.setToolTip('Status bar');
  tray.on('click', () => tray.popUpContextMenu(menu()));
  tray.on('right-click', () => tray.popUpContextMenu(menu()));

  ipcMain.on('menu', () => menu().popup({ window: win }));
  ipcMain.on('claude:signin', () => claude.openSignIn());
  ipcMain.on('claude:refresh', () => claude.refresh());
  ipcMain.on('open', (_e, which) => {
    const urls = { usage: 'https://claude.ai/settings/usage', janasDocs: 'http://127.0.0.1:8080/' };
    if (urls[which]) shell.openExternal(urls[which]);
  });

  const reposition = () => { if (appbar && win.isVisible()) appbar.position(screen.getPrimaryDisplay()); };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
  setInterval(push, 1000); // keeps countdowns ticking
});

app.on('second-instance', () => { if (win && !win.isVisible()) toggleBar(); });

app.on('before-quit', () => {
  try { appbar && appbar.unregister(); } catch {}
  for (const c of [hw, janas, claude, hermes]) { try { c && c.stop(); } catch {} }
});

app.on('window-all-closed', () => {});
