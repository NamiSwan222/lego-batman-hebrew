// Run with: node --test games/lego-batman/
// Uses a synthetic GAME.DAT and LEGOBatman.exe in the game's formats (no game files needed),
// plus read-only checks against the real install when it is present.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ttdat = require('./tools/lib/ttdat');
const rtl = require('./tools/lib/rtl');
const font = require('./tools/lib/font');
const build = require('./tools/lib/build');
const exestrings = require('./tools/lib/exestrings');
const { coverage } = require('./tools/lib/coverage');
const { findSteamApp } = require('./tools/lib/steam');

const TRANSLATION = path.join(__dirname, 'translation');

// ---------- synthetic archive ----------

// files: { 'stuff/text/english.txt': Buffer, ... } -> GAME.DAT bytes (index version -2)
function makeDat(files) {
  const names = Object.keys(files).sort();
  // build the folder tree
  const root = { name: '', children: new Map() };
  names.forEach((full, fileIndex) => {
    const parts = full.split('/');
    let node = root;
    parts.forEach((p, i) => {
      if (!node.children.has(p)) node.children.set(p, { name: p, children: new Map(), fileIndex: i === parts.length - 1 ? fileIndex : undefined });
      node = node.children.get(p);
    });
  });
  const entries = [];
  let pool = Buffer.from([0]);
  const nameOff = (n) => {
    const off = pool.length;
    pool = Buffer.concat([pool, Buffer.from(`${n}\0`, 'latin1')]);
    return off;
  };
  // entry 0 is the root; a folder's `next` is the index of its last direct child,
  // a file's `next` is minus its file index, `prev` is the previous sibling (0 = first child)
  const lastChildOf = new Map();
  entries.push({ next: 0, prev: 0, nameOff: 0 });
  const visit = (node, idx) => {
    let prev = 0;
    for (const kid of node.children.values()) {
      const i = entries.length;
      entries.push({ next: 0, prev, nameOff: nameOff(kid.name) });
      if (kid.fileIndex !== undefined) entries[i].next = -kid.fileIndex;
      else visit(kid, i);
      lastChildOf.set(idx, i);
      prev = i;
    }
    entries[idx].next = lastChildOf.get(idx);
  };
  visit(root, 0);

  // data
  const chunks = [];
  let offset = 0x200;
  const fileEntries = names.map((n) => {
    const data = files[n];
    const e = { offset, size: data.length };
    const padded = Buffer.alloc(Math.ceil(data.length / 256) * 256);
    data.copy(padded);
    chunks.push(padded);
    offset += padded.length;
    return e;
  });
  const indexOffset = offset;
  const idx = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  idx.push(u32(-2 >>> 0), u32(names.length));
  for (const e of fileEntries) idx.push(u32(e.offset / 256), u32(e.size), u32(e.size), u32(0));
  idx.push(u32(entries.length));
  for (const e of entries) {
    const b = Buffer.alloc(8);
    b.writeInt16LE(e.next, 0);
    b.writeUInt16LE(e.prev, 2);
    b.writeUInt32LE(e.nameOff, 4);
    idx.push(b);
  }
  idx.push(u32(pool.length), pool, Buffer.alloc(64)); // trailing hash area
  const index = Buffer.concat(idx);
  const head = Buffer.alloc(0x200);
  head.writeUInt32LE((((indexOffset - 0x100) / 256) ^ 0xffffffff) >>> 0, 0);
  head.writeUInt32LE(index.length, 4);
  return Buffer.concat([head, ...chunks, index, Buffer.alloc(300)]);
}

// A small font in the game's .fnt layout: 64x64 DXT5 atlas, 8px cells.
function makeFont() {
  const chars = [' ', 'A', 'B', 'a', 'e', 'o', ...Array.from({ length: 30 }, (_, i) => String.fromCharCode(0xc0 + i))];
  const n = chars.length;
  const cell = 8;
  const recOff = 0x60;
  const mapOff = recOff + n * 12;
  const ddsOff = Math.ceil((mapOff + (n + 1) * 4 + 16) / 16) * 16;
  const W = 64;
  const H = 64;
  const buf = Buffer.alloc(ddsOff + 128 + (W / 4) * (H / 4) * 16 + 68);
  buf.writeUInt32LE(ddsOff - 8, 8);
  buf.writeUInt32LE(n, 0x1c);
  buf.writeFloatLE(cell, 0x24);
  buf.writeFloatLE(6, 0x28);
  chars.forEach((ch, g) => {
    const x = (g % 12) * 5;
    const y = Math.floor(g / 12) * cell;
    buf.writeFloatLE(x, recOff + g * 12);
    buf.writeFloatLE(y, recOff + g * 12 + 4);
    buf.writeFloatLE(4, recOff + g * 12 + 8);
  });
  chars
    .map((ch, g) => ({ code: ch.charCodeAt(0), g }))
    .sort((a, b) => a.code - b.code)
    .forEach((m, i) => {
      buf.writeUInt16LE(m.code, mapOff + i * 4);
      buf.writeUInt16LE(m.g, mapOff + i * 4 + 2);
    });
  buf.writeUInt32LE(0xffffffff, mapOff + n * 4);
  buf.write('DDS ', ddsOff, 'latin1');
  buf.writeUInt32LE(124, ddsOff + 4);
  buf.writeUInt32LE(H, ddsOff + 12);
  buf.writeUInt32LE(W, ddsOff + 16);
  buf.writeUInt32LE(1, ddsOff + 28);
  buf.write('DXT5', ddsOff + 84, 'latin1');
  // every block: opaque white
  for (let p = ddsOff + 128; p < ddsOff + 128 + (W / 4) * (H / 4) * 16; p += 16) {
    buf[p] = 255;
    buf[p + 1] = 254;
    buf.writeUInt16LE(0xffff, p + 8);
    buf.writeUInt16LE(0xfffe, p + 10);
  }
  return buf;
}

// A minimal PE exe with the game's menu string tables: 7 languages x (40 { id, ptr } + terminator).
const EXE_STRINGS = [...build.parsePairs(fs.readFileSync(path.join(TRANSLATION, 'hebrew-exe.txt'), 'utf8')).keys()];
function makeExe() {
  const IMAGE_BASE = 0x400000;
  const RDATA = { va: 0x1000, raw: 0x400, size: 0x4000 };
  const DATA = { va: 0x5000, raw: 0x4400, size: 0x1000 };
  const exe = Buffer.alloc(DATA.raw + DATA.size);
  exe.write('MZ', 0, 'latin1');
  exe.writeUInt32LE(0x40, 0x3c);
  exe.write('PE\0\0', 0x40, 'latin1');
  exe.writeUInt16LE(2, 0x46); // sections
  exe.writeUInt16LE(0xe0, 0x54); // optional header size
  exe.writeUInt32LE(IMAGE_BASE, 0x58 + 28);
  [RDATA, DATA].forEach((s, i) => {
    const h = 0x58 + 0xe0 + i * 40;
    exe.writeUInt32LE(s.size, h + 8);
    exe.writeUInt32LE(s.va, h + 12);
    exe.writeUInt32LE(s.size, h + 16);
    exe.writeUInt32LE(s.raw, h + 20);
  });
  let cursor = RDATA.raw + 16;
  const addString = (s) => {
    const off = cursor;
    exe.write(`${s}\0`, off, 'utf8');
    cursor = Math.ceil((off + Buffer.byteLength(s) + 1) / 4) * 4;
    return off - RDATA.raw + RDATA.va + IMAGE_BASE;
  };
  const english = EXE_STRINGS.map(addString);
  const languages = [english, english];
  for (let l = 0; l < 5; l++) languages.push(EXE_STRINGS.map((s, i) => addString(`Fremdsprache ${l}/${i} ${s}`)));
  languages.forEach((ptrs, l) => {
    const t = DATA.raw + l * 41 * 8;
    ptrs.forEach((p, k) => {
      exe.writeUInt32LE(k, t + k * 8);
      exe.writeUInt32LE(p, t + k * 8 + 4);
    });
    exe.writeUInt32LE(40, t + 40 * 8);
  });
  return exe;
}

// Stand-in for the GDI+ renderer: one 4x8 opaque block per Hebrew letter.
function fakeRender() {
  return font.HEBREW.map((code) => ({ code, w: 4, h: 8, rgba: Buffer.alloc(4 * 8 * 4, 200) }));
}

const BOM = '﻿';
function gameFiles() {
  return {
    'stuff/text/english.txt': Buffer.from(`${BOM}\r\n; comment\r\n\r\n252 "New Game"\r\n263 "Options"\r\n433 "~2Toxic Waste~~ is poisonous - but some characters and vehicles can get through safely!"\r\n920 pc "Control Setup"\r\n999 "Untranslated"\r\n`, 'utf8'),
    'stuff/text/american.txt': Buffer.from('656 "Armor Plating"\r\n', 'utf8'),
    'stuff/text/trc.csv': Buffer.from(`${BOM}"LABEL","ENGLISH","FRENCH","AMERICAN"\r\n,,,\r\n"GEN_YES","Yes","Oui","Yes"\r\n"PS2_X","Memory Card","Carte","Memory Card"\r\n`, 'utf16le'),
    'stuff/text/batman_font_pc.fnt': makeFont(),
    'stuff/text/pc_english_credits.txt': Buffer.from(`${BOM}heading colour 1.0 0.875 0.0\r\n\r\nheading\t"DEVELOPED BY"\r\ncompany\t"Traveller's Tales"\r\ntitle\t"DIRECTOR"\r\nname\t"Jon Burton"\r\npc_only credit  "Uses Bink Video Technology."\r\n`, 'utf8'),
    'levels/a/level.txt': Buffer.from('level data'),
    'binkw32.dll': Buffer.alloc(1000, 7),
  };
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tirgumim-legobatman-'));
  fs.writeFileSync(path.join(root, 'GAME.DAT'), makeDat(gameFiles()));
  fs.writeFileSync(path.join(root, 'LEGOBatman.exe'), makeExe());
  return { root, dat: path.join(root, 'GAME.DAT'), exe: path.join(root, 'LEGOBatman.exe') };
}

function withInstall(fn) {
  const inst = fakeInstall();
  try {
    return fn(inst);
  } finally {
    fs.rmSync(inst.root, { recursive: true, force: true });
  }
}

// ---------- tests ----------

test('synthetic archive reads back through the DAT reader', () => withInstall(({ dat }) => {
  const index = ttdat.readIndex(dat);
  for (const [name, data] of Object.entries(gameFiles())) assert.deepStrictEqual(ttdat.extract(dat, name, index), data, name);
}));

test('Hebrew archive = original + append + overlay: the game sees Hebrew, the original is untouched', () => withInstall(({ dat }) => {
  const before = sha(dat);
  const { files } = build.buildPatch(dat, TRANSLATION, { render: fakeRender });
  const { append, overlay } = ttdat.planAppend(dat, files);
  assert.strictEqual(sha(dat), before, 'building never writes to GAME.DAT');

  // the new files live after the original's end
  const size = fs.statSync(dat).size;
  assert.ok(overlay.every((o) => o.data.readUInt32LE(0) * 256 >= size));

  const seen = (name) => ttdat.extractPatched(dat, append, overlay, name);
  const text = seen('stuff/text/english.txt').toString('utf8');
  assert.match(text, /252 "שדח קחשמ"/);
  assert.match(text, /~2הליער תלוספ~~/);
  assert.match(text, /999 "Untranslated"/);
  const trc = seen('stuff/text/trc.csv').toString('utf16le');
  assert.match(trc, /"GEN_YES","ןכ","Oui","ןכ"/);
  assert.match(trc, /"PS2_X","Memory Card","Carte","Memory Card"/);
  const credits = seen('stuff/text/pc_english_credits.txt').toString('utf8');
  assert.match(credits, /heading\t"ידי לע חתופ"/);
  assert.match(credits, /company\t"Traveller's Tales"/);
  assert.match(credits, /name\t"Jon Burton"/);
  assert.match(credits, /pc_only credit {2}"\.Bink ואדיווה תייגולונכטב שמתשמ"/);
  const fnt = seen('stuff/text/batman_font_pc.fnt');
  assert.strictEqual(fnt.length, makeFont().length);
  const codes = font.parse(fnt).map.map((m) => m.code);
  for (const he of font.HEBREW) assert.ok(codes.includes(he), `font maps U+${he.toString(16)}`);
  assert.deepStrictEqual(seen('levels/a/level.txt'), Buffer.from('level data'));

  const lines = ttdat.overlayText(overlay).split('\n');
  assert.strictEqual(lines[0], 'TIRGUMIM-OVERLAY 1');
  assert.match(lines[1], /^\d+ [0-9a-f]{32}$/);
}));

test('menu.cfg points both English exe tables at Hebrew and records the old pointer', () => withInstall(({ exe }) => {
  const buf = fs.readFileSync(exe);
  const { text, missing } = build.buildMenuConfig(buf, TRANSLATION);
  assert.deepStrictEqual(missing, []);
  const lines = text.trim().split('\n');
  assert.strictEqual(lines[0], 'TIRGUMIM-MENU 1');
  assert.strictEqual(lines.length - 1, 80, '40 strings x 2 English tables');
  const tables = exestrings.findTables(buf);
  const quit = tables.read(tables.english[0]).find((e) => e.text === 'Quit to Windows');
  assert.ok(lines.includes(`${quit.slotRva.toString(16)}\t${quit.ptr.toString(16)}\tWindows-ל האיצי`));
  assert.ok(lines.some((l) => l.endsWith(`\t${rtl.toVisual('הגדרות וידאו')}`)));
}));

test('coverage lists every untranslated player-visible string', () => withInstall(({ root }) => {
  const r = coverage(root, TRANSLATION);
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.sections.find((s) => s.name === 'stuff/text/english.txt').missing, ['999 "Untranslated"']);
  assert.strictEqual(r.sections.find((s) => s.name === 'credits').missing.length, 0);
  assert.strictEqual(r.sections.find((s) => s.name === 'LEGOBatman.exe menu strings').missing.length, 0);
}));

test('right-to-left conversion keeps Latin, numbers and game markup readable', () => {
  assert.strictEqual(rtl.toVisual('משחק חדש'), 'שדח קחשמ');
  assert.strictEqual(rtl.toVisual('לחץ [SPECIAL] כדי לבנות.'), '.תונבל ידכ [SPECIAL] ץחל');
  assert.strictEqual(rtl.toVisual('קטע %i'), '%i עטק');
  assert.strictEqual(rtl.toVisual('התקדמות: %.1f%%'), '%.1f%% :תומדקתה');
  assert.strictEqual(rtl.toVisual('נבנה ב-1939'), '1939-ב הנבנ');
  assert.strictEqual(rtl.toVisual('מיסטר (קלאסי)'), '(יסאלק) רטסימ');
  assert.strictEqual(rtl.toVisual('~2פסולת~~ רעל'), 'לער ~2תלוספ~~');
  assert.strictEqual(rtl.toVisual('יציאה ל-Windows'), 'Windows-ל האיצי');
  const long = rtl.toVisual('א'.repeat(10) + ' ב'.repeat(30), { maxWidth: 30 });
  for (const line of long.split(rtl.LINE_BREAK)) assert.ok(line.length <= 30, line);
});

test('translation files parse and only use characters the font can show', () => {
  const he = build.parseStrings(fs.readFileSync(path.join(TRANSLATION, 'hebrew.txt'), 'utf8'));
  const trc = build.parseLabels(fs.readFileSync(path.join(TRANSLATION, 'hebrew-trc.txt'), 'utf8'));
  const pairs = [
    ...build.parsePairs(fs.readFileSync(path.join(TRANSLATION, 'hebrew-credits.txt'), 'utf8')),
    ...build.parsePairs(fs.readFileSync(path.join(TRANSLATION, 'hebrew-exe.txt'), 'utf8')),
  ].filter(([en, h]) => en !== h);
  assert.ok(he.size >= 651, `hebrew.txt has ${he.size} lines`);
  assert.ok(trc.size >= 55);
  const allowed = /^[א-ת A-Za-z0-9.,:;!?'()\-/%[\]_~\\+…®™&]*$/;
  for (const [id, s] of [...he, ...trc, ...pairs]) {
    assert.ok(allowed.test(s), `${id}: unexpected character in "${s}"`);
    assert.ok(!s.includes('"'), `${id}: use '' instead of a double quote`);
  }
});

test('pack config adds files only and turns Hebrew on with a launch argument', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'pack', 'pack.config.json'), 'utf8'));
  assert.strictEqual(cfg.activation.mode, 'args');
  assert.deepStrictEqual(cfg.activation.args, ['-tirgumim-he']);
  assert.ok(cfg.patches.every((p) => p.output && p.output.startsWith('tirgumim/')), 'patches write new files only');
  const entry = JSON.parse(fs.readFileSync(path.join(__dirname, 'pack', 'catalog-entry.json'), 'utf8'));
  assert.strictEqual(entry.id, cfg.gameId);
  assert.strictEqual(entry.detect.steamAppId, '21000');
  const def = fs.readFileSync(path.join(__dirname, 'tools', 'proxy', 'exports.def'), 'utf8');
  for (const ord of [2, 3, 4]) assert.match(def, new RegExp(`@${ord}\\b`), `proxy exports ordinal ${ord}`);
});

const REAL = findSteamApp(21000);
test('real install (if present): coverage is 100% and the pack builds', { skip: !REAL }, () => {
  const r = coverage(REAL, TRANSLATION);
  assert.ok(r.complete, `untranslated: ${r.sections.flatMap((s) => s.missing).join(' | ')}`);
  const dat = path.join(REAL, 'GAME.DAT');
  const { files } = build.buildPatch(dat, TRANSLATION);
  assert.strictEqual(ttdat.planAppend(dat, files).overlay.length, files.length);
  assert.strictEqual(build.buildMenuConfig(fs.readFileSync(path.join(REAL, 'LEGOBatman.exe')), TRANSLATION).missing.length, 0);
});
