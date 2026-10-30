'use strict';

const { Actor } = window.Physics;
const $ = (id) => document.getElementById(id);
const actorEl = $('actor');
const rotEl = $('rot');
const sqEl = $('sq');
const fx = $('fx');
const g2d = fx.getContext('2d');

let cfg = null;
let actor = null;
let world = { width: innerWidth, height: innerHeight };
let windowsList = [];
let claude = 'idle'; // what Claude Code is doing
let wander = true;
let preview = null; // { pose, until }
let imgs = new Map();
let shown = { pose: 'idle', idx: 0, mirror: false, url: null };
let blinkUntil = 0;
let nextBlink = 0;
let ignoring = true;
let mouse = { x: -1, y: -1 };
let down = null;
let last = performance.now();
let lastDraw = 0;
let lastHover = 0;
let wasSitting = false;
let spr = null; // the canvas she is drawn on
let sprCtx = null;
let parts = [];
const MARGIN = 16; // transparent room round the sprite for bobbing, tilting and breathing

// ---- setup ----------------------------------------------------------------
function resizeFx() {
  const dpr = devicePixelRatio;
  fx.width = Math.round(world.width * dpr);
  fx.height = Math.round(world.height * dpr);
  fx.style.width = `${world.width}px`;
  fx.style.height = `${world.height}px`;
}

function build(c) {
  const prevX = actor ? actor.x : undefined;
  cfg = c;
  wander = c.wander;
  claude = c.state || 'idle';
  world = c.world;
  windowsList = c.windows;

  actorEl.style.width = rotEl.style.width = `${c.spriteW}px`;
  actorEl.style.height = rotEl.style.height = `${c.spriteH}px`;
  sqEl.style.transformOrigin = `${c.anchor * 100}% 100%`; // she breathes up from her feet
  sqEl.style.height = `${c.spriteH}px`;
  sqEl.textContent = '';
  // She is drawn on a canvas: every pose, flip, squash and breath goes through a single resample of the
  // full-size art, so her sharpness never changes. A CSS scale or a swapped <img> made it snap.
  const dpr = devicePixelRatio;
  spr = document.createElement('canvas');
  spr.width = Math.round((c.spriteW + 2 * MARGIN) * dpr);
  spr.height = Math.round((c.spriteH + 2 * MARGIN) * dpr);
  spr.style.cssText = `position:absolute;left:${-MARGIN}px;top:${-MARGIN}px;width:${c.spriteW + 2 * MARGIN}px;height:${c.spriteH + 2 * MARGIN}px;pointer-events:none`;
  sqEl.appendChild(spr);
  sprCtx = spr.getContext('2d');
  sprCtx.imageSmoothingEnabled = true;
  sprCtx.imageSmoothingQuality = 'high';
  imgs = new Map();
  for (const list of Object.values(c.frames)) {
    for (const variants of list) {
      for (const url of variants) {
        if (imgs.has(url)) continue;
        const img = new Image();
        img.src = url;
        imgs.set(url, img);
      }
    }
  }
  shown = { pose: 'idle', idx: 0, mirror: false, url: null };

  actor = new Actor({ spriteW: c.spriteW, spriteH: c.spriteH, anchor: c.anchor, half: c.half, feetInset: c.feetInset });
  actor.canSit = !!c.has.sit; // she only sits down if there is art for it
  actor.edgeSit = !!(c.motion.sit && c.motion.sit.seat != null); // her legs hang below her seat, so she sits on window tops only
  resizeFx();
  actor.setWorld(world.width, world.height, windowsList);
  actor.reset(prevX);
  nextBlink = performance.now() + 3000;
}

// ---- which frame to show -----------------------------------------------------
function currentPose(now) {
  if (preview) return preview.pose;
  switch (actor.mode) {
    case 'held': return 'held';
    case 'fall': return 'fall';
    case 'climb': return 'climb';
    case 'jump': return 'jump';
    default: break;
  }
  if (claude !== 'idle') return claude;
  if (actor.sitting) return 'sit';
  if (actor.walking) return 'walk';
  return now < blinkUntil ? 'blink' : 'idle';
}

function frameFor(pose, now) {
  const list = cfg.frames[pose] || cfg.frames.idle;
  let idx = 0;
  if ((pose === 'walk' || pose === 'climb') && list.length > 1) {
    const phase = preview ? (now / 1000) * cfg.fps * Math.PI : actor.phase;
    idx = Math.floor(phase / Math.PI) % list.length;
  }
  return { list, idx };
}

// art that faces one way is mirrored when she goes the other way (manifest "motion.<pose>.facing")
function mirrorFor(pose) {
  const m = cfg.motion[pose];
  if (!m || !m.facing || !cfg.has[pose]) return false; // stand-in frames are never mirrored (the shirt text would flip)
  if (pose === 'walk' || pose === 'jump') return (actor.dir < 0 ? 'left' : 'right') !== m.facing; // she leaps the way she faces
  if (pose === 'climb') return !!actor.face && actor.face !== m.facing;
  return false;
}

// Each frame arrives pre-rendered at her exact size in device pixels and at a few slightly taller sizes. She is
// drawn pixel for pixel at whole-pixel positions and breathing crossfades between neighbouring heights, so the
// browser never scales her: it switches its image filtering at certain scales (at Medium near 1.0 and near
// 1.0105), and every switch showed up as her sharpness jumping. `PET_SHARP=1 npx electron .` re-measures this.
// `level` is how many device pixels taller she is right now (0 to variants - 1), fractions crossfade.
function drawSprite(variants, bobPx, level, sx, sy) {
  const lo = Math.floor(level), hi = Math.min(lo + 1, variants.length - 1), t = level - lo;
  const first = imgs.get(variants[0]), a = imgs.get(variants[lo]), b = imgs.get(variants[hi]);
  if (!first || !first.complete || !first.naturalWidth || !a || !a.complete || !a.naturalWidth) return;
  const dpr = devicePixelRatio, pad = Math.round(MARGIN * dpr);
  const g = sprCtx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, spr.width, spr.height);
  // pivot on her feet and her body's centre, taken from her normal-height frame so it never moves as she
  // breathes: flipping and squashing happen about this point
  const pivotX = pad + Math.round(cfg.anchor * first.naturalWidth);
  g.setTransform(sx, 0, 0, sy, pivotX, pad + first.naturalHeight + bobPx);
  const put = (img, alpha) => {
    g.globalAlpha = alpha;
    g.drawImage(img, -Math.round(cfg.anchor * img.naturalWidth), -img.naturalHeight); // feet stay on the pivot
  };
  // a true blend (1-t)*a + t*b, alpha included: drawing b over a full-strength a would keep a's whole silhouette
  // solid, so every edge that moved would leave a copy of itself behind until the next step
  const blend = t > 0.002 && b !== a && b.complete && b.naturalWidth;
  put(a, blend ? 1 - t : 1);
  if (blend) {
    g.globalCompositeOperation = 'lighter'; // adds the premultiplied pixels
    put(b, t);
    g.globalCompositeOperation = 'source-over';
  }
  g.globalAlpha = 1;
}

function render(now, pose) {
  const { list, idx } = frameFor(pose, now);
  const variants = list[idx];
  const mirror = mirrorFor(pose);
  shown = { pose, idx, mirror, url: variants[0] };

  const left = actor.x + actor.visX - actor.anchor * cfg.spriteW;
  const top = actor.y + actor.visY + cfg.feetInset - cfg.spriteH;
  // whole device pixels, so a standing sprite is never resampled
  const dpr = devicePixelRatio, snap = (v) => Math.round(v * dpr) / dpr;
  // a mid-air pose (the art step marks it "hop" in the manifest) bounces while it is shown
  const hopCfg = cfg.motion[pose];
  const hop = hopCfg && hopCfg.hop && cfg.has[pose] ? Math.abs(Math.sin((now / 1000) * Math.PI * 1.4)) * 0.09 * cfg.spriteH : 0;
  // a sit pose with a "seat" in the manifest is drawn lower, so her seat (not her dangling feet) is on the edge she sits on
  const seat = cfg.motion.sit && cfg.motion.sit.seat;
  const sitDrop = pose === 'sit' && cfg.has.sit && seat != null ? cfg.spriteH * (1 - seat) - cfg.feetInset : 0;
  actorEl.style.transform = `translate3d(${snap(left)}px, ${snap(top - hop + sitDrop)}px, 0)`;

  // swing about the spot she was picked up by while she is held or in the air
  const airborne = actor.mode === 'held' || actor.mode === 'fall';
  rotEl.style.transformOrigin = airborne ? `${actor.grabX}px ${actor.grabY}px` : `${cfg.anchor * 100}% 100%`;
  rotEl.style.transform = actor.rot === 0 ? 'none' : `rotate(${actor.rot.toFixed(2)}deg)`;

  // procedural motion for poses that have no frames of their own yet
  let bob = 0;
  if (pose === 'walk' && list.length < 2) bob = -Math.abs(Math.sin(actor.phase)) * 4 * actor.k;
  else if (pose === 'climb' && list.length < 2) bob = Math.sin(actor.phase) * 3 * actor.k;
  // how many device pixels taller she is right now: the head rises about 3px (5 asleep, slower and deeper)
  const phase = window.__breathPhase ?? 0.5 + 0.5 * Math.sin(now * (pose === 'sleeping' ? 0.0011 : 0.0019)); // 0..1
  const level = Math.min(cfg.variants - 1, (pose === 'sleeping' ? 5 : 3) * dpr) * phase;
  const sx = (1 + actor.squash) * (mirror ? -1 : 1);
  const sy = 1 - actor.squash * 0.9;
  drawSprite(variants, Math.round(bob * dpr), level, sx, sy);
}

// ---- confetti -----------------------------------------------------------------
const COLORS = ['#d97757', '#f3e9dc', '#e8b84a', '#2b2622', '#f0a58a'];

function burst() {
  if (!actor) return;
  const dpr = devicePixelRatio;
  const cx = actor.x * dpr, top = (actor.y - cfg.spriteH) * dpr;
  for (let i = 0; i < 70; i++) {
    parts.push({
      x: cx + (Math.random() - 0.5) * cfg.spriteW * 1.4 * dpr, y: top - Math.random() * 70 * dpr,
      vx: (Math.random() - 0.5) * 140 * dpr, vy: (40 + Math.random() * 160) * dpr,
      size: (4 + Math.random() * 5) * dpr, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 12,
      color: COLORS[(Math.random() * COLORS.length) | 0], life: 0,
    });
  }
}

function tickConfetti(dt) {
  if (!parts.length) return;
  g2d.clearRect(0, 0, fx.width, fx.height);
  parts = parts.filter((p) => p.life < 2.6 && p.y < fx.height + 20);
  for (const p of parts) {
    p.life += dt;
    p.vy += 260 * devicePixelRatio * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    g2d.save();
    g2d.translate(p.x, p.y);
    g2d.rotate(p.rot);
    g2d.globalAlpha = Math.min(1, (2.6 - p.life) / 0.7);
    g2d.fillStyle = p.color;
    g2d.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    g2d.restore();
  }
  if (!parts.length) g2d.clearRect(0, 0, fx.width, fx.height);
}

// ---- window shape (Linux) -----------------------------------------------------------
// A click-through window can't forward the mouse there, and under XWayland the cursor can't be read while it is
// click-through. So the window is cut to a box round her (and round any confetti): only that takes clicks and
// the rest of the screen belongs to the windows underneath.
function bodyBox(m) {
  if (m.box) return m.box;
  let x0 = m.w, x1 = -1, y0 = m.h, y1 = -1;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!m.data[y * m.w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return (m.box = { u0: x0 / m.w, u1: (x1 + 1) / m.w, v0: y0 / m.h, v1: (y1 + 1) / m.h });
}

// a rectangle round [x0,x1] x [y0,y1] with some room, on a grid of q pixels, inside the screen
function shapeRect(x0, y0, x1, y1, q) {
  const pad = 12;
  const l = Math.max(0, Math.min(world.width - 1, Math.floor((x0 - pad) / q) * q));
  const t = Math.max(0, Math.min(world.height - 1, Math.floor((y0 - pad) / q) * q));
  const r = Math.max(l + 1, Math.min(world.width, Math.ceil((x1 + pad) / q) * q));
  const b = Math.max(t + 1, Math.min(world.height, Math.ceil((y1 + pad) / q) * q));
  return { x: l, y: t, width: r - l, height: b - t };
}

let shapeKey = '';
function syncShape() {
  const r = spr.getBoundingClientRect(); // where she really is, after hopping, sitting down, tilting
  let x0 = r.left, x1 = r.right, y0 = r.top, y1 = r.bottom;
  if (actor.rot === 0) { // not tilted: just her body
    const masks = cfg.masks[shown.pose] || cfg.masks.idle;
    const b = bodyBox(masks[Math.min(shown.idx, masks.length - 1)]);
    const [u0, u1] = shown.mirror ? [2 * cfg.anchor - b.u1, 2 * cfg.anchor - b.u0] : [b.u0, b.u1];
    x0 = r.left + MARGIN + u0 * cfg.spriteW; x1 = r.left + MARGIN + u1 * cfg.spriteW;
    y0 = r.top + MARGIN + b.v0 * cfg.spriteH; y1 = r.top + MARGIN + b.v1 * cfg.spriteH;
  }
  const rects = [shapeRect(x0, y0, x1, y1, 4)];
  if (parts.length) { // the confetti has to stay inside the shape to be drawn
    const dpr = devicePixelRatio;
    const xs = parts.map((p) => p.x / dpr), ys = parts.map((p) => p.y / dpr);
    rects.push(shapeRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 16));
  }
  const key = JSON.stringify(rects);
  if (key === shapeKey) return;
  shapeKey = key;
  window.pet.shape(rects);
}

// ---- main loop ------------------------------------------------------------------
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!actor) return;

  if (preview && now > preview.until) preview = null;
  // Claude Code activity always wins: she stops where she is and shows what Claude is doing
  actor.update(dt, { roam: wander && claude === 'idle' && !preview });
  if (actor.sitting !== wasSitting) { wasSitting = actor.sitting; actor.pulse(0.04); } // a little settle as she sits or gets up

  if (claude === 'idle' && actor.mode === 'ground' && !actor.walking && now >= nextBlink && !window.__noBlink) {
    blinkUntil = now + 140;
    nextBlink = now + 2500 + Math.random() * 3500;
  }

  const pose = currentPose(now);
  const still = actor.mode === 'ground' && !actor.walking && !down && !parts.length && !actor.squash;
  // standing still only needs ~20 redraws a second for the breathing
  if (!(still && pose === shown.pose && now - lastDraw < 45)) {
    render(now, pose);
    lastDraw = now;
  }
  tickConfetti(dt);
  if (cfg.shaped) syncShape();

  // she moves under a stationary cursor, so re-check what is under it now and then
  if (!down && now - lastHover > 100) {
    lastHover = now;
    setIgnore(!overSprite(mouse.x, mouse.y));
  }
}

// ---- mouse: click-through except where she actually is ------------------------------
function overSprite(x, y) {
  if (!cfg || !actor) return false;
  const masks = cfg.masks[shown.pose] || cfg.masks.idle;
  const m = masks[Math.min(shown.idx, masks.length - 1)];
  const left = actor.x + actor.visX - actor.anchor * cfg.spriteW;
  const top = actor.y + actor.visY + cfg.feetInset - cfg.spriteH;
  let u = (x - left) / cfg.spriteW;
  const v = (y - top) / cfg.spriteH;
  if (shown.mirror) u = 2 * cfg.anchor - u;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
  return m.data[((v * m.h) | 0) * m.w + ((u * m.w) | 0)] === 1;
}

function setIgnore(value) {
  if (cfg && cfg.shaped) return; // the window is shaped to her instead, see syncShape
  if (value === ignoring) return;
  ignoring = value;
  window.pet.setIgnore(value);
}

function pickUp(toX, toY) {
  const t = performance.now() / 1000;
  clearTimeout(down.timer);
  down.picked = true;
  actor.grab(down.x, down.y, t); // she hangs from the spot you grabbed
  actor.dragTo(toX, toY, t + 0.001);
  setIgnore(false);
}

document.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (down) {
    if (!down.picked && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) pickUp(e.clientX, e.clientY);
    if (down.picked) {
      actor.dragTo(e.clientX, e.clientY, performance.now() / 1000);
      if (e.clientX < 0 || e.clientX > world.width || e.clientY < 0 || e.clientY > world.height) window.pet.dragOut(e.screenX, e.screenY);
    }
    return;
  }
  setIgnore(!overSprite(e.clientX, e.clientY));
});

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !overSprite(e.clientX, e.clientY)) return;
  down = { x: e.clientX, y: e.clientY, picked: false, timer: null };
  // holding her still for a moment also picks her up
  down.timer = setTimeout(() => { if (down && !down.picked) pickUp(mouse.x, mouse.y); }, 220);
});

document.addEventListener('mouseup', (e) => {
  if (!down) return;
  clearTimeout(down.timer);
  if (down.picked) actor.release(performance.now() / 1000);
  else window.pet.click();
  down = null;
  setIgnore(!overSprite(e.clientX, e.clientY));
});

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (overSprite(e.clientX, e.clientY)) window.pet.contextMenu();
});

// ---- messages from the main process --------------------------------------------------
window.pet.onInit(build);
window.pet.onState(({ state, confetti }) => {
  if (state !== claude && actor && actor.mode === 'ground') actor.pulse(0.05);
  claude = state;
  if (confetti) burst();
});
window.pet.onGeometry(({ width, height }) => {
  world = { width, height };
  resizeFx();
  if (actor) actor.setWorld(width, height, windowsList);
});
window.pet.onWindows((list) => {
  windowsList = list;
  if (actor) actor.setWorld(world.width, world.height, list);
});
window.pet.onSettings((s) => { wander = s.wander; });
window.pet.onPreview(({ pose, ms }) => { preview = { pose, until: performance.now() + ms }; });
window.pet.onDrop(() => { if (actor) actor.dropFromTop(); });

// hooks for the self-test screenshots
window.__rect = () => ({ x: actor.x - actor.anchor * cfg.spriteW, y: actor.y + cfg.feetInset - cfg.spriteH, width: cfg.spriteW, height: cfg.spriteH });
window.__actor = new Proxy({}, { get: (_t, k) => (k === 'H' ? world.height : actor && actor[k]) });
window.__drop = () => actor.dropFromTop();
// hold her breath at a point in the cycle (0..1) for the sharpness test; null lets her breathe again
window.__freezeBreath = (v) => { window.__breathPhase = v == null ? undefined : v; };
// what she is doing right now, for GET /actor
window.__state = () => (actor ? {
  mode: actor.mode, x: Math.round(actor.x), y: Math.round(actor.y), pose: shown.pose, mirror: shown.mirror, claude, sitting: actor.sitting,
  platform: actor.platformId, chain: actor.chain,
  climb: actor.climb && { kind: actor.climb.kind, id: actor.climb.id, side: actor.climb.side, phase: actor.climb.phase, top: actor.climb.top },
  jump: actor.jump && { to: actor.jump.then.type, x: Math.round(actor.jump.x1), y: Math.round(actor.jump.y1) },
  windows: windowsList.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h })),
  sideWins: actor.sideWins.map((w) => w.id), standable: actor.climbWins.map((w) => w.id),
} : null);
window.__climbWindow = (side) => {
  preview = null;
  actor.reset();
  const w = actor.sideWins.find((x) => actor.sideOk(x, side));
  if (!w) return 'no climbable window';
  actor.startClimbOn({ kind: 'window', id: w.id, side, x: actor.sideX(w, side), face: side === 'left' ? 'right' : 'left' }, actor.sideSpan(w, side).bottom);
  return w.id;
};
window.__climb = (side) => {
  preview = null;
  actor.reset();
  actor.beginClimb({ kind: 'screen', side, x: side === 'left' ? actor.half : world.width - actor.half, face: side });
};

requestAnimationFrame(loop);
window.pet.ready();
