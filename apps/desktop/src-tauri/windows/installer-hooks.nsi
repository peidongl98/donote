; DoNote 安装器钩子（Tauri nsis.installerHooks 扩展点）。
;
; 这个文件管两件事：
;   一、安装目录不要出现第二份（下面 NSIS_HOOK_PREINSTALL）
;   二、首次安装的默认目录 = 可用空间最大的固定盘（下面 .onGUIInit）
;
;
; ── 一、为什么需要「装到哪就更新到哪」 ───────────────────────────────────────
;
; 实测记录：0.2.6 的自动更新在本机产出过第二份安装 —— 用户 10-10 手动装到
;   D:\DoNote，10-14 自动更新之后 %LOCALAPPDATA%\DoNote 又多出一份，两处并存，
;   快捷方式被改指到新那份。
;
; 模板（tauri-cli 2.12.1 生成的 installer.nsi）在 .onInit 里其实有一次还原尝试
;   —— 在 `$INSTDIR == placeholder` 分支里 `Call RestorePreviousInstallLocation`，
;   读的也是 HKCU\Software\donote\DoNote 的默认值。本节这段与它**重叠**，作为兜底
;   保留：它在安装段里再确认一次 $INSTDIR 是不是上次记录的位置，不是就改回去，
;   不依赖上面那个分支是否被执行到。0.2.8 带上这段之后做过真装真更新：删掉主程序
;   再跑 /S /UPDATE，能写回原目录，%LOCALAPPDATA% 始终没被创建。
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


; ── 二、首次安装的默认目录：可用空间最大的固定盘 ─────────────────────────────
;
; 目的：没选过目录的用户，默认装到「可用空间最大的本地固定盘」根目录下的 DoNote，
;   而不是 %LOCALAPPDATA%（在系统盘上，装上几版就把系统盘吃满）。
;
; 为什么挂在 GUI 初始化阶段：
;   模板只开放 4 个钩子（PREINSTALL / POSTINSTALL / PREUNINSTALL / POSTUNINSTALL），
;   全部在安装段里执行 —— 那是用户按下「安装」之后。在 PREINSTALL 里改 $INSTDIR
;   会出现「目录页显示 C:\…，实际装到 D:\…」的错位，用户看到的是一个假的路径。
;   界面初始化完成、第一个页面显示之前改 $INSTDIR，目录页显示的就是算好的路径
;   ——看得见，也仍然可以自己改。
;
; 注意不能用 `Function .onGUIInit` 自己定义：MUI2 在 MUI_LANGUAGE 那里已经通过
;   MUI_FUNCTION_GUIINIT 生成过这个函数了，重名会直接编译失败
;   （实测报 `Function named ".onGUIInit" already exists`）。正确做法是 MUI 留的
;   扩展点 MUI_CUSTOMFUNCTION_GUIINIT —— 它会被 MUI 生成的 .onGUIInit 调用。
;   本文件在模板第 32 行被 include，MUI_LANGUAGE 在第 465 行，所以这里的 !define
;   一定先于它生效。
;
; 三种情况一律不动（见 DoNoteGuiInit 里的顺序）：
;   1. 更新安装（/UPDATE）—— 更新必须回到原位置，绝不搬走
;      （笔记缓存 data/cache 就在 exe 旁边，搬走等于用户看着像笔记丢了）
;   2. 已经装过 —— 用户手动重跑安装包时不动他现有的位置
;   3. 命令行带 /D=<目录>（企业静默部署）
; 用户在目录页自己改的仍然算数：这里只改「默认值」，改的时机在目录页显示之前。
; 注意：/S 完全静默安装不触发 GUI 回调，会落回 %LOCALAPPDATA%；那种场景一般自带 /D=。
;
; 产品名不写死：本文件被 !include 在模板 !define PRODUCTNAME 之前（见生成的
;   installer.nsi：第 32 行 include、第 37 行才定义产品名），函数体在 include 处就
;   立即展开，这里引用 ${PRODUCTNAME} 会直接报「未定义」。改成运行期从安装目录的
;   最后一段取——那个目录名本身就是产品名，改名也不用回来动这里。

; 全程用自己声明的变量，一个 $R0–$R9 都不碰。
; 那批寄存器是 NSIS 安装器跨页面在用的：.onInit 里算出来的旧版本号放在 $R0，
; 后面的 EarlyChecks / 重装页都要读它。这一段的执行时机（GUI 初始化）在这些页面
; 之前，覆盖掉就等于把安装器自己的状态踩坏。
Var DNTAlphabet
Var DNTIndex
Var DNTLetter
Var DNTRoot
Var DNTFree
Var DNTBestMB
Var DNTBestDir
Var DNTParams
Var DNTD
Var DNTName

; 入参 $DNTName = 产品名（安装目录的最后一段）。出参 $DNTBestDir。
Function DoNotePickInstallDir
  StrCpy $DNTBestDir ""
  StrCpy $DNTBestMB 0
  StrCpy $DNTAlphabet "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  StrCpy $DNTIndex 2                  ; 下标 2 = 'C'
  ${DoWhile} $DNTIndex <= 25
    ; 盘符必须从字母表里取一个字符；直接把 ASCII 码拼进字符串得到的是 "67:\" 这种
    ; 数字串，不是盘符（踩过这个坑，字符串里没有任何盘叫 67）
    StrCpy $DNTLetter $DNTAlphabet 1 $DNTIndex
    StrCpy $DNTRoot "$DNTLetter:\"

    ; 「本地固定盘」用两个信号判断，都是实测过能用的：
    ;   1. ${DriveSpace} 能读到容量 —— 盘存在且已就绪；光驱空仓、未插卡的读卡器会失败
    ;   2. 卷根有系统回收站目录 —— 网络映射盘没有（回收站是本地概念）
    ; 不用 ${GetDrives}：本机实测它只枚举出 C:（FileFunc 3.4 在这个 NSIS 上枚举不全），
    ; 也不用 GetDriveType：System::Call 的返回值写法试了三种都写不进寄存器。
    ; 局限：外接 USB 硬盘同样满足这两条，会被当成候选——不做进一步区分，代价可接受。
    ClearErrors
    ${DriveSpace} "$DNTRoot" "/D=F /S=M" $DNTFree
    ${IfNot} ${Errors}
    ${AndIf} ${FileExists} "$DNTRoot$$Recycle.Bin"
    ${AndIf} $DNTFree > $DNTBestMB
      StrCpy $DNTBestMB $DNTFree
      StrCpy $DNTBestDir "$DNTRoot$DNTName"
    ${EndIf}

    IntOp $DNTIndex $DNTIndex + 1
  ${Loop}

  ; 盘根目录不给写（受限机器）就退回默认位置，别把安装卡在一个装不进去的路径上
  ${If} $DNTBestDir != ""
    ClearErrors
    CreateDirectory "$DNTBestDir"
    ${If} ${Errors}
      DetailPrint "DoNote: $DNTBestDir 不可写，退回默认安装位置"
      StrCpy $DNTBestDir ""
    ${EndIf}
  ${EndIf}
FunctionEnd

; MUI 的扩展点：MUI 自己生成的 .onGUIInit 会调用这里指定的函数。
; 不能自己写 `Function .onGUIInit` —— 重名会直接编译失败（见上面的说明）。
!define MUI_CUSTOMFUNCTION_GUIINIT DoNoteGuiInit

Function DoNoteGuiInit
  ; 三种情况一律不动，顺序即优先级：
  ;   1. 更新安装（命令行带 /UPDATE）—— 必须回到原位置，绝不能在更新时把安装搬走。
  ;      这一条是硬要求：笔记缓存 data/cache 就在 exe 旁边，搬走等于用户看着像笔记丢了。
  ;      ⚠️ 不能读模板的 $UpdateMode：那是第 70 行的 Var，本文件第 32 行就被 include 了，
  ;      函数体在这里立即展开 → 编译期报 unknown variable、判断恒为空（踩过一次）。
  ;      改成自己从命令行解析，和模板 .onInit 里解析 /UPDATE 是同一套办法。
  ;   2. 命令行带 /D=<目录> —— 企业静默部署显式指定的，优先级最高
  ;   3. 已经装过（卸载键里有记录）—— 用户手动重跑安装包时不动他现有的位置
  ${GetParameters} $DNTParams

  ${GetOptions} $DNTParams "/UPDATE" $DNTD
  ${IfNot} ${Errors}
    Goto dnt_keep_dir
  ${EndIf}

  ${GetOptions} $DNTParams "/D=" $DNTD
  ${IfNot} ${Errors}
    Goto dnt_keep_dir
  ${EndIf}

  ; 默认目录的最后一段就是产品名，运行期取（不写死，改名不用回来动这里）
  ${GetFileName} "$INSTDIR" $DNTName

  ; 卸载键名 = Software\Microsoft\Windows\CurrentVersion\Uninstall\<产品名>
  ; 这里用 HKCU：安装模式固定是 currentUser（release.mjs 有基线核验）。
  ; 不用模板的 ${UNINSTKEY} —— 它也是第 62 行的 define，同上，函数体里用不了。
  ReadRegStr $DNTD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$DNTName" "UninstallString"
  ${If} $DNTD != ""
    Goto dnt_keep_dir
  ${EndIf}

  Call DoNotePickInstallDir
  ${If} $DNTBestDir != ""
    DetailPrint "DoNote: 默认安装目录 $DNTBestDir"
    StrCpy $INSTDIR $DNTBestDir
  ${EndIf}

  dnt_keep_dir:
FunctionEnd
