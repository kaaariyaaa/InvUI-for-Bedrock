@echo off
rem Install the manual test packs into the global Minecraft (UWP) pack folders.
rem No world selection and no JSON edits: this only copies folders. Enable the
rem packs afterwards in the world settings (Behavior Packs / Resource Packs).
rem ASCII only: cmd.exe code pages and console fonts differ between machines.
rem Not yet verified on a real device.
setlocal EnableExtensions EnableDelayedExpansion

set "EXITCODE=0"
set "HERE=%~dp0"
set "GLOBAL=%LOCALAPPDATA%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang"
set "BP_ROOT=%GLOBAL%\behavior_packs"
set "RP_ROOT=%GLOBAL%\resource_packs"

if not exist "%BP_ROOT%\" (
  set "ERR=Behavior pack folder not found: !BP_ROOT!"
  echo         Launch Minecraft once, then run this script again.
  goto :fail
)
if not exist "%RP_ROOT%\" (
  set "ERR=Resource pack folder not found: !RP_ROOT!"
  echo         Launch Minecraft once, then run this script again.
  goto :fail
)

rem Pack list: index:kind:source folder next to this script:destination folder.
set "PACKS=1:BP:probe:invui_probe 2:BP:locked-click-probe:locked_click_probe"
set "PACKS=!PACKS! 3:RP:chest-resource-pack:invui_chest_probe"
set "PACKS=!PACKS! 4:RP:data-driven-resource-pack:invui_data_driven_probe"
set "PACKS=!PACKS! 5:RP:button-send-resource-pack:invui_button_send_probe"
set "PACKS=!PACKS! 6:RP:edit-box-resource-pack:invui_edit_box_probe"
set "PACKS=!PACKS! 7:RP:protection-resource-pack:invui_protection_probe"

echo Available packs (global pack folders):
for %%P in (!PACKS!) do (
  for /f "tokens=1-4 delims=:" %%A in ("%%P") do (
    call :resolve %%B %%C %%D
    set "TAG="
    if exist "!DEST!" set "TAG= (installed)"
    echo   %%A  [%%B] %%C!TAG!
  )
)
echo.
echo Enter numbers separated by spaces (for example: 1 3 5), "all", or press Enter to cancel.
set "SEL="
set /p "SEL=Selection: "
if not defined SEL (
  echo Canceled. Nothing was changed.
  goto :done
)
if /i "!SEL!"=="all" (
  for /l %%I in (1,1,7) do set "FLAG_%%I=1"
  goto :validated
)
rem Only digits and spaces are allowed, so the token loop below is safe.
for /f "delims=0123456789 " %%A in ("!SEL!") do (
  set "ERR=Invalid selection: !SEL!. Use numbers 1-7 separated by spaces, or all. Nothing was changed."
  goto :fail
)
for %%A in (!SEL!) do (
  if %%A GTR 7 (
    set "ERR=Selection out of range: %%A (1-7). Nothing was changed."
    goto :fail
  )
  if %%A LSS 1 (
    set "ERR=Selection out of range: %%A (1-7). Nothing was changed."
    goto :fail
  )
  set "FLAG_%%A=1"
)

:validated
set "ANY=0"
set "RPSEL=0"
for /l %%I in (1,1,7) do (
  if "!FLAG_%%I!"=="1" set "ANY=1"
)
if "!ANY!"=="0" (
  set "ERR=Nothing selected. Nothing was changed."
  goto :fail
)
rem Validate every selected source folder before copying anything.
for %%P in (!PACKS!) do (
  for /f "tokens=1-4 delims=:" %%A in ("%%P") do (
    if "!FLAG_%%A!"=="1" (
      call :resolve %%B %%C %%D
      if not exist "!SRC!\manifest.json" (
        set "ERR=Pack folder not found (manifest.json missing): !SRC!"
        goto :fail
      )
      if /i "!KIND!"=="RP" set /a RPSEL+=1
    )
  )
)
if !RPSEL! GTR 1 echo [WARN] Multiple resource packs selected. Enable only one at a time.

for %%P in (!PACKS!) do (
  for /f "tokens=1-4 delims=:" %%A in ("%%P") do (
    if "!FLAG_%%A!"=="1" (
      call :resolve %%B %%C %%D
      if exist "!DEST!" echo [INFO] Updating !DEST! - files are overwritten.
      xcopy "!SRC!" "!DEST!\" /E /Y /Q >nul
      if errorlevel 1 (
        set "ERR=Copy failed: !SRC! to !DEST!. Close Minecraft and check that the folder is writable."
        goto :fail
      )
      echo [OK] !DEST!
    )
  )
)

echo.
echo Done. Enable the packs in World Settings - Behavior Packs / Resource Packs.
echo Resource packs conflict with each other. Enable one resource pack at a time.
goto :done

:resolve
rem Arguments: kind, source folder name, destination folder name.
set "KIND=%~1"
set "SRC=!HERE!%~2"
if /i "!KIND!"=="BP" set "SRC=!SRC!\behavior_pack"
if /i "!KIND!"=="BP" (set "ROOT=!BP_ROOT!") else (set "ROOT=!RP_ROOT!")
set "DEST=!ROOT!\%~3"
exit /b 0

:fail
echo.
echo [ERROR] !ERR!
set "EXITCODE=1"

:done
echo.
if /i not "%~1"=="--no-pause" pause
exit /b !EXITCODE!
