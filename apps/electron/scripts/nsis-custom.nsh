; ============================================================================
; Profer NSIS 自定义段
;
; 1) customCheckAppRunning / customUnInit：安装、卸载前把仍在运行的 Profer 关干净。
;    Profer 在 Windows 上点击关闭只隐藏到托盘（src/main/index.ts），
;    NSIS 默认只做「taskkill 不带 /F → 等 2s」，拿不到退出信号就走到
;    “Profer 无法关闭”，用户只能手动结束进程，甚至去删安装目录里的文件。
;    这里改为：先发 --quit 让应用走正常退出清理（会话落盘、远控/持久化收尾），
;    再 /F /T 强杀（含子进程），仍失败时用 UAC 提权再杀一次（应用以管理员
;    身份运行时非提权 taskkill 必然 Access denied），最后才提示用户手动处理。
;
; 2) customInstall：刷新 Windows Shell 图标缓存，覆盖安装后立刻显示新图标。
;
; 只用 NSIS 内置命令 + nsExec + LogicLib；任何一步失败都不会让安装停在
; 没有提示的状态。
; ============================================================================

!include "LogicLib.nsh"

; 探测 ${APP_EXECUTABLE_FILENAME} 是否有进程在跑，结果写入 $R8（"1"/"0"）。
; 用 tasklist 而不是 nsProcess 插件：不依赖额外插件目录，安装器与卸载器都能用。
; 注意：本宏不含标签，可在同一作用域内多次展开。
!macro PROFER_DETECT_APP_RUNNING
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH'
  Pop $0
  Pop $1
  StrLen $2 "${APP_EXECUTABLE_FILENAME}"
  StrCpy $3 $1 $2
  StrCpy $R8 "0"
  ${If} $3 == "${APP_EXECUTABLE_FILENAME}"
    StrCpy $R8 "1"
  ${EndIf}
!macroend

; 关闭仍在运行的 Profer。_tag 给标签加后缀：同一个脚本里可能插入多次
; （安装段 / 卸载初始化），而 NSIS 标签不能重名。
!macro PROFER_STOP_APP _tag
  ; 应用内更新（安装器带 --updated /S 启动）：应用已被要求退出，且自带 12s
  ; 强制退出兜底，先给 2s 让它把会话写完，避免刚起安装器就 /F。
  ${If} ${isUpdated}
    Sleep 2000
  ${EndIf}

  StrCpy $R7 "0"

  profer_close_check_${_tag}:
    !insertmacro PROFER_DETECT_APP_RUNNING
    ${If} $R8 == "0"
      Goto profer_close_done_${_tag}
    ${EndIf}

    ; 第 1 步：请求应用自己退出。--quit 走第二实例通道，主进程正常退出清理
    ; （会话落盘 + 远控/持久化收尾）。给足 12s，和主进程 quitAndInstall 的
    ; 强制退出预算一致，不要在写盘中途 /F。
    ; 0.16.22 及更早版本不识别该参数，最多只会把主窗口叫出来一次，随后由下一步兜底。
    ${If} $R7 == "0"
      DetailPrint `Closing running "${PRODUCT_NAME}"...`
      ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit'
      ${EndIf}
      StrCpy $R9 "0"
      profer_quit_wait_${_tag}:
        Sleep 1000
        !insertmacro PROFER_DETECT_APP_RUNNING
        ${If} $R8 == "0"
          Goto profer_close_done_${_tag}
        ${EndIf}
        IntOp $R9 $R9 + 1
        ${If} $R9 < 12
          Goto profer_quit_wait_${_tag}
        ${EndIf}
      StrCpy $R7 "1"
      Goto profer_close_check_${_tag}
    ${EndIf}

    ; 第 2 步：强制结束（/T 连子进程一起），再等句柄释放。
    ${If} $R7 == "1"
      DetailPrint `Stopping "${PRODUCT_NAME}"...`
      nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM ${APP_EXECUTABLE_FILENAME}'
      Pop $0
      Pop $1
      Sleep 3000
      StrCpy $R7 "2"
      Goto profer_close_check_${_tag}
    ${EndIf}

    ; 第 3 步：提权再杀一次。应用以管理员权限运行时，非提权 taskkill 会 Access denied。
    ; 静默安装（应用内更新）不弹 UAC：宁可让安装失败，也不能在无人值守时卡住。
    ${If} $R7 == "2"
      ${IfNot} ${Silent}
        ExecShell "runas" "$SYSDIR\taskkill.exe" "/F /T /IM ${APP_EXECUTABLE_FILENAME}" SW_HIDE
        Sleep 3000
      ${EndIf}
      StrCpy $R7 "3"
      Goto profer_close_check_${_tag}
    ${EndIf}

    ; 仍有进程：给出可执行的指引，而不是让用户去删文件。
    ${If} ${Silent}
      DetailPrint `${PRODUCT_NAME} 仍在运行，安装无法继续。`
      Abort
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "${PRODUCT_NAME} 仍在运行，安装无法继续。$\r$\n$\r$\n请在任务管理器中结束所有 ${APP_EXECUTABLE_FILENAME} 进程（若它以管理员权限运行，结束它也需要管理员权限），然后点击“重试”。" \
      IDRETRY profer_close_retry_${_tag}
    Abort

    profer_close_retry_${_tag}:
      StrCpy $R7 "1"
      Goto profer_close_check_${_tag}

  profer_close_done_${_tag}:
!macroend

!macro customCheckAppRunning
  !insertmacro PROFER_STOP_APP check
!macroend

; assisted 卸载在非静默模式下不会走 CHECK_APP_RUNNING；不先关掉进程就删不干净
; 安装目录，用户下次还得再卸一遍。这里在 un.onInit 里补上同样的关闭逻辑。
!macro customUnInit
  !insertmacro PROFER_STOP_APP uninit
!macroend

!macro customInstall
  ; 旧版本会把图标写成 $INSTDIR\resources\icon.ico 并注册为文件关联图标；
  ; 新版改用 exe 内嵌图标 + app-icon.ico。清掉遗留副本（被占用时删不掉也不影响安装）。
  Delete "$INSTDIR\resources\icon.ico"

  ; 刷新 Explorer/桌面图标缓存（Win8+ 为 ie4uinit -show）。
  ; 64 位与 32 位系统目录都试一次；缺失就静默跳过。
  IfFileExists "$WINDIR\System32\ie4uinit.exe" 0 +2
    ExecWait '"$WINDIR\System32\ie4uinit.exe" -show'
  IfFileExists "$WINDIR\SysWOW64\ie4uinit.exe" 0 +2
    ExecWait '"$WINDIR\SysWOW64\ie4uinit.exe" -show'

  ; 通知 Shell 系统资源已变化（兜底，失败不影响安装）。
  System::Call 'shell32.dll::SHChangeNotify(0x08000000, 0x0000, 0, 0)'
!macroend
