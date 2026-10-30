'use strict';
// The Characters window: base girls, community girls (installed, and the online catalog) and your own, with select,
// download, remove, export, share and the "Add" wizard. The page is in src/library/; this is its main-process side.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const charpack = require('./charpack');
const catalog = require('./catalog');

const POSES = ['idle', 'blink', 'thinking', 'working', 'waiting', 'happy', 'thanks', 'oops', 'sleeping', 'held', 'fall', 'jump', 'sit', 'walk', 'walk2', 'climb', 'climb2'];
const PICTURE = /\.(png|webp|jpe?g)$/i;
const MAX_PICTURE = 40 * 1048576;
const REPO = 'k00msh0tr-arch/desktop-pet';
const ZIP = [{ name: 'Character pack', extensions: ['zip'] }];

let ctx = null; // { bundled, userChars, characterDirs, current, switchTo, build, refreshed } from main.js
let win = null;
const previews = new Map(); // folder + modified time -> data: URL

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const fail = (err) => ({ ok: false, error: err.message || String(err) });
// the id of a bundled girl may not be reused by a download or a girl of yours (it would hide her)
const taken = (id) => fs.existsSync(ctx.bundled) && fs.readdirSync(ctx.bundled).some((n) => n.toLowerCase() === String(id).toLowerCase());

// the average colour of the opaque pixels, which tints the card behind her
function tintOf(img) {
  const { width, height } = img.getSize();
  const px = img.resize({ width: 24, height: Math.max(1, Math.round((24 * height) / width)) }).toBitmap(); // BGRA
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 200) continue;
    b += px[i]; g += px[i + 1]; r += px[i + 2]; n++;
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
}

// { url: a data: URL of her idle frame, tint }
function previewOf(dir, manifest) {
  const file = path.join(dir, 'frames', [].concat(manifest.frames.idle)[0]);
  const key = `${file}|${fs.statSync(file).mtimeMs}`;
  if (!previews.has(key)) {
    const img = nativeImage.createFromPath(file).resize({ height: 640, quality: 'good' });
    previews.set(key, { url: img.toDataURL(), tint: tintOf(img) });
  }
  return previews.get(key);
}

function localItems() {
  const out = [];
  for (const [id, dir] of ctx.characterDirs()) {
    try {
      const m = readJson(path.join(dir, 'manifest.json'));
      const marker = readJson(path.join(dir, 'catalog.json'));
      const p = previewOf(dir, m);
      out.push({
        id, name: m.title || m.name || id, author: m.author || '', description: m.description || '', poses: Object.keys(m.frames).length,
        kind: m.base ? 'base' : marker ? 'community' : 'mine', sha256: marker ? marker.sha256 : null, preview: p.url, tint: p.tint,
      });
    } catch (err) {
      console.error(`[pet] cannot list ${id}:`, err.message);
    }
  }
  return out;
}

function issueUrl(title, author) {
  const body = `Name: ${title}\nAuthor: ${author || ''}\n\n- [ ] I made this art myself, or I have its creator's permission to share it\n- [ ] Nothing in it is hateful or sexual content involving minors\n\nDrag the exported .zip into this box.`;
  return `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(`Community girl: ${title}`)}&body=${encodeURIComponent(body)}`;
}

function init(context) {
  ctx = context;

  ipcMain.handle('lib:list', () => ({ current: ctx.current(), items: localItems() }));
  ipcMain.handle('lib:catalog', () => catalog.list().then((items) => ({
    ok: true,
    items: items.map((e) => ({ ...e, tint: e.preview ? tintOf(nativeImage.createFromDataURL(e.preview)) : null })),
  }), fail));
  ipcMain.handle('lib:equip', (_e, id) => { if (ctx.characterDirs().has(id)) ctx.switchTo(id); return { ok: true }; });

  ipcMain.handle('lib:install', async (_e, id) => {
    try {
      if (taken(id)) throw new Error('That name belongs to a base girl.');
      const { pack, sha256 } = await catalog.download(id);
      charpack.install(pack, ctx.userChars, { id: pack.id, sha256 });
      ctx.refreshed();
      return { ok: true, id: pack.id };
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('lib:remove', async (_e, id) => {
    try {
      const dir = ctx.characterDirs().get(id);
      const m = dir && readJson(path.join(dir, 'manifest.json'));
      if (!m) throw new Error('She is not here any more.');
      if (m.base) throw new Error('A base girl cannot be removed.');
      const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Remove her', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Claude Pet', message: `Remove ${m.title || id}?`, detail: 'Her files are deleted from this computer. A community girl can be downloaded again.' });
      if (r.response !== 0) return { ok: false, cancelled: true };
      if (ctx.current() === id) ctx.switchTo([...ctx.characterDirs().keys()].find((k) => k !== id));
      fs.rmSync(dir, { recursive: true, force: true });
      ctx.refreshed();
      return { ok: true };
    } catch (err) { return fail(err); }
  });

  // share = also open the issue form where the .zip is handed in
  ipcMain.handle('lib:export', async (_e, id, share) => {
    try {
      const dir = ctx.characterDirs().get(id);
      const m = dir && readJson(path.join(dir, 'manifest.json'));
      if (!m) throw new Error('She is not here any more.');
      if (m.base) throw new Error('A base girl cannot be exported.');
      const pick = await dialog.showSaveDialog(win, { title: 'Export a girl', defaultPath: path.join(app.getPath('documents'), `${id}.zip`), filters: ZIP });
      if (pick.canceled) return { ok: false, cancelled: true };
      fs.writeFileSync(pick.filePath, charpack.exportDir(dir));
      if (share) { shell.showItemInFolder(pick.filePath); shell.openExternal(issueUrl(m.title || id, m.author)); }
      return { ok: true, file: pick.filePath };
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('lib:import', async () => {
    try {
      const pick = await dialog.showOpenDialog(win, { title: 'Import a girl', properties: ['openFile'], filters: ZIP });
      if (pick.canceled) return { ok: false, cancelled: true };
      const file = pick.filePaths[0];
      if (fs.statSync(file).size > 80 * 1048576) throw new Error('That file is too big to be a character pack.');
      const pack = charpack.parse(fs.readFileSync(file));
      if (taken(pack.id)) throw new Error('That name belongs to a base girl.');
      if (fs.existsSync(path.join(ctx.userChars, pack.id))) {
        const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Replace her', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Claude Pet', message: `${pack.id} is already here.`, detail: 'Replace her with the one in this file?' });
        if (r.response !== 0) return { ok: false, cancelled: true };
      }
      charpack.install(pack, ctx.userChars);
      ctx.refreshed();
      return { ok: true, id: pack.id };
    } catch (err) { return fail(err); }
  });

  // { name, author, files: { pose: path }, overwrite } -> her pictures become a girl via the art tool
  ipcMain.handle('lib:create', async (_e, { name, author, files, overwrite }) => {
    try {
      const folder = String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').slice(0, 40);
      if (!folder) throw new Error('Give her a name.');
      if (taken(folder)) throw new Error(`${folder} is a base girl's name. Pick another.`);
      if (!files || !files.idle) throw new Error('She needs at least an idle picture.');
      for (const [pose, src] of Object.entries(files)) {
        if (!POSES.includes(pose) || typeof src !== 'string' || !PICTURE.test(src)) throw new Error(`${pose}: that is not a png, webp or jpg picture.`);
        const st = fs.statSync(src);
        if (!st.isFile() || st.size > MAX_PICTURE) throw new Error(`${pose}: the picture is missing or too big.`);
      }
      if (fs.existsSync(path.join(ctx.userChars, folder)) && !overwrite) return { ok: false, exists: true };
      const r = await ctx.build(folder, String(author || '').trim().slice(0, 60), files);
      if (!r.ok) return { ok: false, error: r.log.trim().split('\n').slice(-8).join('\n') || 'The art tool failed.' };
      ctx.refreshed();
      return { ok: true, id: folder };
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('lib:open-folder', async () => {
    fs.mkdirSync(ctx.userChars, { recursive: true });
    return shell.openPath(ctx.userChars);
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
    width: 1100, height: 740, minWidth: 880, minHeight: 580, title: 'Claude Pet: Characters', backgroundColor: '#08080c', autoHideMenuBar: true,
    // on Windows the page draws the title bar and the system only adds its three buttons
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#d8d4e6', height: 44 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'library', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  // a picture dropped outside the drop zone must not navigate the window to it
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'library', 'index.html'));
  win.on('closed', () => { win = null; });
}

const changed = () => { if (win) win.webContents.send('changed'); };

module.exports = { init, open, changed };
