@echo off
setlocal DisableDelayedExpansion
node "%~dp0..\src\cli\team.js" %*
