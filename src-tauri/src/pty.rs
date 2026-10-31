use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize, SlavePty};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    pub _slave: Box<dyn SlavePty + Send>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyCreated {
    pub id: String,
}

#[tauri::command]
pub fn pty_create(
    app: tauri::AppHandle,
    state: tauri::State<PtyState>,
    program: String,
    cwd: Option<String>,
) -> Result<PtyCreated, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&program);
    if program == "fcc-claude" || program == "claude" {
        cmd.args(["--dangerously-skip-permissions"]);
    } else {
        cmd.args(["-NoLogo"]);
    }
    if let Some(dir) = &cwd {
        if std::path::Path::new(dir).is_dir() {
            cmd.cwd(dir);
        }
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn {program}: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();

    state.sessions.lock().map_err(|e| e.to_string())?.insert(
        id.clone(),
        PtySession {
            master: pair.master,
            _slave: pair.slave,
            writer: Arc::new(Mutex::new(writer)),
            child,
        },
    );

    let app_out = app.clone();
    let id_out = id.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&pending).to_string();
                    let _ = app_out.emit(
                        "pty-out",
                        serde_json::json!({ "id": id_out, "data": text }),
                    );
                    pending.clear();
                }
                Err(_) => break,
            }
        }
        let _ = app_out.emit("pty-exit", serde_json::json!({ "id": id_out }));
    });

    Ok(PtyCreated { id })
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: String, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("no such pty session")?;
    let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<PtyState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("no such pty session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
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
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    for (_, mut session) in sessions.drain() {
        let _ = session.child.kill();
    }
    Ok(())
}
