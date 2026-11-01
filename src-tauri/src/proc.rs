use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    hide(&mut cmd);
    cmd
}

#[cfg(windows)]
pub fn hide(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub fn hide(cmd: &mut Command) -> &mut Command {
    cmd
}

pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[cfg(windows)]
fn executable_rank(path: &str) -> u8 {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".exe") {
        0
    } else if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        1
    } else if lower.ends_with(".com") {
        2
    } else {
        9
    }
}

#[cfg(windows)]
pub fn find_executable(name: &str) -> Option<String> {
    let output = command("where").arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut candidates: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    candidates.sort_by_key(|c| executable_rank(c));
    candidates
        .into_iter()
        .find(|c| executable_rank(c) < 9)
        .map(String::from)
}

#[cfg(not(windows))]
pub fn find_executable(name: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| {
            std::fs::metadata(candidate)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    let _ = command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

#[cfg(not(windows))]
pub fn kill_tree(pid: u32) {
    let pid = pid.to_string();
    let _ = command("pkill").args(["-TERM", "-P", &pid]).output();
    let _ = command("kill").args(["-TERM", &pid]).output();
}

#[cfg(windows)]
pub fn open_path(target: &str) -> std::io::Result<()> {
    command("explorer").arg(target).spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
pub fn open_path(target: &str) -> std::io::Result<()> {
    command("open").arg(target).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn open_path(target: &str) -> std::io::Result<()> {
    command("xdg-open").arg(target).spawn().map(|_| ())
}

#[cfg(windows)]
pub fn open_url(url: &str) -> std::io::Result<()> {
    command("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn().map(|_| ())
}

#[cfg(not(windows))]
pub fn open_url(url: &str) -> std::io::Result<()> {
    open_path(url)
}

#[cfg(windows)]
pub fn default_shell() -> (String, Vec<String>) {
    let program = find_executable("pwsh").unwrap_or_else(|| "powershell.exe".to_string());
    (program, vec!["-NoLogo".to_string()])
}

#[cfg(not(windows))]
pub fn default_shell() -> (String, Vec<String>) {
    let program = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/bash".to_string());
    (program, vec!["-l".to_string()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_dir_resolves() {
        assert!(home_dir().is_some());
    }

    #[cfg(not(windows))]
    #[test]
    fn finds_common_unix_binary() {
        assert!(find_executable("sh").is_some());
        assert!(find_executable("definitely-not-a-real-binary-xyz").is_none());
    }
}
