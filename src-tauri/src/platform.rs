use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn detach_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

fn path_exts() -> Vec<String> {
    if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
            .collect()
    } else {
        Vec::new()
    }
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn extra_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        if cfg!(windows) {
            if let Ok(appdata) = std::env::var("APPDATA") {
                dirs.push(PathBuf::from(appdata).join("npm"));
            }
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".cargo").join("bin"));
        } else {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".cargo").join("bin"));
            dirs.push(home.join(".npm-global").join("bin"));
            dirs.push(home.join(".bun").join("bin"));
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
        }
    }
    dirs
}

pub fn which(name: &str) -> Option<String> {
    let candidate = Path::new(name);
    if candidate.components().count() > 1 {
        return is_executable(candidate).then(|| name.to_string());
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(extra_search_dirs());
    let exts = path_exts();
    for dir in dirs {
        if exts.is_empty() {
            let full = dir.join(name);
            if is_executable(&full) {
                return Some(full.to_string_lossy().to_string());
            }
        } else {
            let has_ext = candidate
                .extension()
                .map(|e| exts.contains(&format!(".{}", e.to_string_lossy().to_lowercase())))
                .unwrap_or(false);
            if has_ext {
                let full = dir.join(name);
                if full.is_file() {
                    return Some(full.to_string_lossy().to_string());
                }
            }
            for ext in &exts {
                let full = dir.join(format!("{name}{ext}"));
                if full.is_file() {
                    return Some(full.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

pub fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

pub fn username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default()
}

pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(unix)]
    {
        let group = format!("-{pid}");
        let _ = Command::new("kill").args(["-TERM", "--", &group]).output();
        std::thread::sleep(std::time::Duration::from_millis(150));
        let _ = Command::new("kill").args(["-KILL", "--", &group]).output();
        let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).output();
    }
}

pub fn open_path(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let program = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    command(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open {path}: {e}"))
}

pub fn open_url(url: &str) -> Result<(), String> {
    let mut cmd = if cfg!(windows) {
        let mut c = command("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else if cfg!(target_os = "macos") {
        command("open")
    } else {
        command("xdg-open")
    };
    cmd.arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open {url}: {e}"))
}

pub fn default_shell() -> String {
    if cfg!(windows) {
        if which("pwsh").is_some() {
            "pwsh.exe".into()
        } else {
            "powershell.exe".into()
        }
    } else {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty() && Path::new(s).exists())
            .unwrap_or_else(|| {
                if Path::new("/bin/zsh").exists() && cfg!(target_os = "macos") {
                    "/bin/zsh".into()
                } else {
                    "/bin/bash".into()
                }
            })
    }
}

pub fn shell_args(program: &str) -> Vec<String> {
    let file = program.rsplit(['/', '\\']).next().unwrap_or(program).to_lowercase();
    let base = file.strip_suffix(".exe").unwrap_or(&file).to_string();
    match base.as_str() {
        "powershell" | "pwsh" => vec!["-NoLogo".into()],
        "bash" | "zsh" | "fish" | "sh" => vec!["-l".into()],
        _ => Vec::new(),
    }
}

pub fn is_batch(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

pub fn resolve_node_shim(path: &str) -> Option<(String, String)> {
    if !is_batch(path) {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let dir = Path::new(path).parent()?;
    let marker = "%dp0%\\";
    for line in content.lines() {
        let Some(start) = line.find(marker) else { continue };
        let rest = &line[start + marker.len()..];
        let end = rest.find('"').unwrap_or(rest.len());
        let rel = rest[..end].trim();
        let lower = rel.to_lowercase();
        if !(lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs")) {
            continue;
        }
        let script = dir.join(rel.replace('\\', std::path::MAIN_SEPARATOR_STR));
        if !script.is_file() {
            continue;
        }
        let local_node = dir.join("node.exe");
        let node = if local_node.is_file() {
            local_node.to_string_lossy().to_string()
        } else {
            which("node")?
        };
        return Some((node, script.to_string_lossy().to_string()));
    }
    None
}

pub fn is_elevated() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        #[cfg(windows)]
        {
            command("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
                ])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "True")
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            Command::new("id")
                .arg("-u")
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
                .unwrap_or(false)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_args_match_shell_family() {
        assert_eq!(shell_args("powershell.exe"), vec!["-NoLogo".to_string()]);
        assert_eq!(shell_args("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), vec!["-NoLogo".to_string()]);
        assert_eq!(shell_args("/bin/bash"), vec!["-l".to_string()]);
        assert!(shell_args("fcc-claude").is_empty());
    }

    #[test]
    fn batch_detection_is_case_insensitive() {
        assert!(is_batch("C:\\npm\\fcc-claude.CMD"));
        assert!(is_batch("run.bat"));
        assert!(!is_batch("/usr/bin/fcc-claude"));
    }

    #[test]
    fn which_finds_a_real_binary() {
        let name = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(which(name).is_some());
        assert!(which("definitely-not-a-real-binary-xyz").is_none());
    }

    #[test]
    fn node_shim_resolves_script_path() {
        let dir = std::env::temp_dir().join(format!("serenity-shim-{}", std::process::id()));
        let pkg = dir.join("node_modules").join("tool").join("bin");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("cli.js"), "").unwrap();
        std::fs::write(dir.join("node.exe"), "").unwrap();
        let shim = dir.join("tool.cmd");
        std::fs::write(
            &shim,
            "@ECHO off\r\n\"%_prog%\"  \"%dp0%\\node_modules\\tool\\bin\\cli.js\" %*\r\n",
        )
        .unwrap();
        let (node, script) = resolve_node_shim(&shim.to_string_lossy()).unwrap();
        assert!(node.ends_with("node.exe"));
        assert!(script.ends_with("cli.js"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
