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

const dwmapi = koffi.load('dwmapi.dll');
const DwmGetWindowAttribute = dwmapi.func(
  'int __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ RECT *value, uint32 size)'
);
const DWMWA_EXTENDED_FRAME_BOUNDS = 9; // the visible frame, in physical pixels

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

// Explorer broadcasts this when the taskbar is (re)created. A restart of Explorer drops every
// appbar registration, so the bar has to dock again when it sees it.
const RegisterWindowMessageW = user32.func('uint32 __stdcall RegisterWindowMessageW(str16 lpString)');
const TASKBAR_CREATED = RegisterWindowMessageW('TaskbarCreated');

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
    if (TASKBAR_CREATED) {
      win.hookWindowMessage(TASKBAR_CREATED, () => {
        if (!this.registered) return; // hidden by the user: stay undocked
        setTimeout(() => this.redock('taskbar restarted'), 1000);
      });
    }
  }

  // Registers again from scratch, for when Windows has forgotten the bar.
  redock(reason) {
    if (!this.registered || !this.display) return;
    // Drop the old registration first. Registering again on top of a live one gives Windows
    // two entries for this window, and the new one gets placed *below* the old strip: the bar
    // then sits 33 px down, over the top of every window.
    try { SHAppBarMessage(ABM_REMOVE, this.data()); } catch {}
    this.registered = false;
    try { this.register(this.display); if (this.onRedock) this.onRedock(reason); }
    catch (e) { if (this.onRedock) this.onRedock(`${reason}, failed: ${e.message}`); }
  }

  // True when Windows no longer keeps the bar's strip free (work area starts above the
  // strip's bottom edge), e.g. after a shell restart that TaskbarCreated didn't cover.
  lostReservation() {
    if (!this.registered || !this.reservedBottom) return false;
    const mi = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
    if (!GetMonitorInfoW(MonitorFromWindow(this.hwnd, 2 /* nearest */), mi)) return false;
    return mi.rcWork.top < this.reservedBottom;
  }

  // True when the bar sits lower than it could: it docked below another strip (often the
  // strip of a bar that had just crashed or been closed) and that strip has since gone.
  misplaced() {
    if (!this.registered || this.reservedTop == null || !this.display) return false;
    const sf = this.display.scaleFactor, b = this.display.bounds;
    const d = this.data({
      left: Math.round(b.x * sf), top: Math.round(b.y * sf),
      right: Math.round((b.x + b.width) * sf), bottom: Math.round((b.y + this.height) * sf),
    });
    SHAppBarMessage(ABM_QUERYPOS, d);
    return d.rc.top < this.reservedTop;
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
    const asked = Math.round(this.height * sf);
    // Windows may draw the bar taller than asked (the 1 px Windows 11 border, minimum window
    // sizes). The extra is measured once and remembered, because the visible frame can read
    // short right after a move and the strip would shrink back by a pixel.
    this.extraPx = this.extraPx || 0;
    d.rc.bottom = d.rc.top + asked + this.extraPx;
    SHAppBarMessage(ABM_SETPOS, d);
    this.win.setBounds({
      x: Math.round(d.rc.left / sf),
      y: Math.round(d.rc.top / sf),
      width: Math.round((d.rc.right - d.rc.left) / sf),
      height: this.height,
    });
    const vis = { left: 0, top: 0, right: 0, bottom: 0 };
    // Only trust a reading taken with the window already in place at the top, and only a
    // few pixels' worth: right after creation the frame can still report an old position.
    if (DwmGetWindowAttribute(this.hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, vis, koffi.sizeof(RECT)) === 0
        && Math.abs(vis.top - d.rc.top) <= 1 && vis.bottom > d.rc.bottom
        && vis.bottom - (d.rc.top + asked) <= Math.ceil(4 * sf)) {
      this.extraPx = vis.bottom - (d.rc.top + asked);
      d.rc.bottom = vis.bottom;
      SHAppBarMessage(ABM_SETPOS, d);
    }
    this.reservedBottom = d.rc.bottom;
    this.reservedTop = d.rc.top;
    if (d.rc.top > Math.round(b.y * sf) && this.onRedock) {
      this.onRedock(`placed ${d.rc.top - Math.round(b.y * sf)} px below the top of the screen`);
    }
  }

  unregister() {
    if (!this.registered) return;
    try { this.win.unhookWindowMessage(CALLBACK_MSG); } catch {}
    SHAppBarMessage(ABM_REMOVE, this.data());
    this.registered = false;
  }
}

module.exports = { AppBar, foregroundIsFullscreen };
