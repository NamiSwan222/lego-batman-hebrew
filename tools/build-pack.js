// Builds everything the pack needs from a clean LEGO Batman install, into work/:
//   work/GAME.DAT.append                     appended to a copy of GAME.DAT by the launcher
//                                            (tirgumim\he\GAME.DAT = original + this)
//   work/files/tirgumim/he/GAME.DAT.overlay  index bytes the proxy lays over that copy
//   work/files/tirgumim/he/menu.cfg          Hebrew exe menu strings for the proxy
//   work/files/XINPUT1_3.dll                 the proxy (tools/proxy/build.cmd)
// Then: npm run make-pack -- <this folder>\pack\pack.config.json --game-dir "<install>" --out out\...
// (in the launcher repo).
//
// Usage: node tools/build-pack.js --game-dir "D:\SteamLibrary\steamapps\common\Lego Batman"
//        [--allow-incomplete]  (otherwise refuses unless coverage is 100%)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ttdat = require('./lib/ttdat');
const build = require('./lib/build');
const { coverage, report } = require('./lib/coverage');

const ROOT = path.join(__dirname, '..');
const TRANSLATION = path.join(ROOT, 'translation');
const WORK = path.join(ROOT, 'work');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const gameDir = arg('--game-dir');
  if (!gameDir) throw new Error('usage: node tools/build-pack.js --game-dir "<LEGO Batman folder>"');
  const dat = path.join(gameDir, 'GAME.DAT');
  const exe = path.join(gameDir, 'LEGOBatman.exe');
  for (const f of [dat, exe]) if (!fs.existsSync(f)) throw new Error(`${f} not found`);

  const cov = coverage(gameDir, TRANSLATION);
  console.log(report(cov));
  if (!cov.complete && !process.argv.includes('--allow-incomplete')) {
    throw new Error('translation is not complete; fix the strings above or pass --allow-incomplete');
  }

  const { files, translated, total } = build.buildPatch(dat, TRANSLATION);
  const { append, overlay } = ttdat.planAppend(dat, files);
  const menu = build.buildMenuConfig(fs.readFileSync(exe), TRANSLATION);
  if (menu.missing.length) console.warn(`menu strings without Hebrew: ${menu.missing.join(' | ')}`);

  const he = path.join(WORK, 'files', 'tirgumim', 'he');
  fs.mkdirSync(he, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'GAME.DAT.append'), append);
  fs.writeFileSync(path.join(he, 'GAME.DAT.overlay'), ttdat.overlayText(overlay));
  fs.writeFileSync(path.join(he, 'menu.cfg'), menu.text);

  if (!process.argv.includes('--skip-proxy')) {
    execFileSync('cmd', ['/c', path.join(__dirname, 'proxy', 'build.cmd')], { stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(WORK, 'files', 'XINPUT1_3.dll'))) throw new Error('work/files/XINPUT1_3.dll missing (tools/proxy/build.cmd)');

  console.log(`\n${translated}/${total} text lines, ${files.length} archive files (${(append.length / 1024).toFixed(0)} KB appended), ${menu.text.split('\n').length - 2} menu slots.`);
  console.log(`Next, in launcher/: npm run make-pack -- "${path.join(ROOT, 'pack', 'pack.config.json')}" --game-dir "${gameDir}" --out "${path.join(ROOT, 'out', 'lego-batman-he-<version>.zip')}"`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
