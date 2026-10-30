'use strict';
// The page of the Characters window. Everything shown is built with textContent, never innerHTML: names, authors and
// descriptions in the community catalog are written by strangers.

const POSES = [
  ['idle', 'standing still'], ['blink', 'eyes closed'], ['thinking', 'Claude is thinking'], ['working', 'Claude is working'],
  ['waiting', 'waving: Claude needs you'], ['happy', 'Claude is done'], ['thanks', 'you approved something'], ['oops', 'a tool failed'],
  ['sleeping', 'nothing for 5 minutes'], ['held', 'picked up'], ['fall', 'in the air'], ['jump', 'between windows, faces left'],
  ['sit', 'sitting down'], ['walk', 'walking, faces left'], ['walk2', 'second walking step'], ['climb', 'climbing, faces left'], ['climb2', 'second climbing grip'],
];
const BY_LENGTH = POSES.map(([p]) => p).sort((a, b) => b.length - a.length); // walk2 is tried before walk

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const state = { tab: 'base', current: null, local: [], cat: null, loadingCat: false, busy: new Set() };

// ---- messages -------------------------------------------------------------------
let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 7000 : 4000);
}

// run a card's action once at a time, with its buttons disabled while it works
const act = (id, fn) => async () => {
  if (state.busy.has(id)) return;
  state.busy.add(id);
  render();
  try { await fn(); } catch (err) { toast(err.message, true); } finally { state.busy.delete(id); render(); }
};
const report = (r, ok) => { if (r.ok) toast(ok); else if (!r.cancelled) toast(r.error, true); return r; };

// ---- data -----------------------------------------------------------------------
async function refresh() {
  const r = await lib.list();
  state.current = r.current;
  state.local = r.items;
  render();
}

async function loadCatalog() {
  state.loadingCat = true;
  render();
  state.cat = await lib.catalog();
  state.loadingCat = false;
  render();
}

// ---- cards ----------------------------------------------------------------------
function card({ item, badge, badgeClass, buttons }) {
  const c = el('div', `card${item.id === state.current && item.local ? ' on' : ''}`);
  const thumb = el('div', 'thumb');
  if (item.preview) { const img = el('img'); img.src = item.preview; img.alt = ''; thumb.append(img); } else thumb.append(el('span', 'none', 'no preview'));
  if (badge) thumb.append(el('span', `badge ${badgeClass || ''}`, badge));
  const info = el('div', 'info');
  info.append(el('div', 'name', item.name));
  if (item.author) info.append(el('div', 'author', `by ${item.author}`));
  if (item.description) info.append(el('div', 'desc', item.description));
  const row = el('div', 'row');
  const busy = state.busy.has(item.id);
  for (const [label, cls, fn] of buttons) {
    const b = el('button', cls, label);
    b.disabled = busy || cls.includes('disabled');
    if (fn) b.addEventListener('click', act(item.id, fn));
    row.append(b);
  }
  c.append(thumb, info, row);
  return c;
}

const equipButton = (item) => (item.id === state.current
  ? ['Equipped', 'primary disabled', null]
  : ['Equip', 'primary', async () => { await lib.equip(item.id); await refresh(); }]);

const removeButton = (item) => ['Remove', 'small danger', async () => { const r = await lib.remove(item.id); if (!r.ok && !r.cancelled) toast(r.error, true); await refresh(); }];

function localCard(item, extra = []) {
  const buttons = [equipButton(item), ...extra];
  return card({ item: { ...item, local: true }, badge: item.id === state.current ? 'Equipped' : '', badgeClass: 'ok', buttons });
}

function installButton(entry, label) {
  return [label, 'primary', async () => {
    const r = await lib.install(entry.id);
    report(r, `${entry.name} is ready. Equip her from the card.`);
    await refresh();
  }];
}

// ---- tabs -----------------------------------------------------------------------
function note(text, button) {
  const n = $('#note');
  n.replaceChildren(el('span', null, text));
  if (button) { const b = el('button', 'ghost small', button[0]); b.addEventListener('click', button[1]); n.append(b); }
  n.hidden = false;
}

function render() {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === state.tab);
  const grid = $('#grid');
  grid.replaceChildren();
  $('#note').hidden = true;

  if (state.tab === 'base') {
    for (const item of state.local.filter((i) => i.kind === 'base')) grid.append(localCard(item));
  } else if (state.tab === 'mine') {
    const mine = state.local.filter((i) => i.kind === 'mine');
    for (const item of mine) {
      grid.append(localCard(item, [
        ['Export', 'small', async () => report(await lib.exportPack(item.id, false), 'Saved. Send the .zip to a friend; they use Import pack.')],
        ['Share', 'small', async () => report(await lib.exportPack(item.id, true), 'Saved. Drag the .zip into the GitHub page that just opened to offer her to the community.')],
        removeButton(item),
      ]));
    }
    if (!mine.length) {
      const e = el('div', 'empty', 'No girls of your own yet.');
      const b = el('button', 'primary', '＋ Make your first girl');
      b.addEventListener('click', openWizard);
      e.append(el('br'), b);
      grid.append(e);
    }
  } else {
    const installed = new Map(state.local.filter((i) => i.kind === 'community').map((i) => [i.id, i]));
    const online = state.cat && state.cat.ok ? state.cat.items : [];
    if (state.loadingCat) note('Looking for community girls…');
    else if (state.cat && !state.cat.ok) note(`Could not reach the online catalog (${state.cat.error}). Showing what you have downloaded.`, ['Try again', loadCatalog]);
    for (const entry of online) {
      const have = installed.get(entry.id);
      installed.delete(entry.id);
      if (!have) {
        grid.append(card({ item: entry, badge: entry.size ? `${(entry.size / 1048576).toFixed(0)} MB` : '', buttons: [installButton(entry, 'Download')] }));
      } else {
        const update = have.sha256 && have.sha256 !== entry.sha256;
        grid.append(localCard({ ...have, description: have.description || entry.description }, [...(update ? [installButton(entry, 'Update')] : []), removeButton(have)]));
      }
    }
    for (const have of installed.values()) grid.append(localCard(have, [removeButton(have)])); // downloaded, but no longer listed online
    if (!grid.children.length && !state.loadingCat) grid.append(el('div', 'empty', 'Nobody has shared a girl yet.'));
  }
}

// ---- New girl ---------------------------------------------------------------------
const wiz = { files: {}, urls: {} };

function matchPose(name) {
  const stem = name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[\s_-]+/g, '');
  return BY_LENGTH.find((p) => stem.includes(p)) || null;
}

function setFile(pose, file) {
  if (!/\.(png|webp|jpe?g)$/i.test(file.name)) { toast('Only png, webp or jpg pictures.', true); return; }
  if (wiz.urls[pose]) URL.revokeObjectURL(wiz.urls[pose]);
  wiz.files[pose] = file;
  wiz.urls[pose] = URL.createObjectURL(file);
  renderSlots();
}

function addMany(files) {
  const unplaced = [];
  for (const file of files) {
    const pose = matchPose(file.name);
    if (pose) setFile(pose, file); else unplaced.push(file);
  }
  for (const file of unplaced) {
    if (!wiz.files.idle) setFile('idle', file);
    else toast(`I could not tell which pose "${file.name}" is. Click a pose below and choose it there.`, true);
  }
}

function pick(multiple, onFiles) {
  const input = el('input');
  input.type = 'file';
  input.accept = '.png,.webp,.jpg,.jpeg,image/png,image/webp,image/jpeg';
  input.multiple = multiple;
  input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); });
  input.click();
}

function over(node, onDrop) {
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('over'); });
  node.addEventListener('dragleave', () => node.classList.remove('over'));
  node.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); node.classList.remove('over'); onDrop([...e.dataTransfer.files]); });
}

function renderSlots() {
  const slots = $('#slots');
  slots.replaceChildren();
  for (const [pose, hint] of POSES) {
    const s = el('div', `slot${pose === 'idle' ? ' req' : ''}${wiz.files[pose] ? ' filled' : ''}`);
    s.title = hint;
    if (wiz.files[pose]) {
      const img = el('img');
      img.src = wiz.urls[pose];
      img.alt = pose;
      const x = el('button', 'x', '✕');
      x.title = 'Remove this picture';
      x.addEventListener('click', (e) => { e.stopPropagation(); URL.revokeObjectURL(wiz.urls[pose]); delete wiz.files[pose]; delete wiz.urls[pose]; renderSlots(); });
      s.append(img, x);
    } else s.append(el('span', 'plus', '+'));
    s.append(el('span', 'label', pose));
    s.addEventListener('click', () => pick(false, ([f]) => setFile(pose, f)));
    over(s, ([f]) => { if (f) setFile(pose, f); });
    slots.append(s);
  }
  $('#w-create').disabled = !($('#w-name').value.trim() && wiz.files.idle);
}

function openWizard() {
  for (const u of Object.values(wiz.urls)) URL.revokeObjectURL(u);
  wiz.files = {};
  wiz.urls = {};
  $('#w-name').value = '';
  $('#w-author').value = '';
  $('#w-error').hidden = true;
  $('#w-status').textContent = '';
  renderSlots();
  $('#wizard').hidden = false;
  $('#w-name').focus();
}

async function create() {
  const name = $('#w-name').value.trim(), author = $('#w-author').value.trim();
  const files = {};
  for (const [pose, file] of Object.entries(wiz.files)) {
    files[pose] = lib.pathFor(file);
    if (!files[pose]) { toast(`I can't find ${file.name} on disk. Drop it from a folder, not from a web page.`, true); return; }
  }
  const buttons = ['#w-create', '#w-cancel'].map($);
  buttons.forEach((b) => { b.disabled = true; });
  $('#w-error').hidden = true;
  $('#w-status').textContent = 'Building her frames… this takes up to a minute.';
  try {
    let r = await lib.create({ name, author, files });
    if (r.exists && confirm(`${name} is already one of yours. Replace her?`)) r = await lib.create({ name, author, files, overwrite: true });
    if (r.exists) return;
    if (!r.ok) { $('#w-error').textContent = r.error; $('#w-error').hidden = false; return; }
    $('#wizard').hidden = true;
    await lib.equip(r.id);
    state.tab = 'mine';
    await refresh();
    toast(`${name} is ready and on your screen.`);
  } finally {
    $('#w-status').textContent = '';
    buttons.forEach((b) => { b.disabled = false; });
    renderSlots();
  }
}

// ---- wiring -----------------------------------------------------------------------
for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    if (state.tab === 'community' && (!state.cat || !state.cat.ok) && !state.loadingCat) loadCatalog();
    render();
  });
}
$('#new').addEventListener('click', openWizard);
$('#import').addEventListener('click', async () => { const r = report(await lib.importPack(), 'Imported. She is under Mine.'); if (r.ok) state.tab = 'mine'; await refresh(); });
$('#folder').addEventListener('click', () => lib.openFolder());
$('#w-cancel').addEventListener('click', () => { $('#wizard').hidden = true; });
$('#w-create').addEventListener('click', create);
$('#w-name').addEventListener('input', renderSlots);
$('#drop').addEventListener('click', () => pick(true, addMany));
$('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(true, addMany); } });
over($('#drop'), addMany);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#w-cancel').disabled) $('#wizard').hidden = true; });
// a picture dropped anywhere else must not make the window open it
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
lib.onChanged(refresh);

refresh().then(loadCatalog);
