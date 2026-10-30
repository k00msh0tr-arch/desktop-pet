'use strict';
// Reads the position of the visible top-level windows (Windows, and X11 on Linux) so the pet can
// stand on them and climb them. It only reads geometry: no titles, no content.
// Rectangles are in physical screen pixels, front-most window first.

const { spawn } = require('child_process');

const TOOLWINDOW = 0x80;
const NOACTIVATE = 0x08000000;
const LAYERED = 0x80000;
const TRANSPARENT = 0x20;
const SKIP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow']);

let api;
function load() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwm = koffi.load('dwmapi.dll');
    const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const EnumProc = koffi.proto('bool __stdcall EnumProc(intptr_t hwnd, intptr_t lparam)');
    api = {
      koffi,
      EnumProc,
      EnumWindows: user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr_t lparam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
      GetWindowLongW: user32.func('int32 __stdcall GetWindowLongW(intptr_t hwnd, int index)'),
      GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, void *buf, int max)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)'),
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      DwmCloaked: dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ int32_t *out, uint32_t size)'),
      DwmFrame: dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ RECT *out, uint32_t size)'),
    };
  } catch (err) {
    console.error('[pet] window tracking unavailable:', err.message);
    api = null;
  }
  return api;
}

// One snapshot: [{ id, x, y, w, h, fg }] with front-most first.
function snapshot() {
  const w32 = load();
  if (!w32) return [];
  const fgHwnd = w32.GetForegroundWindow();
  const out = [];
  const classBuf = Buffer.alloc(512);
  const cb = w32.koffi.register((hwnd) => {
    try {
      if (!w32.IsWindowVisible(hwnd) || w32.IsIconic(hwnd)) return true;
      const ex = w32.GetWindowLongW(hwnd, -20) >>> 0;
      if (ex & TOOLWINDOW || ex & NOACTIVATE) return true;
      if (ex & LAYERED && ex & TRANSPARENT) return true; // click-through overlays
      if (w32.GetWindowTextLengthW(hwnd) === 0) return true;
      const cloaked = [0];
      if (w32.DwmCloaked(hwnd, 14, cloaked, 4) === 0 && cloaked[0]) return true;
      const pid = [0];
      w32.GetWindowThreadProcessId(hwnd, pid);
      if (pid[0] === process.pid) return true; // her own overlay
      const n = w32.GetClassNameW(hwnd, classBuf, 256);
      if (SKIP_CLASSES.has(classBuf.toString('utf16le', 0, n * 2))) return true;

      const r = {};
      // the visible frame, without the invisible resize borders Windows adds around it
      if (w32.DwmFrame(hwnd, 9, r, 16) !== 0 && !w32.GetWindowRect(hwnd, r)) return true;
      const w = r.right - r.left, h = r.bottom - r.top;
      if (w < 120 || h < 40) return true;
      out.push({ id: String(hwnd), x: r.left, y: r.top, w, h, fg: hwnd === fgHwnd });
    } catch { /* a window vanished mid-enumeration */ }
    return true;
  }, w32.koffi.pointer(w32.EnumProc));
  try {
    w32.EnumWindows(cb, 0);
  } finally {
    w32.koffi.unregister(cb);
  }
  return out;
}

// X11: a small native helper (x11windows.c) prints one line per poll. The Nix package builds it and sets
// PET_X11_HELPER; without it, or without an X server, she just has no windows to stand on.
const parseX11 = (line) => line.split(';').filter(Boolean).map((s) => {
  const [id, x, y, w, h, fg] = s.split(',');
  return { id, x: +x, y: +y, w: +w, h: +h, fg: fg === '1' };
});

function watchX11(intervalMs, onSnapshot) {
  const helper = process.env.PET_X11_HELPER;
  if (!helper) return { stop() {} };
  const child = spawn(helper, [String(process.pid), String(intervalMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    const lines = (buf + chunk).split('\n');
    buf = lines.pop(); // a half-written line waits for the rest
    if (!lines.length) return;
    try { onSnapshot(parseX11(lines.pop())); } catch (err) { console.error('[pet] window poll failed:', err.message); }
  });
  child.on('error', (err) => console.error('[pet] window tracking unavailable:', err.message));
  // no stop needed at quit: the pipe closes with her and the helper ends on its next write
  return { stop: () => child.kill() };
}

function watch(intervalMs, onSnapshot) {
  if (process.platform === 'linux') return watchX11(intervalMs, onSnapshot);
  if (!load()) return { stop() {} };
  const timer = setInterval(() => {
    try { onSnapshot(snapshot()); } catch (err) { console.error('[pet] window poll failed:', err.message); }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

module.exports = { snapshot, watch, parseX11 };
