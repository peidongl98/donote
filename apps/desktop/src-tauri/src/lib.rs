use serde::Serialize;
use tauri::Manager;

mod cache;

/// 无边框窗口的 Win11 系统圆角。
///
/// 窗口去掉了原生边框（`decorations: false`），圆角得自己跟 DWM 要。
/// Win10 不认识这个属性，调用直接失败 —— 忽略即可，直角降级不影响启动。
#[cfg(target_os = "windows")]
mod corners {
    use std::ffi::c_void;

    /// DWMWA_WINDOW_CORNER_PREFERENCE
    const ATTR: u32 = 33;
    /// DWMWCP_ROUND
    const ROUND: u32 = 2;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut c_void,
            attribute: u32,
            value: *const c_void,
            size: u32,
        ) -> i32;
    }

    pub fn round(hwnd: *mut c_void) {
        let preference: u32 = ROUND;
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                ATTR,
                &preference as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

/// Windows 凭据管理器里的服务名。凭据只进系统钥匙串，不落磁盘明文。
const SERVICE: &str = "donote";

#[derive(Serialize)]
pub struct SecretPayload {
    pub value: Option<String>,
}

#[tauri::command]
fn secret_read(key: String) -> Result<SecretPayload, String> {
    let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(SecretPayload { value: Some(v) }),
        Err(keyring::Error::NoEntry) => Ok(SecretPayload { value: None }),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_write(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 把用户选中的本机图片读成原始字节。
///
/// 系统文件对话框只给路径，内容得自己读。返回 Response 走二进制通道，
/// 而不是 JSON 数组 —— 一张 2MB 的图变成数字数组会膨胀到十倍以上。
/// 权限：路径只来自系统对话框，前端拿不到别的入口。
#[tauri::command]
fn read_image(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读不到这个文件：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 拖放导入 / 导出用的纯文本读写。
///
/// 只用 std::fs —— 没引 fs 插件（能力面越小越好，这些路径都来自用户自己拖进来的文件或
/// 自己选的保存位置）。列表用 `list_dir` 递归，目录判定交给调用方。
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读不到这个文件：{e}"))
}

#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("写不进去这个位置：{e}"))
}

#[derive(Serialize)]
pub struct DirEntryDto {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// 列一层目录（不递归）。调用方自己按 is_dir 往下走。
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntryDto>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("打不开这个目录：{e}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 隐藏文件跳过：拖进来的目录里 .DS_Store / Thumbs.db 这类不该变成笔记
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntryDto {
            path: entry.path().to_string_lossy().to_string(),
            name,
            is_dir,
        });
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 走 Rust 侧 reqwest 发请求，不经浏览器，天然不受坚果云的 CORS 限制
        .plugin(tauri_plugin_http::init())
        // 在线更新：endpoint 与公钥在 tauri.conf.json 的 plugins.updater 里
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 插入图片时的系统文件对话框
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 窗口是无边框的，圆角要向系统要（Win10 上会失败，忽略）
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(hwnd) = window.hwnd() {
                    corners::round(hwnd.0);
                }
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secret_read,
            secret_write,
            secret_clear,
            read_image,
            read_text,
            write_text,
            list_dir,
            cache::cache_dir,
            cache::cache_read,
            cache::cache_write,
            cache::cache_remove,
            cache::cache_list,
            cache::cache_open_dir
        ])
        .run(tauri::generate_context!())
        .expect("DoNote 启动失败");
}
