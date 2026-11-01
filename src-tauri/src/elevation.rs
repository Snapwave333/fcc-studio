use serde::Serialize;
use tauri::Manager;

use crate::proc;

#[derive(Debug, Clone, Serialize)]
pub struct ElevationStatus {
    pub is_admin: bool,
    pub user: String,
    pub exe: String,
    pub can_request: bool,
}

#[cfg(windows)]
fn is_elevated() -> bool {
    proc::command("net")
        .args(["session"])
        .stdin(std::process::Stdio::null())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_elevated() -> bool {
    proc::command("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

fn current_user() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn elevation_status() -> Result<ElevationStatus, String> {
    tauri::async_runtime::spawn_blocking(|| ElevationStatus {
        is_admin: is_elevated(),
        user: current_user(),
        exe: std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        can_request: cfg!(windows),
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(windows)]
#[tauri::command]
pub fn request_elevation() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().replace('\'', "''");
    proc::command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("Start-Process -FilePath '{exe_str}' -Verb RunAs"),
        ])
        .spawn()
        .map_err(|e| format!("UAC elevation request failed: {e} (declined or blocked)"))?;
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn request_elevation() -> Result<(), String> {
    Err("elevation is only available on Windows; relaunch with sudo if you need root".into())
}

const SECRET_PATTERNS: &[&str] = &[
    "sk-ant-",
    "sk-",
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
    "glpat-",
    "AKIA",
    "AIza",
    "hf_",
    "xoxb-",
    "xoxp-",
    "Bearer ",
    "bearer ",
    "AUTH_TOKEN=",
    "API_KEY=",
    "api_key=",
    "apikey=",
    "token=",
    "secret=",
    "password=",
    "PASSWORD=",
];

pub fn scrub(text: &str) -> String {
    let mut redacted = text.to_string();
    for pat in SECRET_PATTERNS {
        if !redacted.contains(pat) {
            continue;
        }
        let mut out = String::with_capacity(redacted.len());
        let mut rest = redacted.as_str();
        while let Some(idx) = rest.find(pat) {
            out.push_str(&rest[..idx]);
            out.push_str(pat);
            rest = &rest[idx + pat.len()..];
            let skip = rest
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == ';')
                .unwrap_or(rest.len());
            if skip > 0 && !rest[..skip].starts_with("[REDACTED]") {
                out.push_str("[REDACTED]");
            } else {
                out.push_str(&rest[..skip]);
            }
            rest = &rest[skip..];
        }
        out.push_str(rest);
        redacted = out;
    }
    redacted
}

const AUDIT_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub fn audit_write(app: tauri::AppHandle, event: String, detail: String) -> Result<(), String> {
    use std::io::Write;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("audit.log");
    if std::fs::metadata(&path).map(|m| m.len() > AUDIT_MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("audit.log.1"));
    }
    let line = format!(
        "{} | {} | {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        scrub(&event).replace('\n', " "),
        scrub(&detail).replace('\n', " ")
    );
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn audit_read(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("audit.log");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(content.lines().rev().take(200).map(String::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_known_secret_shapes() {
        let s = scrub("key sk-ant-abc123 and ghp_XYZ, header \"Bearer tok\" API_KEY=hunter2;");
        assert!(!s.contains("abc123"));
        assert!(!s.contains("XYZ"));
        assert!(!s.contains("tok\""));
        assert!(!s.contains("hunter2"));
        assert!(s.contains("[REDACTED]"));
    }

    #[test]
    fn leaves_plain_text_alone() {
        assert_eq!(scrub("mode changed normal -> yolo"), "mode changed normal -> yolo");
    }
}
