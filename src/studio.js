'use strict';
// The sprite studio, main-process side. A project is a design picture, a personality, one prompt per pose and the pictures
// you made for each pose, kept in <userData>/studio/<project>/. Nothing here talks to a paid service: you generate the
// pictures in the Gemini app yourself, and the studio does the rest (prompts, the reference picture on the clipboard,
// collecting and choosing pictures, an optional local upscaler, and building the finished character through the Library).

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, ClipboardItem, nativeImage } = require('electron');
const prompts = require('./studio/prompts');

const LINKS = { gemini: 'https://gemini.google.com/app', upscaler: 'https://github.com/xinntao/Real-ESRGAN/releases' }; // the only places the page can send you
const MAX_IMAGE = 30 * 1048576;
const MAX_HEIGHT = 2400; // an upscaled picture is brought down to this: she is never drawn bigger than a fraction of it
const TEXT = { name: 60, author: 60, personality: 1500, style: 200 }; // the text fields of a project, and their limits
const EMPTY = { name: '', author: '', personality: '', style: '', source: null, prompts: {}, variants: {}, accepted: {}, next: 1 };
const DEFAULTS = { upscalerExe: '', upscalerArgs: '-i {in} -o {out} -n realesrgan-x4plus-anime' };

let ctx = null; // { create, select, openLibrary } from main.js
let win = null;

const root = () => path.join(app.getPath('userData'), 'studio');
const fail = (err) => ({ ok: false, error: err.message || String(err) });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
function dirOf(id) {
  if (!/^[a-z0-9-]{1,40}$/.test(String(id))) throw new Error('That is not a project.');
  return path.join(root(), id);
}

// ---- projects -------------------------------------------------------------------------
function read(id) {
  const dir = dirOf(id);
  const p = { ...EMPTY, ...JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')), id };
  for (const [pose, list] of Object.entries(p.variants)) p.variants[pose] = list.filter((f) => fs.existsSync(path.join(dir, f))); // forget pictures gone from disk
  for (const pose of Object.keys(p.accepted)) if (!(p.variants[pose] || []).includes(p.accepted[pose])) delete p.accepted[pose];
  if (p.source && !fs.existsSync(path.join(dir, p.source))) p.source = null;
  p.base = `${pathToFileURL(dir).href}/`; // the page shows pictures as base + file name
  return p;
}

function write(p) {
  const { base, ...rest } = p;
  fs.writeFileSync(path.join(dirOf(p.id), 'project.json'), JSON.stringify(rest, null, 2));
  return p;
}

function list() {
  if (!fs.existsSync(root())) return [];
  return fs.readdirSync(root(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root(), d.name, 'project.json')))
    .map((d) => ({ id: d.name, name: read(d.name).name || d.name, time: fs.statSync(path.join(root(), d.name, 'project.json')).mtimeMs }))
    .sort((a, b) => b.time - a.time);
}

function create(name) {
  let id = slug(name), n = 2;
  while (fs.existsSync(dirOf(id))) id = `${slug(name)}-${n++}`;
  fs.mkdirSync(dirOf(id), { recursive: true });
  return write({ ...EMPTY, id, name: String(name).trim().slice(0, TEXT.name), base: '' });
}

function patch(id, f) {
  const p = read(id);
  for (const [k, max] of Object.entries(TEXT)) if (typeof f[k] === 'string') p[k] = f[k].slice(0, max);
  if (f.prompts && typeof f.prompts === 'object') for (const k of prompts.KEYS) if (typeof f.prompts[k] === 'string') p.prompts[k] = f.prompts[k].slice(0, 2500);
  if (f.accepted && typeof f.accepted === 'object') {
    for (const [pose, file] of Object.entries(f.accepted)) {
      if (!prompts.KEYS.includes(pose)) continue;
      if (file === null) delete p.accepted[pose];
      else if ((p.variants[pose] || []).includes(file)) p.accepted[pose] = file;
    }
  }
  return write(p);
}

// ---- pictures -------------------------------------------------------------------------
// whatever the picture was (png, webp, jpg), it is kept as png
async function toPng(buf) {
  try { return await require('sharp')(buf).png().toBuffer(); } catch { /* not decodable by sharp, or sharp is missing */ }
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error('I could not read that picture. Use a png, webp or jpg.');
  return img.toPNG();
}

async function addImage(id, pose, bytes) {
  if (pose !== 'source' && !prompts.KEYS.includes(pose)) throw new Error('That is not a pose.');
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > MAX_IMAGE) throw new Error('That picture is empty or too big.');
  const png = await toPng(buf);
  const p = read(id), dir = dirOf(id);
  if (pose === 'source') {
    if (p.source) fs.rmSync(path.join(dir, p.source), { force: true });
    p.source = `source-${p.next++}.png`; // a new name each time, so the page never shows a cached old one
    fs.writeFileSync(path.join(dir, p.source), png);
    return write(p);
  }
  const file = `${pose}-${p.next++}.png`;
  fs.writeFileSync(path.join(dir, file), png);
  (p.variants[pose] = p.variants[pose] || []).push(file);
  return write(p);
}

function deleteImage(id, pose, file) {
  const p = read(id);
  const files = p.variants[pose] || [];
  if (!files.includes(file)) throw new Error('That picture is already gone.');
  fs.rmSync(path.join(dirOf(id), file), { force: true });
  p.variants[pose] = files.filter((f) => f !== file);
  if (p.accepted[pose] === file) delete p.accepted[pose];
  return write(p);
}

// a picture of the project on the clipboard, to paste into Gemini as the reference
async function copyImage(id, file) {
  const p = read(id);
  const known = file === p.source || Object.values(p.variants).some((l) => l.includes(file));
  if (!known) throw new Error('That picture is not in this project.');
  const png = fs.readFileSync(path.join(dirOf(id), file)); // every picture is kept as png
  // Electron 40 and later: the clipboard is asynchronous and takes web-style items
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
}

// ---- the optional upscaler ------------------------------------------------------------
function settings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(root(), 'settings.json'), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}

function saveSettings(s) {
  const exe = String(s.upscalerExe || '').trim();
  if (exe && !fs.existsSync(exe)) throw new Error('I cannot find that upscaler program.');
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(path.join(root(), 'settings.json'), JSON.stringify({ upscalerExe: exe, upscalerArgs: String(s.upscalerArgs || DEFAULTS.upscalerArgs).slice(0, 300) }, null, 2));
}

// the upscaler is run with its arguments as a list, never through a shell; {in} and {out} are replaced in each argument
function runUpscaler(inFile, outFile) {
  const s = settings();
  if (!s.upscalerExe) throw new Error('Set up an upscaler first (the gear in the sidebar).');
  const args = s.upscalerArgs.split(/\s+/).filter(Boolean).map((a) => a.split('{in}').join(inFile).split('{out}').join(outFile));
  return new Promise((resolve, reject) => {
    const child = spawn(s.upscalerExe, args, { cwd: path.dirname(s.upscalerExe), windowsHide: true });
    let log = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('The upscaler took more than 10 minutes, so I stopped it.')); }, 600000);
    child.stderr.on('data', (d) => { log += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outFile)) resolve();
      else reject(new Error(log.trim().split('\n').slice(-3).join('\n') || `The upscaler stopped with code ${code}.`));
    });
  });
}

async function upscale(id, pose, file) {
  const p = read(id), dir = dirOf(id);
  if (!(p.variants[pose] || []).includes(file)) throw new Error('That picture is gone.');
  const name = `${pose}-${p.next++}-up.png`;
  const raw = path.join(dir, `.${name}`);
  try {
    await runUpscaler(path.join(dir, file), raw);
    try { fs.writeFileSync(path.join(dir, name), await require('sharp')(raw).resize({ height: MAX_HEIGHT, fit: 'inside', withoutEnlargement: true }).png().toBuffer()); } catch { fs.copyFileSync(raw, path.join(dir, name)); }
  } finally { fs.rmSync(raw, { force: true }); }
  p.variants[pose].push(name);
  if (p.accepted[pose] === file) p.accepted[pose] = name; // she was the accepted one: the sharper copy takes over
  return write(p);
}

// ---- building her ---------------------------------------------------------------------
async function build(id, overwrite) {
  const p = read(id), dir = dirOf(id);
  if (!p.accepted.idle) throw new Error('Accept an idle picture first.');
  const files = Object.fromEntries(Object.entries(p.accepted).map(([pose, f]) => [pose, path.join(dir, f)]));
  const r = await ctx.create({ name: p.name, author: p.author, files, overwrite });
  if (r.ok) { ctx.select(r.id); ctx.openLibrary(); }
  return r;
}

// ---- window and messages --------------------------------------------------------------
function init(context) {
  ctx = context;
  // every handler answers { ok: true, ...what it returns } or { ok: false, error }
  const on = (channel, fn) => ipcMain.handle(`studio:${channel}`, async (_e, ...args) => { try { return { ok: true, ...(await fn(...args)) }; } catch (err) { return fail(err); } });

  on('projects', () => ({ projects: list() }));
  on('create', (name) => { if (!String(name).trim()) throw new Error('Give the project a name.'); return { project: create(name) }; });
  on('load', (id) => ({ project: read(id) }));
  on('patch', (id, f) => ({ project: patch(id, f) }));
  on('image', async (id, pose, bytes) => ({ project: await addImage(id, pose, bytes) }));
  on('delete-image', (id, pose, file) => ({ project: deleteImage(id, pose, file) }));
  on('copy-image', async (id, file) => { await copyImage(id, file); return {}; });
  on('copy-text', async (text) => { await clipboard.writeText(String(text).slice(0, 20000)); return {}; });
  on('open', (which) => { if (!LINKS[which]) throw new Error('Unknown link.'); shell.openExternal(LINKS[which]); return {}; });
  on('prompts', (id) => ({ project: patch(id, { prompts: prompts.templatePrompts(read(id)) }) }));
  on('request', (id) => ({ text: prompts.claudeRequest(read(id)) }));
  on('apply-reply', (id, text) => { const r = prompts.parseReply(text, read(id)); return { project: patch(id, { prompts: r.prompts }), used: r.used }; });
  on('upscale', async (id, pose, file) => ({ project: await upscale(id, pose, file) }));
  on('build', (id, overwrite) => build(id, overwrite));
  on('settings', () => ({ settings: settings() }));
  on('save-settings', (s) => { saveSettings(s); return { settings: settings() }; });
  on('pick-program', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the upscaler program', properties: ['openFile'] });
    return { file: r.canceled ? null : r.filePaths[0] };
  });
  on('remove', async (id) => {
    const p = read(id);
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Delete the project', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Claude Pet', message: `Delete "${p.name}"?`, detail: 'Its pictures and prompts are deleted from this computer. A character you already built from it stays in your library.' });
    if (r.response !== 0) return { cancelled: true };
    fs.rmSync(dirOf(id), { recursive: true, force: true });
    return {};
  });
}

function open() {
  if (!ctx) return;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 960, minHeight: 600, title: 'Claude Pet: Studio', backgroundColor: '#08080c', autoHideMenuBar: true,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#d8d4e6', height: 44 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'studio', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'studio', 'index.html'));
  win.on('closed', () => { win = null; });
}

module.exports = { init, open };
