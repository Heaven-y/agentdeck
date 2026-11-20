# 自定义范围与目录页；文件替换、数据和快捷方式仍使用 electron-builder 原生流程。
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    # 显式指定安装范围时交给上游处理；两种范围都有安装时仍保留选择。
    ${IfNot} ${isForAllUsers}
    ${AndIfNot} ${isForCurrentUser}
      ${If} $perUserInstallationFolder != ""
      ${AndIf} ${FileExists} "$perUserInstallationFolder\${APP_EXECUTABLE_FILENAME}"
        ${If} $perMachineInstallationFolder == ""
        ${OrIfNot} ${FileExists} "$perMachineInstallationFolder\${APP_EXECUTABLE_FILENAME}"
          StrCpy $isForceCurrentInstall "1"
        ${EndIf}
      ${ElseIf} $perMachineInstallationFolder != ""
      ${AndIf} ${FileExists} "$perMachineInstallationFolder\${APP_EXECUTABLE_FILENAME}"
        StrCpy $isForceMachineInstall "1"
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customPageAfterChangeDir
  Var agentDeckReuseInstallDirectory

  Function agentDeckDirectoryPre
    StrCpy $agentDeckReuseInstallDirectory "0"
    ${If} $installMode == "all"
      StrCpy $0 $perMachineInstallationFolder
    ${Else}
      StrCpy $0 $perUserInstallationFolder
    ${EndIf}
    ${If} $0 != ""
    ${AndIf} $INSTDIR == $0
    ${AndIf} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
      StrCpy $agentDeckReuseInstallDirectory "1"
      Abort
    ${EndIf}
    ${If} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE agentDeckDirectoryPre
  !insertmacro MUI_PAGE_DIRECTORY

  Function agentDeckInstFilesPre
    # 旧目录必须原样复用；/D= 显式路径也不追加应用目录。
    ${If} $agentDeckReuseInstallDirectory == "1"
      Return
    ${EndIf}
    !insertmacro GetDParameter $0
    ${If} $0 != ""
      Return
    ${EndIf}
    # 首次手动选目录保留上游行为，避免直接装进用户选择的公共父目录。
    ${GetFileName} $INSTDIR $0
    ${If} $0 != "${APP_FILENAME}"
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE agentDeckInstFilesPre
!macroend
