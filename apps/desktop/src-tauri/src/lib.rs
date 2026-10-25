use std::path::PathBuf;

use serde::Serialize;
// `AppHandle::path()` 来自 Manager（取随包资源要用）
use tauri::Manager;

mod cache;
mod local;

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

/// 绿色版标记文件：放在 exe 同目录即视为绿色版。
const PORTABLE_MARK: &str = "portable.txt";
/// 绿色版的数据根目录名（与缓存同根：`<exe 目录>/data`）。
const PORTABLE_DATA: &str = "data";

/// 绿色版的数据根；不是绿色版就返回 None。
///
/// 判据只有一个 —— exe 同目录下有没有 `portable.txt`。安装包不带这个文件，
/// 所以两边的存放位置天然互不干扰：绿色版用户哪天换成安装包，也不会读到旧数据。
pub fn portable_root() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    dir.join(PORTABLE_MARK)
        .is_file()
        .then(|| dir.join(PORTABLE_DATA))
}

/// 前端据此决定更新方式：绿色版没有安装器可走，改成引导去下载页取新 zip。
#[tauri::command]
fn portable_mode() -> bool {
    portable_root().is_some()
}

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

/// 打开随安装包附带的《配置说明》PDF（设置页那个按钮）。
///
/// 文件是 `bundle.resources` 里的 `resources/DoNote-Guide.pdf`，安装后在资源目录下。
#[tauri::command]
fn open_guide(app: tauri::AppHandle) -> Result<(), String> {
    let file = app
        .path()
        .resolve(
            "resources/DoNote-Guide.pdf",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;
    if !file.is_file() {
        return Err(format!("找不到配置说明：{}", file.display()));
    }
    cache::open_file(&file)
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
        // 用系统默认浏览器打开外部链接：WebView2 里 <a target="_blank"> 默认没有任何反应，
        // 前端把 http/https 外链统一交给它（capabilities 里只放行 https）
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 窗口在这里自建，不再交给 tauri.conf.json 里那条（那边标了 create:false）。
            // 原因：绿色版要把 WebView 的数据目录（连接配置就存在它的 localStorage 里）
            // 也搬进解压目录，而 Windows 上 Tauri 会强制使用 %LOCALAPPDATA% 下的固定
            // 目录，只有自己建窗口才换得掉。窗口参数仍从 conf 读，不重复第二份。
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or_else(|| "tauri.conf.json 里找不到 main 窗口".to_string())?;
            let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
            if let Some(profile) = portable_root().map(|root| root.join("webview")) {
                let _ = std::fs::create_dir_all(&profile);
                builder = builder.data_directory(profile);
            }
            let window = builder.build()?;

            // 窗口是无边框的，圆角要向系统要（Win10 上会失败，忽略）
            #[cfg(target_os = "windows")]
            if let Ok(hwnd) = window.hwnd() {
                corners::round(hwnd.0);
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            portable_mode,
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
            cache::cache_open_dir,
            cache::cache_reveal,
            local::local_info,
            local::local_open_dir,
            local::local_read,
            local::local_write,
            local::local_remove,
            local::local_move,
            local::local_stat,
            local::local_list,
            local::local_mkdir,
            open_guide
        ])
        .run(tauri::generate_context!())
        .expect("DoNote 启动失败");
}
