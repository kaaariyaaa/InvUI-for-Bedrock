@echo off
rem Install the locked-click-probe behavior pack into a Minecraft (UWP) world.
rem ASCII only: cmd.exe code pages and console fonts differ between machines.
rem Layout: %LOCALAPPDATA%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\minecraftWorlds
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "EXITCODE=0"
set "WORLDS=%LOCALAPPDATA%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\minecraftWorlds"
set "PACK=%~dp0behavior_pack"
set "PACK_NAME=locked_click_probe"

if not exist "%PACK%\manifest.json" (
  set "ERR=behavior_pack\manifest.json not found next to this script. Keep install-to-world.bat in the locked-click-probe folder."
  goto :fail
)
if not exist "%WORLDS%\" (
  set "ERR=Minecraft worlds folder not found: !WORLDS!"
  echo         Launch Minecraft Preview once, then run this script again.
  goto :fail
)

echo Minecraft worlds:
echo   !WORLDS!
echo.
set "COUNT=0"
for /d %%D in ("!WORLDS!\*") do (
  if exist "%%~fD\level.dat" (
    set /a COUNT+=1
    set "WORLD_!COUNT!=%%~fD"
    set "WNAME=(unnamed)"
    if exist "%%~fD\levelname.txt" (
      for /f "usebackq delims=" %%N in ("%%~fD\levelname.txt") do set "WNAME=%%N"
    )
    echo   [!COUNT!] %%~nxD  -  !WNAME!
  )
)
if "!COUNT!"=="0" (
  set "ERR=No worlds found. Create a disposable test world first."
  goto :fail
)

echo.
set "SEL="
set /p "SEL=Select world number (1-!COUNT!): "
if not defined SEL (
  set "ERR=No selection. Nothing was changed."
  goto :fail
)
echo !SEL!| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 (
  set "ERR=Not a number: !SEL!. Nothing was changed."
  goto :fail
)
if not defined WORLD_!SEL! (
  set "ERR=World number out of range: !SEL!. Nothing was changed."
  goto :fail
)
call set "WORLD=%%WORLD_!SEL!%%"
echo.
echo Selected: !WORLD!
echo.

rem Read pack_id and version from manifest.json instead of hardcoding them.
for /f "usebackq tokens=1,2" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = Get-Content -Raw -LiteralPath '%PACK%\manifest.json' ^| ConvertFrom-Json; Write-Output ($m.header.uuid + ' ' + ($m.header.version -join '.'))"`) do (
  set "PACK_UUID=%%A"
  set "PACK_VERSION=%%B"
)
if not defined PACK_UUID (
  set "ERR=Could not read header.uuid from behavior_pack\manifest.json."
  goto :fail
)
if not defined PACK_VERSION (
  set "ERR=Could not read header.version from behavior_pack\manifest.json."
  goto :fail
)
set "PACK_VERSION=!PACK_VERSION:.=,!"

set "DEST=!WORLD!\behavior_packs\!PACK_NAME!"
if not exist "!WORLD!\behavior_packs\" (
  mkdir "!WORLD!\behavior_packs"
  if errorlevel 1 (
    set "ERR=Could not create the behavior_packs folder in the selected world."
    goto :fail
  )
)
if exist "!DEST!\manifest.json" echo [INFO] Pack folder already exists; updating files (user files are not deleted).
xcopy "!PACK!" "!DEST!\" /E /I /Y /Q >nul
if errorlevel 1 (
  set "ERR=Copy failed. Close Minecraft and check that the world folder is writable."
  goto :fail
)
echo [OK] Copied behavior pack to: !DEST!

set "JSON=!WORLD!\world_behavior_packs.json"
echo [INFO] Registering the pack in world_behavior_packs.json...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $f = '!JSON!'; $u = '!PACK_UUID!'; $v = @(!PACK_VERSION!); if (Test-Path -LiteralPath $f) { $bak = $f + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss'); Copy-Item -LiteralPath $f -Destination $bak -Force; Write-Output ('[OK] Backup: ' + $bak); $list = @(Get-Content -Raw -LiteralPath $f | ConvertFrom-Json | Where-Object { $_ }) } else { $list = @() }; $hit = $null; foreach ($e in $list) { if ($e.pack_id -eq $u) { $hit = $e } }; if ($hit) { $hit.version = $v; $result = 'UPDATED' } else { $list += [pscustomobject]@{ pack_id = $u; version = $v }; $result = 'ADDED' }; $json = ConvertTo-Json -InputObject $list -Depth 5; if ($json -notmatch '^\s*\[') { $json = '[' + [Environment]::NewLine + $json + [Environment]::NewLine + ']' }; [IO.File]::WriteAllText($f, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false))); Write-Output ('[OK] world_behavior_packs.json: ' + $result)"
if errorlevel 1 (
  set "ERR=Could not update world_behavior_packs.json. The original file (if any) was backed up next to it and the pack folder copy is still in place."
  goto :fail
)

echo.
echo Done. Enable the pack in the world settings, then enable Beta APIs / Experimental API.
goto :done

:fail
echo.
echo [ERROR] !ERR!
set "EXITCODE=1"

:done
echo.
if /i not "%~1"=="--no-pause" pause
exit /b !EXITCODE!
