//! 本地模式的文件根。
//!
//! 「本地模式」= 不走任何服务器，笔记就落在这台机器的磁盘上。三条落点，按顺序判定：
//!
//! 1. **绿色版**：`<exe 目录>/data/notes` —— 整个文件夹拷走就带走了全部笔记；
//! 2. **安装版**：`文档/DoNote` —— 卸载不会删、资源管理器里找得到、能直接备份；
//!    安装目录在 `%LOCALAPPDATA%` 深处，放那里卸载会连笔记一起删，所以不默认放那儿。
//! 3. 上面两处都不可写时，退回应用数据目录（`%APPDATA%/DoNote/notes`），并在界面上
//!    照实说明（`fallback: true`），不假装落在文档里。
//!
//! 与缓存（`cache.rs`）的关系：缓存是**网盘文件的副本**，本地模式没有网盘，也就没有缓存
//! 这一层 —— 这里的文件就是原件。两边目录分开，互不覆盖。
//!
//! 文件参数一律是「相对本地根」的路径，Rust 侧挡住逃逸到根外的写法。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 绿色版里的本地笔记位置（相对便携根，即 `<exe 目录>/data`）
const PORTABLE_DIR: &str = "notes";
/// 安装版里的本地笔记位置（相对「文档」）
const DOCUMENTS_DIR: &str = "DoNote";
/// 兜底位置（相对应用数据目录）
const FALLBACK_DIR: &str = "notes";

#[derive(Serialize, Clone)]
pub struct LocalInfo {
    /// 绝对路径
    pub dir: String,
    /// 落点：portable / documents / appdata
    pub kind: &'static str,
    /// true = 没落在预期的位置，退到了应用数据目录
    pub fallback: bool,
}

#[derive(Serialize)]
pub struct LocalStat {
    pub size: u64,
    /// 毫秒时间戳，和 WebDAV 那边一致
    pub mtime: u64,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct LocalEntry {
    pub name: String,
    pub size: u64,
    pub mtime: u64,
    pub is_dir: bool,
}

static LOCAL: OnceLock<LocalInfo> = OnceLock::new();

/// 相对路径 → 绝对路径。含 `..`、以分隔符开头、带盘符的一律拒绝。
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

fn compute(app: &AppHandle) -> LocalInfo {
    if let Some(root) = crate::portable_root() {
        let dir = root.join(PORTABLE_DIR);
        if fs::create_dir_all(&dir).is_ok() && writable(&dir) {
            return LocalInfo {
                dir: dir.to_string_lossy().into_owned(),
                kind: "portable",
                fallback: false,
            };
        }
    }
    if let Ok(docs) = app.path().document_dir() {
        let dir = docs.join(DOCUMENTS_DIR);
        if fs::create_dir_all(&dir).is_ok() && writable(&dir) {
            return LocalInfo {
                dir: dir.to_string_lossy().into_owned(),
                kind: "documents",
                fallback: false,
            };
        }
    }
    let base = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join(FALLBACK_DIR);
    let _ = fs::create_dir_all(&dir);
    LocalInfo {
        dir: dir.to_string_lossy().into_owned(),
        kind: "appdata",
        fallback: true,
    }
}

fn root(app: &AppHandle) -> &'static LocalInfo {
    LOCAL.get_or_init(|| compute(app))
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 本地根目录的绝对路径与落点。首次调用会把目录建好。
#[tauri::command]
pub fn local_info(app: AppHandle) -> Result<LocalInfo, String> {
    let info = root(&app);
    fs::create_dir_all(&info.dir).map_err(|e| e.to_string())?;
    Ok(info.clone())
}

/// 在文件管理器里打开本地笔记目录（备份、拷走时用）
#[tauri::command]
pub fn local_open_dir(app: AppHandle) -> Result<(), String> {
    crate::cache::expose(Path::new(&root(&app).dir))
}

/// 读原始字节。走二进制通道，别把图片变成数字数组。
#[tauri::command]
pub fn local_read(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let file = safe_join(Path::new(&root(&app).dir), &path)?;
    let bytes = fs::read(&file).map_err(|e| format!("读不到这个文件：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 写文件。`data` 是 base64（前端把 string / ArrayBuffer 统一编码后传过来）。
#[tauri::command]
pub fn local_write(app: AppHandle, path: String, data: String) -> Result<(), String> {
    let file = safe_join(Path::new(&root(&app).dir), &path)?;
    let bytes = decode_base64(&data)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, bytes).map_err(|e| format!("写不进去：{e}"))
}

#[tauri::command]
pub fn local_remove(app: AppHandle, path: String) -> Result<(), String> {
    let file = safe_join(Path::new(&root(&app).dir), &path)?;
    if file.is_dir() {
        fs::remove_dir_all(&file).map_err(|e| e.to_string())
    } else {
        match fs::remove_file(&file) {
            Ok(()) => Ok(()),
            // 已经不在了也算删掉：业务层会重复调用（删笔记连它的附件目录一起删）
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[tauri::command]
pub fn local_move(app: AppHandle, from: String, to: String) -> Result<(), String> {
    let src = safe_join(Path::new(&root(&app).dir), &from)?;
    let dst = safe_join(Path::new(&root(&app).dir), &to)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&src, &dst).map_err(|e| format!("移动失败：{e}"))
}

#[tauri::command]
pub fn local_stat(app: AppHandle, path: String) -> Result<Option<LocalStat>, String> {
    let file = safe_join(Path::new(&root(&app).dir), &path)?;
    match fs::metadata(&file) {
        Ok(meta) => Ok(Some(LocalStat {
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime: mtime_ms(&meta),
            is_dir: meta.is_dir(),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 列一层目录。隐藏文件**不跳过** —— 回收站（`.trash`）和附件目录（`.assets`）就是点开头的。
#[tauri::command]
pub fn local_list(app: AppHandle, path: String) -> Result<Vec<LocalEntry>, String> {
    let dir = safe_join(Path::new(&root(&app).dir), &path)?;
    if !dir.is_dir() {
        return Err("目录不存在".into());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = entry.metadata() else { continue };
        let is_dir = meta.is_dir();
        out.push(LocalEntry {
            name,
            size: if is_dir { 0 } else { meta.len() },
            mtime: mtime_ms(&meta),
            is_dir,
        });
    }
    Ok(out)
}

/// 逐级创建目录（已存在视为成功）
#[tauri::command]
pub fn local_mkdir(app: AppHandle, path: String) -> Result<(), String> {
    let dir = safe_join(Path::new(&root(&app).dir), &path)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

/// 标准 base64（带 `=` 填充）。自己写十行，不为一次编解码引一个 crate。
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn value(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &c in bytes {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' {
            continue;
        }
        let v = value(c).ok_or_else(|| "base64 数据不合法".to_string())?;
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}
