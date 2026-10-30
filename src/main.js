'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { fork } = require('child_process');
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, shell, clipboard } = require('electron');
const { Pet } = require('./state');
const { startServer, PORT } = require('./server');
const windowsApi = require('./windows');
const hooks = require('../tools/hooks');
const art = require('../tools/art-source');
const library = require('./library');
const studio = require('./studio');

if (process.env.PET_USER_DATA) app.setPath('userData', process.env.PET_USER_DATA); // for tests
// What ships with the app: the base girl (<project>/characters, or app\characters in an installed copy; read-only in the
// Nix build). Community girls you download and the ones you make live in CHARS, which is always writable. A folder of
// images dropped into CHARS also becomes a character (see importCharacters).
const BUNDLED = path.join(__dirname, '..', 'characters');
const CHARS = path.join(app.getPath('userData'), 'characters');
const SIZES = [['Small', 260], ['Medium', 340], ['Large', 440]];
const PREVIEW_STATES = ['idle', 'thinking', 'working', 'waiting', 'happy', 'thanks', 'oops', 'sleeping'];
const PREVIEW_POSES = ['held', 'fall', 'walk', 'climb', 'jump', 'sit'];
// poses she can borrow from another when the character has no art of its own for them yet
const FALLBACK = { blink: 'idle', working: 'thinking', thanks: 'happy', sleeping: 'idle', held: 'oops', fall: 'waiting', climb: 'waiting', walk: 'idle', jump: 'waiting' };

// Linux has no { forward: true } for a click-through window, and under XWayland the cursor can't be read while she is
// click-through, so there the window is cut to a box round her instead (see syncShape in the renderer).
// PET_SHAPE=1 tries the same on another system.
const SHAPED = process.platform === 'linux' || !!process.env.PET_SHAPE;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let tray = null;
let pet = null;
let character = null; // { id, manifest, frames, masks, has, art, body }
let overlay = null; // { id, x, y, width, height } of the display she is on, in DIPs
let rawWindows = []; // physical-pixel rects from the watcher
let lastWindowsJson = '';
let frameScale = null; // the display scale the renderer's frames were made for
let userHidden = false;
let fullscreenHidden = false;
let config = { character: 'sonnet', height: null, onTop: true, wander: true, windows: true };
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
  } catch { /* first run */ }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('[pet] could not save config:', err.message);
  }
}

// every finished character, id -> folder (the library refuses a girl whose id is a bundled one, so the order never matters)
function characterDirs() {
  const out = new Map();
  for (const root of [BUNDLED, CHARS]) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      const dir = path.join(root, d.name);
      if (d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(dir, 'manifest.json')) && fs.existsSync(path.join(dir, 'frames'))) out.set(d.name, dir);
    }
  }
  return out;
}
const listCharacters = () => [...characterDirs().keys()];

// alpha mask at 1/4 resolution so the renderer can tell when the cursor is over her
function buildMask(file) {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const S = 4;
  const mw = Math.ceil(width / S), mh = Math.ceil(height / S);
  const data = new Uint8Array(mw * mh);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bmp[(y * width + x) * 4 + 3] > 24) data[((y / S) | 0) * mw + ((x / S) | 0)] = 1;
    }
  }
  return { w: mw, h: mh, data, art: { w: width, h: height } };
}

// Where her body sits inside the idle frame, as fractions of the frame: the centre of her
// lower body, its half width, and the empty strip under her shoes.
function measureBody({ w, h, data }) {
  let minX = w, maxX = -1, first = -1, last = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      if (first < 0) first = y;
      if (y > last) last = y;
      if (y >= h * 0.5) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
  }
  return { anchor: (minX + maxX + 1) / 2 / w, half: (maxX - minX + 1) / 2 / w, feetInset: (h - 1 - last) / h, bodyFrac: (last - first + 1) / h };
}

function loadCharacter(id) {
  const dir = characterDirs().get(id);
  if (!dir) throw new Error(`character "${id}" was not found`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const frames = {}, files = {}, masks = {}, has = {};
  for (const [pose, entry] of Object.entries(manifest.frames)) {
    // a pose is one image or a list of images she cycles through
    const list = (Array.isArray(entry) ? entry : [entry]).map((f) => path.join(dir, 'frames', f)).filter((f) => fs.existsSync(f));
    if (!list.length) continue;
    files[pose] = list;
    frames[pose] = list.map((f) => pathToFileURL(f).href);
    masks[pose] = list.map(buildMask);
    has[pose] = true;
  }
  if (!frames.idle) throw new Error(`character "${id}" has no idle frame (run npm run art?)`);
  for (const [pose, from] of Object.entries(FALLBACK)) {
    if (!frames[pose] && frames[from]) { frames[pose] = frames[from]; masks[pose] = masks[from]; files[pose] = files[from]; has[pose] = false; }
  }
  const motion = { walk: { facing: null }, climb: { facing: 'left' }, ...(manifest.motion || {}) };
  return { id, dir, manifest, frames, files, masks, has, motion, art: masks.idle[0].art, body: measureBody(masks.idle[0]) };
}

const overlayScale = () => (screen.getAllDisplays().find((d) => d.id === overlay.id) || screen.getPrimaryDisplay()).scaleFactor;

// Every frame resized once, with a high-quality filter, to the exact number of device pixels she is drawn at,
// and at VARIANTS slightly taller heights (up to 5 device pixels, same width) for breathing. The renderer draws them 1:1
// and blends neighbouring heights, so it never scales anything: the browser switches its image filtering
// at certain scales, and that showed up as her sharpness jumping.
// Returns { pose: [ [url of height+0, url of height+1, ...] per frame ] }.
const VARIANTS = 6;
function scaledFrames() {
  const { spriteH } = sprite();
  const hpx = Math.round(spriteH * overlayScale());
  const wpx = Math.round((hpx * character.art.w) / character.art.h); // every height variant keeps this width: breathing only stretches her up
  const dir = path.join(app.getPath('userData'), 'frame-cache', character.id, String(hpx));
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [pose, list] of Object.entries(character.files)) {
    out[pose] = list.map((src) => {
      let source = null;
      const stamp = Math.floor(fs.statSync(src).mtimeMs); // new art, new files
      return Array.from({ length: VARIANTS }, (_, k) => {
        const h = hpx + k;
        const dest = path.join(dir, `${path.basename(src, '.png')}-${stamp}-${wpx}x${h}.png`);
        if (!fs.existsSync(dest)) {
          source = source || nativeImage.createFromPath(src);
          fs.writeFileSync(dest, source.resize({ width: wpx, height: h, quality: 'best' }).toPNG());
        }
        return pathToFileURL(dest).href;
      });
    });
  }
  return out;
}

// A frame with headroom (arms raised in one pose) makes her idle body a smaller part of it. Characters the art tool
// built ("auto") are sized so their idle body is as tall as Sonnet's at the same size setting.
const REFERENCE_BODY = 0.957;

function sprite() {
  const b = character.body;
  const bodyScale = character.manifest.auto ? REFERENCE_BODY / b.bodyFrac : 1;
  const spriteH = (config.height || character.manifest.height || 340) * bodyScale;
  const spriteW = Math.round((spriteH * character.art.w) / character.art.h);
  return { spriteW, spriteH, anchor: b.anchor, half: b.half * spriteW, feetInset: b.feetInset * spriteH };
}

function initPayload() {
  const masks = {};
  for (const [pose, list] of Object.entries(character.masks)) masks[pose] = list.map((m) => ({ w: m.w, h: m.h, data: m.data }));
  return {
    frames: scaledFrames(), variants: VARIANTS, masks, has: character.has, motion: character.motion, fps: character.manifest.fps || 6,
    ...sprite(), world: { width: overlay.width, height: overlay.height }, windows: windowsForOverlay(),
    wander: config.wander, state: pet.state, shaped: SHAPED,
  };
}

// --- overlay -------------------------------------------------------------
// One transparent, click-through window over the work area of the display she is on.
// Everything moves inside it, which keeps motion on the compositor and the physics simple.
function fitOverlay(display) {
  const wa = display.workArea;
  // 1px short on the right so it never counts as a fullscreen window to Windows
  overlay = { id: display.id, x: wa.x, y: wa.y, width: wa.width - 1, height: wa.height };
  win.setBounds({ x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height });
  lastWindowsJson = '';
  win.webContents.send('geometry', { width: overlay.width, height: overlay.height });
  pushWindows(true);
  // a display with a different scale needs frames resized for its pixels
  if (display.scaleFactor !== frameScale) { frameScale = display.scaleFactor; win.webContents.send('init', initPayload()); }
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  overlay = { id: display.id, x: wa.x, y: wa.y, width: wa.width - 1, height: wa.height };
  win = new BrowserWindow({
    x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height,
    transparent: true, frame: false, resizable: false, movable: false, hasShadow: false,
    skipTaskbar: true, focusable: false, show: false, alwaysOnTop: config.onTop,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (config.onTop) win.setAlwaysOnTop(true, 'floating');
  // until the renderer sends her box, only a corner pixel takes clicks
  if (SHAPED) win.setShape([{ x: 0, y: 0, width: 1, height: 1 }]);
  else win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => { win = null; });
}

// --- open windows she can stand on -----------------------------------------
function dipRect(w) {
  if (process.platform === 'linux') { // screenToDipRect is Windows only
    const a = screen.screenToDipPoint({ x: w.x, y: w.y }), b = screen.screenToDipPoint({ x: w.x + w.w, y: w.y + w.h });
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }
  return screen.screenToDipRect(null, { x: w.x, y: w.y, width: w.w, height: w.h });
}

function windowsForOverlay() {
  if (!config.windows) return [];
  const o = overlay, out = [];
  for (const w of rawWindows) {
    const r = dipRect(w);
    if (r.x + r.width <= o.x || r.x >= o.x + o.width || r.y + r.height <= o.y || r.y >= o.y + o.height) continue;
    out.push({ id: w.id, x: r.x - o.x, y: r.y - o.y, w: r.width, h: r.height });
  }
  return out;
}

function pushWindows(force) {
  if (!win) return;
  const list = windowsForOverlay();
  const json = JSON.stringify(list);
  if (!force && json === lastWindowsJson) return;
  lastWindowsJson = json;
  win.webContents.send('windows', list);
}

// hide her while something is fullscreen (a game, a video) so she never sits on top of it
function updateFullscreen() {
  const fg = rawWindows.find((w) => w.fg);
  let full = false;
  if (fg) {
    const r = dipRect(fg);
    full = screen.getAllDisplays().some((d) => {
      const b = d.bounds;
      return r.x <= b.x + 2 && r.y <= b.y + 2 && r.x + r.width >= b.x + b.width - 2 && r.y + r.height >= b.y + b.height - 2;
    });
  }
  if (full === fullscreenHidden || !win) return;
  fullscreenHidden = full;
  if (full) win.hide();
  else if (!userHidden) win.showInactive();
}

// her overlay's native handle as text (an HWND on Windows, an X window id on Linux): the one window she must not stand on
function overlayHandle() {
  const b = win.getNativeWindowHandle();
  return String(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0));
}

function startWatcher() {
  windowsApi.watch(120, (list) => {
    rawWindows = list;
    updateFullscreen();
    pushWindows(false);
  }, overlayHandle());
}

// --- tray / menu -----------------------------------------------------------
function applyLayout() {
  saveConfig();
  win.webContents.send('init', initPayload());
}

function setVisible(visible) {
  userHidden = !visible;
  if (win) {
    if (userHidden) win.hide();
    else if (!fullscreenHidden) win.showInactive();
  }
  refreshTray();
}

function switchCharacter(id) {
  try {
    character = loadCharacter(id);
  } catch (err) {
    dialog.showErrorBox('Could not load character', err.message);
    return;
  }
  config.character = id;
  config.height = null;
  applyLayout();
  if (userHidden) setVisible(true); // switching means you want to see her
  refreshTray();
}

// --- characters dropped into the user folder -----------------------------------
// <userData>/characters/<Name>/ with images named idle, blink, ... (png, webp or jpg) becomes a character: the art tool
// runs in a separate process (keying, lining up, cropping, writing a manifest), then she is offered in the menu.
const CHARS_README = `Add a character
===============
1. Make a folder here named after her, for example  Mia
2. Put her pictures in it, one per pose, named exactly like this (png, webp or jpg):
     idle  (required)  blink  thinking  working  waiting  happy  thanks  oops  sleeping
     held  fall  jump  sit  walk  walk2  climb  climb2
   Every image needs the same flat green background. Only idle is required; missing poses borrow from others.
3. That's it. She is built automatically in a few seconds and shows up under "Library" in the Characters window
   (tray menu > Characters...). That window's "Add" button does all of this for you.

Art for walk, climb and jump should face left.
Optional: art.json next to the pictures, for example {"scales": {"sit": 0.9}}, resizes a pose.
Her finished frames are written to the "frames" folder; if something goes wrong, read import-log.txt.
`;

const runArt = (dir) => new Promise((resolve) => {
  let log = '';
  const done = (ok) => { try { fs.writeFileSync(path.join(dir, 'import-log.txt'), log); } catch { /* read-only folder */ } resolve({ ok, log }); };
  const child = fork(path.join(__dirname, '..', 'tools', 'process-art.js'), [dir], { silent: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('error', (e) => { log += String(e); done(false); });
  child.on('exit', (code) => done(code === 0));
});

// "Add" in the Characters window: her pictures are copied to <CHARS>/<name>/raw, the art tool builds her frames and
// her manifest gets her author. files: { pose: path of a picture }. Resolves { ok, log }; a failed build leaves nothing.
const building = new Set(); // folders being built here, which the folder watcher must leave alone
async function buildCharacter(name, author, files) {
  const dir = path.join(CHARS, name);
  building.add(name);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    for (const [pose, src] of Object.entries(files)) fs.copyFileSync(src, path.join(dir, 'raw', pose + path.extname(src).toLowerCase()));
    const r = await runArt(dir);
    if (r.ok) {
      const file = path.join(dir, 'manifest.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), title: name, ...(author ? { author } : {}) }, null, 2));
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return r;
  } finally {
    building.delete(name);
  }
}

let importing = false;
let importAgain = false; // something was dropped in while an import was running
async function importCharacters() {
  if (importing) { importAgain = true; return; }
  importing = true;
  const added = [], failed = new Set();
  try {
    fs.mkdirSync(CHARS, { recursive: true });
    do {
      importAgain = false;
      for (const d of fs.readdirSync(CHARS, { withFileTypes: true })) {
        const dir = path.join(CHARS, d.name);
        if (!d.isDirectory() || d.name.startsWith('.') || building.has(d.name) || failed.has(d.name) || !art.needsImport(dir)) continue;
        const r = await runArt(dir);
        if (r.ok) { if (!added.includes(d.name)) added.push(d.name); }
        else {
          failed.add(d.name);
          dialog.showMessageBox({ type: 'error', title: 'Claude Pet', message: `Could not add ${d.name}.`, detail: r.log.trim().split('\n').slice(-6).join('\n') });
        }
      }
    } while (importAgain);
  } finally {
    importing = false; // before any dialog: a dialog nobody answers must not block the next import
  }
  refreshTray();
  if (added.length) {
    // "Later" is the default: this pops up on its own, so a stray Enter should not change anything
    const r = await dialog.showMessageBox({ type: 'info', title: 'Claude Pet', message: `Added ${added.join(', ')}.`, detail: `Switch to ${added[0]} now?`, buttons: [`Switch to ${added[0]}`, 'Later'], defaultId: 1, cancelId: 1 });
    if (r.response === 0) switchCharacter(added[0]);
  }
}

// make sure the folder and its instructions exist; false (and a message) if that is not possible
function ensureCharsFolder() {
  try {
    fs.mkdirSync(CHARS, { recursive: true });
    const readme = path.join(CHARS, 'README.txt');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, CHARS_README);
    return null;
  } catch (err) {
    return err.message;
  }
}

async function openCharsFolder() {
  const problem = ensureCharsFolder() || (await shell.openPath(CHARS));
  if (!problem) return;
  clipboard.writeText(CHARS);
  dialog.showMessageBox({
    type: 'warning', title: 'Claude Pet', message: 'Could not open the characters folder.',
    detail: `${problem}\n\nThe path is copied to your clipboard. Paste it into the address bar of a File Explorer window:\n${CHARS}\n\nCreate the folder yourself if it does not exist.`,
  });
}

function watchCharacters() {
  ensureCharsFolder();
  let timer = null;
  try {
    // wait until the copying has stopped; her own output (frames, _contact sheets, logs) never counts
    fs.watch(CHARS, { recursive: true }, (_event, name) => {
      if (!name || /(^|[\\/])(frames([\\/]|$)|_)|import-log|manifest\.json|\.txt$/i.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => importCharacters(), 4000);
    });
  } catch (err) {
    console.error('[pet] cannot watch the characters folder:', err.message);
  }
}

function hookAction(kind) {
  const verb = kind === 'install' ? 'Add' : 'Remove';
  const detail = kind === 'install'
    ? `This adds HTTP hooks to ${hooks.status().file} that send Claude Code events to http://127.0.0.1:${PORT} (this computer only). Your existing settings are kept and a timestamped backup is written first.\n\nTakes effect for Claude Code sessions started after this.`
    : `This removes only the pet's hooks from ${hooks.status().file} and writes a backup first.`;
  const choice = dialog.showMessageBoxSync({ type: 'question', buttons: [`${verb} hooks`, 'Cancel'], defaultId: 1, cancelId: 1, title: 'Claude Pet', message: `${verb} the Claude Code hooks?`, detail });
  if (choice !== 0) return;
  try {
    const r = hooks[kind]();
    dialog.showMessageBoxSync({ type: 'info', title: 'Claude Pet', message: kind === 'install' ? 'Hooks installed.' : 'Hooks removed.', detail: r.backup ? `Backup: ${r.backup}` : 'No existing settings file, nothing to back up.' });
  } catch (err) {
    dialog.showMessageBoxSync({ type: 'error', title: 'Claude Pet', message: `Could not ${kind} hooks.`, detail: `${err.message}\n\nNothing was changed.` });
  }
}

function showHookStatus() {
  const s = hooks.status();
  dialog.showMessageBoxSync({
    type: 'info', title: 'Claude Pet',
    message: s.complete ? 'Hooks are installed.' : s.installed.length ? 'Hooks are partly installed.' : 'Hooks are not installed.',
    detail: `${s.file}\nInstalled for: ${s.installed.join(', ') || 'nothing'}`,
  });
}

function buildMenu() {
  const chars = listCharacters();
  const currentH = config.height || character.manifest.height;
  const send = (channel, payload) => win && win.webContents.send(channel, payload);
  return Menu.buildFromTemplate([
    { label: character.manifest.title || character.manifest.name, enabled: false },
    { label: 'Visible', type: 'checkbox', checked: !userHidden, click: (i) => setVisible(i.checked) },
    { type: 'separator' },
    { label: 'Wander around', type: 'checkbox', checked: config.wander, click: (i) => { config.wander = i.checked; saveConfig(); send('settings', { wander: config.wander }); } },
    { label: 'Climb on open windows', type: 'checkbox', checked: config.windows, click: (i) => { config.windows = i.checked; saveConfig(); pushWindows(true); } },
    { label: 'Size', submenu: SIZES.map(([label, h]) => ({ label, type: 'radio', checked: currentH === h, click: () => { config.height = h; applyLayout(); } })) },
    { label: 'Characters…', click: library.open },
    { label: 'Sprite studio…', click: studio.open },
    { label: 'Switch character', submenu: chars.map((id) => ({ label: id, type: 'radio', checked: id === character.id, click: () => switchCharacter(id) })) },
    { label: 'Always on top', type: 'checkbox', checked: config.onTop, click: (i) => { config.onTop = i.checked; win.setAlwaysOnTop(i.checked, 'floating'); saveConfig(); } },
    {
      label: 'Preview',
      submenu: [
        ...PREVIEW_STATES.map((s) => ({ label: s, click: () => pet.debug(s, null, s === 'happy') })),
        { type: 'separator' },
        ...PREVIEW_POSES.map((p) => ({ label: `${p} pose`, click: () => send('preview', { pose: p, ms: 3000 }) })),
        { label: 'Drop her from the top', click: () => send('drop') },
      ],
    },
    { type: 'separator' },
    { label: 'Install Claude Code hooks…', click: () => hookAction('install') },
    { label: 'Remove Claude Code hooks…', click: () => hookAction('uninstall') },
    { label: 'Hook status', click: showHookStatus },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildMenu());
  library.changed();
}

function createTray() {
  const full = nativeImage.createFromPath(path.join(character.dir, 'frames', 'idle.png'));
  const { width } = full.getSize();
  const head = full.crop({ x: 0, y: 0, width, height: Math.round(width * 0.9) }).resize({ width: 32 });
  tray = new Tray(head);
  tray.setToolTip('Claude Pet');
  tray.on('click', () => tray.popUpContextMenu(buildMenu())); // the menu has "Visible"; a click must not hide her by accident
  refreshTray();
}

function wireIpc() {
  ipcMain.on('ready', () => {
    if (!win) return;
    frameScale = overlayScale();
    win.webContents.send('init', initPayload());
  });
  ipcMain.on('ignore', (_e, ignore) => win && win.setIgnoreMouseEvents(ignore, { forward: true }));
  ipcMain.on('shape', (_e, rects) => win && win.setShape(rects));
  ipcMain.on('click', () => pet.click());
  ipcMain.on('context-menu', () => buildMenu().popup({ window: win }));
  // she was dragged off the edge of this display: follow the cursor onto the next one
  ipcMain.on('drag-out', (_e, sx, sy) => {
    const d = screen.getDisplayNearestPoint({ x: Math.round(sx), y: Math.round(sy) });
    if (d.id !== overlay.id) fitOverlay(d);
  });
}

// PET_SHOT_DIR=<folder> npm start  ->  saves a screenshot of each state and pose, then quits
async function selfTest(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  fs.mkdirSync(dir, { recursive: true });
  await wait(1500);
  const shot = async (name) => {
    const r = JSON.parse(await js('JSON.stringify(window.__rect())'));
    const pad = 20;
    const x = Math.max(0, Math.round(r.x - pad)), y = Math.max(0, Math.round(r.y - pad));
    const rect = { x, y, width: Math.min(Math.round(r.width + pad * 2), overlay.width - x), height: Math.min(Math.round(r.height + pad * 2), overlay.height - y) };
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage(rect)).toPNG());
  };
  for (const [state, confetti] of [['idle', false], ['thinking', false], ['working', false], ['waiting', false], ['happy', true], ['oops', false], ['sleeping', false]]) {
    pet.debug(state, null, confetti);
    await wait(confetti ? 500 : 350);
    await shot(state);
  }
  pet.debug('idle');
  for (const pose of PREVIEW_POSES) {
    win.webContents.send('preview', { pose, ms: 1500 });
    await wait(300);
    await shot(`pose-${pose}`);
  }
  for (const side of ['left', 'right']) { // she must face the wall she is climbing
    await js(`window.__climb('${side}')`);
    await wait(400);
    await shot(`climb-${side}-wall`);
  }
  for (const side of ['left', 'right']) { // and a real open window, if there is one she can climb
    const id = await js(`window.__climbWindow('${side}')`);
    console.log(`window climb ${side}:`, id);
    if (id === 'no climbable window') break;
    await wait(500);
    await shot(`climb-window-${side}`);
  }
  // physics: drop her from the top and watch where she ends up
  await js('window.__drop()');
  await wait(250);
  await shot('pose-falling-live');
  await wait(2500);
  console.log('after drop:', await js('JSON.stringify({ mode: __actor.mode, y: Math.round(__actor.y), floor: __actor.H })'));
  app.quit();
}

// PET_SHARP=1 npm start  ->  compares how sharp she is at the extremes of her breathing, at two sizes
async function sharpnessTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const measure = async () => {
    const r = JSON.parse(await js('JSON.stringify(window.__rect())'));
    const img = await win.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    const { width, height } = img.getSize();
    const px = img.toBitmap();
    const lum = (i) => 0.114 * px[i] + 0.587 * px[i + 1] + 0.299 * px[i + 2];
    const solid = (i) => px[i + 3] === 255;
    let sum = 0, n = 0;
    let top = height; // the first row with anything in it: how high her head is
    for (let y = 0; y < height && top === height; y++) for (let x = 0; x < width; x++) if (px[(y * width + x) * 4 + 3] > 128) { top = y; break; }
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4, r4 = i + 4, d = i + width * 4;
        if (!solid(i) || !solid(r4) || !solid(d) || !solid(i - 4) || !solid(i - width * 4)) continue;
        sum += Math.abs(lum(i) - lum(r4)) + Math.abs(lum(i) - lum(d));
        n++;
      }
    }
    let mass = 0; // how much of her is opaque, in whole pixels: it must grow evenly as she stretches
    for (let i = 3; i < px.length; i += 4) mass += px[i];
    return { sharp: sum / n, top, mass: mass / 255, size: `${width}x${height}` };
  };
  await wait(1500);
  const original = config.height;
  win.webContents.send('settings', { wander: false }); // hold her still so only the breathing changes
  await js('window.__noBlink = true'); // and don't let a blink swap her frame mid-measurement
  for (const [h, pose] of [[260, 'idle'], [340, 'idle'], [440, 'idle'], [260, 'sleeping'], [340, 'sleeping'], [440, 'sleeping']]) {
    config.height = h;
    applyLayout();
    win.webContents.send('settings', { wander: false }); // a new layout re-sends her settings, so hold her still again
    pet.debug(pose);
    await wait(1200);
    const row = [], vals = [], tops = [], masses = [];
    for (const v of Array.from({ length: 21 }, (_, i) => i / 20)) { // the whole breath, from lowest to deepest
      await js(`window.__freezeBreath(${v})`);
      await wait(200);
      const m = await measure();
      vals.push(m.sharp);
      tops.push(m.top);
      masses.push(m.mass);
      row.push(m.sharp.toFixed(2));
    }
    // a copy of her left behind (or a ghost) would put opaque pixels above the straight line from first to last
    const bulge = Math.max(...masses.map((m, i) => Math.abs(m - (masses[0] + ((masses[20] - masses[0]) * i) / 20))));
    await js('window.__freezeBreath(null)');
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    // a snap is a big change between two neighbouring points; a smooth wave is many small ones
    const step = Math.max(...vals.slice(1).map((v, i) => Math.abs(v - vals[i]) / mean)) * 100;
    console.log(`sprite ${h}px ${pose}  sharpness over the breath: ${row.join(' ')}\n   range ${Math.min(...vals).toFixed(1)}-${Math.max(...vals).toFixed(1)}, biggest jump between neighbouring points ${step.toFixed(1)}%, head rises ${Math.max(...tops) - Math.min(...tops)}px over the breath, silhouette grows ${(masses[20] - masses[0]).toFixed(0)}px with a bulge of ${bulge.toFixed(0)}px`);
  }
  config.height = original;
  await js('window.__noBlink = false');
  win.webContents.send('settings', { wander: config.wander });
  applyLayout();
  app.quit();
}

if (gotLock) app.whenReady().then(() => {
  loadConfig();
  const ids = listCharacters();
  const id = ids.includes(config.character) ? config.character : ids[0];
  if (!id) {
    dialog.showErrorBox('Claude Pet', 'No character found. Put frames in characters/<name>/frames (npm run art builds them).');
    return app.quit();
  }
  character = loadCharacter(id);
  pet = new Pet();
  pet.on('change', (s) => win && win.webContents.send('state', s));
  library.init({ bundled: BUNDLED, userChars: CHARS, characterDirs, current: () => character.id, switchTo: switchCharacter, build: buildCharacter, refreshed: refreshTray, openStudio: studio.open });
  studio.init({ create: library.create, select: library.select, openLibrary: library.open });
  app.on('second-instance', library.open); // starting the app again opens its window
  wireIpc();
  createWindow();
  createTray();
  startServer(pet, {
    inspect: async () => {
      const state = JSON.parse((await win.webContents.executeJavaScript('JSON.stringify(window.__state && window.__state())')) || 'null') || {};
      return JSON.stringify({ ...state, character: character.id, characters: listCharacters() });
    },
  });
  startWatcher();
  watchCharacters();
  importCharacters(); // pick up anything dropped in while she was not running
  if (!config.seenLibrary) { config.seenLibrary = true; saveConfig(); library.open(); } // the first time, show who is here
  const refit = () => {
    const d = screen.getAllDisplays().find((x) => x.id === overlay.id) || screen.getPrimaryDisplay();
    fitOverlay(d);
  };
  screen.on('display-metrics-changed', refit);
  screen.on('display-removed', refit);
  if (process.env.PET_SHOT_DIR) win.webContents.once('did-finish-load', () => selfTest(process.env.PET_SHOT_DIR));
  if (process.env.PET_SHARP) win.webContents.once('did-finish-load', sharpnessTest);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => pet && pet.dispose());
