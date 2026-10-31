use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::process::Command;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct ElevationStatus {
    pub is_admin: bool,
    pub user: String,
    pub exe: String,
}

fn is_elevated() -> bool {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        ])
        .creation_flags(0x0800_0000)
        .output();
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim() == "True",
        Err(_) => false,
    }
}

#[tauri::command]
pub fn elevation_status() -> Result<ElevationStatus, String> {
    let user = Command::new("cmd")
        .args(["/C", "echo %USERNAME%"])
        .creation_flags(0x0800_0000)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    Ok(ElevationStatus {
        is_admin: is_elevated(),
        user,
        exe: std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    })
}

/// Launch a new elevated copy of this application via UAC.
/// Windows requires the user to authorize the elevation — the app cannot grant
/// itself admin rights. The current (unelevated) instance keeps running.
#[tauri::command]
pub fn request_elevation() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().to_string();
    Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("Start-Process -FilePath '{}' -Verb RunAs", exe_str.replace('\'', "''")),
        ])
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| format!("UAC elevation request failed: {e} (declined or blocked)"))?;
    Ok(())
}

const SECRET_PATTERNS: &[&str] = &["sk-", "ghp_", "github_pat_", "AKIA", "Bearer ", "xoxb-", "xoxp-", "AUTH_TOKEN=", "API_KEY=", "api_key=", "password=", "PASSWORD="];

fn scrub(text: &str) -> String {
    let mut redacted = text.to_string();
    for pat in SECRET_PATTERNS {
        if redacted.contains(pat) {
            // redact everything after the marker up to whitespace or quote
            let mut out = String::new();
            let mut rest = redacted.as_str();
            while let Some(idx) = rest.find(pat) {
                out.push_str(&rest[..idx]);
                out.push_str(pat);
                out.push_str("[REDACTED]");
                rest = &rest[idx + pat.len()..];
                // skip to next whitespace or quote
                let skip = rest
                    .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                    .unwrap_or(rest.len());
                rest = &rest[skip..];
            }
            out.push_str(rest);
            redacted = out;
        }
    }
    redacted
}

#[tauri::command]
pub fn audit_write(app: tauri::AppHandle, event: String, detail: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("audit.log");
    let line = format!(
        "{} | {} | {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        scrub(&event),
        scrub(&detail)
    );
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn audit_read(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let path = dir.join("audit.log");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let lines: Vec<String> = content.lines().rev().take(120).map(String::from).collect();
    Ok(lines)
}
