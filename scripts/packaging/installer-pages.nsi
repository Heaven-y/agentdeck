# 运行生产安装页面钩子；安装状态来自夹具，不读写真实注册表或安装目录。
Unicode true
Name "AgentDeck installer page checks"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
!define MUI_CUSTOMFUNCTION_GUIINIT fixtureGuiInit
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include "${TEMPLATE_DIR}\include\StdUtils.nsh"
!include "${TEMPLATE_DIR}\multiUser.nsh"

!define APP_EXECUTABLE_FILENAME "AgentDeck.exe"
!define APP_FILENAME "AgentDeck"
!include "${INSTALLER_INCLUDE}"

Var isForceMachineInstall
Var isForceCurrentInstall

# 与 electron-builder 的命令行谓词使用同一原生解析器。
!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`
!macro _isForAllUsers _a _b _t _f
  ${StdUtils.TestParameter} $R9 "allusers"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForAllUsers `"" isForAllUsers ""`
!macro _isForCurrentUser _a _b _t _f
  ${StdUtils.TestParameter} $R9 "currentuser"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForCurrentUser `"" isForCurrentUser ""`

!define MUI_PAGE_CUSTOMFUNCTION_SHOW recordDirectory
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ReadINIStr $INSTDIR "$EXEDIR\input.ini" fixture target
  ReadINIStr $installMode "$EXEDIR\input.ini" fixture mode
  ReadINIStr $perUserInstallationFolder "$EXEDIR\input.ini" fixture user
  ReadINIStr $perMachineInstallationFolder "$EXEDIR\input.ini" fixture machine
  StrCpy $isForceCurrentInstall "0"
  StrCpy $isForceMachineInstall "0"
  !insertmacro customInstallMode
  WriteINIStr "$EXEDIR\result.ini" result forceUser $isForceCurrentInstall
  WriteINIStr "$EXEDIR\result.ini" result forceMachine $isForceMachineInstall
  ${If} ${isUpdated}
    WriteINIStr "$EXEDIR\result.ini" result updated "1"
  ${Else}
    WriteINIStr "$EXEDIR\result.ini" result updated "0"
  ${EndIf}
FunctionEnd

Function fixtureGuiInit
  HideWindow
FunctionEnd

Function recordDirectory
  WriteINIStr "$EXEDIR\result.ini" result directory "shown"
  Call agentDeckInstFilesPre
  Call recordPath
  Quit
FunctionEnd

Function recordPath
  WriteINIStr "$EXEDIR\result.ini" result target $INSTDIR
  SetErrorLevel 0
FunctionEnd

Section
  WriteINIStr "$EXEDIR\result.ini" result directory "skipped"
  Call recordPath
  Quit
SectionEnd
