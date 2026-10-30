'use strict';
// The page of the Characters window. Everything shown is built with textContent, never innerHTML: names, authors and
// descriptions in the community catalog are written by strangers.
//
// Smoothness: the page is not rebuilt on every change. Cards, the featured card and the details panel are kept and
// patched in place (so pictures never reload, hover and focus survive, and a card's ring can ease in), and only
// elements that are new animate in.

const POSES = [
  ['idle', 'standing still'], ['blink', 'eyes closed'], ['thinking', 'Claude is thinking'], ['working', 'Claude is working'],
  ['waiting', 'waving: Claude needs you'], ['happy', 'Claude is done'], ['thanks', 'you approved something'], ['oops', 'a tool failed'],
  ['sleeping', 'nothing for 5 minutes'], ['held', 'picked up'], ['fall', 'in the air'], ['jump', 'between windows, faces left'],
  ['sit', 'sitting down'], ['walk', 'walking, faces left'], ['walk2', 'second walking step'], ['climb', 'climbing, faces left'], ['climb2', 'second climbing grip'],
];
const BY_LENGTH = POSES.map(([p]) => p).sort((a, b) => b.length - a.length); // walk2 is tried before walk
const TABS = [['base', 'Base', 'base'], ['community', 'Community', 'community'], ['mine', 'Library', 'library']]; // kind, label, icon
const KIND = { base: 'Base', community: 'Community', mine: 'Library' };
const TITLES = { base: 'All characters', community: 'All characters', mine: 'Your characters' };

const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  base: 'M12 3.2l2.5 5.4 5.9.7-4.4 4 1.2 5.8L12 16.2l-5.2 2.9 1.2-5.8-4.4-4 5.9-.7L12 3.2z',
  community: 'M9 11.2a3.1 3.1 0 100-6.2 3.1 3.1 0 000 6.2zM3.2 19c.4-3 2.7-4.7 5.8-4.7s5.4 1.7 5.8 4.7M16.4 11a2.7 2.7 0 100-5.4M17.6 14.4c2 .5 3.1 2 3.4 4.6',
  library: 'M5 4.5v15M9.5 4.5v15M14 4.5v15M17.2 5.6l3 13.4',
  search: 'M10.8 17.6a6.8 6.8 0 100-13.6 6.8 6.8 0 000 13.6zM20 20l-4.4-4.4',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14',
  upload: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M5 15v4h14v-4',
  close: 'M6 6l12 12M18 6L6 18',
  folder: 'M3.5 7.5A1.5 1.5 0 015 6h4l2 2.2h8a1.5 1.5 0 011.5 1.5v7.8a1.5 1.5 0 01-1.5 1.5H5a1.5 1.5 0 01-1.5-1.5v-10z',
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

const state = { tab: 'base', current: null, local: [], cat: null, loadingCat: false, busy: new Set(), query: '', open: null };

// ---- showing and hiding with a fade ---------------------------------------------------
// show() runs the element's "in" animation (the CSS plays it whenever it becomes displayed); hide() plays "out", then removes it
const OUT_MS = 220;
const isOpen = (n) => !n.hidden && !n.classList.contains('out');
function show(n) { clearTimeout(n._out); n.classList.remove('out'); n.hidden = false; }
function hide(n) {
  if (n.hidden || n.classList.contains('out')) return;
  n.classList.add('out');
  n._out = setTimeout(() => { n.hidden = true; n.classList.remove('out'); }, OUT_MS);
}
// a new element rises in, a little after the one before it; the class goes when it is done so hover can take over
function enter(n, i) {
  n.style.setProperty('--i', Math.min(i, 12));
  n.classList.add('enter');
  n.addEventListener('animationend', () => n.classList.remove('enter'), { once: true });
}

// ---- messages -------------------------------------------------------------------
let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  clearTimeout(toastTimer);
  t.textContent = msg;
  t.className = `glass${isErr ? ' err' : ''}`;
  show(t);
  toastTimer = setTimeout(() => hide(t), isErr ? 7000 : 4000);
}
const report = (r, ok) => { if (r.ok) toast(ok); else if (!r.cancelled) toast(r.error, true); return r; };

// run one action per character at a time, with its buttons showing a spinner while it works
const act = (id, fn) => async () => {
  if (state.busy.has(id)) return;
  state.busy.add(id);
  render();
  try { await fn(); } catch (err) { toast(err.message, true); } finally { state.busy.delete(id); render(); }
};

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

// every character this window knows, on this computer or in the catalog
function entries() {
  const online = state.cat && state.cat.ok ? state.cat.items : [];
  const have = new Set(state.local.map((i) => i.id));
  const out = state.local.map((i) => {
    const remote = i.kind === 'community' ? online.find((o) => o.id === i.id) : null;
    return { ...i, local: true, remote, update: !!(remote && i.sha256 && i.sha256 !== remote.sha256) };
  });
  for (const o of online) {
    if (!have.has(o.id)) out.push({ id: o.id, name: o.name, author: o.author, description: o.description, preview: o.preview, tint: o.tint, size: o.size, kind: 'community', local: false, remote: o });
  }
  return out;
}

// ---- pieces -----------------------------------------------------------------------
const isCurrent = (e) => e.local && e.id === state.current;
const byline = (e) => (e.author ? `by ${e.author}` : e.kind === 'base' ? 'Comes with the app' : 'Made by you');
const sigOf = (e) => `${e.id}|${e.preview ? e.preview.length : 0}|${(e.tint || []).join(',')}`; // what the picture area is made from

// what the main button of a character does
function primaryOf(e) {
  if (!e.local) {
    return { label: 'Download', icon: 'download', run: async () => { report(await lib.install(e.id), `${e.name} downloaded. Select her to put her on your screen.`); await refresh(); } };
  }
  if (isCurrent(e)) return { selected: true };
  return { label: 'Select', run: async () => { await lib.equip(e.id); await refresh(); } };
}

function tile(e, cls) {
  const t = el('div', `tile ${cls}`);
  t.style.setProperty('--t', (e.tint || [109, 91, 240]).join(','));
  if (e.preview) {
    const img = el('img');
    img.src = e.preview;
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    t.append(img);
  } else t.append(el('span', 'ph', 'No preview'));
  return t;
}

// a button for primaryOf(): big (hero, details) or small (card); a spinner replaces its icon while it works
function primaryButton(e, big) {
  const p = primaryOf(e);
  if (p.selected) return el('span', 'pill ok', 'Selected');
  const busy = state.busy.has(e.id);
  const b = el('button', big ? 'btn primary' : p.icon ? 'icon-btn' : 'btn', big ? p.label : p.icon ? '' : p.label);
  if (p.icon) { b.prepend(icon(p.icon)); b.title = p.label; b.setAttribute('aria-label', p.label); }
  if (busy) { b.classList.add('busy'); b.prepend(el('span', 'spin')); }
  b.disabled = busy;
  b.addEventListener('click', (ev) => { ev.stopPropagation(); act(e.id, p.run)(); });
  return b;
}

const tagsOf = (e) => [
  ...(e.update ? [el('span', 'tag update', 'Update')] : []),
  ...(!e.local && e.size ? [el('span', 'tag', `${(e.size / 1048576).toFixed(0)} MB`)] : []),
];

function barOf(e) {
  const meta = el('div', 'meta');
  meta.append(el('div', 'name', e.name), el('div', 'author', byline(e)));
  const bar = el('div', 'bar');
  bar.append(meta, primaryButton(e, false));
  return bar;
}

function card(e) {
  const c = el('div', `card${isCurrent(e) ? ' on' : ''}`);
  c.tabIndex = 0;
  c.dataset.id = e.id;
  c.dataset.sig = sigOf(e);
  const t = tile(e, '');
  t.append(...tagsOf(e));
  c.append(t, barOf(e));
  c.addEventListener('click', () => openDetails(e.id));
  c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openDetails(e.id); });
  return c;
}

// bring a kept card up to date without touching its picture; a card that just became selected gives a pulse
function patchCard(c, e) {
  const on = isCurrent(e);
  if (on && !c.classList.contains('on')) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
  c.classList.toggle('on', on);
  const t = c.querySelector('.tile');
  t.querySelectorAll('.tag').forEach((x) => x.remove());
  t.append(...tagsOf(e));
  c.querySelector('.bar').replaceWith(barOf(e));
}

let addNode = null;
function addCard() {
  const c = el('div', 'card add');
  c.tabIndex = 0;
  const inner = el('div');
  inner.append(icon('plus'), el('div', null, 'Add your own'));
  c.append(inner);
  c.addEventListener('click', openWizard);
  c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openWizard(); });
  return c;
}

// the grid keeps one node per character: kept nodes are patched and left where they are, new ones rise in, the rest go
let cardNodes = new Map();
function syncGrid(grid, list, extras) {
  const next = new Map();
  const nodes = [];
  list.forEach((e, i) => {
    let n = cardNodes.get(e.id);
    if (n && n.dataset.sig === sigOf(e)) patchCard(n, e);
    else { n = card(e); if (!cardNodes.has(e.id)) enter(n, i); }
    next.set(e.id, n);
    nodes.push(n);
  });
  cardNodes = next;
  nodes.push(...extras);
  let ref = grid.firstChild;
  for (const n of nodes) {
    if (n === ref) ref = ref.nextSibling; // already in place: moving it would restart its animation
    else grid.insertBefore(n, ref);
  }
  while (ref) { const nx = ref.nextSibling; ref.remove(); ref = nx; }
}

let heroNode = null;
function heroText(e) {
  const text = el('div', 'hero-text');
  text.append(el('div', 'eyebrow', isCurrent(e) ? 'Selected' : 'Featured'), el('h2', null, e.name), el('div', 'author', e.author ? `by ${e.author}` : ''));
  if (e.description) text.append(el('p', 'desc', e.description));
  const row = el('div', 'row');
  const more = el('button', 'btn', 'Details');
  more.addEventListener('click', () => openDetails(e.id));
  row.append(primaryButton(e, true), more);
  text.append(row);
  return text;
}

function syncHero(slot, e) {
  if (!e) { if (heroNode) { heroNode.remove(); heroNode = null; } return; }
  if (heroNode && heroNode.dataset.sig === sigOf(e)) { heroNode.querySelector('.hero-text').replaceWith(heroText(e)); return; }
  const h = el('section', 'hero glass');
  h.dataset.sig = sigOf(e);
  h.append(tile(e, 'hero-tile'), heroText(e));
  enter(h, 0);
  slot.replaceChildren(h);
  heroNode = h;
}

function setNote(text, button) {
  const n = $('#note');
  if (!text) { hide(n); return; }
  n.replaceChildren(el('span', null, text));
  if (button) { const b = el('button', 'btn', button[0]); b.addEventListener('click', button[1]); n.append(b); }
  show(n);
}

// ---- the page ---------------------------------------------------------------------
// the nav is built once; a highlight slides to the active item
const navBtns = {};
function renderNav(all) {
  const nav = $('#tabs');
  if (!nav.children.length) {
    nav.append(el('div', 'nav-ind'));
    for (const [kind, label, ico] of TABS) {
      const b = el('button', 'nav');
      const count = el('span', 'count');
      b.append(icon(ico), el('span', null, label), count);
      b.addEventListener('click', () => switchTab(kind));
      nav.append(b);
      navBtns[kind] = { b, count };
    }
  }
  for (const [kind] of TABS) {
    navBtns[kind].b.classList.toggle('on', state.tab === kind);
    navBtns[kind].count.textContent = String(all.filter((e) => e.kind === kind).length);
  }
  nav.firstChild.style.transform = `translateY(${navBtns[state.tab].b.offsetTop}px)`;
  if (!nav.classList.contains('ready')) requestAnimationFrame(() => requestAnimationFrame(() => nav.classList.add('ready'))); // no slide on load
}

function switchTab(kind) {
  if (state.tab === kind) return;
  state.tab = kind;
  $('#scroll').scrollTo({ top: 0, behavior: 'smooth' });
  if (kind === 'community' && (!state.cat || !state.cat.ok) && !state.loadingCat) loadCatalog();
  render();
}

function render() {
  const all = entries();
  renderNav(all);

  const q = state.query.trim().toLowerCase();
  const list = all.filter((e) => e.kind === state.tab && (!q || `${e.name} ${e.author}`.toLowerCase().includes(q)));

  if (state.tab === 'community' && state.loadingCat) setNote('Looking for community characters…');
  else if (state.tab === 'community' && state.cat && !state.cat.ok) setNote(`Could not reach the online catalog (${state.cat.error}). Showing what you have downloaded.`, ['Try again', loadCatalog]);
  else setNote(null);

  syncHero($('#hero'), !q && list.length ? list[0] : null);
  const showGrid = q || state.tab === 'mine' || list.length > 1;
  $('#grid-title').textContent = showGrid ? TITLES[state.tab] : '';

  const extras = [];
  if (state.tab === 'mine' && !q) {
    if (!addNode) addNode = addCard();
    if (!addNode.isConnected) enter(addNode, list.length);
    extras.push(addNode);
  }
  if (q && !list.length) extras.push(el('div', 'empty', `Nothing matches "${state.query.trim()}".`));
  if (!q && !list.length && state.tab === 'community' && !state.loadingCat) extras.push(el('div', 'empty', 'Nobody has shared a character yet.'));
  syncGrid($('#grid'), showGrid ? list : [], extras);

  renderDetails();
}

// ---- details ----------------------------------------------------------------------
// the top of the panel is rebuilt only when the character itself changes; the buttons follow every change
const dClose = el('button', 'icon-btn close');
dClose.append(icon('close'));
dClose.title = 'Close';
dClose.setAttribute('aria-label', 'Close');
dClose.addEventListener('click', () => closeDetails());
const dCore = el('div');
const dActions = el('div', 'd-actions');
$('#details').append(dClose, dCore, dActions);
let dSig = null;

function openDetails(id) { state.open = id; renderDetails(); }
function closeDetails() { state.open = null; renderDetails(); }

function renderDetails() {
  const wrap = $('#details-wrap');
  const e = state.open && entries().find((x) => x.id === state.open);
  if (!e) { state.open = null; dSig = null; hide(wrap); return; }
  show(wrap);

  const sig = [sigOf(e), e.name, e.author, e.description, e.kind, e.poses, e.size].join('|');
  if (sig !== dSig) {
    dSig = sig;
    const chips = el('div', 'chips');
    chips.append(el('span', 'chip', KIND[e.kind]));
    if (e.poses) chips.append(el('span', 'chip', `${e.poses} of ${POSES.length} poses`));
    if (!e.local && e.size) chips.append(el('span', 'chip', `${(e.size / 1048576).toFixed(0)} MB`));
    dCore.replaceChildren(tile(e, 'd-tile'), el('h2', null, e.name), el('div', 'author', byline(e)), chips);
    if (e.description) dCore.append(el('p', 'desc', e.description));
  }

  const busy = state.busy.has(e.id);
  const row = [primaryButton(e, true)];
  const extra = (label, cls, fn) => { const b = el('button', `btn ${cls}`, label); b.disabled = busy; b.addEventListener('click', act(e.id, fn)); row.push(b); };
  if (e.update) extra('Update', '', async () => { report(await lib.install(e.id), `${e.name} is up to date.`); await refresh(); });
  if (e.kind === 'mine') {
    extra('Export', '', async () => { report(await lib.exportPack(e.id, false), 'Saved. Send the .zip to a friend; they use Import pack.'); });
    extra('Share', '', async () => { report(await lib.exportPack(e.id, true), 'Saved. Drag the .zip into the GitHub page that just opened to offer her to the community.'); });
  }
  if (e.local && e.kind !== 'base') extra('Remove', 'danger', async () => { const r = await lib.remove(e.id); if (!r.ok && !r.cancelled) toast(r.error, true); await refresh(); });
  dActions.replaceChildren(...row);
}

// ---- new character ----------------------------------------------------------------
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

// the slots are built once; a slot gets or loses its picture in place
const slotNodes = {};
function buildSlots() {
  const slots = $('#slots');
  for (const [pose, hint] of POSES) {
    const s = el('div', `slot${pose === 'idle' ? ' req' : ''}`);
    s.title = hint;
    const plus = el('span', 'plus', '+');
    const x = el('button', 'x', '✕');
    x.title = 'Remove this picture';
    x.addEventListener('click', (e) => { e.stopPropagation(); URL.revokeObjectURL(wiz.urls[pose]); delete wiz.files[pose]; delete wiz.urls[pose]; renderSlots(); });
    s.append(plus, el('span', 'label', pose), x);
    s.addEventListener('click', () => pick(false, ([f]) => setFile(pose, f)));
    over(s, ([f]) => { if (f) setFile(pose, f); });
    slots.append(s);
    slotNodes[pose] = { s, plus, x, img: null };
  }
}

function renderSlots() {
  for (const [pose] of POSES) {
    const n = slotNodes[pose];
    const file = wiz.files[pose];
    n.s.classList.toggle('filled', !!file);
    if (file && (!n.img || n.img.src !== wiz.urls[pose])) {
      if (n.img) n.img.remove();
      n.img = el('img');
      n.img.src = wiz.urls[pose];
      n.img.alt = pose;
      n.s.prepend(n.img);
    } else if (!file && n.img) { n.img.remove(); n.img = null; }
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
  show($('#wizard'));
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
  $('#w-create').classList.add('busy');
  $('#w-create').prepend(el('span', 'spin'));
  $('#w-error').hidden = true;
  $('#w-status').textContent = 'Building the frames… this takes up to a minute.';
  try {
    let r = await lib.create({ name, author, files });
    if (r.exists && confirm(`${name} is already in your library. Replace her?`)) r = await lib.create({ name, author, files, overwrite: true });
    if (r.exists) return;
    if (!r.ok) { $('#w-error').textContent = r.error; $('#w-error').hidden = false; return; }
    hide($('#wizard'));
    await lib.equip(r.id);
    state.tab = 'mine';
    await refresh();
    toast(`${name} is ready and on your screen.`);
  } finally {
    $('#w-status').textContent = '';
    $('#w-create').classList.remove('busy');
    $('#w-create').querySelector('.spin')?.remove();
    buttons.forEach((b) => { b.disabled = false; });
    renderSlots();
  }
}

// ---- wiring -----------------------------------------------------------------------
if (lib.platform === 'win32') document.body.classList.add('win');
$('#search-icon').append(icon('search'));
$('#new').append(icon('plus'), el('span', null, 'Add'));
$('#import').append(icon('upload'), el('span', null, 'Import pack…'));
$('#folder').append(icon('folder'), el('span', null, 'Open my folder'));
buildSlots();

$('#new').addEventListener('click', openWizard);
$('#import').addEventListener('click', async () => { const r = report(await lib.importPack(), 'Imported. She is in your library.'); if (r.ok) state.tab = 'mine'; await refresh(); });
$('#folder').addEventListener('click', () => lib.openFolder());
$('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
$('#w-cancel').addEventListener('click', () => hide($('#wizard')));
$('#w-create').addEventListener('click', create);
$('#w-name').addEventListener('input', renderSlots);
$('#drop').addEventListener('click', () => pick(true, addMany));
$('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(true, addMany); } });
over($('#drop'), addMany);
$('#details-wrap').addEventListener('click', (e) => { if (e.target.id === 'details-wrap') closeDetails(); });

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (e.key !== 'Escape') return;
  if (isOpen($('#wizard'))) { if (!$('#w-cancel').disabled) hide($('#wizard')); } else if (state.open) closeDetails();
  else if (document.activeElement === $('#search') && state.query) { $('#search').value = ''; state.query = ''; render(); }
});
// a picture dropped anywhere else must not make the window open it
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
lib.onChanged(refresh);

render();
refresh().then(loadCatalog);
