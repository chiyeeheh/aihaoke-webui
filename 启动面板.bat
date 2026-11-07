@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 haoke 作业面板...
start "" http://127.0.0.1:8420
node server.mjs
