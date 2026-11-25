// Builds the Hebrew files from the user's own install:
//   stuff/text/english.txt        English text with every translated line replaced
//   stuff/text/american.txt       the same for the few US-spelling override lines
//   stuff/text/trc.csv            save/load and "press a key" messages (ENGLISH/AMERICAN columns)
//   stuff/text/*credits.txt       end credits (headings and titles; people's names stay)
//   stuff/text/batman_font_pc.fnt the game font with Hebrew letters added
// and menu.cfg, the Hebrew menu strings the proxy DLL puts into LEGOBatman.exe's memory.
// Nothing from the game is stored in this repository; only translation/ (our own text).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const ttdat = require('./ttdat');
const font = require('./font');
const rtl = require('./rtl');
const exestrings = require('./exestrings');

const TEXT_FILE = 'stuff/text/english.txt';
const FONT_FILE = 'stuff/text/batman_font_pc.fnt';
const TRC_FILE = 'stuff/text/trc.csv';
const AMERICAN_FILE = 'stuff/text/american.txt';
const CREDITS_FILES = ['stuff/text/english_credits.txt', 'stuff/text/american_credits.txt', 'stuff/text/pc_english_credits.txt'];
const LINE = /^(﻿?)(\d+)(\s+pc)?(\s+)"([^"]*)"?(.*)$/;

/** Reads a text file in the game's format: `ID "text"` (optionally `ID pc "text"`). */
function parseStrings(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LINE);
    if (m) map.set(`${m[2]}${m[3] ? ' pc' : ''}`, m[5]);
  }
  return map;
}

/** Replaces translated lines in the original English file; everything else stays as is. */
function applyTranslation(englishText, hebrew, opts = {}) {
  let translated = 0;
  const lines = englishText.split('\r\n').map((line) => {
    const m = line.match(LINE);
    if (!m) return line;
    const he = hebrew.get(`${m[2]}${m[3] ? ' pc' : ''}`);
    if (he === undefined || he === '') return line;
    translated++;
    return `${m[1]}${m[2]}${m[3] || ''}${m[4]}"${rtl.toVisual(he, opts)}"${m[6]}`;
  });
  return { text: lines.join('\r\n'), translated };
}

/** Reads `"English" "Hebrew"` / `"English" =` lines (hebrew-credits.txt, hebrew-exe.txt). */
function parsePairs(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    let m = line.match(/^"((?:[^"]|"")*)"\s+"(.*)"\s*$/);
    if (m) map.set(m[1], m[2]);
    else if ((m = line.match(/^"((?:[^"]|"")*)"\s+=\s*$/))) map.set(m[1], m[1]);
  }
  return map;
}

const CREDIT_LINE = /^(\s*)(\w+_only\s+)?(heading|company|title|name|credit|thanks)(\s+)"([^"]*)"(.*)$/i;

/**
 * Credits files: `kind "text"` lines (kind = heading/company/title/name/credit/thanks, with an
 * optional english_only/pc_only/... prefix). Listed strings are replaced; people's names stay.
 */
function applyCreditsTranslation(text, pairs) {
  let translated = 0;
  const lines = text.split('\r\n').map((line) => {
    const m = line.match(CREDIT_LINE);
    if (!m || !pairs.has(m[5]) || pairs.get(m[5]) === m[5]) return line;
    translated++;
    // credits lines are never wrapped
    return `${m[1]}${m[2] || ''}${m[3]}${m[4]}"${rtl.toVisual(pairs.get(m[5]), { maxWidth: 1000 })}"${m[6]}`;
  });
  return { text: lines.join('\r\n'), translated };
}

/** Reads `LABEL "text"` lines (translation/hebrew-trc.txt). */
function parseLabels(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s+"(.*)"\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

// Splits one CSV line into raw fields (quotes kept), so untouched fields are written back as-is.
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      fields.push(cur);
      cur = '';
    } else cur += ch;
  }
  fields.push(cur);
  return fields;
}

/**
 * trc.csv (UTF-16, one row per message: LABEL, ENGLISH, FRENCH, ..., AMERICAN, ...): replaces
 * the ENGLISH and AMERICAN cells of every translated row; everything else is left as it was.
 */
function applyTrcTranslation(csvText, hebrew, opts = {}) {
  const lines = csvText.split('\r\n');
  const header = splitCsvLine(lines[0].replace(/^﻿/, '')).map((f) => f.replace(/"/g, ''));
  const cols = ['ENGLISH', 'AMERICAN'].map((c) => header.indexOf(c)).filter((i) => i > 0);
  let translated = 0;
  const out = lines.map((line, n) => {
    if (n === 0) return line;
    const fields = splitCsvLine(line);
    const label = (fields[0] || '').replace(/"/g, '');
    if (!hebrew.has(label)) return line;
    translated++;
    const cell = `"${rtl.toVisual(hebrew.get(label), opts).replace(/"/g, '""')}"`;
    for (const c of cols) if (c < fields.length) fields[c] = cell;
    return fields.join(',');
  });
  return { text: out.join('\r\n'), translated };
}

const FONT = path.join(__dirname, '..', '..', 'fonts', 'DavidLibre-Bold.ttf');

/** Renders the Hebrew letters from fonts/DavidLibre-Bold.ttf with GDI+ (see render-glyphs.ps1). */
function renderGlyphs() {
  const out = path.join(os.tmpdir(), `tirgumim-lego-batman-glyphs-${process.pid}.json`);
  try {
    execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'render-glyphs.ps1'),
      '-Out', out,
      '-FontFile', FONT,
      '-EmSize', '46',
      '-Baseline', '34',
    ], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    const list = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^﻿/, ''));
    return list.map((g) => {
      const px = Buffer.from(g.bgra, 'base64');
      for (let i = 0; i < px.length; i += 4) [px[i], px[i + 2]] = [px[i + 2], px[i]];
      return { code: g.code, w: g.w, h: g.h, rgba: px };
    });
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/**
 * datPath: a clean GAME.DAT. patchDir: games/lego-batman/translation.
 * Returns { files: [{ name, data }] ready for ttdat.patch, translated, total }.
 */
function buildPatch(datPath, patchDir, { render = renderGlyphs, maxWidth } = {}) {
  const opts = maxWidth ? { maxWidth } : {};
  const index = ttdat.readIndex(datPath);
  const english = ttdat.extract(datPath, TEXT_FILE, index).toString('utf8');
  const hebrew = parseStrings(fs.readFileSync(path.join(patchDir, 'hebrew.txt'), 'utf8'));
  const { text, translated } = applyTranslation(english, hebrew, opts);
  const files = [{ name: TEXT_FILE, data: Buffer.from(text, 'utf8') }];
  const used = new Set();
  for (const s of parseStrings(text).values()) for (const ch of s) used.add(ch.codePointAt(0));

  // american.txt holds a few US-spelling overrides of english.txt lines
  if (index.paths.has(AMERICAN_FILE)) {
    const us = applyTranslation(ttdat.extract(datPath, AMERICAN_FILE, index).toString('utf8'), hebrew, opts).text;
    files.push({ name: AMERICAN_FILE, data: Buffer.from(us, 'utf8') });
    for (const s of parseStrings(us).values()) for (const ch of s) used.add(ch.codePointAt(0));
  }

  const trcFile = path.join(patchDir, 'hebrew-trc.txt');
  if (fs.existsSync(trcFile) && index.paths.has(TRC_FILE)) {
    const trc = ttdat.extract(datPath, TRC_FILE, index).toString('utf16le');
    const out = applyTrcTranslation(trc, parseLabels(fs.readFileSync(trcFile, 'utf8')), opts);
    files.push({ name: TRC_FILE, data: Buffer.from(out.text, 'utf16le') });
    for (const ch of out.text) used.add(ch.codePointAt(0));
  }

  const creditsFile = path.join(patchDir, 'hebrew-credits.txt');
  if (fs.existsSync(creditsFile)) {
    const pairs = parsePairs(fs.readFileSync(creditsFile, 'utf8'));
    for (const name of CREDITS_FILES) {
      if (!index.paths.has(name)) continue;
      const out = applyCreditsTranslation(ttdat.extract(datPath, name, index).toString('utf8'), pairs).text;
      files.push({ name, data: Buffer.from(out, 'utf8') });
      for (const ch of out) used.add(ch.codePointAt(0));
    }
  }

  // Hebrew menu strings in the exe use the same font
  const exeFile = path.join(patchDir, 'hebrew-exe.txt');
  if (fs.existsSync(exeFile)) {
    for (const he of parsePairs(fs.readFileSync(exeFile, 'utf8')).values()) for (const ch of he) used.add(ch.codePointAt(0));
  }

  const fnt = font.addGlyphs(ttdat.extract(datPath, FONT_FILE, index), render(), used);
  files.push({ name: FONT_FILE, data: fnt });
  return { files, translated, total: parseStrings(english).size };
}

/** menu.cfg for the proxy DLL from translation/hebrew-exe.txt. exe: Buffer of LEGOBatman.exe. */
function buildMenuConfig(exe, patchDir) {
  const pairs = parsePairs(fs.readFileSync(path.join(patchDir, 'hebrew-exe.txt'), 'utf8'));
  const visual = new Map([...pairs].map(([en, he]) => [en, he === en ? en : rtl.toVisual(he, { maxWidth: 1000 })]));
  return exestrings.menuConfig(exe, visual);
}

module.exports = {
  buildPatch, buildMenuConfig, parseStrings, parseLabels, parsePairs, applyTranslation,
  applyTrcTranslation, applyCreditsTranslation, renderGlyphs, CREDIT_LINE,
  TEXT_FILE, FONT_FILE, TRC_FILE, AMERICAN_FILE, CREDITS_FILES,
};
