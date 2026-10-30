'use strict';
// Just enough zip for character packs: write (deflate or stored) and read (stored or deflate), with every size and
// checksum checked so it can be pointed at a file from a stranger. No dependencies, so it runs the same on Windows and
// in the Nix build. No zip64, no encryption.

const zlib = require('zlib');

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;

// { 'path/in/zip': Buffer } -> zip file
function write(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const deflated = packed.length < data.length; // a PNG is usually already as small as it gets
    const body = deflated ? packed : data;
    const crc = zlib.crc32(data);
    const method = deflated ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are utf-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, the earliest date a zip can hold
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(CENTRAL, 0);
    head.writeUInt16LE(20, 4); // made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(0x21, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);

    parts.push(local, nameBuf, body);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// zip file -> { 'path/in/zip': Buffer } (folders are left out), or throws
function read(buf, { maxFiles = 100, maxTotal = 120 * 1048576 } = {}) {
  const damaged = () => new Error('damaged zip file');
  let e = buf.length - 22;
  const lowest = Math.max(0, buf.length - 65557); // the end record sits within a comment's length of the end
  while (e >= lowest && buf.readUInt32LE(e) !== END) e--;
  if (e < lowest) throw new Error('not a zip file');
  const count = buf.readUInt16LE(e + 10);
  if (count > maxFiles) throw new Error(`too many files in the pack (${count})`);

  const out = {};
  let p = buf.readUInt32LE(e + 16);
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw damaged();
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new Error('encrypted zip files are not supported');
    if (name.endsWith('/')) continue;
    total += size;
    if (total > maxTotal) throw new Error('the pack is too big');

    if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) throw damaged();
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw damaged();
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }); // never more than it claims
    else throw new Error(`unsupported zip compression (${method})`);
    if (data.length !== size || zlib.crc32(data) !== crc) throw new Error(`${name} is damaged`);
    out[name] = data;
  }
  return out;
}

module.exports = { write, read };
