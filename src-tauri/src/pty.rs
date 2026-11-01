use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

use crate::proc;

pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyState {
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() {
                let _ = session.child.kill();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyCreated {
    pub id: String,
    pub program: String,
}

pub fn split_utf8(pending: &[u8]) -> usize {
    match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => pending.len(),
    }
}

fn is_powershell(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    let name = lower.rsplit(['\\', '/']).next().unwrap_or(&lower);
    matches!(name, "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe")
}

fn is_claude(program: &str) -> bool {
    matches!(program, "fcc-claude" | "claude")
}

#[tauri::command]
pub fn pty_default_shell() -> String {
    proc::default_shell().0
}

#[tauri::command]
pub fn pty_create(
    app: tauri::AppHandle,
    state: tauri::State<PtyState>,
    program: Option<String>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<PtyCreated, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.unwrap_or(30).max(2),
            cols: cols.unwrap_or(120).max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let (program, args) = match program.filter(|p| !p.trim().is_empty()) {
        Some(p) if is_claude(&p) => {
            let resolved = proc::find_executable(&p).ok_or_else(|| format!("{p} not found on PATH"))?;
            (resolved, vec!["--dangerously-skip-permissions".to_string()])
        }
        Some(p) if is_powershell(&p) => (p, vec!["-NoLogo".to_string()]),
        Some(p) => (p, Vec::new()),
        None => proc::default_shell(),
    };

    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(dir) = cwd.as_deref().filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn {program}: {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();

    state.sessions.lock().map_err(|e| e.to_string())?.insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child,
        },
    );

    let app_out = app.clone();
    let id_out = id.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = [0u8; 16384];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let cut = split_utf8(&pending);
                    if cut == 0 {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&pending[..cut]).to_string();
                    pending.drain(..cut);
                    let _ = app_out.emit("pty-out", serde_json::json!({ "id": id_out, "data": text }));
                }
            }
        }
        if !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).to_string();
            let _ = app_out.emit("pty-out", serde_json::json!({ "id": id_out, "data": text }));
        }
        let code = app_out
            .state::<PtyState>()
            .sessions
            .lock()
            .ok()
            .and_then(|mut s| s.remove(&id_out))
            .and_then(|mut s| s.child.wait().ok())
            .map(|st| st.exit_code() as i64);
        let _ = app_out.emit("pty-exit", serde_json::json!({ "id": id_out, "code": code }));
    });

    Ok(PtyCreated { id, program })
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: String, data: String) -> Result<(), String> {
    let writer = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&id).ok_or("no such pty session")?.writer.clone()
    };
    let mut writer = writer.lock().map_err(|e| e.to_string())?;
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<PtyState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("no such pty session")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyState>, id: String) -> Result<(), String> {
    let session = state.sessions.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(mut session) = session {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill_all(state: tauri::State<PtyState>) -> Result<(), String> {
    state.kill_all();
    Ok(())
}

#[tauri::command]
pub fn pty_list(state: tauri::State<PtyState>) -> Result<Vec<String>, String> {
    Ok(state.sessions.lock().map_err(|e| e.to_string())?.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_incomplete_utf8_tail() {
        let bytes = "héllo".as_bytes();
        assert_eq!(split_utf8(bytes), bytes.len());
        let euro = "€".as_bytes();
        let mut partial = b"ab".to_vec();
        partial.extend_from_slice(&euro[..2]);
        assert_eq!(split_utf8(&partial), 2);
        assert_eq!(split_utf8(&[0xff, b'a']), 2);
    }

    #[test]
    fn detects_shell_kinds() {
        assert!(is_powershell("powershell.exe"));
        assert!(is_powershell("C:\\Program Files\\PowerShell\\7\\pwsh.exe"));
        assert!(!is_powershell("/bin/bash"));
        assert!(is_claude("fcc-claude"));
    }
}
