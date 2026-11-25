// The PC options screens and the quit menu ("Video Settings", "Quit to Windows", ...) are not in
// the text files: LEGOBatman.exe holds them as UTF-8 C strings, one table per language
// (English, American, French, German, Italian, Spanish, Danish), each 40 x { u32 id, u32 ptr }
// plus a { 40, 0 } terminator.
//
// The exe is never changed. menu.cfg tells the proxy DLL which table slots to point at Hebrew
// strings in memory, once the game is loaded (and only when started from the launcher).

const TABLE_ENTRIES = 41;
const TABLE_SIZE = TABLE_ENTRIES * 8;
const ANCHOR = 'Quit to Windows';

function sections(exe) {
  const pe = exe.readUInt32LE(0x3c);
  if (exe.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const count = exe.readUInt16LE(pe + 6);
  const optSize = exe.readUInt16LE(pe + 20);
  const imageBase = exe.readUInt32LE(pe + 24 + 28);
  const list = [];
  for (let i = 0, s = pe + 24 + optSize; i < count; i++, s += 40) {
    list.push({ va: exe.readUInt32LE(s + 12), vsize: exe.readUInt32LE(s + 8), raw: exe.readUInt32LE(s + 20), rsize: exe.readUInt32LE(s + 16) });
  }
  const toOffset = (addr) => {
    const rva = addr - imageBase;
    const sec = list.find((x) => rva >= x.va && rva < x.va + Math.min(x.vsize, x.rsize));
    return sec ? rva - sec.va + sec.raw : -1;
  };
  const toRva = (off) => {
    const sec = list.find((x) => off >= x.raw && off < x.raw + x.rsize);
    return sec ? off - sec.raw + sec.va : -1;
  };
  return { imageBase, toOffset, toRva };
}

function cstr(exe, off) {
  return exe.toString('utf8', off, exe.indexOf(0, off));
}

function allRefs(exe, value) {
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(value >>> 0);
  const out = [];
  for (let i = exe.indexOf(needle); i !== -1; i = exe.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Finds the English string tables (the English and American ones). */
function findTables(exe) {
  const { imageBase, toOffset, toRva } = sections(exe);
  const anchor = exe.indexOf(Buffer.from(`\0${ANCHOR}\0`, 'latin1'));
  if (anchor < 0) throw new Error(`"${ANCHOR}" not found in the exe`);
  const anchorAddr = toRva(anchor + 1) + imageBase;
  const valid = (t) => {
    if (t < 0 || t + TABLE_SIZE > exe.length) return false;
    for (let k = 0; k < TABLE_ENTRIES - 1; k++) {
      if (exe.readUInt32LE(t + k * 8) >= TABLE_ENTRIES) return false;
      if (toOffset(exe.readUInt32LE(t + k * 8 + 4)) < 0) return false;
    }
    // last entry is the terminator { 40, 0 }
    return exe.readUInt32LE(t + (TABLE_ENTRIES - 1) * 8) === TABLE_ENTRIES - 1 && exe.readUInt32LE(t + TABLE_SIZE - 4) === 0;
  };
  // the entry pointing at "Quit to Windows" is entry 1
  const english = allRefs(exe, anchorAddr).map((r) => r - 12).filter(valid);
  if (!english.length) throw new Error('English string table not found');
  const read = (t) => Array.from({ length: TABLE_ENTRIES - 1 }, (_, k) => {
    const ptr = exe.readUInt32LE(t + k * 8 + 4);
    return { slotRva: toRva(t + k * 8 + 4), id: exe.readUInt32LE(t + k * 8), ptr, text: cstr(exe, toOffset(ptr)) };
  });
  return { english, read };
}

/** The English strings the game can show: [{ id, text }] */
function englishStrings(exe) {
  const t = findTables(exe);
  return t.read(t.english[0]).map(({ id, text }) => ({ id, text }));
}

/**
 * menu.cfg for the proxy DLL: every slot of the English tables whose string has a Hebrew
 * version, as "<slot RVA>\t<pointer it holds now>\t<Hebrew>". The proxy only changes a slot that
 * still holds that pointer, so another build of the exe is left alone.
 * visual: Map English text -> Hebrew (visual order); a value equal to the key keeps the English.
 */
function menuConfig(exe, visual) {
  const t = findTables(exe);
  const lines = ['TIRGUMIM-MENU 1'];
  const missing = [];
  for (const table of t.english) {
    for (const e of t.read(table)) {
      const he = visual.get(e.text);
      if (he === undefined) {
        if (!missing.includes(e.text)) missing.push(e.text);
      } else if (he !== e.text) {
        if (/[\t\r\n]/.test(he)) throw new Error(`menu string may not contain tabs or line breaks: ${he}`);
        lines.push(`${e.slotRva.toString(16)}\t${e.ptr.toString(16)}\t${he}`);
      }
    }
  }
  return { text: `${lines.join('\n')}\n`, missing };
}

module.exports = { findTables, englishStrings, menuConfig };
