'use strict';
// Character packs: a zip with manifest.json, an optional art.json and frames/<pose>.png. Packs come from strangers (the
// community catalog, a file a friend sent), so nothing in one is trusted: only these names are read, sizes are capped,
// every frame the manifest names has to be a real PNG in the pack, and nothing can land outside her own folder.

const fs = require('fs');
const path = require('path');
const zip = require('./zip');

const MAX_PNG = 12 * 1048576;
const FRAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*\.png$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const isPng = (b) => b.length > PNG.length && b.subarray(0, PNG.length).equals(PNG);

// zip file -> { id, manifest, files: { 'manifest.json', 'art.json'?, 'frames/<f>.png' ... } } or throws with a reason
function parse(buf) {
  const all = {};
  for (const [name, data] of Object.entries(zip.read(buf))) {
    const clean = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').includes('..')) throw new Error(`unsafe path in the pack: ${name}`);
    all[clean] = data;
  }
  // a pack zipped straight from a folder has everything under that folder's name
  if (!all['manifest.json']) {
    const tops = new Set(Object.keys(all).map((n) => n.split('/')[0]));
    const top = tops.size === 1 ? [...tops][0] : null;
    if (top && all[`${top}/manifest.json`]) {
      for (const n of Object.keys(all)) { all[n.slice(top.length + 1)] = all[n]; delete all[n]; }
    }
  }

  let manifest;
  try { manifest = JSON.parse(all['manifest.json'].toString('utf8').replace(/^﻿/, '')); } catch { manifest = null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('the pack has no valid manifest.json');
  const id = slug(manifest.name || manifest.title || '');
  if (!id) throw new Error('the pack\'s manifest has no name');
  if (!manifest.frames || typeof manifest.frames !== 'object' || !manifest.frames.idle) throw new Error('the pack has no idle frame');
  for (const k of ['name', 'title', 'author', 'description']) if (k in manifest) manifest[k] = String(manifest[k]).slice(0, k === 'description' ? 300 : 60);
  for (const k of ['height', 'fps']) if (k in manifest && !Number.isFinite(manifest[k])) delete manifest[k];
  delete manifest.base; // only the app's own girl is a base girl

  const files = { 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)) };
  for (const entry of Object.values(manifest.frames)) {
    for (const f of [].concat(entry)) {
      if (typeof f !== 'string' || !FRAME.test(f)) throw new Error(`the manifest names a frame that is not allowed: ${f}`);
      const data = all[`frames/${f}`];
      if (!data) throw new Error(`frame ${f} is missing from the pack`);
      if (!isPng(data) || data.length > MAX_PNG) throw new Error(`frame ${f} is not a PNG, or is too big`);
      files[`frames/${f}`] = data;
    }
  }
  if (all['art.json']) files['art.json'] = all['art.json'];
  return { id, manifest, files };
}

// write a parsed pack to <root>/<id>; marker (if any) says where she came from. Replaces what was there.
function install({ id, files }, root, marker) {
  fs.mkdirSync(root, { recursive: true });
  const dest = path.join(root, id);
  const tmp = path.join(root, `.${id}.tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(tmp, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  if (marker) fs.writeFileSync(path.join(tmp, 'catalog.json'), JSON.stringify(marker));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  return dest;
}

// a finished character folder -> zip file. patch overrides manifest fields (title, author, description).
function exportDir(dir, patch = {}) {
  const manifest = { ...JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), ...patch };
  delete manifest.base;
  const files = { 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)) };
  const art = path.join(dir, 'art.json');
  if (fs.existsSync(art)) files['art.json'] = fs.readFileSync(art);
  for (const entry of Object.values(manifest.frames)) {
    for (const f of [].concat(entry)) files[`frames/${f}`] = fs.readFileSync(path.join(dir, 'frames', f));
  }
  return zip.write(files);
}

module.exports = { parse, install, exportDir, slug };
