// Minimal DXT5 (BC3) decoder/encoder for the font atlas. The encoder only needs to be good
// enough for white glyphs with a dark outline on transparent background.

function unpack565(v) {
  return [(((v >> 11) & 31) * 255 / 31) | 0, (((v >> 5) & 63) * 255 / 63) | 0, ((v & 31) * 255 / 31) | 0];
}

function pack565(r, g, b) {
  return ((Math.round((r * 31) / 255) << 11) | (Math.round((g * 63) / 255) << 5) | Math.round((b * 31) / 255)) >>> 0;
}

function alphaPalette(a0, a1) {
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push((((7 - i) * a0 + i * a1) / 7) | 0);
  else {
    for (let i = 1; i < 5; i++) pal.push((((5 - i) * a0 + i * a1) / 5) | 0);
    pal.push(0, 255);
  }
  return pal;
}

function colorPalette(c0, c1) {
  const a = unpack565(c0);
  const b = unpack565(c1);
  return [a, b, a.map((x, i) => ((2 * x + b[i]) / 3) | 0), a.map((x, i) => ((x + 2 * b[i]) / 3) | 0)];
}

/** Decodes a w x h DXT5 surface starting at buf[off] into RGBA. */
function decode(buf, off, w, h) {
  const out = Buffer.alloc(w * h * 4);
  let p = off;
  for (let by = 0; by < Math.max(1, h / 4); by++) {
    for (let bx = 0; bx < Math.max(1, w / 4); bx++, p += 16) {
      const apal = alphaPalette(buf[p], buf[p + 1]);
      let abits = 0n;
      for (let i = 0; i < 6; i++) abits |= BigInt(buf[p + 2 + i]) << BigInt(8 * i);
      const cpal = colorPalette(buf.readUInt16LE(p + 8), buf.readUInt16LE(p + 10));
      const idx = buf.readUInt32LE(p + 12);
      for (let k = 0; k < 16; k++) {
        const x = bx * 4 + (k & 3);
        const y = by * 4 + (k >> 2);
        if (x >= w || y >= h) continue;
        const o = (y * w + x) * 4;
        const c = cpal[(idx >>> (2 * k)) & 3];
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = apal[Number((abits >> BigInt(3 * k)) & 7n)];
      }
    }
  }
  return out;
}

/** Encodes the 4x4 block at (bx,by) of an RGBA image into 16 bytes. */
function encodeBlock(rgba, w, h, bx, by) {
  const px = [];
  for (let k = 0; k < 16; k++) {
    const x = Math.min(w - 1, bx * 4 + (k & 3));
    const y = Math.min(h - 1, by * 4 + (k >> 2));
    const o = (y * w + x) * 4;
    px.push([rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]]);
  }
  const out = Buffer.alloc(16);
  // alpha: a0 > a1 gives 8 interpolated levels
  let amin = 255;
  let amax = 0;
  for (const p of px) {
    amin = Math.min(amin, p[3]);
    amax = Math.max(amax, p[3]);
  }
  let a0 = amax;
  let a1 = amin;
  if (a0 === a1) a1 = a0 > 0 ? a0 - 1 : 0;
  if (a0 === a1) a0 = 1;
  const apal = alphaPalette(a0, a1);
  out[0] = a0;
  out[1] = a1;
  let abits = 0n;
  px.forEach((p, k) => {
    let best = 0;
    for (let i = 1; i < 8; i++) if (Math.abs(apal[i] - p[3]) < Math.abs(apal[best] - p[3])) best = i;
    abits |= BigInt(best) << BigInt(3 * k);
  });
  for (let i = 0; i < 6; i++) out[2 + i] = Number((abits >> BigInt(8 * i)) & 0xffn);
  // colour: endpoints = brightest / darkest visible pixel (by luminance)
  const vis = px.filter((p) => p[3] > 8);
  const lum = (p) => p[0] * 3 + p[1] * 6 + p[2];
  const src = vis.length ? vis : px;
  let hi = src[0];
  let lo = src[0];
  for (const p of src) {
    if (lum(p) > lum(hi)) hi = p;
    if (lum(p) < lum(lo)) lo = p;
  }
  let c0 = pack565(hi[0], hi[1], hi[2]);
  let c1 = pack565(lo[0], lo[1], lo[2]);
  if (c0 < c1) [c0, c1] = [c1, c0];
  if (c0 === c1) {
    if (c0 > 0) c1 = c0 - 1;
    else c0 = 1;
  }
  const cpal = colorPalette(c0, c1);
  let idx = 0;
  px.forEach((p, k) => {
    let best = 0;
    let bd = Infinity;
    cpal.forEach((c, i) => {
      const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    idx |= best << (2 * k);
  });
  out.writeUInt16LE(c0, 8);
  out.writeUInt16LE(c1, 10);
  out.writeUInt32LE(idx >>> 0, 12);
  return out;
}

/** Box-filter downsample of an RGBA image by 2 (alpha-weighted colour). */
function downsample(rgba, w, h) {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(w - 1, x * 2 + dx);
          const sy = Math.min(h - 1, y * 2 + dy);
          const o = (sy * w + sx) * 4;
          const pa = rgba[o + 3];
          r += rgba[o] * pa;
          g += rgba[o + 1] * pa;
          b += rgba[o + 2] * pa;
          a += pa;
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

module.exports = { decode, encodeBlock, downsample };
