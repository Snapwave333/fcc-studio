use serde::Serialize;
use std::net::TcpStream;

use crate::platform;

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
        let config_found = platform::home_dir()
            .map(|h| h.join(".relay").exists())
            .unwrap_or(false);
        RelayStatus {
            broker_up,
            config_found,
            browser_relay_cli: platform::which("browser-relay").is_some(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn validate_url(url: &str) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("only http(s) URLs may be opened".into());
    }
    if url.chars().any(|c| c.is_control() || c == '"' || c == ' ') {
        return Err("URL contains characters that are not allowed".into());
    }
    Ok(())
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    validate_url(&url)?;
    platform::open_url(&url)
}

#[cfg(test)]
mod tests {
    use super::validate_url;

    #[test]
    fn rejects_non_http_and_injection() {
        assert!(validate_url("https://example.com/a?b=c&d=e").is_ok());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("http://x\" & calc").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
    }
}
