'use strict';
// The page of the Studio. The Gemini step is yours (free): the studio copies the prompt and the reference picture for you,
// takes the picture you paste or drop back, and lets you accept, regenerate or delete each try. Then it builds her.
// POSES, KEYS and the prompt functions come from prompts.js; $, el, icon, show, hide, toast, over, syncChildren from ui.js.

const state = { projects: [], p: null, step: 'design', settings: { upscalerExe: '' } };
const STEPS = ['design', ...KEYS, 'build'];
const poseInfo = (key) => POSES.find((x) => x[0] === key);
const isUp = (file) => /-up\.png$/.test(file);

// run a call; show its error (and an optional message when it works); null if it failed
async function ok(promise, message) {
  const r = await promise;
  if (!r.ok) { toast(r.error, true); return null; }
  if (message) toast(message);
  return r;
}

// ---- saving what you type -------------------------------------------------------------
const pending = {};
let saveTimer = null;
function save(fields) {
  const { prompts: pr, ...rest } = fields;
  Object.assign(state.p, rest);
  Object.assign(pending, rest);
  if (pr) {
    Object.assign(state.p.prompts, pr);
    pending.prompts = { ...(pending.prompts || {}), ...pr };
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}
async function flush() {
  clearTimeout(saveTimer);
  if (!Object.keys(pending).length || !state.p) return;
  const fields = { ...pending };
  for (const k of Object.keys(pending)) delete pending[k];
  await studio.patch(state.p.id, fields);
}

// a project came back from the main process: keep it and redraw
// what you typed in the last moment is not on the server yet, so it must not be overwritten by its answer
function setProject(p) {
  state.p = { ...p, ...pending, prompts: { ...p.prompts, ...(pending.prompts || {}) } };
  render();
}

// ---- pictures in ----------------------------------------------------------------------
async function addPicture(file, pose) {
  if (!/\.(png|webp|jpe?g)$/i.test(file.name || 'x.png') && !/^image\//.test(file.type)) { toast('Only png, webp or jpg pictures.', true); return; }
  await flush();
  const r = await ok(studio.image(state.p.id, pose, await file.arrayBuffer()));
  if (r) setProject(r.project);
}
const poseForPaste = () => (state.step === 'design' ? 'source' : KEYS.includes(state.step) ? state.step : null);

function chooseFile(onFile) {
  const input = el('input');
  input.type = 'file';
  input.accept = '.png,.webp,.jpg,.jpeg,image/png,image/webp,image/jpeg';
  input.addEventListener('change', () => { if (input.files.length) onFile(input.files[0]); });
  input.click();
}

// ---- the sidebar ------------------------------------------------------------------------
const stepNodes = {};
function statusOf(step) {
  const p = state.p;
  if (step === 'design') return p.source && p.personality.trim() ? 'done' : p.source || p.personality.trim() ? 'some' : '';
  if (step === 'build') return p.accepted.idle ? 'some' : '';
  return p.accepted[step] ? 'done' : (p.variants[step] || []).length ? 'some' : '';
}

function renderSteps() {
  const nav = $('#steps');
  if (!nav.children.length) {
    for (const step of STEPS) {
      if (step === 'idle' || step === 'build') nav.append(el('div', 'step-gap'));
      const b = el('button', 'step');
      const label = el('span', null, step === 'design' ? 'Design' : step === 'build' ? 'Build' : step);
      const mark = el('span', 'mark');
      if (poseInfo(step)) b.title = poseInfo(step)[1];
      b.append(label, mark);
      b.addEventListener('click', () => go(step));
      nav.append(b);
      stepNodes[step] = { b, mark };
    }
  }
  for (const step of STEPS) {
    const { b, mark } = stepNodes[step];
    const s = statusOf(step);
    b.classList.toggle('on', state.step === step);
    b.classList.toggle('done', s === 'done');
    b.classList.toggle('some', s === 'some');
    mark.replaceChildren(...(s === 'done' ? [icon('check')] : s === 'some' ? [el('i')] : []));
  }
}

async function go(step) {
  if (state.step === step) return;
  await flush();
  state.step = step;
  $('#scroll').scrollTo({ top: 0 });
  render();
}

// ---- panels -----------------------------------------------------------------------------
// each view builds its page once and has update(p) to bring it up to date, so typing and pictures never get rebuilt
let view = null;
function renderPanel() {
  const p = state.p;
  if (!view || view.step !== state.step || view.pid !== p.id) {
    view = { step: state.step, pid: p.id, ...(state.step === 'design' ? designView(p) : state.step === 'build' ? buildView() : poseView(state.step)) };
    $('#panel').replaceChildren(view.root);
    enter(view.root, 0);
  }
  view.update(p);
}

const labelled = (text, node) => { const l = el('label'); l.append(el('span', null, text), node); return l; };
function textField(field, placeholder, max) {
  const i = el('input');
  i.placeholder = placeholder;
  i.maxLength = max;
  i.autocomplete = 'off';
  i.addEventListener('input', () => save({ [field]: i.value }));
  return i;
}
const syncValue = (node, value) => { if (document.activeElement !== node && node.value !== value) node.value = value; };
const button = (label, cls, onClick, ico) => {
  const b = el('button', `btn ${cls || ''}`);
  if (ico) b.append(icon(ico));
  b.append(el('span', null, label));
  b.addEventListener('click', onClick);
  return b;
};

function designView() {
  const root = el('div', 'view');
  root.append(el('h2', null, 'Design'), el('p', 'sub', 'Your character picture and who she is. The prompts for every pose come from this.'));

  const name = textField('name', 'Mia', 60), author = textField('author', 'you (optional)', 60), style = textField('style', 'anime, clean lineart, soft shading', 200);
  const personality = el('textarea');
  personality.rows = 4;
  personality.maxLength = 1500;
  personality.placeholder = 'Cheerful and a bit clumsy. Gets excited about small things, hides it when embarrassed, always tries to help.';
  personality.addEventListener('input', () => save({ personality: personality.value }));

  const b1 = el('div', 'box glass');
  b1.append(el('h3', null, 'Her'));
  const f = el('div', 'fields3');
  f.append(labelled('Name', name), labelled('Made by', author), labelled('Art style', style));
  const pl = labelled('Personality', personality);
  pl.style.marginTop = '14px';
  b1.append(f, pl);

  const zone = el('div', 'zone source');
  zone.tabIndex = 0;
  const zoneText = el('span', null, 'Drop your character picture here, paste it (Ctrl+V), or click to choose.');
  const change = el('span', 'change', 'Change picture');
  zone.append(zoneText);
  let img = null;
  zone.addEventListener('click', () => chooseFile((file) => addPicture(file, 'source')));
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter') chooseFile((file) => addPicture(file, 'source')); });
  over(zone, ([file]) => { if (file) addPicture(file, 'source'); });
  const b2 = el('div', 'box glass');
  b2.append(el('h3', null, 'Her picture'), zone);

  const write = button('Write the prompts', 'primary', writePrompts, 'wand');
  const better = button('Make them better with Claude…', '', openReply);
  const status = el('span', 'status');
  const actions = el('div', 'row inline');
  actions.append(write, better, status);
  const b3 = el('div', 'box glass');
  b3.append(el('h3', null, 'Prompts'), el('p', 'status', 'One prompt per pose. The built-in ones work straight away; Claude can write ones that fit her personality.'), actions);
  root.append(b1, b2, b3);

  return {
    root,
    update(p) {
      syncValue(name, p.name); syncValue(author, p.author); syncValue(style, p.style); syncValue(personality, p.personality);
      if (p.source) {
        if (!img) { img = el('img'); img.alt = ''; zone.prepend(img); zone.append(change); }
        const src = p.base + p.source;
        if (img.getAttribute('src') !== src) img.src = src;
        zoneText.hidden = true;
      } else { if (img) { img.remove(); change.remove(); img = null; } zoneText.hidden = false; }
      const n = Object.keys(p.prompts).length;
      write.querySelector('span').textContent = n ? 'Write them again' : 'Write the prompts';
      status.textContent = n ? `${n} prompts are ready. Go through the poses on the left, starting with idle.` : '';
    },
  };
}

async function writePrompts() {
  await flush();
  if (Object.keys(state.p.prompts).length && !confirm('Replace the prompts you have, including any you edited, with fresh ones?')) return;
  const r = await ok(studio.prompts(state.p.id), 'Prompts written. Start with idle.');
  if (r) { setProject(r.project); go('idle'); }
}

function poseView(key) {
  const [, use, , left] = poseInfo(key);
  const root = el('div', 'view');
  root.append(el('h2', null, key), el('p', 'sub', `${use}${left ? ' · faces left' : ''}`));
  const warn = el('div', 'warn');
  root.append(warn);

  const promptBox = el('textarea');
  promptBox.rows = 7;
  promptBox.addEventListener('input', () => save({ prompts: { [key]: promptBox.value } }));
  const note = el('input');
  note.placeholder = 'What should change this time? (optional, added to the prompt)';
  note.autocomplete = 'off';
  note.style.marginTop = '12px';
  const copy = button('Copy prompt', 'primary', async () => {
    const text = promptBox.value + (note.value.trim() ? `\n\nChange from the last try: ${note.value.trim()}` : '');
    await ok(studio.copyText(text), 'Prompt copied. Paste it into Gemini.');
  }, 'copy');
  const ref = button('Copy reference picture', '', async () => {
    const file = key === 'idle' ? state.p.source : state.p.accepted.idle;
    if (file) await ok(studio.copyImage(state.p.id, file), 'Reference copied. Paste it into Gemini first (Ctrl+V), then the prompt.');
  }, 'image');
  const gemini = button('Open Gemini', '', () => studio.open('gemini'), 'external');
  const row = el('div', 'row inline');
  row.append(copy, ref, gemini);
  const b1 = el('div', 'box glass');
  b1.append(el('h3', null, '1. Prompt'), promptBox, note, row, el('p', 'hint', 'In Gemini: paste the reference picture, then the prompt, and generate. Copy the picture it makes and press Ctrl+V here, or drag it in.'));

  const zone = el('div', 'zone');
  zone.tabIndex = 0;
  zone.append(el('b', null, 'Paste (Ctrl+V) or drop the picture Gemini made'), el('span', null, 'or click to choose a file. Each try is kept below.'));
  zone.addEventListener('click', () => chooseFile((file) => addPicture(file, key)));
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter') chooseFile((file) => addPicture(file, key)); });
  over(zone, (files) => files.forEach((file) => addPicture(file, key)));
  const grid = el('div', 'variants');
  const b2 = el('div', 'box glass');
  b2.append(el('h3', null, '2. Pictures'), zone, grid);
  root.append(b1, b2);

  const cards = new Map();
  const working = new Set();
  function card(p, file) {
    let c = cards.get(file);
    if (!c) {
      c = el('div', 'variant');
      const pic = el('div', 'pic'), img = el('img');
      img.alt = '';
      img.src = p.base + file;
      pic.append(img);
      if (isUp(file)) pic.append(el('span', 'tag', 'Upscaled'));
      c.append(pic, el('div', 'acts'));
      enter(c, 0);
      cards.set(file, c);
    }
    const accepted = p.accepted[key] === file;
    c.classList.toggle('on', accepted);
    const acts = c.querySelector('.acts');
    const busy = working.has(file);
    const items = [accepted ? el('span', 'pill ok', 'Accepted') : button('Accept', 'primary', async () => {
      const r = await ok(studio.patch(p.id, { accepted: { [key]: file } }));
      if (r) setProject(r.project);
    })];
    if (state.settings.upscalerExe && !isUp(file)) {
      const up = button(busy ? 'Upscaling…' : 'Upscale', '', async () => {
        working.add(file); render();
        const r = await ok(studio.upscale(p.id, key, file));
        working.delete(file);
        if (r) setProject(r.project); else render();
      });
      if (busy) up.prepend(el('span', 'spin'));
      up.disabled = busy;
      items.push(up);
    }
    const del = el('button', 'icon-btn');
    del.append(icon('trash'));
    del.title = 'Delete this picture';
    del.setAttribute('aria-label', 'Delete this picture');
    del.disabled = busy;
    del.addEventListener('click', async () => { const r = await ok(studio.deleteImage(p.id, key, file)); if (r) setProject(r.project); });
    items.push(del);
    acts.replaceChildren(...items);
    return c;
  }

  return {
    root,
    update(p) {
      syncValue(promptBox, p.prompts[key] || '');
      const reference = key === 'idle' ? p.source : p.accepted.idle;
      ref.disabled = !reference;
      ref.title = reference ? '' : key === 'idle' ? 'Add her design picture on the Design step first' : 'Accept an idle picture first';
      warn.hidden = !!reference;
      warn.textContent = key === 'idle'
        ? 'Add her design picture on the Design step first: Gemini needs it as the reference.'
        : 'Accept an idle picture first: Gemini needs it as the reference for every other pose.';
      if (!p.prompts[key]) { promptBox.placeholder = 'No prompt yet: write them on the Design step.'; }
      const files = p.variants[key] || [];
      note.hidden = !files.length;
      copy.querySelector('span').textContent = files.length ? 'Regenerate: copy prompt' : 'Copy prompt';
      for (const f of [...cards.keys()]) if (!files.includes(f)) cards.delete(f);
      syncChildren(grid, files.map((f) => card(p, f)));
    },
  };
}

function buildView() {
  const root = el('div', 'view');
  root.append(el('h2', null, 'Build'), el('p', 'sub', 'Turn the pictures you accepted into a character in your library.'));
  const summary = el('p', 'status');
  const thumbs = el('div', 'thumbs');
  const missing = el('p', 'hint');
  const box = el('div', 'box glass');
  box.append(el('h3', null, 'Accepted pictures'), summary, thumbs, missing);
  const up = button('Upscale the accepted pictures', '', upscaleAll, 'refresh');
  const create = button('Create her', 'primary', createHer, 'wand');
  const row = el('div', 'row inline');
  row.append(create, up);
  const error = el('pre', 'error');
  error.hidden = true;
  box.append(row, error);
  root.append(box);

  const nodes = new Map();
  async function upscaleAll() {
    const todo = Object.entries(state.p.accepted).filter(([, f]) => !isUp(f));
    up.disabled = create.disabled = true;
    let done = 0;
    for (const [pose, file] of todo) {
      up.querySelector('span').textContent = `Upscaling ${++done} of ${todo.length}…`;
      const r = await ok(studio.upscale(state.p.id, pose, file));
      if (!r) break;
      state.p = r.project;
    }
    up.querySelector('span').textContent = 'Upscale the accepted pictures';
    up.disabled = create.disabled = false;
    render();
    toast('Upscaled.');
  }

  async function createHer() {
    await flush();
    error.hidden = true;
    create.disabled = true;
    create.prepend(el('span', 'spin'));
    try {
      const p = state.p;
      let r = await studio.build(p.id);
      if (r.exists && confirm(`${p.name} is already in your library. Replace her?`)) r = await studio.build(p.id, true);
      if (r.exists) return;
      if (!r.ok) { error.textContent = r.error; error.hidden = false; return; }
      toast(`${p.name} is in your library and on your screen.`);
    } finally {
      create.querySelector('.spin')?.remove();
      create.disabled = !state.p.accepted.idle;
    }
  }

  return {
    root,
    update(p) {
      const have = KEYS.filter((k) => p.accepted[k]);
      summary.textContent = `${have.length} of ${KEYS.length} poses accepted.`;
      syncChildren(thumbs, KEYS.map((k) => {
        let n = nodes.get(k), src = p.accepted[k] ? p.base + p.accepted[k] : null;
        if (!n || n.dataset.src !== (src || '')) {
          n = el('div', `thumb${src ? '' : ' missing'}`);
          n.dataset.src = src || '';
          if (src) { const img = el('img'); img.alt = ''; img.src = src; n.append(img); } else n.append(el('span', 'none', '+'));
          n.append(el('span', null, k));
          nodes.set(k, n);
        }
        return n;
      }));
      missing.textContent = have.length === KEYS.length ? '' : p.accepted.idle
        ? 'Poses without a picture borrow from another one (blink and sleeping from idle, thanks from happy, and so on), so you can build now and add the rest later.'
        : 'Accept an idle picture first: she needs at least that one.';
      create.disabled = !p.accepted.idle;
      up.hidden = !state.settings.upscalerExe || !have.length;
    },
  };
}

function emptyView() {
  const root = el('div', 'empty-view');
  root.append(el('div', null, 'No project yet. A project is one character.'), button('New project', 'primary', openNewProject, 'plus'));
  return { root, update() {} };
}

// ---- projects ---------------------------------------------------------------------------
function renderProjects() {
  const sel = $('#project');
  sel.replaceChildren(...state.projects.map((p) => { const o = el('option', null, p.name || p.id); o.value = p.id; return o; }));
  if (state.p) sel.value = state.p.id;
}

async function openProject(id) {
  await flush();
  const r = await ok(studio.load(id));
  if (!r) return;
  state.step = 'design';
  view = null;
  setProject(r.project);
}

async function reloadProjects(select) {
  const r = await ok(studio.projects());
  if (!r) return;
  state.projects = r.projects;
  if (select && state.projects.some((p) => p.id === select)) await openProject(select);
  else if (!state.p || !state.projects.some((p) => p.id === state.p.id)) {
    state.p = null;
    if (state.projects.length) await openProject(state.projects[0].id); else render();
  } else renderProjects();
}

function render() {
  if (!state.p) {
    view = { step: 'none', pid: '', ...emptyView() };
    $('#panel').replaceChildren(view.root);
    $('#steps').replaceChildren();
    for (const k of Object.keys(stepNodes)) delete stepNodes[k];
    renderProjects();
    return;
  }
  renderProjects();
  renderSteps();
  renderPanel();
}

function openNewProject() { $('#np-name').value = ''; $('#np-create').disabled = true; show($('#newproj')); $('#np-name').focus(); }
async function createProject() {
  const r = await ok(studio.create($('#np-name').value));
  if (!r) return;
  hide($('#newproj'));
  await reloadProjects(r.project.id);
}

// ---- Claude writes the prompts --------------------------------------------------------------
function openReply() { $('#rp-text').value = ''; $('#rp-apply').disabled = true; show($('#reply')); }

// ---- wiring -------------------------------------------------------------------------------
if (studio.platform === 'win32') document.body.classList.add('win');
$('#new-project').append(icon('plus'));
$('#settings').append(icon('gear'), el('span', null, 'Upscaler'));
$('#remove').append(icon('trash'), el('span', null, 'Delete project'));

$('#project').addEventListener('change', (e) => openProject(e.target.value));
$('#new-project').addEventListener('click', openNewProject);
$('#np-name').addEventListener('input', () => { $('#np-create').disabled = !$('#np-name').value.trim(); });
$('#np-name').addEventListener('keydown', (e) => { if (e.key === 'Enter' && $('#np-name').value.trim()) createProject(); });
$('#np-create').addEventListener('click', createProject);
$('#np-cancel').addEventListener('click', () => hide($('#newproj')));
$('#remove').addEventListener('click', async () => {
  if (!state.p) return;
  const r = await ok(studio.remove(state.p.id));
  if (r && !r.cancelled) { state.p = null; await reloadProjects(); }
});

$('#rp-copy').addEventListener('click', async () => {
  await flush();
  const r = await ok(studio.request(state.p.id));
  if (r) await ok(studio.copyText(r.text), 'Copied. Paste it into Claude, then paste its answer below.');
});
$('#rp-text').addEventListener('input', () => { $('#rp-apply').disabled = !$('#rp-text').value.trim(); });
$('#rp-cancel').addEventListener('click', () => hide($('#reply')));
$('#rp-apply').addEventListener('click', async () => {
  const r = await ok(studio.applyReply(state.p.id, $('#rp-text').value));
  if (!r) return;
  hide($('#reply'));
  setProject(r.project);
  toast(`${r.used} of ${KEYS.length} prompts came from Claude${r.used < KEYS.length ? '; the rest use the built-in ones' : ''}.`);
  go('idle');
});

$('#settings').addEventListener('click', () => {
  $('#pf-exe').value = state.settings.upscalerExe || '';
  $('#pf-args').value = state.settings.upscalerArgs || '';
  show($('#prefs'));
});
$('#pf-pick').addEventListener('click', async () => { const r = await ok(studio.pickProgram()); if (r && r.file) $('#pf-exe').value = r.file; });
$('#pf-get').addEventListener('click', () => studio.open('upscaler'));
$('#pf-cancel').addEventListener('click', () => hide($('#prefs')));
$('#pf-save').addEventListener('click', async () => {
  const r = await ok(studio.saveSettings({ upscalerExe: $('#pf-exe').value, upscalerArgs: $('#pf-args').value }), 'Saved.');
  if (!r) return;
  state.settings = r.settings;
  hide($('#prefs'));
  if (state.p) { view = null; render(); }
});

document.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData ? e.clipboardData.files : [])].find((f) => f.type.startsWith('image/'));
  if (!file) return; // text pastes into the field as usual
  e.preventDefault();
  const pose = state.p && poseForPaste();
  if (pose) addPicture(file, pose); else toast('Open the Design step or a pose first, then paste.', true);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const id of ['#newproj', '#reply', '#prefs']) if (isOpen($(id))) { hide($(id)); return; }
});
// a picture dropped anywhere else must not make the window open it
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('beforeunload', () => { flush(); });

(async () => {
  const s = await studio.settings();
  if (s.ok) state.settings = s.settings;
  await reloadProjects();
  if (!state.projects.length) openNewProject();
})();
