'use strict';
// Removes the flat green backdrop from the raw Gemini frames, registers every
// frame against idle, crops them all to one shared box and writes transparent
// PNGs to characters/<name>/frames plus a contact sheet to check the result.
//   node tools/process-art.js [character]

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { rawDir, sources, stamp } = require('./art-source');

// a character name in this project's characters/ folder, or the path of any character folder
const arg = process.argv[2] || 'sonnet';
const ROOT = /[\\/]/.test(arg) ? path.resolve(arg) : path.join(__dirname, '..', 'characters', arg);
const RAW = rawDir(ROOT); // <character>/raw if it has images, otherwise the folder itself
const OUT = path.join(ROOT, 'frames');
// standing poses are registered against idle; the motion poses move her legs, so they are only cropped
const STANDING = ['idle', 'blink', 'thinking', 'working', 'waiting', 'happy', 'thanks', 'oops', 'sleeping'];
const MOTION = ['held', 'fall', 'jump', 'sit', 'walk', 'walk2', 'climb', 'climb2'];
const GROUNDED = ['sit', 'jump']; // the lowest pixel is her trailing shoe, so take-off and landing meet the ground
// Gemini tends to draw the seated figure a bit larger than the standing one. A character's art.json can scale a pose
// ({ "scales": { "sit": 0.89 } }) so her head and body match the standing frames (Sonnet's best match was 0.88-0.89).
// Scaled before the pose is grounded.
// Other art.json keys: "seat" (0-1, how far down the sit image her seat is, so she sits on the edge of a window),
// "autoScale": false (don't measure poses against idle's face) and "legacy": true (the older, simpler motion handling:
// no padding, no auto scale, centred by bounding box; Sonnet uses it so her frames stay exactly as they were).
let ART = {};
try { ART = JSON.parse(fs.readFileSync(path.join(ROOT, 'art.json'), 'utf8')); } catch { /* no art.json */ }
const SCALES = ART.scales || {};
const LEGACY = !!ART.legacy;
const ORDER = [...STANDING, ...MOTION];
const SEARCH = 10; // px of drift tolerated when registering frames
const PAD = 8;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

async function load(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

function sampleBackground({ data, w, h }) {
  const P = 24;
  let r = 0, g = 0, b = 0, n = 0;
  for (const [x0, y0] of [[0, 0], [w - P, 0], [0, h - P], [w - P, h - P]]) {
    for (let y = y0; y < y0 + P; y++) {
      for (let x = x0; x < x0 + P; x++) {
        const i = (y * w + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
  }
  return [r / n, g / n, b / n];
}

function preKeyed({ data, w, h }) {
  let a = 0, n = 0;
  for (const [x0, y0] of [[0, 0], [w - 8, 0], [0, h - 8], [w - 8, h - 8]]) {
    for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) { a += data[(y * w + x) * 4 + 3]; n++; }
  }
  return a / n < 8;
}

// "Greenness" is g - max(r, b): ~80 on the backdrop, <= 0 on everything she wears.
// Only pixels within 2px of obvious backdrop get a partial alpha, so greenish
// pixels deep inside the character are never punched out.
function key(img) {
  const { data, w, h } = img;
  const bg = sampleBackground(img);
  const bgG = bg[1] - Math.max(bg[0], bg[2]);
  const LO = -30, HI = bgG * 0.85, DEFINITE = bgG * 0.5;

  const gr = new Int16Array(w * h);
  const isBg = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    gr[p] = data[i + 1] - Math.max(data[i], data[i + 2]);
    if (gr[p] > DEFINITE) isBg[p] = 1;
  }
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isBg[y * w + x]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) near[yy * w + xx] = 1;
        }
      }
    }
  }

  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (!near[p]) { data[i + 3] = 255; continue; }
    const a = clamp((HI - gr[p]) / (HI - LO), 0, 1);
    if (a < 0.02) { data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0; continue; }
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (a < 1) { // un-premix the backdrop colour out of the edge pixel
      r = (r - (1 - a) * bg[0]) / a;
      g = (g - (1 - a) * bg[1]) / a;
      b = (b - (1 - a) * bg[2]) / a;
    }
    g = Math.min(g, Math.max(r, b)); // despill
    data[i] = clamp(Math.round(r), 0, 255);
    data[i + 1] = clamp(Math.round(g), 0, 255);
    data[i + 2] = clamp(Math.round(b), 0, 255);
    data[i + 3] = Math.round(a * 255);
  }
  return { img, bg, bgG };
}

// The legs and shoes never move between poses, so they register the frames.
function register(ref, cur) {
  const { w, h } = ref;
  const y0 = Math.round(h * 0.7), y1 = h - 12;
  let best = { dx: 0, dy: 0, cost: Infinity };
  let total = 0;
  for (let y = y0; y < y1; y += 2) for (let x = 0; x < w; x += 2) if (ref.data[(y * w + x) * 4 + 3] > 128) total++;
  for (let dy = -SEARCH; dy <= SEARCH; dy++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      let cost = 0;
      for (let y = y0; y < y1; y += 2) {
        const sy = y - dy;
        if (sy < 0 || sy >= h) continue;
        for (let x = 0; x < w; x += 2) {
          const sx = x - dx;
          if (sx < 0 || sx >= w) continue;
          const r = ref.data[(y * w + x) * 4 + 3] > 128;
          const c = cur.data[(sy * w + sx) * 4 + 3] > 128;
          if (r !== c) cost++;
        }
      }
      if (cost < best.cost) best = { dx, dy, cost };
    }
  }
  return { ...best, mismatch: total ? best.cost / total : 0 };
}

function shift(img, dx, dy) {
  if (!dx && !dy) return img;
  const { w, h } = img;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= w) continue;
      img.data.copy(out, (y * w + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
    }
  }
  return { data: out, w, h };
}

// scaled about the bottom centre of the same-size canvas; the caller moves it into place afterwards
async function rescale(img, s) {
  const { w, h } = img;
  const nw = Math.round(w * s), nh = Math.round(h * s);
  const small = await sharp(img.data, { raw: { width: w, height: h, channels: 4 } }).resize(nw, nh, { kernel: 'lanczos3' }).png().toBuffer();
  const out = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: small, left: Math.round((w - nw) / 2), top: h - nh }])
    .raw()
    .toBuffer();
  return { data: out, w, h };
}

function bbox({ data, w, h }) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

// ---- motion poses, the default way ----------------------------------------------------------------------------------
// Each pose is scaled to idle's size, then placed: held and fall so their face lands exactly where idle's face is, sit,
// jump and mid-air poses so their lowest pixel stands on idle's soles, side views so their torso is over idle's torso
// (the pet mirrors them about that line, so an off-centre torso would slide into the wall).
const HEAD_SCALED = ['held', 'fall', 'sit']; // front-facing poses: their size is measured by matching idle's face
const HEAD_ALIGNED = ['held', 'fall'];
const GROUND = ['sit', 'jump'];
const MIN_FACE_MATCH = 0.45;
let seatY = null; // where her seat ended up in the padded canvas, once sit is placed

function blit(src, tx, ty, W, H) { // src copied into a transparent W x H canvas with its top-left at (tx, ty)
  const out = Buffer.alloc(W * H * 4);
  const sx0 = Math.max(0, -tx), sx1 = Math.min(src.w, W - tx);
  if (sx1 > sx0) {
    for (let y = 0; y < src.h; y++) {
      const dy = y + ty;
      if (dy < 0 || dy >= H) continue;
      src.data.copy(out, (dy * W + sx0 + tx) * 4, (y * src.w + sx0) * 4, (y * src.w + sx1) * 4);
    }
  }
  return { data: out, w: W, h: H };
}

async function scaleCanvas(img, s) {
  const { data, info } = await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .resize(Math.round(img.w * s), Math.round(img.h * s), { kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// where the body is horizontally: the centre of mass of the waist and hips
function torsoX(img, b) {
  const hb = b.y1 - b.y0, ya = Math.round(b.y0 + 0.4 * hb), yb = Math.round(b.y0 + 0.56 * hb);
  let sum = 0, n = 0;
  for (let y = ya; y <= yb; y++) for (let x = b.x0; x <= b.x1; x++) if (img.data[(y * img.w + x) * 4 + 3] > 128) { sum += x; n++; }
  return n ? sum / n : (b.x0 + b.x1) / 2;
}

function headX(img, b) { // the centre of her head: the top few percent of her
  const hb = b.y1 - b.y0, ya = Math.round(b.y0 + 0.01 * hb), yb = Math.round(b.y0 + 0.08 * hb);
  let sum = 0, n = 0;
  for (let y = ya; y <= yb; y++) for (let x = b.x0; x <= b.x1; x++) if (img.data[(y * img.w + x) * 4 + 3] > 128) { sum += x; n++; }
  return n ? sum / n : (b.x0 + b.x1) / 2;
}

// a region of a frame on white, in grey, scaled by `factor`
async function grey(img, r, factor) {
  const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
  const w = Math.min(img.w - x, Math.round(r.w)), h = Math.min(img.h - y, Math.round(r.h));
  const out = await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .extract({ left: x, top: y, width: w, height: h }).flatten({ background: '#ffffff' }).greyscale()
    .resize(Math.max(2, Math.round(w * factor)), Math.max(2, Math.round(h * factor)), { kernel: 'lanczos3' })
    .raw().toBuffer({ resolveWithObject: true });
  return { data: out.data, w: out.info.width, h: out.info.height };
}

// normalised cross-correlation of template T over image G (positions x0..x1, y0..y1): the best { x, y, score }
function ncc(T, G, [x0, x1], [y0, y1]) {
  const n = T.w * T.h, tz = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += T.data[i];
  mean /= n;
  let tn = 0;
  for (let i = 0; i < n; i++) { tz[i] = T.data[i] - mean; tn += tz[i] * tz[i]; }
  tn = Math.sqrt(tn) || 1;
  let best = { x: 0, y: 0, score: -1 };
  for (let y = Math.max(0, y0); y <= Math.min(G.h - T.h, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(G.w - T.w, x1); x++) {
      let sg = 0, sgg = 0, dot = 0, k = 0;
      for (let ty = 0; ty < T.h; ty++) {
        const row = (y + ty) * G.w + x;
        for (let tx = 0; tx < T.w; tx++, k++) { const g = G.data[row + tx]; sg += g; sgg += g * g; dot += tz[k] * g; }
      }
      const v = sgg - (sg * sg) / n;
      const score = v > 1 ? dot / (tn * Math.sqrt(v)) : -1;
      if (score > best.score) best = { x, y, score };
    }
  }
  return best;
}

// How big is her face in `cur` compared with idle's, and where is it? Slides idle's face over the top of `cur` at many
// scales (coarse, then fine): { scale, x, y, score } with x, y the face's top-left in cur once cur is scaled (full size).
async function matchHead(idle, face, cur, cb) {
  const T8 = await grey(idle, face, 1 / 8), T4 = await grey(idle, face, 1 / 4);
  const hb = cb.y1 - cb.y0;
  const region = { x: cb.x0 - 120, y: cb.y0 - 120, w: cb.x1 - cb.x0 + 240, h: 0.55 * hb + 240 };
  const rx = Math.max(0, Math.round(region.x)), ry = Math.max(0, Math.round(region.y));
  let best = { score: -1 };
  for (let s = 0.55; s <= 1.8; s += 0.03) {
    const G = await grey(cur, region, s / 8);
    if (G.w < T8.w || G.h < T8.h) continue;
    const m = ncc(T8, G, [0, G.w], [0, G.h]);
    if (m.score > best.score) best = { ...m, s };
  }
  if (best.score < 0) return null;
  let fine = { score: -1 };
  for (let s = best.s - 0.04; s <= best.s + 0.0401; s += 0.01) {
    const G = await grey(cur, region, s / 4);
    if (G.w < T4.w || G.h < T4.h) continue;
    const m = ncc(T4, G, [best.x * 2 - 8, best.x * 2 + 8], [best.y * 2 - 8, best.y * 2 + 8]);
    if (m.score > fine.score) fine = { ...m, s };
  }
  if (fine.score < 0) return null;
  return { scale: fine.s, x: fine.s * rx + 4 * fine.x, y: fine.s * ry + 4 * fine.y, score: fine.score };
}

async function placeMotion(frames, names, flying, W, H, P) {
  const idle = frames.idle, ib = bbox(idle), ibH = ib.y1 - ib.y0;
  const iTorso = torsoX(idle, ib), iHead = headX(idle, ib);
  const face = { x: iHead - 0.075 * ibH, y: ib.y0 + 0.02 * ibH, w: 0.15 * ibH, h: 0.11 * ibH };
  for (const name of names) {
    if (!MOTION.includes(name) && !flying.has(name)) continue;
    const manual = SCALES[name];
    let s = manual || 1, head = null;
    if (!manual && ART.autoScale !== false && (HEAD_SCALED.includes(name) || flying.has(name))) {
      head = await matchHead(idle, face, frames[name], bbox(frames[name]));
      if (head && head.score >= MIN_FACE_MATCH) s = head.scale;
      else { console.log(`${name.padEnd(9)} could not match her face (best ${head ? head.score.toFixed(2) : 'none'}); set "scales" in art.json by hand`); head = null; }
    }
    const img = s === 1 ? frames[name] : await scaleCanvas(frames[name], s);
    const b = bbox(img);
    let tx, ty = 0;
    if (HEAD_ALIGNED.includes(name) && head) {
      tx = Math.round(face.x - head.x); ty = Math.round(face.y - head.y);
    } else {
      tx = Math.round(iTorso - torsoX(img, b));
      if (GROUND.includes(name) || flying.has(name)) ty = ib.y1 - b.y1;
    }
    frames[name] = blit(img, tx, ty, W, H);
    if (name === 'sit' && ART.seat != null) seatY = (ART.seat * (H - 2 * P) + P) * s + ty;
    console.log(`${name.padEnd(9)} scale ${s.toFixed(3)}${head ? ` (face match ${head.score.toFixed(2)})` : manual ? ' (art.json)' : ''}, moved (${tx},${ty})`);
  }
}

// A character that has no manifest of its own (or one marked "auto") gets one built from the poses that were found.
function writeManifest(names, flying = new Set(), seat = null) {
  const file = path.join(ROOT, 'manifest.json');
  let old = null;
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (old && !old.auto) return; // a hand-written manifest is left alone
  const frames = {};
  for (const n of names) if (!/^(walk|climb)2$/.test(n)) frames[n] = `${n}.png`;
  for (const p of ['walk', 'climb']) if (frames[p] && names.includes(`${p}2`)) frames[p] = [`${p}.png`, `${p}2.png`];
  const title = path.basename(ROOT);
  const motion = { walk: { facing: 'left' }, climb: { facing: 'left' }, jump: { facing: 'left' } };
  for (const n of flying) motion[n] = { hop: true }; // she bounces while this mid-air pose is shown
  if (seat != null && names.includes('sit')) motion.sit = { seat: +seat.toFixed(4) }; // her seat, as a fraction of the frame: she sits on the edge of a window
  const manifest = { name: title, title, height: 340, fps: 6, auto: true, frames, motion };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote manifest.json for ${title}`);
}

async function main() {
  const files = sources(ROOT);
  const lower = (f) => path.parse(f).name.toLowerCase();
  const names = ORDER.filter((n) => files.some((f) => lower(f) === n));
  const ignored = files.filter((f) => !ORDER.includes(lower(f)));
  if (ignored.length) console.log(`ignored (not a pose name): ${ignored.join(', ')}`);
  if (!names.includes('idle')) throw new Error('an image named idle (idle.png, idle.webp, ...) is required: it is the reference every other standing frame is lined up against');

  const frames = {};
  for (const name of names) {
    const file = files.find((f) => lower(f) === name);
    const img = await load(path.join(RAW, file));
    frames[name] = img;
    if (preKeyed(img)) { // hand-edited frames that already have a transparent background are used as they are
      console.log(`${name.padEnd(9)} already transparent, left as is`);
      continue;
    }
    const { bg, bgG } = key(img);
    console.log(`${name.padEnd(9)} keyed  bg=(${bg.map(Math.round)}) greenness=${Math.round(bgG)}`);
  }

  // frames can come in different sizes (an arms-up pose that is wider): put them all, centred, on one canvas as big as the biggest
  const BW = Math.max(...names.map((n) => frames[n].w)), BH = Math.max(...names.map((n) => frames[n].h));
  for (const name of names) {
    const f = frames[name];
    if (f.w !== BW || f.h !== BH) frames[name] = blit(f, Math.round((BW - f.w) / 2), Math.round((BH - f.h) / 2), BW, BH);
  }

  // a standing pose whose legs are nothing like idle's (a jump for joy) can't be lined up by its legs: it is grounded
  // like sit and jump instead, and flagged so she hops while it is shown
  const flying = new Set();
  for (const name of names) {
    if (name === 'idle' || MOTION.includes(name)) continue;
    const { dx, dy, mismatch } = register(frames.idle, frames[name]);
    if (mismatch > 0.15) {
      flying.add(name);
      console.log(`${name.padEnd(9)} legs differ from idle by ${(mismatch * 100).toFixed(0)}%: treated as a mid-air pose`);
      continue;
    }
    frames[name] = shift(frames[name], dx, dy);
    const flag = mismatch > 0.03 ? '  <-- legs differ, check this frame' : '';
    console.log(`${name.padEnd(9)} shift (${dx},${dy}) leg mismatch ${(mismatch * 100).toFixed(2)}%${flag}`);
  }

  if (LEGACY) {
    // a seated pose has no standing legs to register on: drop its lowest pixel onto idle's soles and centre it
    const idleBox = bbox(frames.idle);
    for (const name of names) {
      if (!GROUNDED.includes(name) && !flying.has(name)) continue;
      if (SCALES[name]) frames[name] = await rescale(frames[name], SCALES[name]);
      const b = bbox(frames[name]);
      const dx = Math.round((idleBox.x0 + idleBox.x1 - b.x0 - b.x1) / 2), dy = idleBox.y1 - b.y1;
      frames[name] = shift(frames[name], dx, dy);
      console.log(`${name.padEnd(9)} grounded onto idle: shift (${dx},${dy})`);
    }
  } else {
    const P = Math.round(0.2 * Math.max(BW, BH)); // room for poses that grow or move
    for (const name of names) frames[name] = blit(frames[name], P, P, BW + 2 * P, BH + 2 * P);
    await placeMotion(frames, names, flying, BW + 2 * P, BH + 2 * P, P);
  }

  let box = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
  for (const name of names) {
    const b = bbox(frames[name]);
    box = { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) };
  }
  const { w, h } = frames.idle;
  const left = Math.max(0, box.x0 - PAD), top = Math.max(0, box.y0 - PAD);
  const width = Math.min(w, box.x1 + PAD + 1) - left, height = Math.min(h, box.y1 + PAD + 1) - top;
  console.log(`shared crop ${width}x${height} at (${left},${top})`);

  fs.mkdirSync(OUT, { recursive: true });
  const cropped = {};
  for (const name of names) {
    const img = frames[name];
    const buf = await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
      .extract({ left, top, width, height })
      .png({ compressionLevel: 9 })
      .toBuffer();
    fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
    cropped[name] = buf;
  }
  fs.writeFileSync(path.join(OUT, '_size.json'), JSON.stringify({ width, height }));
  writeManifest(names, flying, seatY != null ? (seatY - top) / height : null);

  // contact sheets on dark and light backdrops to spot fringes
  const scale = 0.45, cw = Math.round(width * scale), ch = Math.round(height * scale), cols = 5;
  const rows = Math.ceil(names.length / cols);
  for (const [label, color] of [['dark', '#262626'], ['light', '#f2f2f2']]) {
    const layers = [];
    for (let i = 0; i < names.length; i++) {
      const input = await sharp(cropped[names[i]]).resize(cw, ch).png().toBuffer();
      layers.push({ input, left: (i % cols) * cw, top: Math.floor(i / cols) * ch });
    }
    await sharp({ create: { width: cw * cols, height: ch * rows, channels: 3, background: color } })
      .composite(layers)
      .png()
      .toFile(path.join(ROOT, `_contact-${label}.png`));
  }
  fs.writeFileSync(path.join(OUT, '_source.json'), stamp(ROOT)); // last, so a failed run is retried
  console.log(`wrote ${names.length} frames to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
