; ============================================================================
; Profer NSIS customInstall hook
; Refresh the Windows Shell icon cache after an (upgrade/re)install so the new
; Profer.exe icon takes effect immediately.
;
; Why: Electron 43 relies on after-pack to patch the exe icon manually. When
; installing over the same path, the Shell icon cache (iconcache_*.db) and any
; existing shortcuts may still show the old (electron default) icon. We rebuild
; shortcuts via electron-builder's addDesktopLink/addStartMenuLink before this
; macro runs, then refresh the cache so the new icon is visible at once.
;
; Safety: only NSIS built-in commands (IfFileExists / ExecWait / System::Call).
; All failures are ignored and never block a successful install.
; ============================================================================

!macro customInstall
  ; Refresh the Explorer/desktop icon cache (ie4uinit -show on Win8+).
  ; Try both 64-bit and 32-bit system dirs; skip silently when absent.
  IfFileExists "$WINDIR\System32\ie4uinit.exe" 0 +2
    ExecWait '"$WINDIR\System32\ie4uinit.exe" -show'
  IfFileExists "$WINDIR\SysWOW64\ie4uinit.exe" 0 +2
    ExecWait '"$WINDIR\SysWOW64\ie4uinit.exe" -show'

  ; Notify the shell that a system-level resource changed (best-effort fallback).
  System::Call 'shell32.dll::SHChangeNotify(0x08000000, 0x0000, 0, 0)'
!macroend
