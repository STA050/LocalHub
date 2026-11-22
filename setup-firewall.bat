@echo off
title LocalHub Firewall Setup

net session >nul 2>nul
if errorlevel 1 goto needadmin
goto doadd

:needadmin
echo Admin rights required - a UAC prompt will appear, click "Yes".
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:doadd
echo Adding firewall allow-rule for TCP port 5217 ...
netsh advfirewall firewall add rule name="LocalHub 5217" dir=in action=allow protocol=TCP localport=5217 profile=any >nul 2>nul
if errorlevel 1 goto fail
echo.
echo  [OK] TCP 5217 is now allowed (all network profiles).
echo  Phones can now open:  http://LAN-IP:5217
echo  (the LAN IP is shown in the web UI, top-right QR dialog)
echo.
pause
exit /b 0

:fail
echo  [FAIL] Could not add the rule. Did you click "Yes" on the UAC prompt?
echo.
pause
exit /b 1
