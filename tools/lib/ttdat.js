// Reader for the TT Games .DAT archive used by LEGO Batman (2008), and the planner for the
// Hebrew copy (original + appended files + an index overlay).
//
// Layout (worked out from the game's own GAME.DAT, index version -2):
//   file start: u32 indexPtr, u32 indexSize
//     indexPtr with the top bit set is stored inverted: offset = (~indexPtr << 8) + 0x100
//   index: s32 version (-2), u32 fileCount,
//          fileCount x { u32 offset/256, u32 packedSize, u32 size, u32 packFlags },
//          u32 nameCount, nameCount x { s16 next, u16 prev, u32 nameOffset },
//          u32 namePoolSize, name pool (NUL-terminated lowercase names), then hashes.
//   Name entries form a tree: an entry with next > its own index is a folder whose last direct
//   child is `next`; any other entry is a file whose file index is -next. prev is the previous
//   sibling (0 = first child, whose parent is the entry right before it).
//
// The Hebrew copy never rewrites existing data: new file contents follow the end of the archive
// and only the 16-byte index entries change, and those changes live in a separate overlay.
const fs = require('fs');

const ALIGN = 256;

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let done = 0;
  while (done < len) {
    const n = fs.readSync(fd, buf, done, len - done, pos + done);
    if (n === 0) throw new Error('unexpected end of file');
    done += n;
  }
  return buf;
}

function readIndex(datPath) {
  const fd = fs.openSync(datPath, 'r');
  try {
    const head = readAt(fd, 0, 8);
    const raw = head.readUInt32LE(0);
    const indexOffset = raw & 0x80000000 ? (((raw ^ 0xffffffff) >>> 0) * 256) + 0x100 : raw;
    const indexSize = head.readUInt32LE(4);
    const idx = readAt(fd, indexOffset, indexSize);
    const version = idx.readInt32LE(0);
    if (version !== -2) throw new Error(`unsupported DAT index version ${version}`);
    const fileCount = idx.readUInt32LE(4);
    const files = [];
    let p = 8;
    for (let i = 0; i < fileCount; i++, p += 16) {
      files.push({
        entryPos: indexOffset + p,
        offset: idx.readUInt32LE(p) * ALIGN,
        packedSize: idx.readUInt32LE(p + 4),
        size: idx.readUInt32LE(p + 8),
        flags: idx.readUInt32LE(p + 12),
      });
    }
    const nameCount = idx.readUInt32LE(p);
    p += 4;
    const ents = [];
    for (let i = 0; i < nameCount; i++, p += 8) {
      ents.push({ next: idx.readInt16LE(p), prev: idx.readUInt16LE(p + 2), nameOff: idx.readUInt32LE(p + 4) });
    }
    const pool = p + 4;
    const nameAt = (off) => idx.toString('latin1', pool + off, idx.indexOf(0, pool + off));
    const parent = [];
    const full = [''];
    const paths = new Map();
    for (let i = 1; i < nameCount; i++) {
      const e = ents[i];
      parent[i] = e.prev === 0 ? i - 1 : parent[e.prev];
      full[i] = (full[parent[i]] ? `${full[parent[i]]}/` : '') + nameAt(e.nameOff);
      if (!(e.next > i)) paths.set(full[i].toLowerCase(), -e.next);
    }
    return { indexOffset, indexSize, files, paths };
  } finally {
    fs.closeSync(fd);
  }
}

function fileIndex(index, name) {
  const i = index.paths.get(name.toLowerCase().replace(/\\/g, '/'));
  if (i === undefined || !index.files[i]) throw new Error(`${name} not found in archive`);
  return i;
}

function extract(datPath, name, index = readIndex(datPath)) {
  const f = index.files[fileIndex(index, name)];
  if (f.flags !== 0 || f.packedSize !== f.size) throw new Error(`${name} is compressed; not supported`);
  const fd = fs.openSync(datPath, 'r');
  try {
    return readAt(fd, f.offset, f.size);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Plans the Hebrew archive as "original + appended data": each replacement file goes after the
 * end of the original (256-byte aligned) and its 16-byte index entry is repointed.
 * replacements: [{ name: 'stuff/text/english.txt', data: Buffer }]
 * Returns { append: Buffer (starts right at the original's end), overlay: [{ pos, data }] }.
 * The launcher writes original + append as tirgumim\he\GAME.DAT; the proxy DLL lays the overlay
 * bytes over that file's index when the game reads it. The original file is never changed.
 */
function planAppend(datPath, replacements, index = readIndex(datPath)) {
  const size = fs.statSync(datPath).size;
  let end = Math.ceil(size / ALIGN) * ALIGN;
  const chunks = [Buffer.alloc(end - size)];
  const overlay = [];
  for (const r of replacements) {
    const f = index.files[fileIndex(index, r.name)];
    const padded = Buffer.alloc(Math.ceil(r.data.length / ALIGN) * ALIGN);
    r.data.copy(padded);
    chunks.push(padded);
    const entry = Buffer.alloc(16);
    entry.writeUInt32LE(end / ALIGN, 0);
    entry.writeUInt32LE(r.data.length, 4);
    entry.writeUInt32LE(r.data.length, 8);
    entry.writeUInt32LE(0, 12);
    overlay.push({ pos: f.entryPos, data: entry });
    end += padded.length;
  }
  return { append: Buffer.concat(chunks), overlay };
}

/** Reads a file from "original + append" with the overlay applied (what the game sees). */
function extractPatched(datPath, append, overlay, name) {
  const index = readIndex(datPath);
  const o = overlay.find((x) => x.pos === index.files[fileIndex(index, name)].entryPos);
  if (!o) return extract(datPath, name, index);
  const at = o.data.readUInt32LE(0) * ALIGN - fs.statSync(datPath).size;
  return append.subarray(at, at + o.data.readUInt32LE(8));
}

/** Text form of the overlay read by the proxy DLL. */
function overlayText(overlay) {
  return ['TIRGUMIM-OVERLAY 1', ...overlay.map((o) => `${o.pos} ${o.data.toString('hex')}`), ''].join('\n');
}

module.exports = { readIndex, extract, planAppend, extractPatched, overlayText };
