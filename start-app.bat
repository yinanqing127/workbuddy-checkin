@echo off
setlocal
cd /d "%~dp0"

rem Some toolchains export ELECTRON_RUN_AS_NODE=1 which makes Electron behave
rem like plain Node and crash with "app is undefined". Clear it.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE=1"

if exist "node_modules\electron\dist\electron.exe" goto RUN

echo Electron engine is missing. Repairing, please wait...
if exist "node_modules" goto REPAIR
echo Installing npm packages first...
call npm install --ignore-scripts
if errorlevel 1 goto FAIL

:REPAIR
call node scripts\setup-electron.js
if errorlevel 1 goto FAIL

:RUN
echo.
echo Starting WorkBuddy check-in app...
echo.
call npm start
echo.
echo App closed.
pause
goto :eof

:FAIL
echo.
echo Setup failed. Please check the messages above and try again.
pause
goto :eof
