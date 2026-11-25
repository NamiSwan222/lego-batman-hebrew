@echo off
rem Builds the 32-bit proxy XINPUT1_3.dll (needs Rust with the i686-pc-windows-msvc target and the
rem Visual Studio 2022 Build Tools C++ workload). Output: work\files\XINPUT1_3.dll
setlocal
set VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat
if not exist "%VCVARS%" set VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat
call "%VCVARS%" x64_x86 >nul || exit /b 1
cd /d "%~dp0"
set CARGO_TARGET_DIR=%~dp0target
set RUSTFLAGS=-C link-arg=/DEF:%~dp0exports.def -C target-feature=+crt-static
cargo build --release --target i686-pc-windows-msvc || exit /b 1
if not exist "%~dp0..\..\work\files" mkdir "%~dp0..\..\work\files"
copy /y "%CARGO_TARGET_DIR%\i686-pc-windows-msvc\release\xinput1_3.dll" "%~dp0..\..\work\files\XINPUT1_3.dll" >nul
