// Registers the bar window as a Windows "appbar" so it reserves a strip at the top of the
// screen: maximized windows stop below it instead of sliding underneath.
const koffi = require('koffi');

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const APPBARDATA = koffi.struct('APPBARDATA', {
  cbSize: 'uint32',
  hWnd: 'intptr',
  uCallbackMessage: 'uint32',
  uEdge: 'uint32',
  rc: RECT,
  lParam: 'intptr',
});

const shell32 = koffi.load('shell32.dll');
const SHAppBarMessage = shell32.func(
  'uintptr __stdcall SHAppBarMessage(uint32 dwMessage, _Inout_ APPBARDATA *pData)'
);

const user32 = koffi.load('user32.dll');
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr hWnd, _Out_ uint16_t *lpClassName, int nMaxCount)');

// Windows also reports "fullscreen" when the bare desktop takes focus (no windows open,
// Win+D, clicking the wallpaper). Those aren't real fullscreen apps.
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);
function foregroundIsDesktop() {
  const hwnd = GetForegroundWindow();
  if (!hwnd) return true;
  const buf = new Uint16Array(256);
  const len = GetClassNameW(hwnd, buf, 256);
  return DESKTOP_CLASSES.has(String.fromCharCode(...buf.slice(0, len)));
}

const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hWnd, _Out_ RECT *lpRect)');
const MonitorFromWindow = user32.func('intptr __stdcall MonitorFromWindow(intptr hwnd, uint32 dwFlags)');
const MONITORINFO = koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });
const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(intptr hMonitor, _Inout_ MONITORINFO *lpmi)');

// Checks directly whether the window in front covers its whole monitor, so the bar can
// come back even if Windows never sends the "fullscreen ended" message (common at sign-in).
function foregroundIsFullscreen() {
  if (foregroundIsDesktop()) return false;
  const hwnd = GetForegroundWindow();
  const r = {};
  if (!GetWindowRect(hwnd, r)) return false;
  const mi = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
  if (!GetMonitorInfoW(MonitorFromWindow(hwnd, 2 /* nearest */), mi)) return false;
  const m = mi.rcMonitor;
  return r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
}

const ABM_NEW = 0, ABM_REMOVE = 1, ABM_QUERYPOS = 2, ABM_SETPOS = 3;
const ABE_TOP = 1;
const ABN_POSCHANGED = 1, ABN_FULLSCREENAPP = 2;
const CALLBACK_MSG = 0x0400 + 0x101; // WM_USER + n

class AppBar {
  constructor(win, { height, onFullscreen }) {
    this.win = win;
    this.height = height;
    this.onFullscreen = onFullscreen;
    this.registered = false;
    const buf = win.getNativeWindowHandle();
    this.hwnd = Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));
  }

  data(rc) {
    return {
      cbSize: koffi.sizeof(APPBARDATA),
      hWnd: this.hwnd,
      uCallbackMessage: CALLBACK_MSG,
      uEdge: ABE_TOP,
      rc: rc || { left: 0, top: 0, right: 0, bottom: 0 },
      lParam: 0,
    };
  }

  register(display) {
    if (!this.registered) {
      SHAppBarMessage(ABM_NEW, this.data());
      this.registered = true;
      this.win.hookWindowMessage(CALLBACK_MSG, (wParam, lParam) => {
        const code = wParam.length >= 8 ? Number(wParam.readBigUInt64LE(0)) : wParam.readUInt32LE(0);
        const flag = lParam.length >= 8 ? Number(lParam.readBigUInt64LE(0)) : lParam.readUInt32LE(0);
        if (code === ABN_POSCHANGED) this.position(this.display);
        if (code === ABN_FULLSCREENAPP && this.onFullscreen) {
          // Small delay so the foreground window has settled before we look at it.
          setTimeout(() => this.onFullscreen(flag !== 0 && !foregroundIsDesktop()), 150);
        }
      });
    }
    this.position(display);
  }

  position(display) {
    this.display = display;
    const sf = display.scaleFactor;
    const b = display.bounds;
    const d = this.data({
      left: Math.round(b.x * sf),
      top: Math.round(b.y * sf),
      right: Math.round((b.x + b.width) * sf),
      bottom: Math.round((b.y + this.height) * sf),
    });
    SHAppBarMessage(ABM_QUERYPOS, d);
    d.rc.bottom = d.rc.top + Math.round(this.height * sf);
    SHAppBarMessage(ABM_SETPOS, d);
    this.win.setBounds({
      x: Math.round(d.rc.left / sf),
      y: Math.round(d.rc.top / sf),
      width: Math.round((d.rc.right - d.rc.left) / sf),
      height: this.height,
    });
  }

  unregister() {
    if (!this.registered) return;
    try { this.win.unhookWindowMessage(CALLBACK_MSG); } catch {}
    SHAppBarMessage(ABM_REMOVE, this.data());
    this.registered = false;
  }
}

module.exports = { AppBar, foregroundIsFullscreen };
