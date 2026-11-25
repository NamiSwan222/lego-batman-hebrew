// The game draws every string left-to-right, so Hebrew is stored in visual order: each line
// reversed, with Latin words and numbers kept left-to-right inside it. The game would also
// wrap long lines on its own (which puts the end of a reversed sentence on the first line),
// so long strings are wrapped here and joined with the game's line break code: a literal "\n".
//
// Game markup kept intact: [[cross]] / [SPECIAL] button tags, %i / %s / %.1f%% numbers,
// ~X ... ~~ colour spans (X = one colour character), \n line breaks.

const LINE_BREAK = '\\n';
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '<': '>', '>': '<', '{': '}', '}': '{' };
const HEBREW_CHAR = /[֐-׿]/;
const STRONG_LTR = /[A-Za-z0-9]/;

// Splits a string into tokens: { text, kind: 'R' | 'L' | 'N', width }.
// Colour spans become one token whose inside is already in visual order.
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = rest.match(/^~([^~])([\s\S]*?)~~/))) {
      const inner = visualLine(m[2]);
      out.push({ text: `~${m[1]}${inner}~~`, kind: HEBREW_CHAR.test(m[2]) ? 'R' : 'L', width: m[2].length });
      i += m[0].length;
    } else if ((m = rest.match(/^(\[\[[A-Za-z0-9_+]+\]\]|\[[A-Z0-9_]+\]|%[0-9.]*[a-z]|%%)/))) {
      out.push({ text: m[0], kind: 'L', width: 2 });
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z0-9]+/))) {
      out.push({ text: m[0], kind: 'L', width: m[0].length });
      i += m[0].length;
    } else {
      const ch = s[i];
      out.push({ text: ch, kind: HEBREW_CHAR.test(ch) ? 'R' : 'N', width: 1 });
      i += 1;
    }
  }
  return out;
}

/** One line of logical-order text -> visual order (right-to-left paragraph). */
function visualLine(s) {
  const toks = tokenize(s);
  // neutrals between two left-to-right tokens stay with them ("Mr. Freeze", "1 - 2");
  // every other neutral follows the right-to-left paragraph direction.
  const kinds = toks.map((t) => t.kind);
  for (let i = 0; i < toks.length; i++) {
    if (kinds[i] !== 'N') continue;
    let a = i - 1;
    while (a >= 0 && kinds[a] === 'N') a--;
    let b = i + 1;
    while (b < toks.length && toks[b].kind === 'N') b++;
    kinds[i] = a >= 0 && b < toks.length && kinds[a] === 'L' && toks[b].kind === 'L' ? 'L' : 'R';
  }
  const runs = [];
  toks.forEach((t, i) => {
    const last = runs[runs.length - 1];
    if (last && last.kind === kinds[i]) last.toks.push(t);
    else runs.push({ kind: kinds[i], toks: [t] });
  });
  return runs
    .reverse()
    .map((r) => {
      if (r.kind === 'L') return r.toks.map((t) => t.text).join('');
      return r.toks
        .slice()
        .reverse()
        .map((t) => (t.text.length === 1 ? MIRROR[t.text] || t.text : t.text))
        .join('');
    })
    .join('');
}

/** Greedy word wrap of logical text; widths ignore markup. */
function wrap(s, maxWidth) {
  const words = s.split(' ');
  const lines = [];
  let cur = [];
  let width = 0;
  for (const w of words) {
    const ww = tokenize(w).reduce((n, t) => n + t.width, 0);
    if (cur.length && width + 1 + ww > maxWidth) {
      lines.push(cur.join(' '));
      cur = [];
      width = 0;
    }
    width += (cur.length ? 1 : 0) + ww;
    cur.push(w);
  }
  if (cur.length) lines.push(cur.join(' '));
  return lines;
}

/**
 * Full string -> visual order. Strings longer than `maxWidth` characters are split into
 * balanced lines no longer than that.
 */
function toVisual(s, { maxWidth = 40 } = {}) {
  return s
    .split(LINE_BREAK)
    .map((para) => {
      const len = tokenize(para).reduce((n, t) => n + t.width, 0);
      if (len <= maxWidth) return visualLine(para);
      const count = Math.ceil(len / maxWidth);
      const target = Math.min(maxWidth, Math.ceil(len / count) + 6);
      return wrap(para, target).map(visualLine).join(LINE_BREAK);
    })
    .join(LINE_BREAK);
}

module.exports = { toVisual, visualLine, wrap, LINE_BREAK };
