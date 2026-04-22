@echo off
:: Creates a desktop shortcut for WardoFlix
set SCRIPT_DIR=%~dp0
set SHORTCUT=%USERPROFILE%\Desktop\WardoFlix.lnk

powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = '%SCRIPT_DIR%WardoFlix.bat'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.Description = 'WardoFlix - Premium Streaming'; $s.Save()"

if exist "%SHORTCUT%" (
    echo Shortcut created on your Desktop!
) else (
    echo Failed to create shortcut.
)
pause
