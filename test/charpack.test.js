'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zip = require('../src/zip');
const { parse, install, exportDir } = require('../src/charpack');

// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const manifest = (extra = {}) => Buffer.from(JSON.stringify({ name: 'Mia', title: 'Mia', frames: { idle: 'idle.png', walk: ['walk.png', 'walk2.png'] }, ...extra }));
const good = () => ({ 'manifest.json': manifest(), 'frames/idle.png': PNG, 'frames/walk.png': PNG, 'frames/walk2.png': PNG });
const rejects = (files, why) => assert.throws(() => parse(zip.write(files)), (e) => { assert.ok(e.message, why); return true; }, why);

// a round trip through a real folder
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charpack-'));
const src = path.join(tmp, 'src', 'Mia');
fs.mkdirSync(path.join(src, 'frames'), { recursive: true });
fs.writeFileSync(path.join(src, 'manifest.json'), manifest({ base: true }));
for (const f of ['idle', 'walk', 'walk2']) fs.writeFileSync(path.join(src, 'frames', `${f}.png`), PNG);
const packed = exportDir(src, { author: 'me' });
const back = parse(packed);
assert.strictEqual(back.id, 'mia');
assert.strictEqual(back.manifest.author, 'me');
assert.ok(!('base' in back.manifest), 'a pack never claims to be a base girl');
assert.deepStrictEqual(Object.keys(back.files).sort(), ['frames/idle.png', 'frames/walk.png', 'frames/walk2.png', 'manifest.json']);
const dest = install(back, path.join(tmp, 'user'), { id: 'mia' });
assert.ok(fs.existsSync(path.join(dest, 'frames', 'walk2.png')) && fs.existsSync(path.join(dest, 'catalog.json')));
install(back, path.join(tmp, 'user')); // installing again replaces it
assert.ok(!fs.existsSync(path.join(dest, 'catalog.json')));
fs.rmSync(tmp, { recursive: true, force: true });

// a zip made from a folder keeps everything under that folder's name
const wrapped = Object.fromEntries(Object.entries(good()).map(([k, v]) => [`Mia/${k}`, v]));
assert.strictEqual(parse(zip.write(wrapped)).id, 'mia');

// things that are not allowed
rejects({ ...good(), '../evil.png': PNG }, 'path with ..');
rejects({ ...good(), '/abs.png': PNG }, 'absolute path');
rejects({ ...good(), 'C:/x.png': PNG }, 'drive letter');
rejects({ ...good(), 'manifest.json': manifest({ frames: { idle: '../../secret.png' } }) }, 'frame path in the manifest');
rejects({ ...good(), 'manifest.json': manifest({ frames: { idle: 'nope.png' } }) }, 'missing frame');
rejects({ ...good(), 'manifest.json': manifest({ frames: { walk: 'walk.png' } }) }, 'no idle');
rejects({ ...good(), 'frames/idle.png': Buffer.from('not a png at all') }, 'not a png');
rejects({ ...good(), 'manifest.json': Buffer.from('{ broken') }, 'bad json');
rejects({ ...good(), 'manifest.json': manifest({ name: '!!!', title: '' }) }, 'no usable name');
assert.throws(() => parse(Buffer.from('this is not a zip file, just text')), /not a zip/);

// extra files in a pack are simply not read
const extras = parse(zip.write({ ...good(), 'run.exe': Buffer.from('MZ'), 'frames/extra.png': PNG, '__MACOSX/x': PNG }));
assert.deepStrictEqual(Object.keys(extras.files).sort(), ['frames/idle.png', 'frames/walk.png', 'frames/walk2.png', 'manifest.json']);

// the zip reader checks what it is told
const z = zip.write({ 'a.txt': Buffer.from('hello hello hello hello hello hello') });
const flipped = Buffer.from(z); flipped[40] ^= 0xff; // a byte of the file's data
assert.throws(() => zip.read(flipped), /damaged/);
assert.throws(() => zip.read(z, { maxTotal: 5 }), /too big/);
assert.throws(() => zip.read(z, { maxFiles: 0 }), /too many/);

console.log('charpack: all tests passed');
