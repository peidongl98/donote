//! 本地缓存目录。
//!
//! 缓存落在安装目录的 `data/cache/`（用户可见、可备份）。
//! 安装目录不可写时（例如装在 Program Files）自动回落到应用数据目录；
//! 实际落在哪里由 `cache_dir` 返回给前端，界面照实显示，不假装。
//!
//! 文件参数一律是「相对缓存根」的路径，Rust 侧负责挡住逃逸到根外的写法，
//! 前端拿不到缓存根以外的任何文件。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 相对安装目录的缓存位置
const DATA_DIR: &str = "data/cache";

#[derive(Serialize)]
pub struct CacheInfo {
    /// 绝对路径
    pub dir: String,
    /// true = 没落在安装目录，回落到了应用数据目录
    pub fallback: bool,
}

static CACHE: OnceLock<CacheInfo> = OnceLock::new();

/// 相对路径 → 缓存根下的绝对路径。含 `..`、以分隔符开头、带盘符的一律拒绝。
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.starts_with('/') || rel.starts_with('\\') || rel.contains(':') {
        return Err("路径不合法".into());
    }
    let mut out = root.to_path_buf();
    for part in rel.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return Err("路径不合法".into()),
            _ => out.push(part),
        }
    }
    Ok(out)
}

/// 真的写一个文件才算数 —— 目录建得出来不代表可写（Program Files 就是这样）
fn writable(dir: &Path) -> bool {
    let probe = dir.join(".write-test");
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn compute(app: &AppHandle) -> CacheInfo {
    if let Some(install) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let candidate = install.join(DATA_DIR);
        if fs::create_dir_all(&candidate).is_ok() && writable(&candidate) {
            return CacheInfo {
                dir: candidate.to_string_lossy().into_owned(),
                fallback: false,
            };
        }
    }
    let base = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    let candidate = base.join("cache");
    let _ = fs::create_dir_all(&candidate);
    CacheInfo {
        dir: candidate.to_string_lossy().into_owned(),
        fallback: true,
    }
}

fn root(app: &AppHandle) -> &'static CacheInfo {
    CACHE.get_or_init(|| compute(app))
}

/// 缓存目录的绝对路径。首次调用会把 `notes/` 一并建好。
#[tauri::command]
pub fn cache_dir(app: AppHandle) -> Result<CacheInfo, String> {
    let info = root(&app);
    fs::create_dir_all(Path::new(&info.dir).join("notes")).map_err(|e| e.to_string())?;
    Ok(CacheInfo {
        dir: info.dir.clone(),
        fallback: info.fallback,
    })
}

/// 读一个缓存文件。不存在返回 null，不算错误。
#[tauri::command]
pub fn cache_read(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let file = safe_join(Path::new(&root(&app).dir), &path)?;
    match fs::read_to_string(&file) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn cache_write(app: AppHandle, path: String, content: String) -> Result<(), String> {
    let file = safe_join(Path::new(&root(&app).dir), &path)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, content).map_err(|e| e.to_string())
}

/// 删除缓存里的文件或目录。本来就不存在视为成功。
///
/// 目录也要能删：对账发现云端已经没了的文件夹，本地这一份副本得整棵清掉，
/// 否则会留下一个删不掉的空壳（实测在缓存里积了好几个回归测试的夹具目录）。
#[tauri::command]
pub fn cache_remove(app: AppHandle, path: String) -> Result<(), String> {
    let file = safe_join(Path::new(&root(&app).dir), &path)?;
    if file.is_dir() {
        return match fs::remove_dir_all(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 列目录下的文件名，返回相对缓存根的路径。只走一层 —— 缓存里最深就是 `notes/`。
#[tauri::command]
pub fn cache_list(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let base = root(&app);
    let dir = safe_join(Path::new(&base.dir), &path)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let root_path = Path::new(&base.dir);
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(root_path) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(out)
}

/// 打开一个目录交给文件管理器。
///
/// 一律打开**目录**：给的是文件就打开它所在的目录（`explorer /select,` 在这台机器上不可靠，
/// 会退回一个没有位置的无标题窗口，高亮一个文件名不值这个风险）。
///
/// 走 `ShellExecuteW` 而不是自己 `Command::new("explorer")` —— 后者从应用里拉起来时
/// 只弹一个空白的「文档 / 桌面」窗口（命令行走查过、用 python 原样跑同一串是好的，
/// 所以问题出在这层进程拉起上），改用 shell 的官方入口，并且把失败原因透给调用方。
#[cfg(target_os = "windows")]
mod win_open {
    use std::ffi::{c_void, OsStr};
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_cmd: i32,
        ) -> *mut c_void;
    }

    const SW_SHOWNORMAL: i32 = 1;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(once(0)).collect()
    }

    /// 交给系统用默认程序打开一个文件（PDF / 文本之类）
    pub fn open_file(path: &Path) -> Result<(), String> {
        let target = wide(path.as_os_str());
        let code = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if code > 32 {
            Ok(())
        } else {
            Err(format!("系统没能打开这个文件（ShellExecuteW 返回 {code}）"))
        }
    }

    pub fn open_dir(dir: &Path) -> Result<(), String> {
        let target = wide(dir.as_os_str());
        // 返回值 <= 32 是 ShellExecute 的历史约定，表示没起来
        let code = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if code > 32 {
            return Ok(());
        }

        // 兜底：直接拉 explorer，别继承宿主 GUI 进程那几个无效的标准句柄
        Command::new("explorer")
            .arg(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("ShellExecuteW 返回 {code}，explorer 也起不来：{e}"))
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn expose(path: &Path) -> Result<(), String> {
    let dir = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    win_open::open_dir(dir)
}

/// 用系统默认程序打开一个文件（《配置说明》这类随包文档用）
#[cfg(target_os = "windows")]
pub(crate) fn open_file(path: &Path) -> Result<(), String> {
    win_open::open_file(path)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn open_file(path: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn expose(_path: &Path) -> Result<(), String> {
    Err("这个平台还不支持直接打开目录".into())
}

/// 在文件管理器里打开缓存目录。用户要备份或看内容时用。
#[tauri::command]
pub fn cache_open_dir(app: AppHandle) -> Result<(), String> {
    expose(Path::new(&root(&app).dir))
}

/// 在文件管理器里打开缓存中这条路径（笔记或文件夹）**所在的目录**。
///
/// `rel` 是相对同步根的路径，和笔记 / 文件夹 id 解出来的那个一致，落在 `notes/` 下。
/// 目标不存在就逐级上溯到最近的已存在祖先 —— 正文是「按需」缓存的，没在本机打开过的
/// 笔记本来就没有副本，打开它所在的目录比报一条看不懂的错有用。
#[tauri::command]
pub fn cache_reveal(app: AppHandle, rel: String) -> Result<(), String> {
    let base = Path::new(&root(&app).dir).join("notes");
    let _ = fs::create_dir_all(&base);
    let mut target = safe_join(&base, &rel)?;
    while !target.exists() {
        if target == base || !target.pop() {
            target = base.clone();
            break;
        }
    }
    expose(&target)
}
