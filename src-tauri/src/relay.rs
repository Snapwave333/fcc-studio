use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize)]
pub struct RelayStatus {
    pub broker_up: bool,
    pub config_found: bool,
    pub browser_relay_cli: bool,
}

#[tauri::command]
pub fn relay_status() -> Result<RelayStatus, String> {
    let broker_up = TcpStream::connect_timeout(
        &"127.0.0.1:4098".parse().map_err(|e| format!("bad addr: {e}"))?,
        std::time::Duration::from_millis(800),
    )
    .is_ok();

    let config_found = std::env::var("USERPROFILE")
        .ok()
        .map(|h| std::path::PathBuf::from(h).join(".relay").exists())
        .unwrap_or(false);

    let browser_relay_cli = std::process::Command::new("where")
        .arg("browser-relay")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    Ok(RelayStatus {
        broker_up,
        config_found,
        browser_relay_cli,
    })
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) URLs may be opened".into());
    }
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
