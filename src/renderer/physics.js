'use strict';
// Physics and roaming behaviour for the pet. Pure logic with no DOM, so it runs in
// the renderer and in node tests alike.
//
// Coordinates are overlay pixels. (x, y) is the middle of her body at her feet.
// She is "held" by the cursor, falls under gravity, stands on the screen floor or
// on the top edge of open windows, walks around, climbs screen edges and window
// sides, and jumps between them.

(function (root) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // remove [a, b] from a list of [start, end] intervals
  function subtract(segs, a, b) {
    const out = [];
    for (const [s, e] of segs) {
      if (b <= s || a >= e) { out.push([s, e]); continue; }
      if (a > s) out.push([s, a]);
      if (b < e) out.push([b, e]);
    }
    return out;
  }

  class Actor {
    // spriteW/H: drawn size. anchor: where her body centre sits across the sprite (0-1).
    // half: half her body width. feetInset: transparent pixels under her shoes.
    constructor({ spriteW, spriteH, anchor = 0.5, half, feetInset = 0 }) {
      this.sw = spriteW;
      this.sh = spriteH;
      this.anchor = anchor;
      this.half = half;
      this.inset = feetInset;
      this.k = spriteH / 340; // everything scales with her size
      // Clinging or flying, her feet stay this far below the top of the screen so all of her shows.
      this.head = spriteH * 0.9;
      // She may stand on a window whose top is this low: about half of her is on screen, the rest
      // is cut off by the top of the screen.
      this.standMin = spriteH * 0.5;

      this.g = 2600 * this.k;
      this.maxFall = 2800 * this.k;
      this.walkSpeed = 58 * this.k;
      this.climbSpeed = 48 * this.k;

      this.W = 1920;
      this.H = 1080;
      this.windows = [];
      this.winById = new Map();
      this.platforms = []; // tops of windows she can stand on, plus the floor
      this.climbWins = []; // windows with a standable top
      this.sideWins = []; // windows with a visible side she can climb
      this.sideVis = new Map(); // window id -> { left, right } visible stretch of each side
      this.floorSeg = { id: 'floor', x1: half, x2: 1920 - half, y: 1080 };

      this.t = 0;
      this.mode = 'ground'; // ground | fall | held | climb | hop | jump
      this.x = 0;
      this.y = 0;
      this.vx = 0;
      this.vy = 0;
      this.platformId = 'floor';
      this.dir = 1;
      this.walking = false;
      this.speedMul = 1; // 1 strolling, more when she is hurrying somewhere
      this.canSit = false; // set by the renderer when the character has a sitting pose
      this.edgeSit = false; // her sitting pose hangs its legs below the seat: she sits on a window's top edge, never on the floor
      this.plan = null;
      this.climb = null;
      this.hop = null;
      this.jump = null;
      this.chain = 0; // jumps in a row without touching the ground; makes her less eager each time
      this.phase = 0;

      this.rot = 0; // degrees, springs back to 0
      this.rotV = 0;
      this.squash = 0;
      this.squashV = 0;
      this.visX = 0; // visual offset that eases out when a window under her jumps
      this.visY = 0;

      this.grabX = 0;
      this.grabY = 0;
      this.samples = [];
      this.cvx = 0;
      this.cvy = 0;
      this.onEvent = () => {};
    }

    // ---- world -----------------------------------------------------------
    sideX(w, side) { return side === 'left' ? w.x - this.half * 0.95 : w.x + w.w + this.half * 0.95; }
    // The visible stretch of a window's side she can hold on to, or null: { top, bottom, realTop }. Parts of the
    // edge hidden behind a window in front don't count. If the window's own top is visible and she can stand
    // there she climbs right up to it; otherwise she stops where her whole body still shows.
    sideSpan(w, side) {
      const v = this.sideVis.get(w.id);
      return v ? v[side] : null;
    }
    sideOk(w, side) {
      const x = this.sideX(w, side);
      return x >= this.half && x <= this.W - this.half && !!this.sideSpan(w, side);
    }

    setWorld(width, height, windows = []) {
      const prev = this.winById;
      this.W = width;
      this.H = height;
      this.windows = windows;
      this.winById = new Map(windows.map((w) => [w.id, w]));
      this.floorSeg = { id: 'floor', x1: this.half, x2: width - this.half, y: height };
      this.platforms = [];
      this.climbWins = [];
      this.sideWins = [];
      this.sideVis = new Map();

      // the stretch of the line at x, along the window's height, that no window in front covers
      const visibleEdge = (i, w, x) => {
        let spans = [[w.y, w.y + w.h]];
        for (let j = 0; j < i; j++) {
          const o = windows[j];
          if (o.x <= x + 1 && o.x + o.w >= x - 1) spans = subtract(spans, o.y, o.y + o.h);
        }
        let best = null;
        for (const [a, b] of spans) {
          const lo = Math.max(a, 0), hi = Math.min(b, height);
          if (hi - lo > (best ? best[1] - best[0] : 0)) best = [lo, hi];
        }
        return best;
      };

      const maximised = (w) => w.w >= width * 0.92 && w.h >= height * 0.85;
      windows.forEach((w, i) => {
        if (maximised(w)) return;

        const vis = { left: null, right: null };
        for (const side of ['left', 'right']) {
          const span = w.w >= 120 ? visibleEdge(i, w, side === 'left' ? w.x : w.x + w.w) : null;
          if (!span) continue;
          const realTop = span[0] <= w.y + 1; // the window's own top corner is visible
          const top = realTop && w.y >= this.standMin ? w.y : Math.max(span[0], this.head);
          if (span[1] - top >= 80 * this.k) vis[side] = { top, bottom: span[1], realTop };
        }
        this.sideVis.set(w.id, vis);
        if (this.sideOk(w, 'left') || this.sideOk(w, 'right')) this.sideWins.push(w);

        if (w.y < this.standMin || w.y > height - 24) return;
        let segs = [[Math.max(0, w.x), Math.min(width, w.x + w.w)]];
        // windows earlier in the list sit above this one and hide parts of its top edge
        for (let j = 0; j < i; j++) {
          const o = windows[j];
          if (o.y <= w.y && o.y + o.h > w.y) segs = subtract(segs, o.x, o.x + o.w);
        }
        let any = false;
        for (const [a, b] of segs) {
          if (b - a < this.half * 1.6) continue;
          this.platforms.push({ id: w.id, x1: a, x2: b, y: w.y });
          any = true;
        }
        if (any) this.climbWins.push(w);
      });
      this.platforms.push(this.floorSeg);

      if (this.mode === 'ground') {
        if (this.platformId === 'floor') {
          this.y = height;
          this.x = clamp(this.x, this.half, width - this.half);
        } else {
          const was = prev.get(this.platformId);
          const now = this.winById.get(this.platformId);
          if (!now) this.startFall(0, 0);
          else if (was) { // ride the window as it moves
            const dx = now.x - was.x, dy = now.y - was.y;
            this.x += dx; this.y += dy;
            this.visX -= dx; this.visY -= dy;
          }
        }
      } else if (this.mode === 'climb' && this.climb.kind === 'screen') {
        this.x = this.climb.side === 'left' ? this.half : width - this.half;
      }
    }

    reset(x) {
      this.mode = 'ground';
      this.platformId = 'floor';
      this.x = clamp(x ?? this.W - this.half - 40 * this.k, this.half, this.W - this.half);
      this.y = this.H;
      this.vx = this.vy = 0;
      this.walking = false;
      this.plan = null;
      this.climb = null;
      this.jump = null;
      this.hop = null;
      this.chain = 0;
    }

    dropFromTop() {
      this.x = clamp(rand(this.W * 0.2, this.W * 0.8), this.half, this.W - this.half);
      this.y = this.head;
      this.startFall(0, 0);
    }

    pulse(amount) {
      this.squash = amount;
    }

    // ---- being picked up -----------------------------------------------
    get left() { return this.x - this.anchor * this.sw; }
    get top() { return this.y + this.inset - this.sh; }

    grab(px, py, t) {
      this.grabX = clamp(px - (this.left + this.visX), 0, this.sw);
      this.grabY = clamp(py - (this.top + this.visY), 0, this.sh);
      this.mode = 'held';
      this.platformId = null;
      this.walking = false;
      this.plan = null;
      this.climb = null;
      this.jump = null;
      this.hop = null;
      this.vx = this.vy = 0;
      this.visX = this.visY = 0;
      this.samples = [{ x: px, y: py, t }];
      this.cvx = this.cvy = 0;
      this.onEvent('grab');
    }

    dragTo(px, py, t) {
      if (this.mode !== 'held') return;
      this.samples.push({ x: px, y: py, t });
      while (this.samples.length > 2 && t - this.samples[0].t > 0.1) this.samples.shift();
      const a = this.samples[0], b = this.samples[this.samples.length - 1];
      const dt = b.t - a.t;
      this.cvx = dt > 0.008 ? (b.x - a.x) / dt : 0;
      this.cvy = dt > 0.008 ? (b.y - a.y) / dt : 0;
      this.x = px - this.grabX + this.anchor * this.sw;
      this.y = Math.min(py - this.grabY + this.sh - this.inset, this.H); // feet can't go below the floor
    }

    release(t) {
      if (this.mode !== 'held') return;
      const stale = this.samples.length && t - this.samples[this.samples.length - 1].t > 0.12;
      let vx = stale ? 0 : this.cvx, vy = stale ? 0 : this.cvy;
      const max = 3200 * this.k, speed = Math.hypot(vx, vy);
      if (speed > max) { vx *= max / speed; vy *= max / speed; }
      this.startFall(vx, vy);
      this.onEvent('release');
    }

    startFall(vx, vy) {
      this.mode = 'fall';
      this.platformId = null;
      this.walking = false;
      this.plan = null;
      this.climb = null;
      this.hop = null;
      this.jump = null;
      this.vx = vx;
      this.vy = vy;
    }

    land(p, speed = 0) {
      this.mode = 'ground';
      this.y = p.y;
      this.platformId = p.id;
      this.vx = this.vy = 0;
      this.walking = false;
      this.chain = 0;
      this.plan = { kind: 'stand', until: this.t + rand(0.8, 2) };
      this.squash = clamp(speed / (2200 * this.k), 0, 0.2);
      this.rot = 0;
      this.rotV = 0;
      this.onEvent('land', speed);
    }

    // ---- per frame -------------------------------------------------------
    // ctx.roam: she may wander (no Claude activity, wandering switched on)
    update(dt, ctx = {}) {
      dt = Math.min(dt, 0.05);
      this.t += dt;
      switch (this.mode) {
        case 'fall': this.stepFall(dt); break;
        case 'ground': this.stepGround(dt, ctx); break;
        case 'climb': this.stepClimb(dt, ctx); break;
        case 'hop': this.stepHop(dt); break;
        case 'jump': this.stepJump(dt, ctx); break;
        default: break;
      }

      // pendulum swing while held or flailing in the air, settles flat otherwise
      const swing = this.mode === 'held' ? clamp(this.cvx * 0.012, -28, 28)
        : this.mode === 'fall' ? clamp(this.vx * 0.004, -18, 18) : 0;
      const w = this.mode === 'ground' ? 22 : 13, zeta = this.mode === 'ground' ? 0.9 : 0.3;
      this.rotV += (-w * w * (this.rot - swing) - 2 * zeta * w * this.rotV) * dt;
      this.rot += this.rotV * dt;
      if (this.mode === 'ground' && Math.abs(this.rot) < 0.05 && Math.abs(this.rotV) < 0.5) this.rot = this.rotV = 0;

      this.squashV += (-380 * this.squash - 22 * this.squashV) * dt;
      this.squash += this.squashV * dt;
      if (Math.abs(this.squash) < 0.0005 && Math.abs(this.squashV) < 0.005) this.squash = this.squashV = 0;

      const ease = Math.min(1, dt * 16);
      this.visX -= this.visX * ease;
      this.visY -= this.visY * ease;
      if (this.walking) this.phase += dt * 8 * this.speedMul;
      else if (this.mode === 'climb' && this.climb.phase !== 'cling') this.phase += dt * 6;

      // never lose her: anything that left the screen puts her back on the floor
      const lost = !Number.isFinite(this.x) || !Number.isFinite(this.y) || this.x < -50 || this.x > this.W + 50 || this.y > this.H + 50;
      if (lost && this.mode !== 'held') this.reset();
    }

    stepFall(dt) {
      const prevY = this.y;
      this.vy = Math.min(this.vy + this.g * dt, this.maxFall);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.vx *= 1 - Math.min(1, 0.6 * dt);

      const minX = this.half, maxX = this.W - this.half;
      if (this.x < minX) { this.x = minX; this.vx = Math.abs(this.vx) * 0.35; }
      else if (this.x > maxX) { this.x = maxX; this.vx = -Math.abs(this.vx) * 0.35; }
      const minY = this.standMin; // a high window she stood on must not snap her down when she steps off
      if (this.y < minY) { this.y = minY; this.vy = Math.abs(this.vy) * 0.2; }

      if (this.vy > 0) {
        let best = null;
        for (const p of this.platforms) {
          if (p.y >= prevY - 0.5 && p.y <= this.y && this.x >= p.x1 && this.x <= p.x2 && (!best || p.y < best.y)) best = p;
        }
        if (best) this.land(best, this.vy);
      }
      // the floor catches anything that ended up below it (dragged past the taskbar line, a resize)
      if (this.mode === 'fall' && this.y >= this.H) this.land(this.floorSeg, this.vy);
    }

    segmentAt(id, x) {
      if (id === 'floor') return this.floorSeg;
      for (const p of this.platforms) if (p.id === id && x >= p.x1 - 2 && x <= p.x2 + 2) return p;
      return null;
    }

    stepGround(dt, ctx) {
      const seg = this.segmentAt(this.platformId, this.x);
      if (!seg) { this.startFall(0, 0); return; }
      this.y = seg.y;
      if (!ctx.roam) { this.walking = false; this.plan = null; return; }

      if (!this.plan || this.t >= this.plan.until) this.plan = this.choosePlan(seg);
      const p = this.plan;
      if (p.kind === 'stand' || p.kind === 'sit') { this.walking = false; return; }

      let dir = p.dir;
      // she hurries when she is heading for something to climb or jump onto
      const speed = p.kind === 'goto' ? this.walkSpeed * 1.5 : this.walkSpeed;
      this.speedMul = speed / this.walkSpeed;
      if (p.kind === 'goto') {
        // she walks to a run-up spot first when the target needs a jump, then leaps from there
        const goal = p.target.approach ?? p.target.x;
        const gap = goal - this.x;
        if (Math.abs(gap) <= speed * dt + 1) { this.x = goal; this.beginTarget(p.target); return; }
        dir = Math.sign(gap);
      }
      this.dir = dir;
      this.walking = true;
      this.x += dir * speed * dt;

      if (this.x <= seg.x1 || this.x >= seg.x2) {
        this.x = clamp(this.x, seg.x1, seg.x2);
        if (p.kind === 'goto' || seg.id === 'floor' || Math.random() < 0.5) {
          this.plan = { kind: 'walk', dir: -dir, until: this.t + rand(1.5, 4) };
        } else { // stroll off the edge of a window
          this.x += dir * 3;
          this.startFall(dir * this.walkSpeed * 0.6, 0);
        }
      }
    }

    choosePlan(seg) {
      const targets = this.climbTargets(seg);
      const r = Math.random();
      // now and then she sits down for a while (only if the character has a sitting pose)
      if (this.canSit && r < 0.16 && !(this.edgeSit && this.platformId === 'floor')) return { kind: 'sit', until: this.t + rand(8, 25) };
      // when there are windows to climb or leap onto she goes for them much more often
      const windowy = targets.filter((t) => t.kind !== 'screen');
      if (r < (windowy.length ? 0.16 : 0.28)) return { kind: 'stand', until: this.t + rand(2, 5) };
      if (r < (windowy.length ? 0.4 : 0.7) || !targets.length) {
        let dir = Math.random() < 0.5 ? -1 : 1;
        if (this.x - seg.x1 < 80 * this.k) dir = 1;
        else if (seg.x2 - this.x < 80 * this.k) dir = -1;
        return { kind: 'walk', dir, until: this.t + rand(2, 5) };
      }
      const pool = windowy.length && Math.random() < 0.85 ? windowy : targets;
      // mostly something close by, so she isn't off across the whole screen for ages
      const dist = (t) => Math.abs((t.approach ?? t.x) - this.x);
      const near = pool.slice().sort((a, b) => dist(a) - dist(b)).slice(0, 3);
      return { kind: 'goto', target: pick(near), until: this.t + 14 };
    }

    // things she could climb from where she stands
    climbTargets(seg) {
      const out = [];
      if (seg.x1 <= this.half + 1) out.push({ kind: 'screen', side: 'left', x: this.half, face: 'left' });
      if (seg.x2 >= this.W - this.half - 1) out.push({ kind: 'screen', side: 'right', x: this.W - this.half, face: 'right' });
      const k = this.k;
      const lo = Math.max(seg.x1, this.half), hi = Math.min(seg.x2, this.W - this.half);
      // a run-up spot 100px before the target, on the side she comes from
      const runUp = (x, away) => { const a = clamp(x + away * 100 * k, lo, hi); return Math.abs(a - x) >= 40 * k ? a : null; };

      for (const w of this.sideWins) {
        for (const side of ['left', 'right']) {
          if (!this.sideOk(w, side)) continue;
          const s = this.sideSpan(w, side);
          // something to climb above her; a window that floats above her is reached with a leap onto its side
          if (!(s.top < this.y - 50 * k) || this.y - s.bottom > 340 * k) continue;
          const floating = this.y - s.bottom > 6 * k;
          const x = this.sideX(w, side);
          if (x < lo || x > hi) continue;
          out.push({ kind: 'window', id: w.id, side, x, face: side === 'left' ? 'right' : 'left', approach: floating ? runUp(x, side === 'left' ? -1 : 1) : null });
        }
      }

      for (const p of this.platforms) { // leap straight up onto the top of a window that is not too high
        if (p.id === 'floor' || p.id === seg.id) continue;
        const rise = this.y - p.y;
        if (rise < 60 * k || rise > 340 * k) continue;
        const x = p.x2 - p.x1 >= this.half * 2 ? clamp(this.x, p.x1 + this.half, p.x2 - this.half) : (p.x1 + p.x2) / 2;
        const away = x >= this.x ? -1 : 1; // run up from the side she is already on
        const approach = runUp(x, away);
        if (Math.abs((approach ?? this.x) - x) > 260 * k) continue;
        out.push({ kind: 'leap', id: p.id, x, y: p.y, approach });
      }
      return out;
    }

    // she has reached the spot to start from: climb, or leap
    beginTarget(t) {
      if (t.kind === 'leap') {
        if (!this.segmentAt(t.id, t.x)) { this.plan = { kind: 'stand', until: this.t + 1 }; return; }
        const rise = Math.max(0, this.y - t.y);
        this.beginJump({
          x: t.x, y: t.y, dur: clamp(0.42 + rise / 900 + Math.abs(t.x - this.x) / 2200, 0.42, 0.85),
          arc: 44 * this.k + rise * 0.35, then: { type: 'top', id: t.id },
        });
        return;
      }
      this.beginClimb(t);
    }

    beginClimb(target) {
      if (target.kind === 'window') {
        const w = this.winById.get(target.id);
        const s = w && this.sideSpan(w, target.side);
        if (!s) return;
        const startY = Math.min(this.y, s.bottom);
        const rise = this.y - startY;
        if (rise > 2) { // the window floats above her: leap onto its bottom edge
          this.beginJump({
            x: target.x, y: startY, dur: clamp(0.4 + rise / 900 + Math.abs(target.x - this.x) / 2200, 0.4, 0.8),
            arc: 40 * this.k + rise * 0.35, then: { type: 'climb', target },
          });
          return;
        }
      }
      this.startClimbOn(target, this.y);
    }

    startClimbOn(target, y) {
      const w = target.kind === 'window' ? this.winById.get(target.id) : null;
      const s = w ? this.sideSpan(w, target.side) : null;
      if (target.kind === 'window' && !s) { this.startFall(0, 0); return; }
      const topY = s ? s.top : Math.max(this.head, Math.min(y - 80 * this.k, this.H * rand(0.3, 0.75)));
      this.mode = 'climb';
      this.platformId = null;
      this.walking = false;
      this.plan = null;
      this.hop = null;
      this.jump = null;
      this.x = target.x;
      this.y = y;
      this.climb = {
        ...target, topY, phase: y > topY + 4 ? 'up' : 'cling', timer: rand(0.8, 1.6),
        top: !!s && s.realTop && this.climbWins.includes(w), // can she stand on it once she is up there?
        bottom: s ? s.bottom : this.H,
        rect: w ? { x: w.x, y: w.y, w: w.w, h: w.h } : null, // if it moves she loses her grip
        jump: undefined,
      };
    }

    stepClimb(dt, ctx) {
      const c = this.climb;
      if (!ctx.roam) { this.letGo(); return; }
      let w = null;
      if (c.kind === 'window') {
        w = this.winById.get(c.id);
        const r = c.rect;
        const moved = w && (Math.abs(w.x - r.x) > 4 || Math.abs(w.y - r.y) > 4 || Math.abs(w.w - r.w) > 4 || Math.abs(w.h - r.h) > 4);
        if (!w || moved) { this.letGo(); return; } // minimised, closed or dragged: she falls off
      }

      if (c.phase === 'up') {
        this.y -= this.climbSpeed * dt;
        if (this.y <= c.topY) {
          this.y = c.topY;
          if (w && c.top) { this.beginHop(w, c); return; }
          c.phase = 'cling';
          c.timer = rand(0.8, 1.6);
        }
      } else if (c.phase === 'cling') {
        c.timer -= dt;
        if (c.timer > 0) return;
        // at the top she would rather leap to a window than let go or climb back down
        if (c.jump === undefined) c.jump = this.pickJump(c);
        if (c.jump && Math.random() < 0.85 / (1 + this.chain * 0.6)) { this.chain++; this.beginJump(c.jump); }
        else if (Math.random() < 0.5) this.letGo();
        else c.phase = 'down';
      } else {
        let ground = this.floorSeg;
        for (const p of this.platforms) {
          if (p.y >= this.y - 1 && p.y < ground.y && this.x >= p.x1 && this.x <= p.x2) ground = p;
        }
        this.y += this.climbSpeed * dt;
        if (this.y >= ground.y) this.land(ground, 0);
        else if (w && this.y >= c.bottom) this.letGo(); // ran out of visible window, step off
      }
    }

    letGo() {
      const away = this.climb && this.climb.face === 'left' ? 1 : -1;
      this.startFall(away * 70 * this.k, 0);
    }

    // somewhere to leap to from the spot she is clinging to, or null
    pickJump(c) {
      const k = this.k, half = this.half, fx = this.x, fy = this.y;
      const maxDx = 760 * k;
      const cands = [];

      for (const p of this.platforms) { // land on top of a window
        if (p.id === 'floor' || p.id === c.id) continue;
        const lx = p.x2 - p.x1 >= half * 2 ? clamp(fx, p.x1 + half, p.x2 - half) : (p.x1 + p.x2) / 2;
        const dx = Math.abs(lx - fx), dy = p.y - fy;
        if (dx < 20 * k || dx > maxDx || dy < -480 * k || dy > 640 * k) continue;
        cands.push({ x: lx, y: p.y, then: { type: 'top', id: p.id }, dist: dx + Math.abs(dy) * 0.6 });
      }

      for (const w of this.sideWins) { // grab the side of a window that faces her
        if (w.id === c.id) continue;
        for (const side of ['left', 'right']) {
          if (!this.sideOk(w, side)) continue;
          const s = this.sideSpan(w, side);
          const x = this.sideX(w, side), dx = Math.abs(x - fx);
          if ((side === 'left') !== (x > fx) || dx < 60 * k || dx > maxDx) continue;
          const y = clamp(fy, s.top + 20 * k, s.bottom - 20 * k);
          if (Math.abs(y - fy) > 400 * k) continue;
          cands.push({ x, y, then: { type: 'climb', target: { kind: 'window', id: w.id, side, x, face: side === 'left' ? 'right' : 'left' } }, dist: dx + Math.abs(y - fy) * 0.6 });
        }
      }

      if (c.kind === 'window') { // from one window across to a screen edge, the last resort
        for (const side of ['left', 'right']) {
          const x = side === 'left' ? half : this.W - half, dx = Math.abs(x - fx);
          if ((x < fx) !== (side === 'left') || dx < 100 * k || dx > maxDx) continue;
          cands.push({ x, y: clamp(fy, this.head, this.H - 40 * k), then: { type: 'climb', target: { kind: 'screen', side, x, face: side } }, dist: dx + 400 });
        }
      }

      if (!cands.length) return null;
      cands.sort((a, b) => a.dist - b.dist);
      return cands[Math.floor(Math.random() * Math.min(2, cands.length))];
    }

    beginJump(spec) {
      const dx = Math.abs(spec.x - this.x);
      this.mode = 'jump';
      this.climb = null;
      this.hop = null;
      this.platformId = null;
      this.walking = false;
      this.plan = null;
      this.jump = {
        t: 0, dur: spec.dur ?? clamp(0.5 + dx / 1500, 0.5, 0.95),
        x0: this.x, y0: this.y, x1: spec.x, y1: spec.y,
        arc: spec.arc ?? 50 * this.k + 0.1 * dx, then: spec.then,
      };
      this.dir = Math.sign(spec.x - this.x) || this.dir;
    }

    stepJump(dt, ctx) {
      const j = this.jump;
      if (!ctx.roam) { this.startFall(0, 0); return; }
      j.t += dt;
      const p = clamp(j.t / j.dur, 0, 1);
      this.x = j.x0 + (j.x1 - j.x0) * p;
      this.y = j.y0 + (j.y1 - j.y0) * p - 4 * j.arc * p * (1 - p);
      if (p < 1) return;

      this.x = j.x1;
      this.y = j.y1;
      this.jump = null;
      if (j.then.type === 'top') {
        const seg = this.segmentAt(j.then.id, this.x);
        if (seg) this.land(seg, 700 * this.k);
        else this.startFall(0, 0);
      } else {
        this.startClimbOn(j.then.target, this.y);
      }
    }

    beginHop(w, c) {
      const want = c.side === 'left' ? w.x + this.half * 1.1 : w.x + w.w - this.half * 1.1;
      let seg = null;
      for (const p of this.platforms) if (p.id === w.id && want >= p.x1 - 2 && want <= p.x2 + 2) seg = p;
      if (!seg) { this.letGo(); return; }
      this.mode = 'hop';
      this.climb = null;
      this.hop = { t: 0, dur: 0.38, x0: this.x, y0: this.y, x1: clamp(want, seg.x1, seg.x2), y1: w.y, id: w.id };
    }

    stepHop(dt) {
      const h = this.hop;
      h.t += dt;
      const p = clamp(h.t / h.dur, 0, 1);
      this.x = h.x0 + (h.x1 - h.x0) * p;
      this.y = h.y0 + (h.y1 - h.y0) * p - Math.sin(Math.PI * p) * 28 * this.k;
      if (p >= 1) {
        this.y = h.y1;
        this.mode = 'ground';
        this.platformId = h.id;
        this.hop = null;
        this.chain = 0;
        this.plan = { kind: 'stand', until: this.t + rand(1, 2.5) };
        this.squash = 0.06;
      }
    }

    // ---- what the renderer needs -----------------------------------------
    get sitting() { return this.mode === 'ground' && !!this.plan && this.plan.kind === 'sit'; }
    get face() { return this.climb ? this.climb.face : null; }
    get moving() { return this.walking || (this.mode === 'climb' && this.climb.phase !== 'cling'); }
  }

  const api = { Actor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Physics = api;
})(typeof window !== 'undefined' ? window : globalThis);
