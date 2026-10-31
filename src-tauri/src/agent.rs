use serde::Serialize;
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Default)]
pub struct AgentState {
    pub runs: Mutex<HashMap<String, RunHandle>>,
}

pub struct RunHandle {
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunStarted {
    pub run_id: String,
    pub pid: u32,
}

fn find_executable(name: &str) -> Option<String> {
    let output = Command::new("where").arg(name).output().ok()?;
    if output.status.success() {
        let s = String::from_utf8_lossy(&output.stdout);
        s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
    } else {
        None
    }
}

#[tauri::command]
pub fn detect_environment() -> Result<serde_json::Value, String> {
    let fcc = find_executable("fcc-claude");
    let claude = find_executable("claude");
    let node = find_executable("node");
    let git = find_executable("git");
    let browser_relay = find_executable("browser-relay");
    let relay_config = std::env::var("USERPROFILE")
        .ok()
        .map(|h| {
            let p = std::path::PathBuf::from(h).join(".relay");
            p.exists()
        })
        .unwrap_or(false);
    let claude_version = claude
        .as_ref()
        .and_then(|path| {
            Command::new(path)
                .arg("--version")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .unwrap_or_default();
    Ok(serde_json::json!({
        "fcc_claude": fcc,
        "claude": claude,
        "claude_version": claude_version,
        "node": node,
        "git": git,
        "browser_relay": browser_relay,
        "relay_config_found": relay_config,
    }))
}

#[tauri::command]
pub fn start_agent_run(
    app: tauri::AppHandle,
    state: tauri::State<AgentState>,
    project_root: String,
    prompt: String,
    session_id: Option<String>,
    extra_system_prompt: Option<String>,
    autonomy: Option<String>,
) -> Result<RunStarted, String> {
    let fcc = find_executable("fcc-claude").ok_or("fcc-claude not found on PATH. Install Free Claude Code first.")?;
    let root = std::path::PathBuf::from(&project_root);
    if !root.is_dir() {
        return Err(format!("project root does not exist: {project_root}"));
    }

    let autonomy = autonomy.unwrap_or_else(|| "yolo".to_string());
    let permission_args: Vec<&str> = match autonomy.as_str() {
        "normal" => vec!["--permission-mode", "default"],
        "redline" => vec!["--permission-mode", "acceptEdits"],
        // yolo and anything else: maximum available autonomy
        _ => vec!["--dangerously-skip-permissions"],
    };

    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "cd /D", &root.to_string_lossy(), "&&", &fcc]);
    cmd.arg("-p")
        .arg(&prompt)
        .args(["--output-format", "stream-json", "--include-partial-messages", "--verbose"])
        .args(&permission_args);
    if let Some(sid) = &session_id {
        if !sid.is_empty() {
            cmd.arg("--resume").arg(sid);
        }
    }
    if let Some(sp) = &extra_system_prompt {
        if !sp.is_empty() {
            cmd.arg("--append-system-prompt").arg(sp);
        }
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(0x0800_0000);

    let mut child = cmd.spawn().map_err(|e| format!("failed to launch fcc-claude: {e}"))?;
    let pid = child.id();
    let run_id = uuid::Uuid::new_v4().to_string();

    state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), RunHandle { pid });

    let app2 = app.clone();
    let run_id2 = run_id.clone();
    let state2_name = run_id.clone();
    let _ = state2_name;

    // stdout: stream-json lines
    if let Some(stdout) = child.stdout.take() {
        let app_handle = app.clone();
        let rid = run_id.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if l.trim().is_empty() {
                            continue;
                        }
                        let parsed: serde_json::Value = serde_json::from_str(&l)
                            .unwrap_or(serde_json::Value::String(l.clone()));
                        let _ = app_handle.emit(
                            "agent-event",
                            serde_json::json!({ "runId": rid, "event": parsed }),
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // stderr: raw text
    if let Some(stderr) = child.stderr.take() {
        let app_handle = app.clone();
        let rid = run_id.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            let mut buf = String::new();
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        buf.push_str(&l);
                        if buf.len() > 8000 {
                            let _ = app_handle.emit(
                                "agent-stderr",
                                serde_json::json!({ "runId": rid, "text": buf }),
                            );
                            buf.clear();
                        }
                    }
                    Err(_) => break,
                }
            }
            if !buf.is_empty() {
                let _ = app_handle.emit(
                    "agent-stderr",
                    serde_json::json!({ "runId": rid, "text": buf }),
                );
            }
        });
    }

    // exit watcher
    std::thread::spawn(move || {
        let status = child.wait();
        let code = status
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(-1);
        let _ = app2.emit(
            "agent-exit",
            serde_json::json!({ "runId": run_id2, "code": code }),
        );
    });

    Ok(RunStarted { run_id, pid })
}

#[tauri::command]
pub fn cancel_agent_run(
    state: tauri::State<AgentState>,
    run_id: String,
) -> Result<(), String> {
    let handle = state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .get(&run_id)
        .map(|h| h.pid);
    if let Some(pid) = handle {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .output();
    }
    state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&run_id);
    Ok(())
}
