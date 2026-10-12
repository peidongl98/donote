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

/// 删除缓存文件。本来就不存在视为成功。
#[tauri::command]
pub fn cache_remove(app: AppHandle, path: String) -> Result<(), String> {
    let file = safe_join(Path::new(&root(&app).dir), &path)?;
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

/// 在文件管理器里打开缓存目录。用户要备份或看内容时用。
#[tauri::command]
pub fn cache_open_dir(app: AppHandle) -> Result<(), String> {
    let info = root(&app);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&info.dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("这个平台还不支持直接打开缓存目录".into())
    }
}
