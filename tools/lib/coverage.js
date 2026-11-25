// Lists every player-visible string of the user's install and whether translation/ translates it.
// Sources (everything the PC game can draw as text):
//   english.txt, american.txt      all lines
//   trc.csv                        GEN_* and PC_* rows (PS2_/360_/WII_/PS3_/PSP_ rows are
//                                  console-only and never shown on PC)
//   *credits.txt                   headings, titles, companies and sentence lines; people's
//                                  names stay as written (counted, not listed)
//   LEGOBatman.exe                 the English menu string table
// Not text (left as is): logo artwork, and key names such as "Enter"/"Space", which the game
// shows as printed on the keyboard.
const fs = require('fs');
const path = require('path');
const ttdat = require('./ttdat');
const build = require('./build');
const exestrings = require('./exestrings');

const SENTENCE = /\b(by|and|the|of|for|to|with|from|is|are|uses|copyright|thanks?|thank|family|music|written|original|my|friends|dear|always|you)\b|[.:!]$/i;

function section(name, items, translations, isKeptByRule = () => false) {
  const out = { name, total: 0, translated: 0, kept: 0, byRule: 0, missing: [] };
  for (const [key, text] of items) {
    out.total++;
    const he = translations.get(key);
    if (he !== undefined && he !== '') {
      if (he === key && he === text) out.kept++;
      else out.translated++;
    } else if (isKeptByRule(text)) out.byRule++;
    else out.missing.push(key === text ? text : `${key} "${text}"`);
  }
  return out;
}

/** installDir: folder with GAME.DAT and LEGOBatman.exe. */
function coverage(installDir, patchDir) {
  const dat = path.join(installDir, 'GAME.DAT');
  const index = ttdat.readIndex(dat);
  const read = (name) => ttdat.extract(dat, name, index);
  const he = build.parseStrings(fs.readFileSync(path.join(patchDir, 'hebrew.txt'), 'utf8'));
  const sections = [];

  for (const name of [build.TEXT_FILE, build.AMERICAN_FILE]) {
    if (!index.paths.has(name)) continue;
    sections.push(section(name, build.parseStrings(read(name).toString('utf8')), he));
  }

  if (index.paths.has(build.TRC_FILE)) {
    const labels = build.parseLabels(fs.readFileSync(path.join(patchDir, 'hebrew-trc.txt'), 'utf8'));
    const rows = new Map();
    for (const line of read(build.TRC_FILE).toString('utf16le').split('\r\n')) {
      const m = line.match(/^﻿?"((?:GEN|PC)_[A-Z0-9_]+)","((?:[^"]|"")*)"/);
      if (m) rows.set(m[1], m[2]);
    }
    sections.push(section(build.TRC_FILE, rows, labels));
  }

  const pairs = build.parsePairs(fs.readFileSync(path.join(patchDir, 'hebrew-credits.txt'), 'utf8'));
  const credits = new Map();
  for (const name of build.CREDITS_FILES) {
    if (!index.paths.has(name)) continue;
    for (const line of read(name).toString('utf8').split(/\r?\n/)) {
      const m = line.match(build.CREDIT_LINE);
      if (!m || m[5].trim() === '') continue;
      const kind = m[3].toLowerCase();
      // job titles, headings and companies always need an entry; name lines only if they are sentences
      credits.set(m[5], ['heading', 'title', 'company'].includes(kind) ? 'label' : 'name');
    }
  }
  sections.push(section('credits', [...credits].map(([text, kind]) => [text, text]), pairs,
    (text) => credits.get(text) === 'name' && !SENTENCE.test(text)));

  const exePath = path.join(installDir, 'LEGOBatman.exe');
  if (fs.existsSync(exePath)) {
    const exeMap = build.parsePairs(fs.readFileSync(path.join(patchDir, 'hebrew-exe.txt'), 'utf8'));
    const strings = exestrings.englishStrings(fs.readFileSync(exePath)).map((s) => [s.text, s.text]);
    sections.push(section('LEGOBatman.exe menu strings', strings, exeMap));
  }

  const missing = sections.reduce((n, s) => n + s.missing.length, 0);
  return { sections, missing, complete: missing === 0 };
}

function report(result) {
  const lines = [];
  for (const s of result.sections) {
    const extra = [s.kept && `${s.kept} kept on purpose`, s.byRule && `${s.byRule} names kept`].filter(Boolean).join(', ');
    lines.push(`${s.missing.length ? 'MISSING' : 'ok     '} ${s.name}: ${s.translated + s.kept + s.byRule}/${s.total}${extra ? ` (${extra})` : ''}`);
    for (const m of s.missing) lines.push(`          - ${m}`);
  }
  lines.push(result.complete ? 'Coverage: 100%' : `Coverage: ${result.missing} string(s) untranslated`);
  return lines.join('\n');
}

module.exports = { coverage, report };
