@echo off
rem One-line installer for the dsh-guard plugin (Windows cmd.exe).
rem
rem   scripts\install.cmd                       install or update in the desktop profile
rem   scripts\install.cmd -Status               read-only report
rem   scripts\install.cmd -Uninstall            remove entry + copied files
rem   scripts\install.cmd -DryRun               show what would be written
rem
rem Any further dsh-guard arguments are passed straight through (see scripts\install.ps1 -?).
rem Run this from OUTSIDE dsh: the profile directory is outside a dsh session's file sandbox.

setlocal
set "SCRIPT=%~dp0install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
