'use strict';
// Maintainer tool for the community catalog in catalog/ (index.json, packs/<id>.zip, previews/<id>.png).
//   node tools/catalog.js add <pack.zip or a finished character folder> [--title T] [--author A] [--description D]
//       checks a submitted pack, writes it to catalog/packs/<id>.zip and rebuilds the index
//   node tools/catalog.js build         rebuilds catalog/index.json and the previews from catalog/packs/
//   node tools/catalog.js remove <id>   takes a girl out of the catalog
// The app reads the files from the repo's main branch, so a change goes live when it is pushed. Needs sharp (npm install).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zip = require('../src/zip');
const charpack = require('../src/charpack');

const DIR = path.join(__dirname, '..', 'catalog');
const PACKS = path.join(DIR, 'packs');
const PREVIEWS = path.join(DIR, 'previews');

const opt = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

function add(src) {
  const patch = {};
  for (const k of ['title', 'author', 'description']) if (opt(k)) patch[k] = opt(k);
  const pack = charpack.parse(fs.statSync(src).isDirectory() ? charpack.exportDir(src) : fs.readFileSync(src));
  if (Object.keys(patch).length) pack.files['manifest.json'] = Buffer.from(JSON.stringify({ ...pack.manifest, ...patch }, null, 2));
  fs.mkdirSync(PACKS, { recursive: true });
  // written fresh: no stray files, no wrapper folder, and the same bytes (so the same sha256) every time
  fs.writeFileSync(path.join(PACKS, `${pack.id}.zip`), zip.write(pack.files));
  console.log(`added ${pack.id}`);
}

async function build() {
  const sharp = require('sharp');
  fs.mkdirSync(PACKS, { recursive: true });
  fs.mkdirSync(PREVIEWS, { recursive: true });
  const characters = [];
  for (const f of fs.readdirSync(PACKS).filter((n) => n.endsWith('.zip')).sort()) {
    const buf = fs.readFileSync(path.join(PACKS, f));
    const { id, manifest, files } = charpack.parse(buf);
    if (f !== `${id}.zip`) throw new Error(`${f} must be named ${id}.zip`);
    await sharp(files[`frames/${[].concat(manifest.frames.idle)[0]}`]).resize({ height: 640 }).png({ compressionLevel: 9 }).toFile(path.join(PREVIEWS, `${id}.png`));
    characters.push({
      id, name: manifest.title || manifest.name, author: manifest.author || '', description: manifest.description || '',
      zip: `packs/${f}`, preview: `previews/${id}.png`, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length,
    });
  }
  for (const f of fs.readdirSync(PREVIEWS)) if (!characters.some((c) => `${c.id}.png` === f)) fs.rmSync(path.join(PREVIEWS, f));
  fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify({ version: 1, characters }, null, 2) + '\n');
  console.log(`index.json lists ${characters.map((c) => c.id).join(', ') || 'nobody'}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'add' && arg) add(arg);
  else if (cmd === 'remove' && arg) fs.rmSync(path.join(PACKS, `${charpack.slug(arg)}.zip`), { force: true });
  else if (cmd !== 'build') { console.error('usage: node tools/catalog.js add <pack.zip|folder> | remove <id> | build'); process.exit(1); }
  await build();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
