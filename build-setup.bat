@echo off
rem ============================================================
rem  WorkBuddy Checkin - Windows installer builder
rem  Pure ASCII on purpose: avoid any codepage issues.
rem  Double-click to build dist\WorkBuddyCheckin-Setup-%version%.exe
rem ============================================================
setlocal
cd /d "%~dp0"

rem Keep Electron from degrading into plain Node
set "ELECTRON_RUN_AS_NODE="

rem China mirrors. electron-builder pulls NSIS helpers from GitHub by default,
rem which is unreachable/slow in most CN networks -> use npmmirror instead.
rem NOTE: the correct variable name is ELECTRON_BUILDER_BINARIES_MIRROR
rem (ELECTRON_BUILDER_BINARIES_DOWNLOAD_MIRROR is wrong and silently ignored).
set ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
set ELECTRON_BUILDER_BINARIES_DOWNLOAD_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
set ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/

echo [1/4] Generating icons...
call node scripts\make-icon.js
if errorlevel 1 goto FAIL
call node scripts\make-winicon.js
if errorlevel 1 goto FAIL

echo [2/4] Checking electron engine...
if not exist "node_modules\electron\dist\electron.exe" goto ENGINEMISSING

echo [3/4] Checking electron-builder...
if exist "node_modules\electron-builder\out\cli\cli.js" goto BUILD
echo electron-builder is missing. Installing from npmmirror, please wait...
call npm install --ignore-scripts
if errorlevel 1 goto FAIL

:BUILD
echo [4/4] Building installer for Windows x64...
call node node_modules\electron-builder\out\cli\cli.js --win --x64
if errorlevel 1 goto FAIL

echo.
echo BUILD DONE. Output folder: dist
echo.
dir /b dist\*.exe 2>nul
echo.
pause
goto END

:ENGINEMISSING
echo Electron engine is missing. Running setup script, please wait...
call node scripts\setup-electron.js
if errorlevel 1 goto FAIL
echo Engine ready. Please run this bat again.
pause
goto END

:FAIL
echo.
echo BUILD FAILED. Scroll up for the error message.
pause
goto END

:END
endlocal
