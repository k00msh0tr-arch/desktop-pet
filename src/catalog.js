'use strict';
// The online catalog of community girls: a folder in the project's GitHub repo with index.json, packs/<id>.zip and
// previews/<id>.png (tools/catalog.js builds it). Nothing from the network is trusted: sizes are capped, a pack must match
// the sha256 the index lists, and charpack.parse checks what is inside it.
// PET_CATALOG=<url ending in /> points the app at another catalog (https, or http on this computer for testing).

const crypto = require('crypto');
const charpack = require('./charpack');

const BASE = process.env.PET_CATALOG || 'https://raw.githubusercontent.com/k00msh0tr-arch/desktop-pet/main/catalog/';
const MAX_INDEX = 1048576, MAX_PREVIEW = 400 * 1024, MAX_PACK = 80 * 1048576;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function base() {
  const url = new URL(BASE);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('the catalog address must be https');
  return url;
}

async function get(rel, max) {
  const root = base();
  const url = new URL(rel, root);
  if (url.origin !== root.origin) throw new Error('the catalog points somewhere else');
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${rel}`);
  if (Number(res.headers.get('content-length')) > max) throw new Error(`${rel} is too big`);
  const chunks = [];
  let n = 0;
  for await (const chunk of res.body) {
    n += chunk.length;
    if (n > max) throw new Error(`${rel} is too big`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const text = (v, max) => String(v == null ? '' : v).slice(0, max);

async function index() {
  const list = JSON.parse((await get('index.json', MAX_INDEX)).toString('utf8')).characters;
  if (!Array.isArray(list)) throw new Error('the catalog index is not a list');
  return list
    .filter((e) => e && /^[a-z0-9-]{1,40}$/.test(e.id) && typeof e.name === 'string'
      && /^packs\/[a-z0-9-]+\.zip$/.test(e.zip) && /^previews\/[a-z0-9-]+\.png$/.test(e.preview) && /^[0-9a-f]{64}$/.test(e.sha256))
    .slice(0, 200)
    .map((e) => ({ id: e.id, name: text(e.name, 60), author: text(e.author, 60), description: text(e.description, 300), zip: e.zip, preview: e.preview, sha256: e.sha256, size: Number(e.size) || 0 }));
}

// the entries, each with its preview picture as a data: URL (null if that one failed)
async function list() {
  const entries = await index();
  return Promise.all(entries.map(async ({ zip, preview, ...e }) => {
    const png = await get(preview, MAX_PREVIEW).catch(() => null);
    return { ...e, preview: png && png.subarray(0, 4).equals(PNG) ? `data:image/png;base64,${png.toString('base64')}` : null };
  }));
}

// -> { pack (parsed, ready for charpack.install), sha256 }
async function download(id) {
  const entry = (await index()).find((e) => e.id === id);
  if (!entry) throw new Error('That girl is not in the catalog any more.');
  const buf = await get(entry.zip, MAX_PACK);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha256 !== entry.sha256) throw new Error('The download does not match the catalog (it may have just been updated). Refresh and try again.');
  const pack = charpack.parse(buf);
  if (pack.id !== entry.id) throw new Error('The pack does not match its catalog entry.');
  return { pack, sha256 };
}

module.exports = { list, download };
