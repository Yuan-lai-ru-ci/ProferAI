@echo off
setlocal
set "PATH=C:\Windows\System32;C:\Windows;C:\Users\yuan\.bun\bin;C:\Program Files\nodejs;D:\profer\Proma-main\node_modules\.bin;%PATH%"
set "ComSpec=C:\Windows\System32\cmd.exe"
cd /d D:\profer\Proma-main
C:\Users\yuan\.bun\bin\bun.exe run dev > .context\profer-dev-knowledge-selection.log 2> .context\profer-dev-knowledge-selection-error.log
