; Tauri CLI 2.12.6 includes this file before declaring its WebView2 and Install
; sections. Its PREINSTALL macro runs after WebView2 and SetOutPath, so the
; required hidden section checks the prerequisite before either section runs.
; No framework download, registry write, or payload extraction occurs here.

Function AthenaRequireDotNet48
  Push $0
  SetRegView 64
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  SetRegView lastused
  IfErrors athena_dotnet_missing
  ; Microsoft's documented minimum Release value for .NET Framework 4.8+.
  IntCmpU $0 528040 athena_dotnet_ready athena_dotnet_missing athena_dotnet_ready

  athena_dotnet_missing:
    Pop $0
    DetailPrint "Athena requires Microsoft .NET Framework 4.8 or later."
    IfSilent athena_dotnet_exit
    MessageBox MB_OK|MB_ICONSTOP "Athena requires Microsoft .NET Framework 4.8 or later.$\r$\nInstall .NET Framework from Microsoft, then run this installer again."
  athena_dotnet_exit:
    SetErrorLevel 2
    Quit

  athena_dotnet_ready:
    Pop $0
FunctionEnd

Section "-Athena prerequisites"
  SectionIn RO
  Call AthenaRequireDotNet48
SectionEnd

!macro NSIS_HOOK_PREINSTALL
  Call AthenaRequireDotNet48
!macroend
