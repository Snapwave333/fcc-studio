use serde::Serialize;
use std::net::TcpStream;

use crate::proc;

#[derive(Debug, Clone, Serialize)]
pub struct RelayStatus {
    pub broker_up: bool,
    pub config_found: bool,
    pub browser_relay_cli: bool,
}

#[tauri::command]
pub async fn relay_status() -> Result<RelayStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let broker_up = TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], 4098)),
            std::time::Duration::from_millis(800),
        )
        .is_ok();
        let config_found = proc::home_dir().map(|h| h.join(".relay").exists()).unwrap_or(false);
        let browser_relay_cli = proc::find_executable("browser-relay").is_some();
        RelayStatus {
            broker_up,
            config_found,
            browser_relay_cli,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn is_web_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && !url.chars().any(|c| c.is_control() || c == '"' || c == ' ')
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err("only http(s) URLs may be opened".into());
    }
    proc::open_url(url.trim()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_urls_are_allowed() {
        assert!(is_web_url("http://127.0.0.1:5173/"));
        assert!(is_web_url("https://example.com/a?b=1&c=2"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("http://x\" & calc"));
    }
}
