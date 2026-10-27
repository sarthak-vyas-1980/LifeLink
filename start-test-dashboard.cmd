@echo off
rem Double-click to start the LifeLink test database, test API and live test dashboard.
cd /d "%~dp0lifelink-platform"
node scripts\presentation-tests.mjs
echo.
pause
