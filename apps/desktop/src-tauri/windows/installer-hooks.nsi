; DoNote 安装器钩子（Tauri nsis.installerHooks 扩展点）。
;
; 这个文件管三件事：
;   一、安装目录不要出现第二份（下面 NSIS_HOOK_PREINSTALL）
;   二、装完之后通知外壳丢图标缓存（下面 NSIS_HOOK_POSTINSTALL）
;   三、首次安装的默认目录 = 可用空间最大的固定盘（下面 .onGUIInit）
;
;
; ── 一、为什么需要「装到哪就更新到哪」 ───────────────────────────────────────
;
; 实测记录一：0.2.6 的自动更新在本机产出过第二份安装 —— 用户 10-10 手动装到
;   D:\DoNote，10-14 自动更新之后 %LOCALAPPDATA%\DoNote 又多出一份，两处并存，
;   快捷方式被改指到新那份。
;
; 实测记录二：0.4.4 的自动更新**又**踩了一次同样的坑 —— 10-16 23:07 更新到 0.4.3
;   时还正常落在 D:\DoNote；10-17 00:22 更新到 0.4.4，D:\DoNote 停在 0.4.3，
;   %LOCALAPPDATA%\DoNote 里多出一份 0.4.4。
;
; 两次都是「找不到原位置 → 落回系统盘」。0.4.4 这次的去向在清理时得到了确认：
;   %LOCALAPPDATA%\DoNote 的目录创建时间正好是 00:22，D:\DoNote\donote.exe 停在
;   0.4.3 的构建时间。
;
; 为什么会找不到 —— 模板里只有**一处**尝试：
;   installer.nsi 的 .onInit 在 `$INSTDIR == placeholder` 分支里 Call
;   RestorePreviousInstallLocation，它 ReadRegStr SHCTX "${MANUPRODUCTKEY}" ""，
;   一条记录定生死。这条记录一旦为空（被卸载器清过、装过别的形态、版本间漂移），
;   就直接落到 `$INSTDIR = $LOCALAPPDATA\${PRODUCTNAME}` —— 系统盘。
;
; 而「可用空间最大的固定盘」那套逻辑挂在 .onGUIInit（本文件第三节），**只有 GUI
;   安装才跑**。自动更新走 updater 的 /P 被动模式，根本不经过它，所以也救不回来。
;
; 所以这里不再只信一条记录。更新安装时按下面的顺序找，**每一个候选都要求
;   「该目录下真的躺着 donote.exe」**才算数（过期的记录不该把安装拽到别处）：
;
;     1. Tauri 自己的恢复键 ${MANUPRODUCTKEY} 的默认值
;     2. 卸载键 ${UNINSTKEY} 的 InstallLocation（去成对引号、去尾反斜杠）
;     3. 逐个固定盘找 <盘>:\<产品>\donote.exe
;     4. %LOCALAPPDATA%\<产品>\donote.exe
;     5. 都没有 → 当没装过，取「可用空间最大的固定盘」（与首次安装的默认一致）
;
;   /D=<目录> 优先级最高，命令行给了就不找。
;
; 注意第 2 条与第 1 条为什么会分家：两者由同一次安装一起写，但卸载器清的是
;   "${MANUPRODUCTKEY}"（`DeleteRegValue` 那个 Installer Language + `/ifempty`
;   整个键），卸载键则按 ARP 的规则单独存活。0.4.4 那次就是恢复键的值已经不是
;   原位置、只剩卸载键还留着线索的情形。
;
; 执行时机：模板的 Section Install 里，紧跟在 SetOutPath $INSTDIR 之后、
;   写文件与写注册表之前（!ifmacrodef NSIS_HOOK_PREINSTALL）。所以这里改掉
;   $INSTDIR 之后必须自己重设 SetOutPath，后续的 File / 注册表 / 快捷方式
;   才会一起落到新位置。
;
; 本机真机验证（2026-10-17，用重编译的安装包，不重新发版）：
;   1. 把恢复键与卸载键**都改成指向一个已经不存在的 C 盘路径**（复现 0.4.4 的处境），
;      跑 `/S /UPDATE` 且不给 /D= —— 文件正确落到 D:\DoNote，注册表与快捷方式都指回
;      D 盘。这一条同时证明了「过期记录会被拒绝」。
;   2. 扫描与归一化单独跑了一遍（用一个只调用这两个函数的小脚本）：
;      C:\DoNote 是空壳（0 个文件）而 D:\DoNote 有 exe 时返回 D:\DoNote（空壳被跳过）；
;      "D:\DoNote"（成对引号）与 D:\DoNote\（尾反斜杠）都归一到 D:\DoNote；
;      指向不存在目录的记录返回空。

!macro NSIS_HOOK_PREINSTALL
  ; 函数在 include 时立即展开，用不了后面才定义的 ${PRODUCTNAME} / ${MAINBINARYNAME}，
  ; 所以由宏（在模板第 634 行展开，那时所有 define 都生效了）把值塞进变量传进去。
  StrCpy $DNTMain "${MAINBINARYNAME}.exe"
  StrCpy $DNTProd "${PRODUCTNAME}"
  StrCpy $DNTFound ""

  ; /D=<目录>：企业静默部署显式指定的，优先级最高，给了就不找
  ${GetParameters} $DNTParams
  ${GetOptions} $DNTParams "/D=" $DNTD
  ${IfNot} ${Errors}
    Goto dnt_pre_done
  ${EndIf}

  ${If} $UpdateMode = 1
    ; 1) Tauri 自己的恢复键
    ReadRegStr $DNTCand SHCTX "${MANUPRODUCTKEY}" ""
    Call DoNoteAcceptDir

    ; 2) 卸载键的 InstallLocation（ARP 里写作 "D:\DoNote"，带引号）
    ${If} $DNTFound == ""
      ReadRegStr $DNTCand SHCTX "${UNINSTKEY}" "InstallLocation"
      Call DoNoteAcceptDir
    ${EndIf}

    ; 3) 逐个固定盘找 <盘>:\<产品>\<主程序>.exe
    ${If} $DNTFound == ""
      Call DoNoteScanDrives
    ${EndIf}

    ; 4) 系统盘上的默认位置（确实有用户就装在这儿）
    ${If} $DNTFound == ""
      StrCpy $DNTCand "$LOCALAPPDATA\${PRODUCTNAME}"
      Call DoNoteAcceptDir
    ${EndIf}

    ; 5) 一个都没找到 —— 按没装过处理，取可用空间最大的固定盘：
    ;    与首次安装的默认一致，好过默不作声地往系统盘塞第二份。
    ${If} $DNTFound == ""
      StrCpy $DNTName "${PRODUCTNAME}"
      Call DoNotePickInstallDir
      StrCpy $DNTFound $DNTBestDir
    ${EndIf}

    ${If} $DNTFound != ""
    ${AndIf} $DNTFound != $INSTDIR
      ; 模板在调用本宏之前已经 SetOutPath 过一遍默认目录 —— SetOutPath 会把目录建出来。
      ; 于是每次把安装重定向回原位置，系统盘上都会留下一个空壳：0.4.4 那次之后，
      ; %LOCALAPPDATA%\DoNote 与 C:\DoNote 各留了一个（都是 0 个文件）。
      ; RMDir 不带 /r 只删空目录，里面有东西就不动，删不掉也不会让安装失败。
      RMDir "$INSTDIR"
      DetailPrint "DoNote: 更新回到已安装的位置 $DNTFound"
      StrCpy $INSTDIR $DNTFound
      SetOutPath $INSTDIR
    ${EndIf}
  ${EndIf}

  dnt_pre_done:
!macroend


; ── 二、装完之后让外壳把旧图标丢掉 ─────────────────────────────────────────
;
; 症状：老版本原地更新到新版本，界面全变了，但资源管理器 / 任务栏 / 开始菜单里
;   那枚图标还是旧的 —— 也就是「更新了，logo 不换」。
;
; 为什么：前端和图标都编在 donote.exe 里，更新会把这个 exe 整个换掉。
;   实测两枚 exe 的图标子图完全不重合（`icons/icon.ico` 的 6 枚子图，在
;   0.3.0 的 exe 里 0 命中、在 0.4.1 的 exe 里 6 命中），说明 exe 本身换得很干净。
;   问题出在 Windows 外壳：它按 **exe 路径**缓存图标，路径没变（原地更新，
;   安装目录被 PREINSTALL 保留下来了）就一直拿旧的那张。
;
; 手法：SHCNE_ASSOCCHANGED (0x08000000) 是「关联与图标都变了，重读一遍」的正式
;   信号，发给外壳即可让它丢掉图标缓存重算。三个入参（item1 / item2 / lock）传 0。
;   不检查返回值：这一步失败只影响图标显示，不该让安装失败。
;
; ⚠️ 必须挂 POSTINSTALL（文件、注册表、快捷方式都写完之后）。
;   挂在 PREINSTALL 会在 exe 还没落地时就发信号，外壳重算出来的还是旧图标。

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend


; ── 三、首次安装的默认目录：可用空间最大的固定盘 ─────────────────────────────
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
; 注意：/S 完全静默安装不触发 GUI 回调 —— 更新走的 /P、/S 两种模式都靠上面的
;   PREINSTALL 找原位置，这里是「首次安装的默认值」这一条路。
;
; 产品名不写死：本文件被 !include 在模板 !define PRODUCTNAME 之前（见生成的
;   installer.nsi：第 32 行 include、第 37 行才定义产品名），函数体在 include 处就
;   立即展开，这里引用 ${PRODUCTNAME} 会直接报「未定义」。改成运行期从安装目录的
;   最后一段取——那个目录名本身就是产品名，改名也不用回来动这里。
;
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
Var DNTCand
Var DNTFound
Var DNTQ
Var DNTMain
Var DNTProd

; 入参 $DNTCand。出参 $DNTFound = 通过校验的目录（"" 表示不合格）。
; 校验两件事：去掉成对引号与尾反斜杠；该目录下真的有 $DNTMain。
Function DoNoteAcceptDir
  StrCpy $DNTFound ""

  ; 卸载键的 InstallLocation 写作 "D:\DoNote"，首尾各一个双引号
  StrCpy $DNTQ $DNTCand 1
  ${If} $DNTQ == '"'
    StrCpy $DNTCand $DNTCand "" 1          ; 去掉首字符
    StrLen $DNTQ $DNTCand
    IntOp $DNTQ $DNTQ - 1
    StrCpy $DNTCand $DNTCand $DNTQ         ; 去掉尾字符
  ${EndIf}

  ; 尾反斜杠：D:\DoNote\ 与 D:\DoNote 是同一个地方
  StrCpy $DNTQ $DNTCand 1 -1               ; 取最后一个字符
  ${If} $DNTQ == "\"
    StrLen $DNTQ $DNTCand
    ${If} $DNTQ > 3                        ; "D:\" 本身就是盘根，别削成 "D:"
      IntOp $DNTQ $DNTQ - 1
      StrCpy $DNTCand $DNTCand $DNTQ
    ${EndIf}
  ${EndIf}

  ; 目录里真的躺着主程序才算数 —— 一条过期的记录不该把安装拽到别处
  ${If} $DNTCand != ""
  ${AndIf} ${FileExists} "$DNTCand\$DNTMain"
    StrCpy $DNTFound $DNTCand
  ${EndIf}
FunctionEnd

; 逐个固定盘找 <盘>:\<产品>\<主程序>。入参 $DNTProd / $DNTMain，出参 $DNTFound。
; 不做「本地固定盘」的判定：路径上真的存在主程序已经足够强的信号，
; 网络盘上恰好有同名同结构安装的概率可以忽略。
Function DoNoteScanDrives
  StrCpy $DNTFound ""
  StrCpy $DNTAlphabet "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  StrCpy $DNTIndex 2                       ; 下标 2 = 'C'
  ${DoWhile} $DNTIndex <= 25
    ${If} $DNTFound == ""
      StrCpy $DNTLetter $DNTAlphabet 1 $DNTIndex
      StrCpy $DNTCand "$DNTLetter:\$DNTProd"
      Call DoNoteAcceptDir
    ${EndIf}
    IntOp $DNTIndex $DNTIndex + 1
  ${Loop}
FunctionEnd

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
