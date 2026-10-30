@echo off
rem Starts the ComfyUI backend for Video Studio on 127.0.0.1:8188.
rem Override the install folder with: set COMFY_HOME=<your ComfyUI_windows_portable folder>
if "%COMFY_HOME%"=="" (echo Set COMFY_HOME to your ComfyUI_windows_portable folder first & exit /b 1)
cd /d "%COMFY_HOME%"
"%COMFY_HOME%\python_embeded\python.exe" -s ComfyUI\main.py --windows-standalone-build --listen 127.0.0.1 --port 8188
