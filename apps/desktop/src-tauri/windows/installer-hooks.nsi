; DoNote 安装器钩子（Tauri nsis.installerHooks 扩展点）。
;
; 为什么需要它 —— 一个会导致「同一台机器出现两份 DoNote」的缺陷：
;
;   Tauri 的 NSIS 模板里，目录选择页是**无条件插入**的：
;       !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
;       !insertmacro MUI_PAGE_DIRECTORY
;   手动安装时这一页会显示，用户可以自选安装目录（例如装到 D:\DoNote）。
;   但自动更新走 /P（passive），SkipIfPassive 把这一页跳过，$INSTDIR 落回
;   .onInit 里按 installMode 算出的默认值 —— currentUser 模式即
;   %LOCALAPPDATA%\DoNote。而 currentUser 模式下模板**没有**「沿用上次安装位置」
;   的逻辑（RestorePreviousInstallLocation 只属于 both 模式的 MultiUser），
;   于是凡是自选过目录的用户，第一次自动更新就会在默认位置多装一份，
;   旧的还留在原处 —— 两处并存，快捷方式还被改成指向新那份。
;
; 做法：更新安装（/UPDATE）时，读回上次的安装位置并沿用。
;   模板在安装段会把 $INSTDIR 裸写进 HKCU\Software\<厂商>\<产品名> 的默认值
;   （WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR），读它即可，无需去引号。
;   只在 $UpdateMode=1 时生效，用户手动安装时换目录的行为完全不受影响。
;
; 执行时机：模板的 Section Install 里，紧跟在 SetOutPath $INSTDIR 之后、
;   写文件与写注册表之前（!ifmacrodef NSIS_HOOK_PREINSTALL）。所以这里改掉
;   $INSTDIR 之后必须自己重设 SetOutPath，后续的 File / 注册表 / 快捷方式
;   才会一起落到新位置。

!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    ReadRegStr $R8 SHCTX "${MANUPRODUCTKEY}" ""
    ${If} $R8 != ""
    ${AndIf} $R8 != $INSTDIR
      DetailPrint "Reusing previous install location: $R8"
      StrCpy $INSTDIR $R8
      SetOutPath $INSTDIR
    ${EndIf}
  ${EndIf}
!macroend
