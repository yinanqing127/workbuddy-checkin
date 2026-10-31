; 卸载时清理由 Electron setLoginItemSettings 写入的开机自启项。
; 背景：Electron 会把登录项写在 HKCU\...\Run 下，名称形如 "electron.app.<产品名>"。
; 卸载程序默认不会清它，卸载后会残留一个指向已删除 exe 的启动项（每次开机尝试启动失败）。
; 这里用 ASCII 前缀 "electron.app.WorkBuddy" 做匹配，避免在 .nsh 里写入中文导致编码问题。
!macro customUnInstall
  DetailPrint "正在清理开机自启动项..."
  StrCpy $0 0
  wb_run_scan:
    EnumRegValue $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $0
    StrCmp $1 "" wb_run_done
    StrCpy $2 "$1" 22
    StrCmp $2 "electron.app.WorkBuddy" wb_run_delete
    IntOp $0 $0 + 1
    Goto wb_run_scan
  wb_run_delete:
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$1"
    StrCpy $0 0
    Goto wb_run_scan
  wb_run_done:
!macroend

; 安装时同样清一次：覆盖安装旧版本时，可能残留指向旧路径/旧.exe名的启动项
!macro customInstall
  DetailPrint "正在重置开机自启动项..."
  StrCpy $0 0
  wb_run_scan_install:
    EnumRegValue $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $0
    StrCmp $1 "" wb_run_done_install
    StrCpy $2 "$1" 22
    StrCmp $2 "electron.app.WorkBuddy" wb_run_delete_install
    IntOp $0 $0 + 1
    Goto wb_run_scan_install
  wb_run_delete_install:
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$1"
    StrCpy $0 0
    Goto wb_run_scan_install
  wb_run_done_install:
!macroend
