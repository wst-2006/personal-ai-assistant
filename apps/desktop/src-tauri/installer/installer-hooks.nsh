!macro StopPersonalAiRuntime
  ; Ask the app to exit first so it can stop its API and worker normally.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; A forcibly closed older release can leave its bundled Node processes alive.
  ; Extract the new GUI executable as a native cleanup helper. It matches the
  ; complete node.exe path and never invokes an external command shell.
  InitPluginsDir
  File /oname=$PLUGINSDIR\personal-ai-runtime-cleanup.exe "${MAINBINARYSRCPATH}"
  nsExec::ExecToStack '"$PLUGINSDIR\personal-ai-runtime-cleanup.exe" --cleanup-installed-runtime "$INSTDIR\runtime\node.exe"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    DetailPrint "Unable to stop the previous bundled runtime: $R1"
    MessageBox MB_ICONSTOP|MB_OK "无法关闭旧版个人 AI 助理的后台服务。请退出软件后重新运行安装程序。"
    Abort
  ${EndIf}

  ; The bundled runtime is fully replaceable. Removing it after all matching
  ; processes have stopped prevents stale API/Worker files from surviving an
  ; in-place upgrade. User configuration and backups live outside this folder.
  RMDir /r "$INSTDIR\runtime"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopPersonalAiRuntime
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopPersonalAiRuntime
!macroend
