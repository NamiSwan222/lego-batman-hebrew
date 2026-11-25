//! Tirgumim proxy `XINPUT1_3.dll` for LEGO Batman: The Videogame (2008, Steam 21000, 32-bit).
//!
//! The game imports `XINPUT1_3.dll` (ordinals 2, 3, 4). Windows loads a DLL of that name from the game
//! folder before the system one (it is not a KnownDLL), so this file is loaded on every start, whoever
//! starts the game. All XInput calls are forwarded to the real system DLL.
//!
//! It does nothing else unless the Tirgumim launcher started the game (`-tirgumim-he` on the command
//! line, passed through `steam -applaunch 21000`, or `TIRGUMIM_LANG=he`). Then,
//! if `<game folder>\tirgumim\he\` holds the Hebrew data (or `%TIRGUMIM_DATA_DIR%`):
//!   * opening `GAME.DAT` (CreateFileA) opens `tirgumim\he\GAME.DAT` instead: the original archive
//!     with the Hebrew files appended (made by the launcher, the original is never changed);
//!   * reads from that file get the bytes listed in `GAME.DAT.overlay` laid over them: the archive
//!     index entries that point the game's text and font files at the appended Hebrew ones;
//!   * the English menu string table in the exe's memory (quit menu, PC video options) is pointed at
//!     the Hebrew strings in `menu.cfg`, after checking each slot still holds the expected pointer.
//! Any missing or unexpected file: it stays inert and the game runs in English.
#![allow(non_snake_case, clippy::missing_safety_doc)]

use core::ffi::c_void;
use core::ptr::null_mut;
use core::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

type Bool = i32;
type Handle = *mut c_void;

#[link(name = "kernel32")]
extern "system" {
    fn GetEnvironmentVariableA(name: *const u8, buf: *mut u8, size: u32) -> u32;
    fn GetModuleHandleA(name: *const u8) -> Handle;
    fn GetModuleFileNameA(module: Handle, buf: *mut u8, size: u32) -> u32;
    fn VirtualProtect(addr: *mut c_void, size: usize, new: u32, old: *mut u32) -> Bool;
    fn GetSystemDirectoryA(buf: *mut u8, size: u32) -> u32;
    fn LoadLibraryA(name: *const u8) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *mut c_void;
    fn SetFilePointerEx(h: Handle, dist: i64, new_pos: *mut i64, method: u32) -> Bool;
    fn GetCommandLineA() -> *const u8;
}

const INVALID_HANDLE: usize = usize::MAX;
const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;

struct State {
    dat_path: Vec<u8>,            // NUL-terminated path of the Hebrew GAME.DAT
    overlay: Vec<(u64, Vec<u8>)>, // (file offset, bytes)
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static HANDLES: Mutex<Vec<usize>> = Mutex::new(Vec::new());
static REAL_CREATEFILEA: AtomicUsize = AtomicUsize::new(0);
static REAL_READFILE: AtomicUsize = AtomicUsize::new(0);
static REAL_CLOSEHANDLE: AtomicUsize = AtomicUsize::new(0);

type CreateFileAFn = unsafe extern "system" fn(*const u8, u32, u32, *mut c_void, u32, u32, Handle) -> Handle;
type ReadFileFn = unsafe extern "system" fn(Handle, *mut u8, u32, *mut u32, *mut c_void) -> Bool;
type CloseHandleFn = unsafe extern "system" fn(Handle) -> Bool;

unsafe fn cstr<'a>(p: *const u8) -> &'a [u8] {
    let mut n = 0;
    while *p.add(n) != 0 {
        n += 1;
    }
    core::slice::from_raw_parts(p, n)
}

fn eq_ignore_case(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_ascii_lowercase() == y.to_ascii_lowercase())
}

fn is_game_dat(path: &[u8]) -> bool {
    let start = path.iter().rposition(|&c| c == b'\\' || c == b'/').map_or(0, |i| i + 1);
    eq_ignore_case(&path[start..], b"GAME.DAT")
}

unsafe extern "system" fn hook_createfilea(
    path: *const u8, access: u32, share: u32, sa: *mut c_void, disp: u32, flags: u32, tmpl: Handle,
) -> Handle {
    let real: CreateFileAFn = core::mem::transmute(REAL_CREATEFILEA.load(Ordering::Relaxed));
    if !path.is_null() && flags & FILE_FLAG_OVERLAPPED == 0 && is_game_dat(cstr(path)) {
        let target = STATE.lock().ok().and_then(|s| s.as_ref().map(|s| s.dat_path.clone()));
        if let Some(target) = target {
            let h = real(target.as_ptr(), access, share, sa, disp, flags, tmpl);
            if h as usize != INVALID_HANDLE && !h.is_null() {
                if let Ok(mut list) = HANDLES.lock() {
                    list.push(h as usize);
                }
                return h;
            }
        }
    }
    real(path, access, share, sa, disp, flags, tmpl)
}

unsafe extern "system" fn hook_readfile(h: Handle, buf: *mut u8, len: u32, read: *mut u32, ov: *mut c_void) -> Bool {
    let real: ReadFileFn = core::mem::transmute(REAL_READFILE.load(Ordering::Relaxed));
    let ours = HANDLES.lock().map(|l| l.contains(&(h as usize))).unwrap_or(false);
    if !ours {
        return real(h, buf, len, read, ov);
    }
    let pos: u64 = if ov.is_null() {
        let mut p = 0i64;
        if SetFilePointerEx(h, 0, &mut p, 1) == 0 {
            return real(h, buf, len, read, ov);
        }
        p as u64
    } else {
        // OVERLAPPED: Internal, InternalHigh, Offset, OffsetHigh
        let o = ov as *const u32;
        (*o.add(2) as u64) | ((*o.add(3) as u64) << 32)
    };
    let mut got = 0u32;
    let ok = real(h, buf, len, if read.is_null() { &mut got } else { read }, ov);
    let n = if read.is_null() { got } else { *read } as u64;
    if ok != 0 && n > 0 {
        if let Ok(state) = STATE.lock() {
            if let Some(s) = state.as_ref() {
                for (off, bytes) in &s.overlay {
                    let a = (*off).max(pos);
                    let b = (*off + bytes.len() as u64).min(pos + n);
                    if a < b {
                        core::ptr::copy_nonoverlapping(bytes.as_ptr().add((a - off) as usize), buf.add((a - pos) as usize), (b - a) as usize);
                    }
                }
            }
        }
    }
    ok
}

unsafe extern "system" fn hook_closehandle(h: Handle) -> Bool {
    if let Ok(mut list) = HANDLES.lock() {
        list.retain(|&x| x != h as usize);
    }
    let real: CloseHandleFn = core::mem::transmute(REAL_CLOSEHANDLE.load(Ordering::Relaxed));
    real(h)
}

/// Replace `func` imported from `dll` in the main executable's import table (PE32). Returns the old pointer.
unsafe fn patch_iat(dll: &[u8], func: &[u8], new: usize) -> usize {
    let base = GetModuleHandleA(core::ptr::null()) as *const u8;
    if base.is_null() {
        return 0;
    }
    let rd32 = |off: usize| core::ptr::read_unaligned(base.add(off) as *const u32) as usize;
    let nt = rd32(0x3c);
    if rd32(nt) != 0x4550 || core::ptr::read_unaligned(base.add(nt + 24) as *const u16) != 0x10b {
        return 0; // "PE\0\0", PE32 only
    }
    let imp = rd32(nt + 24 + 96 + 8); // DataDirectory[1].VirtualAddress
    if imp == 0 {
        return 0;
    }
    let mut d = imp;
    loop {
        let oft = rd32(d);
        let name = rd32(d + 12);
        let ft = rd32(d + 16);
        if name == 0 && ft == 0 {
            break;
        }
        if eq_ignore_case(cstr(base.add(name)), dll) {
            let lookup = if oft != 0 { oft } else { ft };
            let mut i = 0usize;
            loop {
                let ent = rd32(lookup + i * 4);
                if ent == 0 {
                    break;
                }
                if ent & 0x8000_0000 == 0 && cstr(base.add(ent + 2)) == func {
                    let slot = base.add(ft + i * 4) as *mut usize;
                    let mut old = 0u32;
                    if VirtualProtect(slot as *mut c_void, 4, 0x04, &mut old) == 0 {
                        return 0;
                    }
                    let prev = core::ptr::read(slot);
                    core::ptr::write(slot, new);
                    VirtualProtect(slot as *mut c_void, 4, old, &mut old);
                    return prev;
                }
                i += 1;
            }
        }
        d += 20;
    }
    0
}

fn parse_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// `GAME.DAT.overlay`: first line `TIRGUMIM-OVERLAY 1`, then `<decimal offset> <hex bytes>` lines.
fn load_overlay(text: &str) -> Option<Vec<(u64, Vec<u8>)>> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "TIRGUMIM-OVERLAY 1" {
        return None;
    }
    let mut out = Vec::new();
    for line in lines.filter(|l| !l.trim().is_empty()) {
        let (off, hex) = line.trim().split_once(' ')?;
        out.push((off.parse().ok()?, parse_hex(hex.trim())?));
    }
    Some(out)
}

/// `menu.cfg`: first line `TIRGUMIM-MENU 1`, then `<hex rva of pointer slot>\t<hex expected pointer>\t<text>`.
unsafe fn apply_menu(text: &str) {
    let base = GetModuleHandleA(core::ptr::null()) as usize;
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("TIRGUMIM-MENU 1") {
        return;
    }
    for line in lines {
        let mut parts = line.splitn(3, '\t');
        let (Some(rva), Some(expected), Some(s)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let (Ok(rva), Ok(expected)) = (usize::from_str_radix(rva, 16), usize::from_str_radix(expected, 16)) else { continue };
        let slot = (base + rva) as *mut usize;
        if core::ptr::read_unaligned(slot) != expected {
            continue; // not the exe this file was made for
        }
        let mut owned = s.as_bytes().to_vec();
        owned.push(0);
        let leaked: &'static mut [u8] = Box::leak(owned.into_boxed_slice());
        let mut old = 0u32;
        if VirtualProtect(slot as *mut c_void, 4, 0x04, &mut old) != 0 {
            core::ptr::write_unaligned(slot, leaked.as_ptr() as usize);
            VirtualProtect(slot as *mut c_void, 4, old, &mut old);
        }
    }
}

unsafe fn data_dir() -> Option<String> {
    let mut buf = [0u8; 1024];
    let n = GetEnvironmentVariableA(b"TIRGUMIM_DATA_DIR\0".as_ptr(), buf.as_mut_ptr(), buf.len() as u32) as usize;
    if n > 0 && n < buf.len() {
        return Some(String::from_utf8_lossy(&buf[..n]).trim_end_matches(['\\', '/']).to_string());
    }
    let n = GetModuleFileNameA(null_mut(), buf.as_mut_ptr(), buf.len() as u32) as usize;
    if n == 0 || n >= buf.len() {
        return None;
    }
    let exe = String::from_utf8_lossy(&buf[..n]).to_string();
    let dir = &exe[..exe.rfind(['\\', '/'])?];
    Some(format!("{dir}\\tirgumim\\he"))
}

/// Started by the Tirgumim launcher: `-tirgumim-he` on the command line (works through
/// `steam -applaunch`, so Steam keeps overlay, playtime and cloud saves) or `TIRGUMIM_LANG=he`.
unsafe fn started_for_hebrew() -> bool {
    let cmd = cstr(GetCommandLineA()).to_ascii_lowercase();
    if cmd.split(|&c| c == b' ' || c == b'\t' || c == b'"').any(|t| t == b"-tirgumim-he") {
        return true;
    }
    let mut lang = [0u8; 16];
    let n = GetEnvironmentVariableA(b"TIRGUMIM_LANG\0".as_ptr(), lang.as_mut_ptr(), lang.len() as u32) as usize;
    n > 0 && n < lang.len() && eq_ignore_case(&lang[..n], b"he")
}

unsafe fn activate() {
    if !started_for_hebrew() {
        return; // not started by the Tirgumim launcher: stay inert
    }
    let Some(dir) = data_dir() else { return };
    let dat = format!("{dir}\\GAME.DAT");
    let Ok(meta) = std::fs::metadata(&dat) else { return };
    if !meta.is_file() {
        return;
    }
    let Some(overlay) = std::fs::read_to_string(format!("{dir}\\GAME.DAT.overlay")).ok().and_then(|t| load_overlay(&t)) else { return };
    if let Ok(menu) = std::fs::read_to_string(format!("{dir}\\menu.cfg")) {
        apply_menu(&menu);
    }
    let mut dat_path = dat.into_bytes();
    dat_path.push(0);
    if let Ok(mut s) = STATE.lock() {
        *s = Some(State { dat_path, overlay });
    }
    for (func, hook, slot) in [
        (&b"CreateFileA"[..], hook_createfilea as *const () as usize, &REAL_CREATEFILEA),
        (&b"ReadFile"[..], hook_readfile as *const () as usize, &REAL_READFILE),
        (&b"CloseHandle"[..], hook_closehandle as *const () as usize, &REAL_CLOSEHANDLE),
    ] {
        // store the real pointer before swapping the slot (the game has not run yet)
        let real = GetProcAddress(GetModuleHandleA(b"kernel32.dll\0".as_ptr()), [func, b"\0"].concat().as_ptr()) as usize;
        slot.store(real, Ordering::Relaxed);
        let prev = patch_iat(b"KERNEL32.dll", func, hook);
        if prev != 0 {
            slot.store(prev, Ordering::Relaxed);
        }
    }
}

#[no_mangle]
pub unsafe extern "system" fn DllMain(_inst: Handle, reason: u32, _res: *mut c_void) -> Bool {
    if reason == 1 {
        activate();
    }
    1
}

// ---------- XInput forwarding ----------

static REAL_XINPUT: AtomicUsize = AtomicUsize::new(0);

unsafe fn real_fn(name: &[u8]) -> usize {
    let mut m = REAL_XINPUT.load(Ordering::Acquire);
    if m == 0 {
        let mut path = [0u8; 600];
        let n = GetSystemDirectoryA(path.as_mut_ptr(), 560) as usize;
        if n == 0 || n >= 560 {
            return 0;
        }
        let tail = b"\\xinput1_3.dll\0";
        path[n..n + tail.len()].copy_from_slice(tail);
        m = LoadLibraryA(path.as_ptr()) as usize;
        if m == 0 {
            return 0;
        }
        REAL_XINPUT.store(m, Ordering::Release);
    }
    GetProcAddress(m as Handle, name.as_ptr()) as usize
}

const NOT_CONNECTED: u32 = 1167;

macro_rules! forward {
    ($name:ident, ($($arg:ident: $ty:ty),*), $ret:ty, $fail:expr) => {
        #[no_mangle]
        pub unsafe extern "system" fn $name($($arg: $ty),*) -> $ret {
            let f = real_fn(concat!(stringify!($name), "\0").as_bytes());
            if f == 0 {
                return $fail;
            }
            let real: unsafe extern "system" fn($($ty),*) -> $ret = core::mem::transmute(f);
            real($($arg),*)
        }
    };
}

forward!(XInputGetState, (user: u32, state: *mut c_void), u32, NOT_CONNECTED);
forward!(XInputSetState, (user: u32, vibration: *mut c_void), u32, NOT_CONNECTED);
forward!(XInputGetCapabilities, (user: u32, flags: u32, caps: *mut c_void), u32, NOT_CONNECTED);
forward!(XInputEnable, (enable: i32), (), ());
forward!(XInputGetDSoundAudioDeviceGuids, (user: u32, render: *mut c_void, capture: *mut c_void), u32, NOT_CONNECTED);
forward!(XInputGetBatteryInformation, (user: u32, kind: u8, info: *mut c_void), u32, NOT_CONNECTED);
forward!(XInputGetKeystroke, (user: u32, reserved: u32, keystroke: *mut c_void), u32, NOT_CONNECTED);
