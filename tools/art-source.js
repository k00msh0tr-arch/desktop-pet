'use strict';
// Where a character's source images are, and whether its frames are out of date.
// Shared by the art tool (tools/process-art.js) and the app, which builds new characters from a dropped-in folder.

const fs = require('fs');
const path = require('path');

const IMAGE = /\.(png|webp|jpe?g)$/i;

const images = (dir) => fs.readdirSync(dir).filter((f) => IMAGE.test(f) && !f.startsWith('_') && fs.statSync(path.join(dir, f)).isFile());

// the images live in <character>/raw if that has any, otherwise straight in the character folder
function rawDir(dir) {
  const raw = path.join(dir, 'raw');
  return fs.existsSync(raw) && images(raw).length ? raw : dir;
}

const sources = (dir) => images(rawDir(dir));

// one line that changes whenever a source image is added, replaced or removed
function stamp(dir) {
  const raw = rawDir(dir);
  const list = sources(dir).sort().map((f) => {
    const s = fs.statSync(path.join(raw, f));
    return `${f}:${s.size}:${Math.floor(s.mtimeMs)}`;
  });
  try { // art.json settings (scales, seat, ...) are part of what the frames are made from
    const a = fs.statSync(path.join(dir, 'art.json'));
    list.push(`art.json:${a.size}:${Math.floor(a.mtimeMs)}`);
  } catch { /* none */ }
  return JSON.stringify({ sources: list });
}

// a folder with an idle image whose frames are missing or older than its images
function needsImport(dir) {
  if (!sources(dir).some((f) => path.parse(f).name.toLowerCase() === 'idle')) return false;
  try {
    return fs.readFileSync(path.join(dir, 'frames', '_source.json'), 'utf8') !== stamp(dir);
  } catch {
    return true;
  }
}

module.exports = { rawDir, sources, stamp, needsImport };
