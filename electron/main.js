const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell } = require('electron');
const { AppBar, foregroundIsFullscreen } = require('./appbar');
const { HardwareCollector } = require('./collectors/hardware');
const { JanasCollector } = require('./collectors/janas');
const { ClaudeCollector } = require('./collectors/claude');
const { HermesCollector } = require('./collectors/hermes');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// A small log in %APPDATA%\statusbar\statusbar.log, so startup problems can be seen afterwards.
const LOG = path.join(app.getPath('userData'), 'statusbar.log');
function log(...parts) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch {}
}
process.on('uncaughtException', (e) => log('error:', e && e.stack || e));

const AT_LOGIN = process.argv.includes('--startup');
log('start', AT_LOGIN ? '(at sign-in)' : '', process.argv.slice(1).join(' '));

// The bar is simple enough to draw without the GPU. Leaving it off avoids Electron quitting
// when the graphics process fails early in sign-in, and keeps the laptop's NVIDIA GPU asleep.
app.disableHardwareAcceleration();
app.on('child-process-gone', (_e, d) => log('child process gone:', d.type, d.reason, d.exitCode));

const DEFAULTS = {
  barHeight: 32,
  janasUrl: 'http://127.0.0.1:8080',
  metricsFile: path.join(process.env.LOCALAPPDATA || '', 'janas', 'metrics.jsonl'),
  claudePollMinutes: 5,
  character: 'banner',
};

const CHARACTERS = [
  ['classic', 'Classic'], ['banner', 'Hermes'], ['wings', 'Winged messenger'], ['blob', 'Blob'],
  ['ghost', 'Ghost'], ['robot', 'Robot'], ['pixel', 'Pixel sprite'],
];

function setCharacter(id) {
  config.character = id;
  try {
    let user = {};
    try { user = JSON.parse(fs.readFileSync(config.file, 'utf8')); } catch {}
    fs.writeFileSync(config.file, JSON.stringify({ ...user, character: id }, null, 2));
  } catch (e) { console.error('could not save character:', e); }
  push();
}

function nextCharacter() {
  const i = CHARACTERS.findIndex(([id]) => id === config.character);
  setCharacter(CHARACTERS[(i + 1) % CHARACTERS.length][0]);
}

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
    character: config.character,
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

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

function trayIcon() {
  const img = nativeImage.createFromPath(ICON);
  if (!img.isEmpty()) return img.resize({ width: 16, height: 16, quality: 'best' });
  // Fallback: a 16x16 dot drawn in code.
  const size = 16, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), i = (y * size + x) * 4;
    const a = Math.max(0, Math.min(1, 6.5 - d));
    buf[i] = 0x57; buf[i + 1] = 0x77; buf[i + 2] = 0xd9; buf[i + 3] = Math.round(a * 255); // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function loginItemArgs() {
  return app.isPackaged
    ? { args: ['--startup'] }
    : { path: process.execPath, args: [app.getAppPath(), '--startup'] };
}

// Older versions registered the startup entry without --startup; move it over.
function migrateLoginItem() {
  const old = app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
  if (app.getLoginItemSettings(old).openAtLogin && !app.getLoginItemSettings(loginItemArgs()).openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: false, ...old });
    app.setLoginItemSettings({ openAtLogin: true, ...loginItemArgs() });
    log('moved startup entry to --startup');
  }
}

function menu() {
  const opensAtLogin = app.getLoginItemSettings(loginItemArgs()).openAtLogin;
  const signedIn = claude.state.status === 'ok' || claude.state.status === 'stale';
  return Menu.buildFromTemplate([
    { label: 'Refresh Claude usage', click: () => claude.refresh() },
    signedIn && claude.state.source === 'claude.ai'
      ? { label: 'Sign out of claude.ai', click: () => claude.signOut() }
      : { label: 'Sign in to claude.ai…', click: () => claude.openSignIn() },
    { label: 'Character', submenu: CHARACTERS.map(([id, label]) => (
      { label, type: 'radio', checked: config.character === id, click: () => setCharacter(id) })) },
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
  userHidden = win.isVisible();
  if (userHidden) { appbar.unregister(); win.hide(); }
  else { win.show(); appbar.register(screen.getPrimaryDisplay()); }
}

// Fullscreen handling. Windows tells us when a fullscreen app starts and stops, but at
// sign-in (lock and welcome screens) the "stopped" message can go missing. While hidden
// for fullscreen, check every few seconds and come back once nothing covers the screen.
let userHidden = false, fsHidden = false, fsTimer = null;
function setFullscreen(on) {
  log('fullscreen', on ? 'on' : 'off');
  if (on) {
    fsHidden = true;
    win.setAlwaysOnTop(false);
    win.hide();
    if (!fsTimer) fsTimer = setInterval(() => { if (!foregroundIsFullscreen()) setFullscreen(false); }, 3000);
  } else {
    clearInterval(fsTimer); fsTimer = null;
    if (!fsHidden) return;
    fsHidden = false;
    if (userHidden) return;
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.showInactive();
    try { appbar.position(screen.getPrimaryDisplay()); } catch {}
  }
}

function createBar() {
  const display = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: config.barHeight,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, thickFrame: false,
    show: false, backgroundColor: '#0e0f12', title: 'Status bar', icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    appbar = new AppBar(win, {
      height: config.barHeight,
      // Step aside while a game or video is fullscreen.
      onFullscreen: setFullscreen,
    });
    try { appbar.register(screen.getPrimaryDisplay()); log('docked'); }
    catch (e) { log('appbar registration failed, bar will float instead:', e && e.stack || e); }
    push();
    // At sign-in the taskbar may still be settling: dock again a little later.
    if (AT_LOGIN) setTimeout(() => {
      if (!win.isVisible() && !userHidden && !foregroundIsFullscreen()) { win.showInactive(); log('shown after sign-in'); }
      try { appbar.position(screen.getPrimaryDisplay()); } catch {}
    }, 15000);
  });
  // The bar only closes through Quit. Anything else (Alt+F4, a tool closing windows) is
  // refused, and if the window is destroyed anyway, a new one is made.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); log('close refused'); } });
  win.on('closed', () => {
    log('window closed', quitting ? '(quitting)' : '- making a new one');
    if (quitting) return;
    try { appbar && appbar.unregister(); } catch {}
    appbar = null;
    setTimeout(createBar, 1000);
  });
  win.on('session-end', () => log('windows session ending'));
  win.on('unresponsive', () => log('window unresponsive'));
  win.webContents.on('did-finish-load', push);
  win.webContents.on('render-process-gone', (_e, d) => {
    log('bar page crashed:', d.reason, '- reloading');
    setTimeout(() => { if (!win.isDestroyed()) win.reload(); }, 1000);
  });
}

app.whenReady().then(async () => {
  // At sign-in, give Windows a few seconds to finish starting the desktop first.
  if (AT_LOGIN) await new Promise((r) => setTimeout(r, 8000));
  migrateLoginItem();
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
  ipcMain.on('character:next', nextCharacter);
  ipcMain.on('open', (_e, which) => {
    const urls = { usage: 'https://claude.ai/settings/usage', janasDocs: 'http://127.0.0.1:8080/' };
    if (urls[which]) shell.openExternal(urls[which]);
  });

  const reposition = () => {
    if (appbar && win && !win.isDestroyed() && win.isVisible()) {
      try { appbar.position(screen.getPrimaryDisplay()); } catch (e) { log('reposition failed:', e.message); }
    }
  };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
  setInterval(push, 1000); // keeps countdowns ticking
});

app.on('second-instance', () => { if (win && !win.isDestroyed() && !win.isVisible()) toggleBar(); });

let quitting = false;
process.on('exit', (code) => log('exit, code', code));
app.on('before-quit', () => {
  quitting = true;
  log('quit requested');
  try { appbar && appbar.unregister(); } catch {}
  for (const c of [hw, janas, claude, hermes]) { try { c && c.stop(); } catch {} }
});

app.on('window-all-closed', () => {});
