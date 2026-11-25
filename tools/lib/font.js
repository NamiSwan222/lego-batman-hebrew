// Adds Hebrew letters to the game's font (stuff/text/batman_font_pc.fnt) without changing its
// size or layout: accented Latin glyphs that the Hebrew text does not use give up their glyph
// slots and atlas space, and the Hebrew letters are painted into the 512x512 DXT5 atlas.
//
// .fnt layout (worked out from the game's files):
//   0x08 u32  DDS offset - 8          0x1c u32 glyph record count (n)
//   0x24 f32  cell height (48)        0x28 f32 baseline (37)
//   0x60      n x { f32 x, f32 y, f32 width }   (glyph record g is at 0x60 + g*12)
//   then      { u16 codepoint, u16 glyph } pairs sorted by codepoint, ended by 0xFFFF 0xFFFF
//   DDS       DXT5 atlas with a full mip chain
const dxt5 = require('./dxt5');

const HEBREW = Array.from({ length: 27 }, (_, i) => 0x05d0 + i);

function parse(buf) {
  const n = buf.readUInt32LE(0x1c);
  const recOff = 0x60;
  const mapOff = recOff + n * 12;
  const map = [];
  for (let p = mapOff; ; p += 4) {
    const code = buf.readUInt16LE(p);
    if (code === 0xffff) break;
    map.push({ code, glyph: buf.readUInt16LE(p + 2), pos: p });
  }
  const dds = buf.readUInt32LE(8) + 8;
  if (buf.toString('latin1', dds, dds + 4) !== 'DDS ') throw new Error('font: DDS header not found');
  if (buf.toString('latin1', dds + 84, dds + 88) !== 'DXT5') throw new Error('font: atlas is not DXT5');
  return {
    n,
    recOff,
    mapOff,
    map,
    cellHeight: buf.readFloatLE(0x24),
    dds,
    height: buf.readUInt32LE(dds + 12),
    width: buf.readUInt32LE(dds + 16),
    mips: Math.max(1, buf.readUInt32LE(dds + 28)),
    record(g) {
      const o = recOff + g * 12;
      return { x: buf.readFloatLE(o), y: buf.readFloatLE(o + 4), w: buf.readFloatLE(o + 8) };
    },
  };
}

// Characters whose glyph slots may be given to Hebrew (only if the final text does not use them).
function isRemovable(code) {
  const ch = String.fromCharCode(code);
  if (code >= 0xc0 && code <= 0x17f) return true; // accented Latin letters
  // NOT symbols like ± § ¤ £ « { } $ ` ´: this font maps HUD icons (Robin logo, arrows, ticks) onto them
  return 'œ¡¿ªº²'.includes(ch);
}

function baseLetter(code) {
  const base = String.fromCharCode(code).normalize('NFD').replace(/[̀-ͯ]/g, '');
  return base.length === 1 ? base.charCodeAt(0) : null;
}

/**
 * fnt: original font Buffer. glyphs: [{ code, w, h, rgba Buffer }] (cell height tall, baseline
 * aligned with the font). usedChars: Set of code points the final text uses.
 * Returns a new font Buffer of the same size.
 */
function addGlyphs(fnt, glyphs, usedChars) {
  const out = Buffer.from(fnt);
  const f = parse(out);
  const W = f.width;
  const H = f.height;

  const removed = f.map.filter((m) => isRemovable(m.code) && !usedChars.has(m.code));
  const kept = f.map.filter((m) => !removed.includes(m));
  const keptGlyphs = new Set(kept.map((m) => m.glyph));
  const freeSlots = [...new Set(removed.map((m) => m.glyph))].filter((g) => !keptGlyphs.has(g));
  if (freeSlots.length < glyphs.length || removed.length < glyphs.length) {
    throw new Error(`font: only ${freeSlots.length} free glyph slots for ${glyphs.length} new letters`);
  }

  // atlas pixels
  const level0 = dxt5.decode(out, f.dds + 128, W, H);
  const occupied = new Uint8Array(W * H);
  const mark = (r, val) => {
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(H, Math.ceil(r.y + f.cellHeight)); y++) {
      for (let x = Math.max(0, Math.floor(r.x) - 1); x < Math.min(W, Math.ceil(r.x + r.w) + 1); x++) {
        occupied[y * W + x] = val;
      }
    }
  };
  for (const g of keptGlyphs) {
    const r = f.record(g);
    if (r.w > 0) mark(r, 1);
  }
  const original = Buffer.from(level0);
  // clear everything outside the kept glyphs: removed glyphs, and ink that spills past a cell
  // edge, which would otherwise show up as specks next to the new letters
  for (let i = 0; i < W * H; i++) if (!occupied[i]) level0.writeUInt32LE(0, i * 4);

  // place each new glyph on a row (band) where its whole cell is free
  const bands = [...new Set(f.map.map((m) => f.record(m.glyph).y))]
    .filter((y) => y >= 0 && y + f.cellHeight <= H)
    .sort((a, b) => a - b);
  const fits = (x, y, w) => {
    for (let yy = y; yy < y + f.cellHeight; yy++) {
      for (let xx = x; xx < x + w; xx++) if (occupied[yy * W + xx]) return false;
    }
    return true;
  };
  const placed = [];
  for (const [i, gl] of glyphs.entries()) {
    let spot = null;
    for (const y of bands) {
      // keep 2px off the atlas edges: the texture wraps, so a cell touching the right edge
      // samples the left edge too (seen in game as a speck next to the letter)
      for (let x = 2; x + gl.w <= W - 2 && !spot; x++) if (fits(x, y, gl.w)) spot = { x, y };
      if (spot) break;
    }
    if (!spot) throw new Error(`font: no room in the atlas for U+${gl.code.toString(16)}`);
    for (let yy = 0; yy < gl.h && spot.y + yy < H; yy++) {
      for (let xx = 0; xx < gl.w; xx++) {
        const s = (yy * gl.w + xx) * 4;
        const d = ((spot.y + yy) * W + spot.x + xx) * 4;
        gl.rgba.copy(level0, d, s, s + 4);
      }
    }
    const rec = { x: spot.x, y: spot.y, w: gl.w };
    mark(rec, 1);
    const slot = freeSlots[i];
    const o = f.recOff + slot * 12;
    out.writeFloatLE(rec.x, o);
    out.writeFloatLE(rec.y, o + 4);
    out.writeFloatLE(rec.w, o + 8);
    placed.push({ code: gl.code, glyph: slot });
  }

  // character map: same number of entries. New letters take over removed entries; removed
  // characters left over fall back to their unaccented letter (é -> e) or a space.
  const byCode = new Map(kept.map((m) => [m.code, m.glyph]));
  const spare = removed.slice(placed.length).map((m) => {
    const base = baseLetter(m.code);
    return { code: m.code, glyph: byCode.get(base) ?? byCode.get(32) ?? 0 };
  });
  const entries = [...kept.map((m) => ({ code: m.code, glyph: m.glyph })), ...placed, ...spare].sort((a, b) => a.code - b.code);
  entries.forEach((e, i) => {
    out.writeUInt16LE(e.code, f.mapOff + i * 4);
    out.writeUInt16LE(e.glyph, f.mapOff + i * 4 + 2);
  });

  // re-encode only the DXT blocks (in every mip level) whose level-0 pixels changed
  const bw0 = Math.ceil(W / 4);
  const changed = new Uint8Array(bw0 * Math.ceil(H / 4));
  for (let i = 0; i < W * H; i++) {
    if (original.readUInt32LE(i * 4) !== level0.readUInt32LE(i * 4)) {
      changed[Math.floor(Math.floor(i / W) / 4) * bw0 + Math.floor((i % W) / 4)] = 1;
    }
  }
  const touchedAt = (level, bx, by) => {
    const s = 1 << level; // a block at this level covers s x s level-0 blocks
    for (let y = by * s; y < Math.min((by + 1) * s, H / 4); y++) {
      for (let x = bx * s; x < Math.min((bx + 1) * s, bw0); x++) if (changed[y * bw0 + x]) return true;
    }
    return false;
  };
  let img = level0;
  let w = W;
  let h = H;
  let off = f.dds + 128;
  for (let level = 0; level < f.mips; level++) {
    const bw = Math.max(1, Math.ceil(w / 4));
    const bh = Math.max(1, Math.ceil(h / 4));
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        if (touchedAt(level, bx, by)) dxt5.encodeBlock(img, w, h, bx, by).copy(out, off + (by * bw + bx) * 16);
      }
    }
    off += bw * bh * 16;
    if (w === 1 && h === 1) break;
    img = dxt5.downsample(img, w, h);
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return out;
}

module.exports = { parse, addGlyphs, HEBREW };
