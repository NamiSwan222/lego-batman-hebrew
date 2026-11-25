// Finds a Steam game's folder (registry SteamPath + libraryfolders.vdf + appmanifest).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function steamRoot() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (m) return path.normalize(m[1].trim());
  } catch {}
  return null;
}

function findSteamApp(appId) {
  const root = steamRoot();
  if (!root) return null;
  const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
  const libs = fs.existsSync(vdf)
    ? [...fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1].replace(/\\\\/g, '\\'))
    : [root];
  for (const lib of libs) {
    const manifest = path.join(lib, 'steamapps', `appmanifest_${appId}.acf`);
    if (!fs.existsSync(manifest)) continue;
    const m = fs.readFileSync(manifest, 'utf8').match(/"installdir"\s+"([^"]+)"/);
    const dir = m && path.join(lib, 'steamapps', 'common', m[1]);
    if (dir && fs.existsSync(dir)) return dir;
  }
  return null;
}

module.exports = { findSteamApp };
