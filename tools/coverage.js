// Coverage check: lists every player-visible string the translation does not cover.
// Usage: node tools/coverage.js [path to the LEGO Batman folder]   (default: the Steam install)
// Exit code 1 when something is untranslated.
const path = require('path');
const { coverage, report } = require('./lib/coverage');
const { findSteamApp } = require('./lib/steam');

const installDir = process.argv[2] || findSteamApp(21000);
if (!installDir) {
  console.error('LEGO Batman not found; pass its folder: node tools/coverage.js "D:\\Games\\LEGO Batman"');
  process.exit(2);
}
const result = coverage(installDir, path.join(__dirname, '..', 'translation'));
console.log(report(result));
process.exit(result.complete ? 0 : 1);
