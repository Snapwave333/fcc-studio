use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

use crate::{agent, platform};

pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
}

#[derive(Default, Clone)]
pub struct PtyState {
    pub sessions: Arc<Mutex<HashMap<String, PtySession>>>,
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
        Err(e) => {
            if e.error_len().is_some() {
                pending.len()
            } else {
                e.valid_up_to()
            }
        }
    }
}

fn build(program: &str, autonomy: &str) -> Result<(CommandBuilder, String), String> {
    let is_agent = program == "fcc-claude" || program == "claude";
    let resolved = if program == "shell" || program.is_empty() {
        platform::default_shell()
    } else {
        program.to_string()
    };
    let path = platform::which(&resolved).unwrap_or_else(|| resolved.clone());
    let args: Vec<String> = if is_agent {
        agent::permission_args(autonomy)
    } else {
        platform::shell_args(&path)
    };
    let cmd = if let Some((node, script)) = platform::resolve_node_shim(&path) {
        let mut c = CommandBuilder::new(node);
        c.arg(script);
        c.args(&args);
        c
    } else if platform::is_batch(&path) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/D", "/C"]);
        c.arg(&path);
        c.args(&args);
        c
    } else {
        let mut c = CommandBuilder::new(&path);
        c.args(&args);
        c
    };
    Ok((cmd, resolved))
}

#[tauri::command]
pub fn pty_create(
    app: tauri::AppHandle,
    state: tauri::State<PtyState>,
    program: String,
    cwd: Option<String>,
    autonomy: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<PtyCreated, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(30).max(2),
            cols: cols.unwrap_or(120).max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let (mut cmd, resolved) = build(&program, autonomy.as_deref().unwrap_or("normal"))?;
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(dir) = cwd.as_ref().filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.cwd(dir);
    } else if let Some(home) = platform::home_dir() {
        cmd.cwd(home);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn {resolved}: {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();

    state.sessions.lock().map_err(|e| e.to_string())?.insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer,
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
                Ok(0) => break,
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
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).to_string();
            let _ = app_out.emit("pty-out", serde_json::json!({ "id": id_out, "data": text }));
        }
        let mut code: Option<u32> = None;
        if let Some(st) = app_out.try_state::<PtyState>() {
            if let Ok(mut sessions) = st.sessions.lock() {
                if let Some(mut s) = sessions.remove(&id_out) {
                    code = s.child.try_wait().ok().flatten().map(|status| status.exit_code());
                }
            }
        }
        let _ = app_out.emit("pty-exit", serde_json::json!({ "id": id_out, "code": code }));
    });

    Ok(PtyCreated { id, program: resolved })
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("terminal session has ended")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<PtyState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("terminal session has ended")?;
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
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill_all(state: tauri::State<PtyState>) -> Result<(), String> {
    state.kill_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::split_utf8;

    #[test]
    fn keeps_incomplete_multibyte_sequences_for_next_read() {
        let snowman = "a☃".as_bytes();
        assert_eq!(split_utf8(&snowman[..2]), 1);
        assert_eq!(split_utf8(snowman), snowman.len());
    }

    #[test]
    fn flushes_invalid_bytes_instead_of_stalling() {
        assert_eq!(split_utf8(&[b'a', 0xff, b'b']), 3);
    }
}
