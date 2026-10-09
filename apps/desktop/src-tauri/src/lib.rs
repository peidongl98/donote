use serde::Serialize;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 走 Rust 侧 reqwest 发请求，不经浏览器，天然不受坚果云的 CORS 限制
        .plugin(tauri_plugin_http::init())
        // 在线更新：endpoint 与公钥在 tauri.conf.json 的 plugins.updater 里
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            secret_read,
            secret_write,
            secret_clear
        ])
        .run(tauri::generate_context!())
        .expect("DoNote 启动失败");
}
