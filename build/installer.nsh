; crft Play installer hooks (electron-builder picks this file up from build/ by itself).
; The app was called PlayStation Cyber. appId is unchanged, so an existing install is found and updated in place, and its data
; (%APPDATA%\PlayStation Cyber\data, pinned in electron/main.js) is never touched. Only the shortcuts under the old name are left over.

!macro customInstall
  Delete "$DESKTOP\PlayStation Cyber.lnk"
  Delete "$SMPROGRAMS\PlayStation Cyber.lnk"
!macroend
