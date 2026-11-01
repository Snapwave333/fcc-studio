use serde::Serialize;
use tauri::Manager;

use crate::platform;

#[derive(Debug, Clone, Serialize)]
pub struct ElevationStatus {
    pub is_admin: bool,
    pub user: String,
    pub exe: String,
    pub os: String,
    pub can_request: bool,
}

#[tauri::command]
pub async fn elevation_status() -> Result<ElevationStatus, String> {
    tauri::async_runtime::spawn_blocking(|| ElevationStatus {
        is_admin: platform::is_elevated(),
        user: platform::username(),
        exe: std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        os: std::env::consts::OS.to_string(),
        can_request: cfg!(windows),
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_elevation() -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.to_string_lossy().to_string();
        platform::command("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("Start-Process -FilePath '{}' -Verb RunAs", exe_str.replace('\'', "''")),
            ])
            .spawn()
            .map_err(|e| format!("UAC elevation request failed: {e} (declined or blocked)"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("In-app elevation is only available on Windows. Relaunch Serenity from a root shell (e.g. sudo -E serenity) to run elevated.".into())
    }
}

const SECRET_PATTERNS: &[&str] = &[
    "sk-ant-", "sk-", "ghp_", "gho_", "github_pat_", "glpat-", "AKIA", "AIza", "Bearer ", "xoxb-", "xoxp-",
    "AUTH_TOKEN=", "API_KEY=", "api_key=", "apikey=", "password=", "PASSWORD=", "token=", "TOKEN=", "secret=", "SECRET=",
];

pub fn scrub(text: &str) -> String {
    let mut redacted = text.replace(['\n', '\r'], " ");
    for pat in SECRET_PATTERNS {
        if !redacted.contains(pat) {
            continue;
        }
        let mut out = String::new();
        let mut rest = redacted.as_str();
        while let Some(idx) = rest.find(pat) {
            out.push_str(&rest[..idx]);
            out.push_str(pat);
            rest = &rest[idx + pat.len()..];
            let skip = rest
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == ';')
                .unwrap_or(rest.len());
            if skip > 0 {
                out.push_str("[REDACTED]");
            }
            rest = &rest[skip..];
        }
        out.push_str(rest);
        redacted = out;
    }
    redacted
}

const MAX_AUDIT_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub fn audit_write(app: tauri::AppHandle, event: String, detail: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("audit.log");
    if std::fs::metadata(&path).map(|m| m.len() > MAX_AUDIT_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("audit.log.1"));
    }
    let line = format!(
        "{} | {} | {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        scrub(&event),
        scrub(&detail)
    );
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn audit_read(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("audit.log");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(content.lines().rev().take(200).map(String::from).collect())
}

#[cfg(test)]
mod tests {
    use super::scrub;

    #[test]
    fn redacts_known_secret_shapes() {
        let out = scrub("key sk-ant-abc123 and ghp_XYZ plus API_KEY=hunter2 done");
        assert!(!out.contains("abc123"));
        assert!(!out.contains("XYZ"));
        assert!(!out.contains("hunter2"));
        assert!(out.contains("done"));
    }

    #[test]
    fn keeps_single_line_entries() {
        assert!(!scrub("line1\nline2").contains('\n'));
    }
}
