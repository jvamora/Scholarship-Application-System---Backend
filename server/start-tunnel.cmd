@echo off
REM ============================================================
REM  EduGrant - localtunnel launcher (auto-restart + keep-alive)
REM  Exposes the Vite dev server (port 3000) at:
REM      https://smooth-impalas-stare.loca.lt
REM  Reuses the FIXED subdomain so existing invite links work.
REM
REM  HOW IT WORKS:
REM   - Auto-restarts the tunnel whenever it drops.
REM   - Launches a background keep-alive pinger that hits the
REM     public URL every 45s, preventing loca.lt's idle timeout.
REM
REM  IMPORTANT: Keep this window OPEN while the recipient needs
REM  to click the invite link.
REM ============================================================
title EduGrant tunnel (smooth-impalas-stare.loca.lt)

echo Starting tunnel: https://smooth-impalas-stare.loca.lt  -^>  localhost:3000
echo Keep this window open. Press Ctrl+C to stop the tunnel.
echo.

REM --- Launch keep-alive pinger in a minimized background window ---
start "" /min cmd /c "for /L %%i in (1,1,99999) do (curl.exe -s -o nul https://smooth-impalas-stare.loca.lt/ >nul 2>&1 ^& timeout /t 45 /nobreak >nul)"

REM --- Auto-restarting tunnel loop ---
:LOOP
echo [%time%] Starting localtunnel...
npx --yes localtunnel --port 3000 --subdomain smooth-impalas-stare
echo [!] Tunnel exited. Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto LOOP
