@echo off
cd /d "%~dp0"
if errorlevel 1 goto NODIR

echo Running check-in logic tests. 6 cases total...
call npm run test:logic
pause
goto :eof

:NODIR
echo Failed to change to the project directory.
pause
goto :eof
