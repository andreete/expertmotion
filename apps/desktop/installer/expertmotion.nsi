; Expertmotion installer (DEPLOYMENT_AND_PACKAGING.md §5). Built from the electron-builder `win-unpacked` folder with
; makensis, which also runs on Linux (scripts/build-installer.sh), so no wine is needed.
; Per-user install: no administrator rights, files in %LOCALAPPDATA%\Programs\Expertmotion, projects in %APPDATA%\Expertmotion.
; Defines passed by scripts/build-installer.sh: VERSION, SRC_DIR, OUT_FILE, ICON.
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 32
RequestExecutionLevel user
ManifestDPIAware true

!define APP_NAME "Expertmotion"
!define APP_EXE "Expertmotion.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.expertmotion.desktop"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
BrandingText "${APP_NAME} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Expertmotion"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Indonesian"

Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

; Close a running copy first so its files can be replaced (updates, reinstall).
!macro CloseApp
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /T'
  Sleep 1500
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /T /F'
!macroend

Section "Install"
  !insertmacro CloseApp
  SetOutPath "$INSTDIR"
  ; Replace the previous version's program files (projects live in %APPDATA% and are untouched).
  RMDir /r "$INSTDIR\resources"
  File /r "${SRC_DIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall ${APP_NAME}.exe"

  CreateShortCut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall ${APP_NAME}.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall ${APP_NAME}.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

LangString KeepData ${LANG_ENGLISH} "Also delete your Expertmotion projects, media copies, settings and licence from this computer?$\r$\n$\r$\nChoose No to keep them (recommended if you will reinstall)."
LangString KeepData ${LANG_INDONESIAN} "Hapus juga proyek, salinan media, pengaturan dan lisensi Expertmotion dari komputer ini?$\r$\n$\r$\nPilih Tidak untuk menyimpannya (disarankan kalau kamu akan memasang ulang)."

Section "Uninstall"
  !insertmacro CloseApp
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(KeepData)" IDNO keep
    RMDir /r "$APPDATA\${APP_NAME}"
    keep:
  ${EndIf}
SectionEnd

Function un.onInit
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd
