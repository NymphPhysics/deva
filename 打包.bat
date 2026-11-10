@echo off
title Deva package
echo.
echo   Package Deva after it exits
echo   ===========================
echo.
echo   1. Quit Deva completely: right-click the tray icon - Quit
echo      (closing the window is not enough, it stays in the tray)
echo.
echo   2. This script then builds automatically and shows a popup when done.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\deva\repo\scripts\package-after-exit.ps1"
pause
