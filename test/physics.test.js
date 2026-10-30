'use strict';
// node test/physics.test.js
const assert = require('assert');
const { Actor } = require('../src/renderer/physics');

// The simulation uses Math.random (where she wanders, when she sits), and a few checks below are about timing she may
// legitimately vary by a frame or two, so unseeded they fail about one run in a hundred. A fixed seed makes every run
// identical; SEED=<number> npm test tries another one.
let seed = Number(process.env.SEED) || 20260101;
Math.random = () => { // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const W = 1000, H = 800;
const make = () => new Actor({ spriteW: 177, spriteH: 340, anchor: 0.5, half: 55, feetInset: 3 });
const run = (a, seconds, ctx = {}) => { for (let t = 0; t < seconds; t += 1 / 60) a.update(1 / 60, ctx); };
const near = (v, target, tol = 1) => assert(Math.abs(v - target) <= tol, `${v} not within ${tol} of ${target}`);

// 1. dropped in empty space, she lands on the floor
{
  const a = make();
  a.setWorld(W, H, []);
  a.grab(500, 100, 0);
  a.dragTo(500, 100, 0.01);
  a.release(0.02);
  assert.strictEqual(a.mode, 'fall');
  run(a, 3);
  assert.strictEqual(a.mode, 'ground');
  near(a.y, H);
  assert.strictEqual(a.platformId, 'floor');
}

// 2. dropped above a window, she lands on its top edge; dropped beside it, on the floor
{
  const win = { id: 'w1', x: 300, y: 400, w: 400, h: 400 };
  const a = make();
  a.setWorld(W, H, [win]);
  a.x = 500; a.y = 100; a.startFall(0, 0);
  run(a, 3);
  near(a.y, 400);
  assert.strictEqual(a.platformId, 'w1');

  const b = make();
  b.setWorld(W, H, [win]);
  b.x = 150; b.y = 100; b.startFall(0, 0);
  run(b, 3);
  near(b.y, H);
}

// 3. dragged inside a window below its top edge, she falls past it to the floor
{
  const a = make();
  a.setWorld(W, H, [{ id: 'w1', x: 300, y: 400, w: 400, h: 400 }]);
  a.x = 500; a.y = 600; a.startFall(0, 0);
  run(a, 3);
  near(a.y, H);
}

// 4. window closes under her: she falls; window moves: she rides it
{
  const a = make();
  a.setWorld(W, H, [{ id: 'w1', x: 300, y: 400, w: 400, h: 400 }]);
  a.x = 500; a.y = 100; a.startFall(0, 0);
  run(a, 3);
  a.setWorld(W, H, [{ id: 'w1', x: 340, y: 380, w: 400, h: 420 }]);
  near(a.x, 540, 0.5);
  near(a.y, 380, 0.5);
  assert.strictEqual(a.mode, 'ground');
  a.setWorld(W, H, []);
  assert.strictEqual(a.mode, 'fall');
  run(a, 3);
  near(a.y, H);
}

// 5. a window in front hides the edge she stood on
{
  const a = make();
  a.setWorld(W, H, [{ id: 'w1', x: 300, y: 400, w: 400, h: 400 }]);
  a.x = 500; a.y = 100; a.startFall(0, 0);
  run(a, 3);
  a.setWorld(W, H, [{ id: 'cover', x: 250, y: 350, w: 500, h: 450 }, { id: 'w1', x: 300, y: 400, w: 400, h: 400 }]);
  run(a, 0.1);
  assert.strictEqual(a.mode, 'fall');
}

// 6. a throw flies sideways and bounces off the screen edge
{
  const a = make();
  a.setWorld(W, H, []);
  a.x = 500; a.y = 400; a.startFall(2500, -300);
  run(a, 3);
  assert(a.x >= 55 && a.x <= W - 55);
  near(a.y, H);
}

// 7. nothing she does leaves the screen, and she actually walks and climbs
{
  const seen = new Set();
  let climbed = 0, onWindow = 0, maxFall = 0;
  const a = make();
  a.onEvent = () => {};
  const wins = [{ id: 'a', x: 150, y: 300, w: 300, h: 500 }, { id: 'b', x: 600, y: 450, w: 250, h: 350 }];
  a.setWorld(W, H, wins);
  a.reset(500);
  let prevMode = a.mode;
  for (let i = 0; i < 60 * 60 * 20; i++) { // twenty minutes of wandering
    a.update(1 / 60, { roam: true });
    seen.add(a.mode);
    if (a.mode === 'climb' && prevMode !== 'climb') climbed++;
    if (a.mode === 'ground' && a.platformId !== 'floor') onWindow++;
    prevMode = a.mode;
    assert(Number.isFinite(a.x) && Number.isFinite(a.y), 'NaN position');
    assert(a.x >= -1 && a.x <= W + 1, `x out of bounds: ${a.x}`);
    assert(a.y <= H + 1 && a.y >= 0, `y out of bounds: ${a.y}`);
    maxFall = Math.max(maxFall, a.vy);
  }
  console.log(`  modes seen: ${[...seen].join(', ')}; climbs started: ${climbed}; frames spent on windows: ${onWindow}`);
  assert(seen.has('climb') && seen.has('hop') && seen.has('fall'), 'expected climbing, hopping and falling');
  assert(onWindow > 0, 'never stood on a window');
}

// 8. Claude starts working while she is climbing: she lets go and ends up on solid ground
{
  const a = make();
  a.setWorld(W, H, []);
  a.reset(500);
  a.beginClimb({ kind: 'screen', side: 'left', x: 55, face: 'left' });
  run(a, 2, { roam: true });
  assert.strictEqual(a.mode, 'climb');
  run(a, 0.1, { roam: false });
  assert.strictEqual(a.mode, 'fall');
  run(a, 3, { roam: false });
  assert.strictEqual(a.mode, 'ground');
  near(a.y, H);
  assert.strictEqual(a.walking, false);
}

// 9. no roaming while Claude is active
{
  const a = make();
  a.setWorld(W, H, []);
  a.reset(500);
  const x0 = a.x;
  run(a, 20, { roam: false });
  assert.strictEqual(a.x, x0);
}

// 10. dragged below the floor line and let go: she lands on the floor instead of falling out of the screen
{
  const a = make();
  a.setWorld(W, H, []);
  a.grab(500, 700, 0);
  a.dragTo(500, H + 400, 0.01);
  assert(a.y <= H, 'feet must stay above the floor while held');
  a.release(0.02);
  run(a, 2);
  assert.strictEqual(a.mode, 'ground');
  near(a.y, H);
  // and even if something puts her under the floor, the floor catches her
  const b = make();
  b.setWorld(W, H, []);
  b.x = 500; b.y = H + 300; b.startFall(0, 500);
  run(b, 1);
  assert.strictEqual(b.mode, 'ground');
  near(b.y, H);
}

// 11. climbing a window: if it is minimised, closed or dragged she lets go and falls
{
  const win = { id: 'w1', x: 300, y: 400, w: 400, h: 400 };
  const start = () => {
    const a = make();
    a.setWorld(W, H, [win]);
    a.reset(200);
    a.beginClimb({ kind: 'window', id: 'w1', side: 'left', x: win.x - 55 * 0.95, face: 'right' });
    run(a, 1, { roam: true });
    assert.strictEqual(a.mode, 'climb');
    assert(a.y < H, 'should have climbed a little');
    return a;
  };
  let a = start();
  a.setWorld(W, H, []); // minimised
  run(a, 0.1, { roam: true });
  assert.strictEqual(a.mode, 'fall');
  run(a, 3, { roam: true });
  near(a.y, H);

  a = start();
  a.setWorld(W, H, [{ ...win, x: win.x + 60 }]); // dragged sideways
  run(a, 0.1, { roam: true });
  assert.strictEqual(a.mode, 'fall');

  a = start();
  a.setWorld(W, H, [win]); // untouched window: she keeps climbing
  run(a, 0.5, { roam: true });
  assert.strictEqual(a.mode, 'climb');
}

// 12. her real desktop: the Claude window sits too high to stand on (top at y=116, she needs ~306 above her
// feet), floats 115px above the floor, and Chrome/VS Code are maximised. She must still climb Claude's sides,
// never leave the visible screen, and leap from a wall to Claude's side instead of dropping off.
{
  const RW = 1919, RH = 1032;
  const real = [
    { id: 'claude', x: 359, y: 116, w: 1202, h: 801 },
    { id: 'chrome', x: 0, y: 0, w: 1920, h: 1032 },
    { id: 'code', x: 0, y: 0, w: 1920, h: 1032 },
  ];
  const a = new Actor({ spriteW: 200, spriteH: 340, anchor: 0.45, half: 58, feetInset: 3 });
  a.setWorld(RW, RH, real);
  assert.deepStrictEqual(a.sideWins.map((w) => w.id), ['claude'], 'only Claude is climbable; maximised windows count as the screen');
  assert.strictEqual(a.platforms.length, 1, 'nothing standable but the floor');
  a.reset(900);

  let climbsOnClaude = 0, wallToClaude = 0, prev = a.mode;
  const head = 340 * 0.9;
  for (let i = 0; i < 60 * 60 * 30; i++) { // half an hour
    a.update(1 / 60, { roam: true });
    if (a.mode === 'climb') {
      assert(a.y >= head - 0.5, `climbed above the head line: y=${a.y}`);
      if (a.climb.id === 'claude' && prev !== 'climb') climbsOnClaude++;
    }
    if (a.mode === 'jump' && prev !== 'jump') {
      const then = a.jump.then;
      if (then.type === 'climb' && then.target.id === 'claude') wallToClaude++;
    }
    assert.notStrictEqual(a.platformId, 'claude', 'cannot stand on Claude');
    assert(a.x >= -1 && a.x <= RW + 1 && a.y <= RH + 1 && a.y >= 0);
    prev = a.mode;
  }
  console.log(`  real layout: ${climbsOnClaude} climbs on Claude's sides, ${wallToClaude} jumps onto them`);
  assert(climbsOnClaude > 0, 'never climbed the Claude window');
  assert(wallToClaude > 0, 'never leapt onto the Claude window');
}

// 13. at the top of a wall climb she jumps to a window rather than letting go or climbing down
{
  const win = [{ id: 'w', x: 500, y: 200, w: 300, h: 600 }];
  let jumps = 0, trials = 40;
  for (let n = 0; n < trials; n++) {
    const a = make();
    a.setWorld(W, H, win);
    a.reset(200);
    a.startClimbOn({ kind: 'screen', side: 'left', x: 55, face: 'left' }, 500);
    a.climb.phase = 'cling';
    a.climb.topY = a.y;
    a.climb.timer = 0.1;
    run(a, 0.3, { roam: true });
    const then = a.mode === 'jump' ? a.jump.then : null; // onto its top or onto its side, either counts
    if (then && ((then.type === 'top' && then.id === 'w') || (then.type === 'climb' && then.target.id === 'w'))) {
      jumps++;
      run(a, 1.5, { roam: true });
      assert.strictEqual(a.mode === 'climb' || a.mode === 'hop' || a.mode === 'ground', true, `after the jump she is ${a.mode}`);
      if (a.mode === 'climb') assert.strictEqual(a.climb.id, 'w');
      if (a.mode === 'ground') assert.strictEqual(a.platformId, 'w');
    }
  }
  console.log(`  jumped to the window in ${jumps}/${trials} trials`);
  assert(jumps >= trials * 0.7, 'should prefer jumping to a window at the top of a climb');
}

// 14. a floating window: from the floor she hops up onto its bottom edge and climbs its side
{
  const win = [{ id: 'f', x: 500, y: 250, w: 300, h: 400 }]; // bottom at 650, floor at 800
  const a = make();
  a.setWorld(W, H, win);
  a.reset(300);
  const target = a.climbTargets(a.floorSeg).find((t) => t.kind === 'window');
  assert(target, 'the floating window should be a climb target');
  a.x = target.x;
  a.beginClimb(target);
  assert.strictEqual(a.mode, 'jump');
  run(a, 1, { roam: true }); // a 150px leap takes about 0.6s
  assert.strictEqual(a.mode, 'climb');
  assert(a.y <= 650, 'she is on the window side');
}

// 15. she can stand on a window whose top is so high that only about half of her fits on screen
{
  // sprite is 340 tall, so the lowest top she may use is 170 (half her height); this one is at 200
  const high = [{ id: 'high', x: 500, y: 200, w: 300, h: 600 }];
  const a = make();
  a.setWorld(W, H, high);
  assert(a.platforms.some((p) => p.id === 'high'), 'a window at y=200 is standable (about 60% of her shows)');
  const none = make();
  none.setWorld(W, H, [{ id: 'too-high', x: 500, y: 120, w: 300, h: 680 }]);
  assert(!none.platforms.some((p) => p.id === 'too-high'), 'a window at y=120 leaves less than half of her on screen');

  // she climbs its side all the way to the edge and steps up onto it
  a.reset(300);
  a.startClimbOn({ kind: 'window', id: 'high', side: 'left', x: a.sideX(high[0], 'left'), face: 'right' }, H);
  assert.strictEqual(a.climb.topY, 200, 'climbs right up to the top edge, not stopping where her whole body shows');
  // stop the moment she is up: left to roam on a 300px window she may stroll off its edge, which is not what this checks
  for (let t = 0; t < 20 && !(a.mode === 'ground' && a.platformId === 'high'); t += 1 / 60) a.update(1 / 60, { roam: true });
  assert.strictEqual(a.platformId, 'high', `she should be standing on the window, but is ${a.mode} on ${a.platformId}`);
  near(a.y, 200);

  // stepping off that high window must not teleport her down
  a.walking = false; a.plan = null;
  a.x = 810; // just past the right edge (the edge is at 800)
  a.update(1 / 60, { roam: true });
  const before = a.y;
  assert.strictEqual(a.mode, 'fall');
  a.update(1 / 60, { roam: true });
  assert(a.y - before < 10, `fell smoothly (moved ${a.y - before}px in one frame)`);
}

// 16. from the floor she leaps diagonally up onto a window, with a run-up, instead of just popping onto it
{
  const cases = [
    ['a ledge whose top she leaps onto', [{ id: 'ledge', x: 500, y: 560, w: 300, h: 240 }], (t) => t.kind === 'leap'],
    ['a window floating above the floor, whose side she leaps onto', [{ id: 'float', x: 500, y: 300, w: 300, h: 400 }], (t) => t.kind === 'window'],
  ];
  for (const [label, win, want] of cases) {
    let leaps = 0, wide = 0, landed = 0;
    for (let n = 0; n < 30; n++) {
      const a = make();
      a.setWorld(W, H, win);
      a.reset(250);
      const t = a.climbTargets(a.floorSeg).find(want);
      assert(t, `no target for: ${label}`);
      a.plan = { kind: 'goto', target: t, until: 99 };
      let prev = a.mode;
      for (let i = 0; i < 60 * 14; i++) {
        a.update(1 / 60, { roam: true });
        if (a.mode === 'jump' && prev !== 'jump') {
          leaps++;
          if (Math.abs(a.jump.x1 - a.jump.x0) >= 60) wide++;
          for (let j = 0; j < 90 && a.mode === 'jump'; j++) a.update(1 / 60, { roam: true });
          if (a.mode === 'climb' || a.platformId === win[0].id) landed++;
          break;
        }
        prev = a.mode;
      }
    }
    console.log(`  ${label}: ${leaps}/30 leaps, ${wide} with a run-up of 60px or more, ${landed} landed on it`);
    assert(leaps >= 28, `she should leap: ${label}`);
    assert(wide >= leaps * 0.8, `the leap should travel sideways, not pop straight up: ${label}`);
    assert(landed >= leaps - 1, `the leap should land on the window: ${label}`);
  }
}

// 17. windows hidden behind a window in front are not climbable, standable or jumped to. This is her real desktop:
// Claude in front, a maximised Edge behind it covering XAMPP and two Explorer windows, a maximised Chrome at the back.
{
  const RW = 1919, RH = 1032;
  const desk = [
    { id: 'claude', x: 343, y: 565, w: 1202, h: 401 },
    { id: 'edge', x: 0, y: 0, w: 1920, h: 1032 },
    { id: 'xampp', x: 6, y: -1, w: 668, h: 434 },
    { id: 'explorer1', x: 7, y: 0, w: 1228, h: 731 },
    { id: 'explorer2', x: 683, y: 290, w: 1228, h: 731 },
    { id: 'chrome', x: 0, y: 0, w: 1920, h: 1032 },
  ];
  const a = new Actor({ spriteW: 200, spriteH: 340, anchor: 0.45, half: 58, feetInset: 3 });
  a.setWorld(RW, RH, desk);
  assert.deepStrictEqual(a.sideWins.map((w) => w.id), ['claude'], 'only the visible window can be climbed');
  assert.deepStrictEqual(a.platforms.map((p) => p.id).sort(), ['claude', 'floor'], 'only the visible window can be stood on');

  // the same windows with the maximised Edge moved to the back: now the others show through
  const shown = [desk[0], desk[2], desk[3], desk[4], desk[1], desk[5]];
  a.setWorld(RW, RH, shown);
  assert(a.sideWins.length > 1, 'windows no longer covered should be climbable again');

  // a window that is only partly covered keeps just its uncovered stretch
  const b = new Actor({ spriteW: 200, spriteH: 340, anchor: 0.45, half: 58, feetInset: 3 });
  b.setWorld(RW, RH, [
    { id: 'front', x: 100, y: 300, w: 300, h: 300 }, // covers y 300-600 at x 100-400
    { id: 'back', x: 400, y: 200, w: 500, h: 700 }, // its left edge is at x=400, mostly in the clear
  ]);
  const left = b.sideSpan(b.winById.get('back'), 'left');
  assert(left && left.bottom - left.top >= 80, 'the left edge of the back window is visible');
}

// 18. sitting: only when the character has a sitting pose, never while Claude is busy, and she doesn't slide around
{
  const sit = (canSit, roam, minutes) => {
    const a = make();
    a.setWorld(W, H, []);
    a.reset(500);
    a.canSit = canSit;
    let sat = 0, moved = 0, prevX = a.x;
    for (let i = 0; i < 60 * 60 * minutes; i++) {
      a.update(1 / 60, { roam });
      if (a.sitting) { sat++; if (a.x !== prevX) moved++; }
      prevX = a.x;
    }
    return { sat, moved, a };
  };
  assert.strictEqual(sit(false, true, 10).sat, 0, 'no sitting pose, no sitting');
  assert.strictEqual(sit(true, false, 10).sat, 0, 'no sitting while Claude is busy');
  const r = sit(true, true, 10);
  console.log(`  sat for ${(r.sat / 60).toFixed(0)}s of 600s`);
  assert(r.sat > 60 * 30, 'should sit for a good while over ten minutes');
  assert(r.sat < 60 * 400, 'but not most of the time');
  assert.strictEqual(r.moved, 0, 'does not slide while sitting');

  // a sit pose whose legs hang below the seat is for window tops only: never on the floor, still on a window
  const edge = (windows) => {
    const a = make();
    a.setWorld(W, H, windows);
    a.reset(500);
    a.canSit = true;
    a.edgeSit = true;
    let onFloor = 0, onWindow = 0;
    for (let i = 0; i < 60 * 60 * 10; i++) {
      a.update(1 / 60, { roam: true });
      if (a.sitting) { if (a.platformId === 'floor') onFloor++; else onWindow++; }
    }
    return { onFloor, onWindow };
  };
  assert.strictEqual(edge([]).onFloor, 0, 'an edge-sitting pose never sits on the floor');
  const e = edge([{ id: 'w1', x: 300, y: 500, w: 600, h: 400 }, { id: 'w2', x: 1000, y: 400, w: 500, h: 500 }]);
  assert.strictEqual(e.onFloor, 0, 'not on the floor even with windows about');
  console.log(`  edge-sitting pose: ${(e.onWindow / 60).toFixed(0)}s on window tops, 0s on the floor`);

  // picking her up ends the sit
  const a = make();
  a.setWorld(W, H, []);
  a.reset(500);
  a.plan = { kind: 'sit', until: 999 };
  assert.strictEqual(a.sitting, true);
  a.grab(500, 700, 0);
  assert.strictEqual(a.sitting, false);
  // and Claude starting work does too
  const b = make();
  b.setWorld(W, H, []);
  b.reset(500);
  b.plan = { kind: 'sit', until: 999 };
  b.update(1 / 60, { roam: false });
  assert.strictEqual(b.sitting, false);
}

console.log('physics: all tests passed');
