@echo off
title PlayStation Cyber
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist node_modules\electron (
  echo Installing... please wait
  call npm install
)
start "" node_modules\electron\dist\electron.exe .
