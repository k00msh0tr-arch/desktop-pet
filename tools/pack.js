'use strict';
// Builds dist/Claude-Pet.zip: the app, the Electron runtime, an installer, an uninstaller and a launcher.
// The target PC needs nothing installed (electron.exe also runs the hook installer as plain node).
//   npm run pack
// Windows only: it copies the win32-x64 Electron and koffi builds that are in node_modules.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'Claude Pet';
const STAGE = path.join(DIST, NAME);
// npm run pack -- --only sonnet   builds dist/Claude-Pet-sonnet.zip with just those characters (for sharing publicly)
const onlyAt = process.argv.indexOf('--only');
const ONLY = onlyAt > 0 && process.argv[onlyAt + 1] ? process.argv[onlyAt + 1].split(',') : null;
const ZIP = path.join(DIST, ONLY ? `Claude-Pet-${ONLY.join('+')}.zip` : 'Claude-Pet.zip');
const NM = path.join(ROOT, 'node_modules');

const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
const need = (p) => { if (!fs.existsSync(p)) throw new Error(`missing ${path.relative(ROOT, p)}; run npm install first`); return p; };

// text files get Windows line endings so cmd and PowerShell read them reliably
function crlf(file) {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
}

// a Windows icon (PNG-compressed images inside an .ico) from her face
async function makeIcon(file) {
  const sharp = require('sharp');
  const frame = path.join(ROOT, 'characters', 'sonnet', 'frames', 'idle.png');
  const sizes = [256, 64, 48, 32, 16];
  const pngs = [];
  for (const s of sizes) {
    pngs.push(await sharp(frame).extract({ left: 95, top: 12, width: 385, height: 385 }).resize(s, s, { kernel: 'lanczos3' }).png().toBuffer());
  }
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    head[e] = s === 256 ? 0 : s; // width, 0 means 256
    head[e + 1] = s === 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4); // colour planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(file, Buffer.concat([head, ...pngs]));
}

async function main() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true }); // other zips in dist/ are left alone
  fs.mkdirSync(path.join(STAGE, 'app'), { recursive: true });

  // the app: only what runs (no raw art, tests or art tools)
  const app = path.join(STAGE, 'app');
  const pkg = require('../package.json');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main, private: true }, null, 2) + '\n');
  copy(path.join(ROOT, 'src'), path.join(app, 'src'));
  fs.mkdirSync(path.join(app, 'tools'));
  // hooks.js installs the Claude Code hooks; the art tool builds characters dropped into her characters folder
  for (const f of ['hooks.js', 'art-source.js', 'process-art.js']) fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(app, 'tools', f));
  for (const c of fs.readdirSync(path.join(ROOT, 'characters'), { withFileTypes: true })) {
    if (!c.isDirectory() || (ONLY && !ONLY.includes(c.name))) continue;
    const from = path.join(ROOT, 'characters', c.name);
    if (!fs.existsSync(path.join(from, 'manifest.json')) || !fs.existsSync(path.join(from, 'frames'))) continue;
    copy(path.join(from, 'frames'), path.join(app, 'characters', c.name, 'frames'));
    fs.copyFileSync(path.join(from, 'manifest.json'), path.join(app, 'characters', c.name, 'manifest.json'));
  }
  // koffi reads the open windows; sharp (and what it needs) runs the art tool
  for (const pkgName of ['koffi', '@koromix/koffi-win32-x64', 'sharp', '@img/colour', '@img/sharp-win32-x64', 'detect-libc', 'semver']) {
    copy(need(path.join(NM, pkgName)), path.join(app, 'node_modules', pkgName));
  }

  // the runtime
  copy(need(path.join(NM, 'electron', 'dist')), path.join(STAGE, 'electron'));

  // installer, uninstaller, launcher, readme, icon
  copy(path.join(ROOT, 'installer'), STAGE);
  for (const f of ['Install Claude Pet.bat', 'Uninstall Claude Pet.bat', 'Claude Pet.bat', 'README.txt', 'setup/install.ps1', 'setup/uninstall.ps1']) crlf(path.join(STAGE, f));
  await makeIcon(path.join(STAGE, 'claude-pet.ico'));

  // bsdtar ships with Windows 10+ and writes a normal zip
  const r = spawnSync('tar.exe', ['-a', '-c', '-f', ZIP, '-C', DIST, NAME], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar failed');
  const mb = (fs.statSync(ZIP).size / 1048576).toFixed(0);
  console.log(`built ${path.relative(ROOT, ZIP)} (${mb} MB)`);
  fs.rmSync(STAGE, { recursive: true, force: true }); // the zip is what counts
}

main().catch((e) => { console.error(e); process.exit(1); });
