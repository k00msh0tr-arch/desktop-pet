'use strict';
// Small helpers the Characters window and the Studio share (loaded before each page's own script).
// Everything shown is built with textContent, never innerHTML: names and descriptions can come from strangers.

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
  wand: 'M5 19L15 9M14 5l1.2 2.3L17.5 8.5l-2.3 1.2L14 12l-1.2-2.3L10.5 8.5l2.3-1.2L14 5zM19 13l.7 1.3 1.3.7-1.3.7L19 17l-.7-1.3-1.3-.7 1.3-.7L19 13z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 12.5l4.2 4.2L19 7',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l.8 12h8.4L17 7',
  external: 'M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 01-1 1H6a1 1 0 01-1-1V8a1 1 0 011-1h4',
  image: 'M4.5 6A1.5 1.5 0 016 4.5h12A1.5 1.5 0 0119.5 6v12a1.5 1.5 0 01-1.5 1.5H6A1.5 1.5 0 014.5 18zM4.5 16l4.5-4.5 4 4 2.5-2.5 4 4M15 9.5h.01',
  gear: 'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM19 12l1.8-1-.9-2.2-2 .3-.9-1.6.8-1.9-1.9-1.4-1.5 1.4-1.8-.4L12 2.5l-1.6 1.7-1.8.4L7.1 3.2 5.2 4.6l.8 1.9-.9 1.6-2-.3L2.2 10 4 11v2l-1.8 1 .9 2.2 2-.3.9 1.6-.8 1.9 1.9 1.4 1.5-1.4 1.8.4L12 21.5l1.6-1.7 1.8-.4 1.5 1.4 1.9-1.4-.8-1.9.9-1.6 2 .3.9-2.2L19 13z',
  refresh: 'M19 8a7.5 7.5 0 00-13.4-1.5L4 9M4 5v4h4M5 16a7.5 7.5 0 0013.4 1.5L20 15M20 19v-4h-4',
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

// ---- dropping and ordering -----------------------------------------------------------
// a drop target: it marks itself while something is dragged over it and hands the dropped files to onDrop
function over(node, onDrop) {
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('over'); });
  node.addEventListener('dragleave', () => node.classList.remove('over'));
  node.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); node.classList.remove('over'); onDrop([...e.dataTransfer.files]); });
}

// make parent's children exactly the given nodes, in that order, moving as little as possible: a node that is already in place is
// left alone (moving one restarts its animation and loses its hover)
function syncChildren(parent, nodes) {
  let ref = parent.firstChild;
  for (const n of nodes) {
    if (n === ref) ref = ref.nextSibling;
    else parent.insertBefore(n, ref);
  }
  while (ref) { const next = ref.nextSibling; ref.remove(); ref = next; }
}

// ---- messages -----------------------------------------------------------------------
let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  clearTimeout(toastTimer);
  t.textContent = msg;
  t.className = `glass${isErr ? ' err' : ''}`;
  show(t);
  toastTimer = setTimeout(() => hide(t), isErr ? 7000 : 4000);
}
