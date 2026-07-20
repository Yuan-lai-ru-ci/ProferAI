@echo off
setlocal
cd /d D:\profer\Proma-main\apps\electron
start "Profer Vite" /b C:\Users\yuan\.bun\bin\bun.exe x vite dev > ..\..\.context\profer-dev-vite.log 2>&1
timeout /t 3 /nobreak > nul
C:\Users\yuan\.bun\bin\bun.exe run build:main > ..\..\.context\profer-dev-build.log 2>&1
if errorlevel 1 exit /b 1
C:\Users\yuan\.bun\bin\bun.exe run build:preload >> ..\..\.context\profer-dev-build.log 2>&1
if errorlevel 1 exit /b 1
C:\Users\yuan\.bun\bin\bun.exe run build:resources >> ..\..\.context\profer-dev-build.log 2>&1
if errorlevel 1 exit /b 1
start "Profer Electron Dev" /b D:\profer\Proma-main\node_modules\electron\dist\electron.exe . > ..\..\.context\profer-dev-electron.log 2>&1
