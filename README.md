# LEGO Batman: The Videogame (2008), Hebrew

**Status: translation complete (coverage 100%), published.** Repo
[NamiSwan222/lego-batman-hebrew](https://github.com/NamiSwan222/lego-batman-hebrew) (topic `tirgumim-pack`),
release `lego-batman-0.1.0` with `lego-batman-he-0.1.0.zip`. Tested on the Steam version.

A Tirgumim launch-only pack: started from the launcher ("שחק בעברית"), the game is in Hebrew.
Started from Steam or anywhere else, it is the original English game. **No game file is ever
changed**, not even during play, so a crash can't leave the game in Hebrew.

## What is translated

| source | strings | notes |
|---|---|---|
| `stuff/text/english.txt` (+ `american.txt`) | 651 (+7) | menus, HUD, hints, level and character names, loading-screen bios and quotes, extras |
| `stuff/text/trc.csv` | 55 | save/load messages and "press a key" prompts (the GEN_ and PC_ rows; console-only rows are never shown on PC) |
| end credits (`*credits.txt`) | 454 | headings and job titles translated; people's names, company names and licence notices kept (see glossary.md) |
| `LEGOBatman.exe` menu table | 40 | quit menu and the PC video/effects options, which are built into the exe |

`node tools/coverage.js` lists anything not covered. Today it prints `Coverage: 100%`. The game
has no voiced dialogue or subtitles: cutscenes are mime. Still English on purpose: key names
("Enter", "Esc"), the logo artwork, and brand names.

## How it works

The game keeps its text and font inside `GAME.DAT` (a TT Games archive) and ignores loose files.
Some menu strings are compiled into the exe. So the pack is an `args` pack with a proxy DLL,
like the Yu-Gi-Oh pack:

- **`XINPUT1_3.dll`** (our proxy, `tools/proxy/`, Rust, 32-bit). The game imports XInput 1.3,
  so Windows loads this copy from the game folder on every start. It always forwards XInput to the
  real system DLL. It does nothing else unless the game was started with `-tirgumim-he` on the
  command line (or `TIRGUMIM_LANG=he`). The launcher passes that argument through
  `steam -applaunch 21000`, so Steam keeps the overlay, playtime and cloud saves.
- **`tirgumim\he\GAME.DAT`** is made by the launcher on install: the original `GAME.DAT`
  followed by our appended data (`append` patch with `output`; the original is only read). The
  appended data holds the Hebrew `english.txt`, `american.txt`, `trc.csv`, three credits files
  and the font with Hebrew letters, about 612 KB.
- **`tirgumim\he\GAME.DAT.overlay`**: the archive index entries (16 bytes each) that point
  those files at the appended copies. When active, the proxy opens the Hebrew copy instead of
  `GAME.DAT` and lays these bytes over what the game reads.
- **`tirgumim\he\menu.cfg`**: for each slot of the exe's English menu-string tables, the
  slot's address, the pointer it must hold (a different exe build is left alone) and the
  Hebrew string. The proxy repoints those slots in memory at startup.

If any Hebrew file is missing or doesn't match, the proxy stays inert and the game runs in English.

### Formats (worked out from the game's files)

- `GAME.DAT` index (version -2): documented at the top of `tools/lib/ttdat.js`. The text and
  font files are stored uncompressed.
- Font `batman_font_pc.fnt`: glyph records `(x, y, width)`, a sorted `(codepoint, glyph)` map,
  and a 512x512 DXT5 atlas with mips (`tools/lib/font.js`). Accented Latin letters the text no
  longer uses give their slots and atlas space to the 27 Hebrew letters. HUD icons mapped onto
  symbols (`± § ¤ £ «`) are never touched. The letters are rendered from **David Libre Bold**
  (SIL OFL, `fonts/`) with the game's white-fill, dark-outline style
  (`tools/lib/render-glyphs.ps1`).
- Right-to-left (`tools/lib/rtl.js`): the game draws left to right, so lines are stored in
  visual order. Latin, numbers, `[BUTTON]` tags, `%i` and `~2…~~` colour codes stay readable.
  Long strings are pre-wrapped with the game's line break, a literal `\n`, which was found by
  testing in game.
- Exe menu tables (`tools/lib/exestrings.js`): seven language tables of `{id, ptr}`. The two
  English ones are found from the "Quit to Windows" string.

## Layout

| path | what |
|---|---|
| `translation/hebrew.txt` | `english.txt` lines (`ID "text"`, logical Hebrew) |
| `translation/hebrew-trc.txt` | `trc.csv` rows (`LABEL "text"`) |
| `translation/hebrew-credits.txt` | credits (`"English" "Hebrew"`, `=` = keep as is) |
| `translation/hebrew-exe.txt` | exe menu strings (`"English" "Hebrew"`) |
| `glossary.md` | fixed terms, names, what stays English and why |
| `fonts/` | David Libre Bold + its OFL licence |
| `tools/build-pack.js` | builds `work/` from a clean install (refuses below 100% coverage) |
| `tools/coverage.js` | coverage report |
| `tools/proxy/` | the proxy DLL (`build.cmd`) |
| `pack/pack.config.json`, `pack/catalog-entry.json` | make-pack config, launcher catalog entry |
| `test.js` | `node --test games/lego-batman/` |

## Building the pack

Needs Node, Rust with `rustup target add i686-pc-windows-msvc`, and the Visual Studio 2022
Build Tools (C++). `tools/proxy/.cargo/config.toml` names this PC's MSVC linker and library folders
(rustc doesn't detect this Build Tools install by itself), so `cargo build` / `cargo test` also work
from Git Bash. On another PC, update the version folders in it.

```powershell
node games/lego-batman/tools/build-pack.js --game-dir "D:\SteamLibrary\steamapps\common\Lego Batman"
```

Then, in `launcher/` (from `cmd` or PowerShell, not Git Bash, whose `link` hides MSVC's):

```powershell
npm run make-pack -- D:\AIStuff\Tirgumim\games\lego-batman\pack\pack.config.json --game-dir "D:\SteamLibrary\steamapps\common\Lego Batman" --out D:\AIStuff\Tirgumim\games\lego-batman\out\lego-batman-he-0.1.0.zip
```

`work/` and `out/` are built from the game's files and are git-ignored. Never commit them.

## Tested (Steam version, 2026-11-25)

The `0.1.0` zip from make-pack was installed by hand, doing what the launcher does for an args
pack: added its 3 files, and made `tirgumim\he\GAME.DAT` from the append. That file's hash
matched the manifest's `toSha256`.
- `steam -applaunch 21000 -tirgumim-he`: the input-device prompt, main menu (including the
  exe's "Quit to Windows"), Options and Video Settings are all Hebrew, right-to-left. An earlier
  build also showed the hint/bio text and loading screens in Hebrew.
- Plain Steam start **with the pack still installed**: original English.
- `GAME.DAT` and `LEGOBatman.exe` kept their SHA-256 and modified time throughout. The test
  files were removed afterwards.
- Not yet done: installing through the real launcher (pending; GitHub's anonymous API limit was
  used up on this PC right after the release was published).

## Known limits

- The pack needs about 776 MB of free disk for `tirgumim\he\GAME.DAT` (a copy plus 612 KB).
- The translation was written by Claude (AI) and has not been proofread by a native speaker yet.
- Line wrapping is a 40-character estimate. A string in an unusually narrow box could wrap
  again in game. Adjust `maxWidth` in `tools/lib/rtl.js`.
- The typewriter effect on loading screens reveals each Hebrew line from its left end (cosmetic).
- Only the Steam exe was tested. Another build of the exe (disc/GOG) would get the text and font,
  but `menu.cfg`'s pointer checks would skip the exe menu strings.
